// 运动层（L1）：目标 → 每帧运动量。
//
// 纯函数，无副作用，不碰 Cesium。所有几何都在 ENU 平面内算。
//
// 三个基础行为：
//   seek   —— 朝目标全速前进
//   arrive —— 进入减速半径后按距离线性降速，避免冲过头
//   face   —— 朝向目标，用于到达后的朝向对齐

import type { AgentConfig, MovementCommand, Vec3 } from './types.ts';

const TAU = Math.PI * 2;

/** 把角度归一化到 (-π, π]。 */
export function wrapPi(angle: number): number {
    let a = angle % TAU;
    if (a > Math.PI) a -= TAU;
    if (a <= -Math.PI) a += TAU;
    return a;
}

/** 水平距离（忽略高度）。 */
export function horizontalDistance(a: Vec3, b: Vec3): number {
    return Math.hypot(b.east - a.east, b.north - a.north);
}

/** 由 A 指向 B 的方位角：0 = 正北，顺时针为正。 */
export function headingTo(from: Vec3, to: Vec3): number {
    return Math.atan2(to.east - from.east, to.north - from.north);
}

/** 由 A 指向 B 的单位向量（水平）。重合时返回零向量。 */
export function unitTo(from: Vec3, to: Vec3): { east: number; north: number } {
    const de = to.east - from.east;
    const dn = to.north - from.north;
    const len = Math.hypot(de, dn);
    if (len < 1e-9) return { east: 0, north: 0 };
    return { east: de / len, north: dn / len };
}

/**
 * arrive 行为：距离 → 速度。
 *
 * 在 slowRadius 之外全速；之内线性降到 minSpeed；
 * 进入 tolerance 后速度归零（由调用方判定到达，这里只保证不冲过头）。
 */
export function arriveSpeed(distance: number, tolerance: number, config: AgentConfig): number {
    if (distance <= tolerance) return 0;
    const slowRadius = Math.max(config.slowRadius, tolerance + 1e-6);
    if (distance >= slowRadius) return config.walkSpeed;
    // 从 minSpeed 到 walkSpeed 线性插值
    const t = (distance - tolerance) / (slowRadius - tolerance);
    return config.minSpeed + (config.walkSpeed - config.minSpeed) * t;
}

/**
 * 计算朝目标移动的运动指令。
 *
 * 返回值直接喂给 playerController.setWorldMovement()。
 * 方向为单位向量（控制器会再归一化，这里保持单位长度让日志更直观）。
 *
 * `facingYaw` 传入人物当前朝向时，会启用「先转再走」：
 * 偏离行进方向太多就先原地转身，不往前滑。不传则退化为纯速度解算
 * （单元测试和不需要朝向的场景用）。
 */
export function steerToward(
    pose: Vec3,
    goal: Vec3,
    tolerance: number,
    config: AgentConfig,
    opts: { run?: boolean; speedOverride?: number; facingYaw?: number } = {},
): MovementCommand {
    const distance = horizontalDistance(pose, goal);
    if (distance <= tolerance) {
        return { east: 0, north: 0, up: 0, run: false, speedMetersPerSecond: 0 };
    }
    const dir = unitTo(pose, goal);
    let speed = opts.speedOverride ?? arriveSpeed(distance, tolerance, config);
    const run = opts.run ?? speed > config.runThreshold;
    // 跑步时用跑步速度覆盖，但仍遵守减速曲线
    if (run && opts.speedOverride == null) {
        const t = distance >= config.slowRadius
            ? 1
            : (distance - tolerance) / Math.max(config.slowRadius - tolerance, 1e-6);
        speed = config.minSpeed + (config.runSpeed - config.minSpeed) * Math.max(0, Math.min(1, t));
    }
    // 先转再走：偏离超过 turnFirstAngle 时速度压到 0（原地转），
    // 在 [alignAngle, turnFirstAngle] 之间按比例降速，过渡不生硬。
    if (opts.facingYaw != null) {
        const offAxis = Math.abs(wrapPi(headingTo(pose, goal) - opts.facingYaw));
        if (offAxis >= config.turnFirstAngle) speed = 0;
        else if (offAxis > config.alignAngle) {
            const t = (offAxis - config.alignAngle) / Math.max(config.turnFirstAngle - config.alignAngle, 1e-6);
            speed *= Math.max(0, 1 - t);
        }
    }
    return {
        east: dir.east,
        north: dir.north,
        up: 0,
        run,
        speedMetersPerSecond: Math.max(0, speed),
    };
}

/**
 * 转向：把当前 yaw 朝目标 yaw 旋转，受 turnRate 限制。
 *
 * 这是「像活的一样」的关键——瞬时转向会显得像机器人，
 * 有角速度上限的转向才有重量感。
 */
export function turnToward(currentYaw: number, targetYaw: number, deltaSeconds: number, turnRate: number): number {
    const diff = wrapPi(targetYaw - currentYaw);
    const maxStep = turnRate * deltaSeconds;
    if (Math.abs(diff) <= maxStep) return wrapPi(targetYaw);
    return wrapPi(currentYaw + Math.sign(diff) * maxStep);
}
