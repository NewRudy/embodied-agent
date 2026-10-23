// 把智能体输出施加到「有身体」的角色上。
//
// 这是纯逻辑，不依赖 Cesium —— 只要能接受这几个方法，任何 3D 引擎都能接。
// Cesium 的 playerController 是其中之一，但不是唯一。

import type { AgentOutput, MovementCommand } from './types.ts';

/**
 * 本包需要角色具备的最小能力。
 *
 * 用结构类型而不是具体类，这样 cesium-player-controller 只是「一种实现」，
 * 而不是硬依赖。
 */
export interface BodyLike {
    /** 世界方向的运动指令。传 null 表示交还键鼠控制。 */
    setWorldMovement(input: {
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
}

/** 每个 body 上一帧是否由智能体接管。用于「只在边沿交接」判断。 */
const wasEngaged = new WeakMap<BodyLike, boolean>();

const STOP_MOVEMENT: MovementCommand = { east: 0, north: 0, up: 0, run: false, speedMetersPerSecond: 0 };

/**
 * 把智能体的输出写回角色。每帧调用一次。
 *
 * 三件事：
 *   1. setWorldMovement —— 决定位移
 *   2. setInput        —— 决定动画（只对读按键轴的角色有意义）
 *   3. 交接           —— 没有活动目标时把控制权还给键鼠
 *
 * 缺了第 2 步，人物会「滑行」：位移在动，但动画恒为 idle。
 * 缺了第 3 步，WASD 会被清零的 worldMovement 吃掉，手动控制失效。
 */
export function applyOutput(body: BodyLike, out: AgentOutput): void {
    const engaged = out.state === 'active';
    const prevEngaged = wasEngaged.get(body) ?? false;
    wasEngaged.set(body, engaged);

    if (!engaged) {
        // 交还控制权：worldMovement 非 null 会覆盖键鼠方向，必须置空。
        body.setWorldMovement(null);
        // 合成的摇杆轴只在「刚交接」这一帧清一次。
        // 每帧都清会把用户的手柄/摇杆输入也一起抹掉。
        if (prevEngaged) body.setInput?.({ moveX: 0, moveY: 0 });
        body.setScriptedYaw?.(null);
        return;
    }

    const moving = out.movement.speedMetersPerSecond > 0;
    body.setWorldMovement({
        east: out.movement.east,
        north: out.movement.north,
        up: out.movement.up,
        run: out.movement.run,
        speedMetersPerSecond: out.movement.speedMetersPerSecond,
    });

    // 本包的运动永远是「朝目标前进」，所以前进轴恒为 1。
    // 不同步的话按键状态恒为 false，AnimationSystem 会一直播 idle。
    body.setInput?.({ moveX: 0, moveY: moving ? 1 : 0, shift: moving && out.movement.run });
    body.setScriptedYaw?.(out.yaw);
}

/** 让角色彻底停下并交还控制权。 */
export function releaseBody(body: BodyLike): void {
    wasEngaged.set(body, false);
    body.setWorldMovement(null);
    body.setInput?.({ moveX: 0, moveY: 0 });
    body.setScriptedYaw?.(null);
}

export { STOP_MOVEMENT };
