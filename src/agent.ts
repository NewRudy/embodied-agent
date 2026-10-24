// 智能体核心（L1 运动 + L2 反射）
//
// 单位是「目标」不是「命令」：
//   目标有生命周期（active → arrived / failed / cancelled），
//   可以中途修正（revise），修正不会让运动重置。
//
// 每帧调用 update(dt)，返回本帧应施加的运动量与朝向。
// 不依赖 Cesium：场景通过 SceneAdapter 注入。

import {
    DEFAULT_CONFIG,
    STOP,
    type AgentConfig,
    type AgentOutput,
    type FailReason,
    type Goal,
    type GoalState,
    type MovementCommand,
    type SceneAdapter,
    type Vec3,
} from './types.ts';
import { horizontalDistance, steerToward, turnToward, unitTo, wrapPi } from './steering.ts';

export interface AgentOptions {
    config?: Partial<AgentConfig>;
    /** 活动边界圆心；不填则用首次目标的建立点。 */
    origin?: Vec3;
}

export class EmbodiedAgent {
    readonly config: AgentConfig;
    private readonly scene: SceneAdapter;
    private origin: Vec3 | null;

    private goal: Goal | null = null;
    private state: GoalState = 'idle';
    private elapsed = 0;

    // 卡住检测
    private lastPos: Vec3 | null = null;
    private accumulatedMove = 0;
    private stillTimer = 0;

    /**
     * 我们**自己**认为的朝向（弧度）。
     *
     * 为什么不每帧都读 `scene.getPose().yaw`：那是「身体实际朝哪」，
     * 而 setScriptedYaw 下发的值要等物理/动画消费之后才反映到模型上，
     * 有些实现（Cesium 的 getPlayerHeading）压根不同步这个值 ——
     * 实测真实场景里 pose.yaw 恒为 0，而我们已经转到 142°。
     *
     * 如果每帧都从 pose.yaw 起算，等于每帧把转身进度清零，
     * 只靠这个缓存勉强连贯；一旦外部重置 scriptedYaw，转身会突然跳回去。
     *
     * 规则：
     *   - 第一次接管（lastYaw 为 null）才读 pose.yaw 作为起点
     *   - 之后一律以自己上一帧算出的值为准
     *   - release() **不清空**：我们下发的朝向是身体朝向的最佳估计，
     *     清掉反而会退回到不可靠的 pose.yaw
     */
    private lastYaw: number | null = null;

    /** 上一帧的实际速度，用于加速度爬坡。 */
    private currentSpeed = 0;

    constructor(scene: SceneAdapter, options: AgentOptions = {}) {
        this.scene = scene;
        this.config = { ...DEFAULT_CONFIG, ...options.config };
        this.origin = options.origin ?? null;
    }

    get currentGoal(): Goal | null { return this.goal; }
    get currentState(): GoalState { return this.state; }

    /**
     * 设定新目标。若已有目标在跑，直接替换（抢占）。
     * 抢占时保留 yaw 连续性，不做瞬移式转向。
     */
    setGoal(goal: Goal): void {
        this.goal = { ...goal };
        this.state = 'active';
        this.elapsed = 0;
        this.resetStuck();
        if (!this.origin) {
            const pose = this.scene.getPose();
            this.origin = { east: pose.east, north: pose.north, up: pose.up };
        }
    }

    /**
     * 中途修正目标 —— 只改指定字段，状态保持 active。
     *
     * 这是「像活的一样」的核心：用户走到一半说「往左一点」，
     * 目标偏移后运动层每帧重新解算，速度方向连续变化，不会停下来重算。
     */
    reviseGoal(patch: Partial<Goal>): void {
        if (!this.goal || this.state !== 'active') return;
        this.goal = { ...this.goal, ...patch };
        this.elapsed = 0;          // 修正后重新计时，避免被原超时误杀
        this.stillTimer = 0;       // 修正后允许重新起步
        this.accumulatedMove = 0;
    }

    cancel(): void {
        if (!this.goal) return;
        this.state = 'cancelled';
        this.goal = null;
        // 取消后速度必须归零，否则「停」之后还会按上一帧的速度滑一段
        this.currentSpeed = 0;
    }

    /** 清空所有状态，交还键鼠控制。 */
    release(): void {
        this.goal = null;
        this.state = 'idle';
        this.lastPos = null;
        this.currentSpeed = 0;
        // 注意**不清** lastYaw：它是「身体现在朝哪」的最佳估计。
        // 清成 null 会让下一次接管退回去读不可靠的 pose.yaw。
        this.resetStuck();
    }

    private resetStuck(): void {
        this.lastPos = null;
        this.accumulatedMove = 0;
        this.stillTimer = 0;
    }

    /**
     * 每帧解算。dt 为秒。
     */
    update(dt: number): AgentOutput {
        const pose = this.scene.getPose();
        const base: AgentOutput = {
            movement: STOP,
            yaw: null,
            state: this.state,
            justArrived: false,
            failure: null,
            goal: this.goal,
            distance: null,
        };

        if (!this.goal || this.state !== 'active') return base;

        const goal = this.goal;
        const tolerance = goal.tolerance ?? this.config.arriveTolerance;
        const distance = horizontalDistance(pose, goal.position);
        base.distance = distance;

        // —— 到达判定 ——
        if (distance <= tolerance) {
            this.state = 'arrived';
            base.state = 'arrived';
            base.justArrived = true;
            base.movement = this.config.stopOnArrive ? STOP : STOP;
            base.yaw = goal.faceYaw != null ? goal.faceYaw : null;
            return base;
        }

        // —— 超时 ——
        this.elapsed += dt;
        const timeout = goal.timeoutSeconds ?? this.config.defaultTimeout;
        if (this.elapsed > timeout) {
            return this.fail('TIMEOUT', base);
        }

        // —— 活动边界 ——
        if (this.origin) {
            const fromOrigin = horizontalDistance(this.origin, pose);
            if (fromOrigin > this.config.boundsRadius) {
                return this.fail('OUT_OF_BOUNDS', base);
            }
        }

        // —— 卡住检测 ——
        // 注意：悬空下落期间水平位移为 0 是正常的，不能判卡住。
        const airborne = !pose.onGround && !pose.flying;
        if (this.lastPos && !airborne) {
            const moved = horizontalDistance(this.lastPos, pose);
            this.accumulatedMove += moved;
            if (moved < this.config.stuckDistance * dt * 2) {
                this.stillTimer += dt;
            } else {
                this.stillTimer = 0;
            }
            if (this.stillTimer > this.config.stuckSeconds) {
                return this.fail('STUCK', base);
            }
        }
        this.lastPos = { east: pose.east, north: pose.north, up: pose.up };

        // —— 悬崖反射：向前探一步，落差过大就停 ——
        // 只在站稳时探测；悬空或未落地时探测没有意义。
        const dir = unitTo(pose, goal.position);
        if (pose.onGround && !pose.flying) {
            const probeE = pose.east + dir.east * this.config.probeDistance;
            const probeN = pose.north + dir.north * this.config.probeDistance;
            const probeH = this.scene.groundHeightAt(probeE, probeN);
            if (probeH != null) {
                const drop = pose.up - probeH;
                if (drop > this.config.maxStepDown) {
                    return this.fail('NO_GROUND_AHEAD', base);
                }
            }
        }

        // —— 运动解算 ——
        // 把当前朝向传进去：偏离目标方向太多时先原地转身再走，
        // 否则转向受 turnRate 限制，前 0.5 秒是「横着滑过去」。
        const currentYaw = this.lastYaw ?? pose.yaw;
        const steering = steerToward(pose, goal.position, tolerance, this.config, {
            facingYaw: currentYaw,
        });
        // 速度不能瞬间到位：0 → 3.2 m/s 一步到位会让动画对不上位移，
        // 看起来像被推着走。这里按 accel/decel 爬坡。
        const movement = this.rampSpeed(steering, dt);

        // —— 朝向：朝行进方向转，受角速度限制 ——
        const targetYaw = Math.atan2(dir.east, dir.north);
        const yaw = turnToward(currentYaw, targetYaw, dt, this.config.turnRate);
        this.lastYaw = yaw;

        base.movement = movement;
        base.yaw = yaw;
        return base;
    }

    /**
     * 把目标速度按加速度限制爬坡。
     *
     * 加速用 accel，减速用 decel。两者分开是因为真人停下比起步快。
     * 关键：**减速时方向也要跟着收敛**，否则急停那一帧人物会横着滑一下。
     */
    private rampSpeed(target: MovementCommand, dt: number): MovementCommand {
        const want = target.speedMetersPerSecond;
        const current = this.currentSpeed;
        const rate = want > current ? this.config.accel : this.config.decel;
        let next: number;
        if (!Number.isFinite(rate)) next = want;
        else {
            const maxDelta = rate * dt;
            next = Math.abs(want - current) <= maxDelta ? want : current + Math.sign(want - current) * maxDelta;
        }
        this.currentSpeed = next;
        return next === want ? target : { ...target, speedMetersPerSecond: next };
    }

    private fail(reason: FailReason, base: AgentOutput): AgentOutput {
        this.state = 'failed';
        return { ...base, state: 'failed', failure: reason, movement: STOP, yaw: null };
    }
}

/** 便捷构造：从一组参照物坐标批量建目标。 */
export function goalAt(position: Vec3, label?: string, tolerance?: number): Goal {
    return { position, tolerance: tolerance ?? DEFAULT_CONFIG.arriveTolerance, label };
}

export { wrapPi };
