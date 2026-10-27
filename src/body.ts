// 把智能体输出施加到「有身体」的角色上。
//
// 这是纯逻辑，不依赖 Cesium —— 只要能接受这几个方法，任何 3D 引擎都能接。
// Cesium 的 playerController 是其中之一，但不是唯一。

import type { AgentOutput, MovementCommand } from './types.ts';
import { locomotionFor, type LocomotionProfile } from './locomotion.ts';

/**
 * 本包需要角色具备的最小能力。
 *
 * 用结构类型而不是具体类，这样 cesium-player-controller 只是「一种实现」，
 * 而不是硬依赖。
 */
export interface BodyLike {
    /**
     * 世界方向的运动指令。传 null 表示交还键鼠控制。
     *
     * **可选**。不实现时本包降级为 `setInput` 驱动（见下）。
     *
     * 为什么标成可选：这是本包自己定义的接口，**不是所有引擎都有**。
     * 实测 `cesium-player-controller` 的 94 个方法里没有 setWorldMovement ——
     * 它只接受按键轴（setInput）。之前这里标成必需，于是 wind demo 每帧在
     * 这一行抛 `setWorldMovement is not a function`，被 tick 的 try/catch 吞掉，
     * 表现是「人物站着不动、日志只报一次」，非常难查。
     */
    setWorldMovement?(input: {
        east: number; north: number; up?: number;
        run?: boolean; speedMetersPerSecond?: number; maxTravelMeters?: number;
    } | null): void;
    /** 脚本化朝向；null 表示交还相机驱动。 */
    setScriptedYaw?(yaw: number | null): void;
    /**
     * 同步「按键轴」。
     *
     * 存在的理由：playerController 的动画选择（AnimationSystem）只读键盘按键状态，
     * 不看 setWorldMovement。不同步的话，人物会一直播 idle —— 像滑行的雕像。
     * 其他引擎不需要这个方法，所以是可选的。
     */
    setInput?(input: { moveX?: number; moveY?: number; shift?: boolean }): void;
    /**
     * 按名播放动画，并**锁定**这个选择。
     *
     * 配合 `locomotion` 选项用：本包算出「该播哪个 clip、以多快播」，
     * 通过这个方法下发。不实现的话就退回按键轴驱动（脚会打滑）。
     *
     * 参数是**动画 clip 名**（如 Walk_Loop）。
     *
     * 传 null 表示解锁，交还引擎自己按按键选动画。
     *
     * 为什么必须「锁定」：引擎每帧会按按键状态重选一次动画。我们下发的 clip
     * 如果不锁，下一帧就被改回 idle —— 表现为「倍速生效了但永远在站着」。
     *
     * **名字对不上的坑**：`cesium-player-controller` 的真实方法叫
     * `playPlayerAnimationByName`，不是这个名字。见下面 `resolveBody` 的适配。
     */
    playPlayerAnimationByClipName?(clipName: string | null): void;
    /** 调整当前动画播放速率（1 = 原速）。 */
    setPlayerAnimationTimeScale?(scale: number): void;
    /**
     * 直接设朝向（弧度）。null 表示交还相机驱动。
     *
     * `cesium-player-controller` 只有相对转向的 `addYaw(delta)` 和读朝向的
     * `getYaw()`，没有绝对设置。适配见 `resolveBody`。
     */
    setScriptedYaw?(yaw: number | null): void;
}

/**
 * 把引擎对象适配成 BodyLike，补上名字对不上的那几个方法。
 *
 * 为什么需要：`BodyLike` 里有一半方法名是本包自己起的，而
 * `cesium-player-controller` 用的是另一套名字。实测在真实浏览器里，
 * 它的 94 个公开方法中：
 *
 *   setWorldMovement                → 不存在（只有 setInput）
 *   playPlayerAnimationByClipName   → 实际叫 playPlayerAnimationByName
 *   setPlayerAnimationTimeScale     → 不存在
 *   setScriptedYaw                  → 实际是 addYaw(增量) + getYaw()
 *
 * 结果是 wind demo 里**动画匹配、朝向控制、位移全都没生效**，
 * 而且因为 applyOutput 的调用都带 `?.`，失败是静默的。
 *
 * 这个适配层是幂等的：已经是 BodyLike 的对象原样返回。
 */
export function resolveBody(raw: unknown): BodyLike {
    const body = raw as Record<string, unknown> & BodyLike;
    if (!body || typeof body !== 'object') return body as BodyLike;

    // 引擎只认按键轴 → 用 setInput 驱动（applyOutput 会检测到没有
    // setWorldMovement 并自动走这条分支）。
    if (typeof body.playPlayerAnimationByClipName !== 'function'
        && typeof body.playPlayerAnimationByName === 'function') {
        body.playPlayerAnimationByClipName = (clipName: string | null) => {
            if (clipName == null) {
                // 引擎没有「解锁」概念：交还按键驱动即可
                (body as { setAnimationByPressed?: () => void }).setAnimationByPressed?.();
                return;
            }
            (body.playPlayerAnimationByName as (n: string) => void).call(body, clipName);
        };
    }

    // 绝对朝向 → 引擎没有「设朝向」的方法，得改相机的方位角。
    //
    // 为什么不能只调 addYaw：实测读引擎源码（dist/index.js 的 updatePlayer）：
    //     const camYaw = this.getCameraYaw();
    //     let dirE = moveAxes.y * Math.sin(camYaw) + moveAxes.x * Math.cos(camYaw);
    //     let dirN = moveAxes.y * Math.cos(camYaw) - moveAxes.x * Math.sin(camYaw);
    // **位移方向由相机朝向决定**，不是 player 的 yaw。addYaw 只改 player，
    // 于是「yaw 转过去了、人还是朝反方向走」—— 实测距目标从 425 m 一路涨到 458 m。
    //
    // 相机方位角是 cam.theta，且实测 camYaw = theta - π（改 theta 会同步改 camYaw）。
    if (typeof body.setScriptedYaw !== 'function') {
        const cam = (body as { cam?: { theta?: number } }).cam;
        const canSetCameraYaw = cam && typeof cam.theta === 'number';
        const getCameraYaw = body.getCameraYaw as (() => number) | undefined;
        const callAddYaw = typeof body.addYaw === 'function'
            ? (d: number) => (body.addYaw as (d: number) => void).call(body, d)
            : null;

        if (canSetCameraYaw || callAddYaw) {
            body.setScriptedYaw = (yaw: number | null) => {
                if (yaw == null) return;
                if (!Number.isFinite(yaw)) return;
                if (cam && typeof cam.theta === 'number') {
                    // 相机方位角 = 目标朝向 + π。
                    //
                    // 不要归一化到 (-π, π]：theta 是相机的连续角度，引擎自己
                    // 也不归一。把 4.14 绕成 -2.14 数学上等价，但会让相机
                    // 在下一帧往回转一整圈，视觉上是「猛地掉头」。
                    cam.theta = yaw + Math.PI;
                } else if (callAddYaw && getCameraYaw) {
                    // 退化路径：没有相机对象时至少把 player 转对。
                    // 必须 .call(body) —— 解构后直接调用会丢 this，
                    // 引擎内部读 this.xxx 时抛异常（实测被 try/catch 吞掉，
                    // 表现为「人物朝反方向走」，很难定位）。
                    const cur = getCameraYaw.call(body);
                    if (!Number.isFinite(cur)) return;
                    let delta = yaw - cur;
                    while (delta > Math.PI) delta -= Math.PI * 2;
                    while (delta < -Math.PI) delta += Math.PI * 2;
                    callAddYaw(delta);
                }
            };
        }
    }

    return body;
}

/** 每个 body 上一帧是否由智能体接管。用于「只在边沿交接」判断。 */
const wasEngaged = new WeakMap<BodyLike, boolean>();
/** 每个 body 上一次下发的动画，避免每帧重复调 playByName。 */
const lastClip = new WeakMap<BodyLike, string>();
/** 每个 body 上一次下发的播放速率，避免每帧重复写。 */
const lastTimeScale = new WeakMap<BodyLike, number>();

const STOP_MOVEMENT: MovementCommand = { east: 0, north: 0, up: 0, run: false, speedMetersPerSecond: 0 };

export interface ApplyOptions {
    /**
     * 移动动画配置。给了才会做动画速度匹配（脚不打滑）。
     *
     * 不给时退回老行为：只同步按键轴，动画由引擎按 walk/run 二选一播放 ——
     * 那时人物的位移速度和动画速度对不上，看起来像滑冰。
     */
    locomotion?: LocomotionProfile;
}

/**
 * 把智能体的输出写回角色。每帧调用一次。
 *
 * 四件事：
 *   1. setWorldMovement —— 决定位移
 *   2. 动画匹配       —— 决定播哪个 clip、以多快播（脚不打滑）
 *   3. setInput       —— 兜底：让只认按键轴的引擎也能选对动画
 *   4. 交接           —— 没有活动目标时把控制权还给键鼠
 *
 * 缺了第 2 步，人物会「滑行」：位移在走，脚却在按固定节奏倒腾。
 * 缺了第 4 步，WASD 会被清零的 worldMovement 吃掉，手动控制失效。
 */
export function applyOutput(body: BodyLike, out: AgentOutput, options: ApplyOptions = {}): void {
    const engaged = out.state === 'active';
    const prevEngaged = wasEngaged.get(body) ?? false;
    wasEngaged.set(body, engaged);

    if (!engaged) {
        // 交还控制权：worldMovement 非 null 会覆盖键鼠方向，必须置空。
        body.setWorldMovement?.(null);
        // 合成的摇杆轴只在「刚交接」这一帧清一次。
        // 每帧都清会把用户的手柄/摇杆输入也一起抹掉。
        if (prevEngaged) body.setInput?.({ moveX: 0, moveY: 0 });
        body.setScriptedYaw?.(null);
        if (prevEngaged) {
            // 交接时把播放速率还原，别让下一段手动操作继承我们的倍速
            body.setPlayerAnimationTimeScale?.(1);
            // 同时解锁动画选择，否则用户按 WASD 时画面还卡在我们的 clip 上
            body.playPlayerAnimationByClipName?.(null);
            lastTimeScale.set(body, 1);
            lastClip.delete(body);
        }
        return;
    }

    const speed = out.movement.speedMetersPerSecond;
    const moving = speed > 0;
    body.setWorldMovement?.({
        east: out.movement.east,
        north: out.movement.north,
        up: out.movement.up,
        run: out.movement.run,
        speedMetersPerSecond: speed,
    });

    // 引擎不认世界坐标运动指令时，只能退回按键轴。
    //
    // 这条分支是 `cesium-player-controller` 的实际走法：它没有 setWorldMovement，
    // 位移由自己的 InputSystem 按 moveX/moveY 驱动。不喂它，人物就站着不动。
    //
    // 注意这条**必须独立于 locomotion 分支**：之前只在「没配 locomotion」时才
    // setInput，于是 wind demo（配了 locomotion）两条路都没走通 ——
    // setWorldMovement 不存在抛异常，setInput 又没被调用，人物永远不动。
    if (!body.setWorldMovement) {
        // 本包的运动永远是「朝目标前进」，前进轴恒为 1。
        // moveX 是左右，本包不做横向平移（转向由 setScriptedYaw 负责）。
        body.setInput?.({ moveX: 0, moveY: moving ? 1 : 0, shift: moving && out.movement.run });
    }

    if (options.locomotion) {
        // —— 动画速度匹配 ——
        // 按实际速度挑 clip 并算倍速。这是「脚不打滑」的关键：
        // Walk_Loop 的自然速度约 1.07 m/s，以 3.2 m/s 走时倍速约 3.0，
        // 脚步频率跟上位移，脚看起来是踩在地上的。
        const state = locomotionFor(speed, options.locomotion);
        if (lastClip.get(body) !== state.clip) {
            body.playPlayerAnimationByClipName?.(state.clip);
            lastClip.set(body, state.clip);
        }
        // 倍速每帧都可能有微小变化，只在变化超过 5% 时才写，减少无谓调用。
        //
        // 为什么是 5% 而不是 1%：每次改倍速都要重建 Cesium 的 runtime。
        // 加速阶段速度每帧涨 0.2 m/s（12 m/s² ÷ 60fps），1% 阈值意味着
        // 几乎每帧都重建 —— 即使续上了相位，也白白打断动画采样。
        // 5% 意味着每约 4~5 帧写一次，肉眼分辨不出 5% 的脚步快慢差异。
        const prev = lastTimeScale.get(body) ?? 1;
        if (Math.abs(state.timeScale - prev) > prev * 0.05) {
            body.setPlayerAnimationTimeScale?.(state.timeScale);
            lastTimeScale.set(body, state.timeScale);
        }
    } else if (body.setWorldMovement) {
        // 没有动画配置、且引擎认世界坐标指令时，退回按键轴驱动。
        //
        // 只在这种组合下才发：引擎不认 setWorldMovement 的情况已经在上面
        // 统一处理过了，这里再发一次就是重复。
        body.setInput?.({ moveX: 0, moveY: moving ? 1 : 0, shift: moving && out.movement.run });
    }

    body.setScriptedYaw?.(out.yaw);
}

/** 让角色彻底停下并交还控制权。 */
export function releaseBody(body: BodyLike): void {
    wasEngaged.set(body, false);
    body.setWorldMovement?.(null);
    body.setInput?.({ moveX: 0, moveY: 0 });
    body.setScriptedYaw?.(null);
    body.setPlayerAnimationTimeScale?.(1);
    body.playPlayerAnimationByClipName?.(null);
    lastClip.delete(body);
    lastTimeScale.set(body, 1);
}

export { STOP_MOVEMENT };
