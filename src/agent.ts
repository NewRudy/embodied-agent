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

    // 上一帧的 yaw（用于受 turnRate 限制的转向）
    private lastYaw: number | null = null;

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
    }

    /** 清空所有状态，交还键鼠控制。 */
    release(): void {
        this.goal = null;
        this.state = 'idle';
        this.lastPos = null;
        this.lastYaw = null;
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
        const movement = steerToward(pose, goal.position, tolerance, this.config);

        // —— 朝向：朝行进方向转，受角速度限制 ——
        const targetYaw = Math.atan2(dir.east, dir.north);
        const currentYaw = this.lastYaw ?? pose.yaw;
        const yaw = turnToward(currentYaw, targetYaw, dt, this.config.turnRate);
        this.lastYaw = yaw;

        base.movement = movement;
        base.yaw = yaw;
        return base;
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
