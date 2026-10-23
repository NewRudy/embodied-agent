// 运动层与反射层测试 —— 纯数学，不需要 Cesium、不需要网络、不需要模型。
//
// 运行：node --test test/
//
// 这些测试证明的是「解算逻辑正确」，不是「场景里看起来对」。
// 后者必须靠浏览器验收。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EmbodiedAgent } from '../src/agent.ts';
import { arriveSpeed, headingTo, horizontalDistance, turnToward, wrapPi } from '../src/steering.ts';
import { DEFAULT_CONFIG, type Pose, type SceneAdapter } from '../src/types.ts';

const DT = 1 / 60;

/** 平地场景：地面高度恒定，无参照物。 */
export function flatScene(start: Partial<Pose> = {}, ground = 0): SceneAdapter {
    const pose: Pose = { east: 0, north: 0, up: ground, yaw: 0, flying: false, onGround: true, ...start };
    return {
        getPose: () => ({ ...pose }),
        groundHeightAt: () => ground,
        resolveReference: () => null,
    };
}

/** 带状态的模拟场景：agent 的输出会真正移动位姿，用来测收敛。 */
function simScene(start: Partial<Pose> = {}, ground = 0) {
    const pose: Pose = { east: 0, north: 0, up: ground, yaw: 0, flying: false, onGround: true, ...start };
    const scene: SceneAdapter = {
        getPose: () => ({ ...pose }),
        groundHeightAt: () => ground,
        resolveReference: () => null,
    };
    const step = (m: { east: number; north: number; speedMetersPerSecond: number }, dt = DT) => {
        pose.east += m.east * m.speedMetersPerSecond * dt;
        pose.north += m.north * m.speedMetersPerSecond * dt;
    };
    return { scene, pose, step };
}

// ==================== 基础数学 ====================

test('headingTo: 正北为 0，正东为 π/2', () => {
    assert.equal(headingTo({ east: 0, north: 0, up: 0 }, { east: 0, north: 10, up: 0 }), 0);
    assert.ok(Math.abs(headingTo({ east: 0, north: 0, up: 0 }, { east: 10, north: 0, up: 0 }) - Math.PI / 2) < 1e-9);
});

test('wrapPi: 归一化到 (-π, π]', () => {
    assert.ok(Math.abs(wrapPi(3 * Math.PI) - Math.PI) < 1e-9);
    assert.ok(Math.abs(wrapPi(-3 * Math.PI) - Math.PI) < 1e-9);
    assert.equal(wrapPi(0), 0);
});

test('horizontalDistance: 忽略高度差', () => {
    assert.equal(horizontalDistance({ east: 0, north: 0, up: 0 }, { east: 3, north: 4, up: 100 }), 5);
});

// ==================== arrive 减速曲线 ====================

test('arriveSpeed: 远处全速，近处减速，到达点归零', () => {
    const c = DEFAULT_CONFIG;
    assert.equal(arriveSpeed(100, 3, c), c.walkSpeed);
    assert.ok(arriveSpeed(6, 3, c) < c.walkSpeed);
    assert.ok(arriveSpeed(4, 3, c) < arriveSpeed(6, 3, c));
    assert.equal(arriveSpeed(3, 3, c), 0);
});

test('arriveSpeed: 减速曲线单调不增', () => {
    const c = DEFAULT_CONFIG;
    let prev = Infinity;
    for (let d = 30; d >= 3; d -= 0.5) {
        const s = arriveSpeed(d, 3, c);
        assert.ok(s <= prev + 1e-9, `距离 ${d} 处速度反弹：${s} > ${prev}`);
        prev = s;
    }
});

// ==================== 转向角速度限制 ====================

test('turnToward: 受角速度上限约束，不会瞬移', () => {
    const yaw = turnToward(0, Math.PI, 1 / 60, Math.PI);
    assert.ok(Math.abs(yaw) <= Math.PI / 60 + 1e-9, `单帧转角过大：${yaw}`);
});

test('turnToward: 角度差小于单帧上限时直接到位', () => {
    // 单帧上限 = turnRate * dt = π/60 ≈ 0.0524
    const maxStep = Math.PI / 60;
    const target = maxStep * 0.5;
    assert.ok(Math.abs(turnToward(0, target, 1 / 60, Math.PI) - target) < 1e-9);
    // 超过上限时只能走满一步
    const big = maxStep * 3;
    assert.ok(Math.abs(turnToward(0, big, 1 / 60, Math.PI) - maxStep) < 1e-9);
});

// ==================== 目标收敛 ====================

test('直线目标：从 (0,0) 走到 (50,0)，最终到达', () => {
    const { scene, pose, step } = simScene();
    const agent = new EmbodiedAgent(scene);
    agent.setGoal({ position: { east: 50, north: 0, up: 0 }, tolerance: 2 });

    let frames = 0;
    let out = agent.update(DT);
    while (out.state === 'active' && frames < 60 * 60) {
        step(out.movement);
        out = agent.update(DT);
        frames++;
    }
    assert.equal(out.state, 'arrived');
    assert.ok(horizontalDistance(pose, { east: 50, north: 0, up: 0 }) <= 2.5);
    assert.ok(frames < 60 * 30, `走 50 米用了 ${frames} 帧，太慢`);
});

test('斜向目标：能到达任意方向的目标点', () => {
    for (const target of [
        { east: 30, north: 30, up: 0 },
        { east: -40, north: 20, up: 0 },
        { east: 0, north: -35, up: 0 },
    ]) {
        const { scene, pose, step } = simScene();
        const agent = new EmbodiedAgent(scene);
        agent.setGoal({ position: target, tolerance: 2 });
        let out = agent.update(DT);
        let frames = 0;
        while (out.state === 'active' && frames < 60 * 90) {
            step(out.movement);
            out = agent.update(DT);
            frames++;
        }
        assert.equal(out.state, 'arrived', `目标 ${JSON.stringify(target)} 未到达`);
        assert.ok(horizontalDistance(pose, target) <= 2.5);
    }
});

test('不会冲过头：到达时速度已降下来', () => {
    const { scene, pose, step } = simScene();
    const agent = new EmbodiedAgent(scene);
    agent.setGoal({ position: { east: 40, north: 0, up: 0 }, tolerance: 3 });

    let out = agent.update(DT);
    let lastSpeed = 0;
    let frames = 0;
    while (out.state === 'active' && frames < 60 * 60) {
        lastSpeed = out.movement.speedMetersPerSecond;
        step(out.movement);
        out = agent.update(DT);
        frames++;
    }
    // 最后一步速度应远低于巡航速度
    assert.ok(lastSpeed < DEFAULT_CONFIG.walkSpeed * 0.6, `接近目标时速度仍为 ${lastSpeed}`);
    assert.ok(pose.east <= 40 + 3, `冲过头到 ${pose.east}`);
});

// ==================== 目标修正 ====================

test('中途修正目标：不重置状态，速度方向连续变化', () => {
    const { scene, step } = simScene();
    const agent = new EmbodiedAgent(scene);
    agent.setGoal({ position: { east: 100, north: 0, up: 0 }, tolerance: 2 });

    // 先跑 1 秒
    let out = agent.update(DT);
    for (let i = 0; i < 60; i++) { step(out.movement); out = agent.update(DT); }
    assert.equal(out.state, 'active');
    const beforeSpeed = out.movement.speedMetersPerSecond;
    assert.ok(beforeSpeed > 1, '修正前应在移动');

    // 中途把目标改到左前方
    agent.reviseGoal({ position: { east: 100, north: 60, up: 0 } });
    const after = agent.update(DT);

    assert.equal(after.state, 'active', '修正后不应退出 active');
    // 方向应该已经朝新目标偏转，但幅度是渐进的
    assert.ok(after.movement.north > 0, '修正后应向北偏');
    assert.ok(Math.abs(after.movement.speedMetersPerSecond - beforeSpeed) < DEFAULT_CONFIG.walkSpeed,
        '修正瞬间速度不应跳变');
});

test('修正后仍然到达新目标', () => {
    const { scene, pose, step } = simScene();
    const agent = new EmbodiedAgent(scene);
    agent.setGoal({ position: { east: 80, north: 0, up: 0 }, tolerance: 2 });
    let out = agent.update(DT);
    for (let i = 0; i < 60; i++) { step(out.movement); out = agent.update(DT); }
    const revised = { east: 40, north: 50, up: 0 };
    agent.reviseGoal({ position: revised });
    out = agent.update(DT);
    let frames = 0;
    while (out.state === 'active' && frames < 60 * 90) {
        step(out.movement);
        out = agent.update(DT);
        frames++;
    }
    assert.equal(out.state, 'arrived');
    assert.ok(horizontalDistance(pose, revised) <= 2.5);
});

// ==================== 反射 ====================

test('悬崖反射：前方落差过大时拒绝前进并判失败', () => {
    const pose: Pose = { east: 0, north: 0, up: 100, yaw: 0, flying: false, onGround: true };
    const scene: SceneAdapter = {
        getPose: () => ({ ...pose }),
        // 前方 2.5 米处地面骤降 50 米
        groundHeightAt: (e, n) => (Math.hypot(e, n) > 1.5 ? 50 : 100),
        resolveReference: () => null,
    };
    const agent = new EmbodiedAgent(scene);
    agent.setGoal({ position: { east: 100, north: 0, up: 100 }, tolerance: 2 });
    const out = agent.update(DT);
    assert.equal(out.state, 'failed');
    assert.equal(out.failure, 'NO_GROUND_AHEAD');
    assert.equal(out.movement.speedMetersPerSecond, 0);
});

test('卡住反射：原地不动超过阈值判失败', () => {
    const { scene } = simScene();
    const agent = new EmbodiedAgent(scene, { config: { stuckSeconds: 0.5 } });
    agent.setGoal({ position: { east: 50, north: 0, up: 0 }, tolerance: 2 });
    // 不调用 step，人物原地不动
    let out = agent.update(DT);
    let frames = 0;
    while (out.state === 'active' && frames < 60 * 5) {
        out = agent.update(DT);
        frames++;
    }
    assert.equal(out.state, 'failed');
    assert.equal(out.failure, 'STUCK');
});

test('超时反射：目标超时判失败', () => {
    const { scene } = simScene();
    const agent = new EmbodiedAgent(scene, { config: { defaultTimeout: 0.3, stuckSeconds: 999 } });
    agent.setGoal({ position: { east: 5000, north: 0, up: 0 }, tolerance: 2 });
    let out = agent.update(DT);
    let frames = 0;
    while (out.state === 'active' && frames < 60 * 3) {
        out = agent.update(DT);
        frames++;
    }
    assert.equal(out.state, 'failed');
    assert.equal(out.failure, 'TIMEOUT');
});

test('活动边界：走出半径判失败', () => {
    const pose: Pose = { east: 0, north: 0, up: 0, yaw: 0, flying: false, onGround: true };
    const scene: SceneAdapter = {
        getPose: () => ({ ...pose }),
        groundHeightAt: () => 0,
        resolveReference: () => null,
    };
    const agent = new EmbodiedAgent(scene, { config: { boundsRadius: 100 } });
    agent.setGoal({ position: { east: 50, north: 0, up: 0 }, tolerance: 2 });
    agent.update(DT);
    // 把人物挪到边界外
    pose.east = 150;
    const out = agent.update(DT);
    assert.equal(out.state, 'failed');
    assert.equal(out.failure, 'OUT_OF_BOUNDS');
});

// ==================== 抢占与取消 ====================

test('抢占：新目标直接替换旧目标', () => {
    const { scene } = simScene();
    const agent = new EmbodiedAgent(scene);
    agent.setGoal({ position: { east: 100, north: 0, up: 0 }, tolerance: 2, label: 'A' });
    agent.setGoal({ position: { east: 0, north: 100, up: 0 }, tolerance: 2, label: 'B' });
    const out = agent.update(DT);
    assert.equal(out.goal?.label, 'B');
    assert.ok(out.movement.north > 0, '应朝新目标（北）移动');
});

test('取消：清空目标并停住', () => {
    const { scene } = simScene();
    const agent = new EmbodiedAgent(scene);
    agent.setGoal({ position: { east: 100, north: 0, up: 0 }, tolerance: 2 });
    agent.update(DT);
    agent.cancel();
    assert.equal(agent.currentState, 'cancelled');
    assert.equal(agent.currentGoal, null);
});

test('到达后不再移动', () => {
    const { scene, step } = simScene();
    const agent = new EmbodiedAgent(scene);
    agent.setGoal({ position: { east: 10, north: 0, up: 0 }, tolerance: 2 });
    let out = agent.update(DT);
    let frames = 0;
    while (out.state === 'active' && frames < 60 * 30) {
        step(out.movement);
        out = agent.update(DT);
        frames++;
    }
    assert.equal(out.state, 'arrived');
    // 再跑几帧，应保持静止
    for (let i = 0; i < 10; i++) {
        const o = agent.update(DT);
        assert.equal(o.movement.speedMetersPerSecond, 0);
    }
});

// ==================== 空转安全 ====================

test('没有目标时输出静止，不抛错', () => {
    const { scene } = simScene();
    const agent = new EmbodiedAgent(scene);
    const out = agent.update(DT);
    assert.equal(out.state, 'idle');
    assert.equal(out.movement.speedMetersPerSecond, 0);
    assert.equal(out.goal, null);
});
