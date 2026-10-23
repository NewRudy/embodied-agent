// 一站式装配的测试 —— 证明「调一次就有人物能听话」。
//
// 用假的 SceneAdapter 和假的 PlayerLike，不依赖 Cesium。
// 这里验证的是装配逻辑：意图 → 目标 → 运动量 → 施加，以及语音事件如何驱动它。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEmbodiedScene } from '../src/create-scene.ts';
import type { Pose, SceneAdapter, Vec3 } from '../src/types.ts';

/** 一个会随目标移动的假场景。 */
function fakeScene(start: Vec3 = { east: 0, north: 0, up: 0 }) {
    const pose: Pose = { ...start, yaw: 0, flying: false, onGround: true };
    const adapter: SceneAdapter = {
        getPose: () => ({ ...pose }),
        groundHeightAt: () => 0,
        resolveReference: (text: string) => (text.includes('风机') ? { east: 100, north: 0, up: 0 } : null),
    };
    /** 把人物往目标推进一点，模拟物理。 */
    function advance(dt: number, speed: number) {
        const goal = (adapter as unknown as { _goal?: Vec3 })._goal;
        void goal;
        return { pose, advance };
    }
    return { pose, adapter, advance };
}

function fakePlayer() {
    const calls: string[] = [];
    let lastMove: { east: number; north: number; speedMetersPerSecond: number } | null = null;
    const player = {
        posEcef: {} as never,
        isFlying: false,
        playerIsOnGround: true,
        setWorldMovement(input: { east: number; north: number; speedMetersPerSecond?: number } | null) {
            lastMove = input ? { east: input.east, north: input.north, speedMetersPerSecond: input.speedMetersPerSecond ?? 0 } : null;
        },
        setScriptedYaw() { calls.push('yaw'); },
        setFlightMode() { calls.push('fly'); },
        getGroundClearanceMeters: () => 0,
        setInput(input: { moveY?: number }) { calls.push(`input:${input.moveY}`); },
        stopHorizontalMotion() { calls.push('stop'); },
        viewer: { scene: { globe: { getHeight: () => undefined } } },
    };
    return { player, calls, getMove: () => lastMove };
}

test('说「去3号风机」后开始朝目标移动', () => {
    const { adapter } = fakeScene();
    const { player, getMove } = fakePlayer();
    const scene = createEmbodiedScene({ adapter, player: player as never, log: () => {} });

    scene.handleCommand('去3号风机');
    assert.equal(scene.agent.currentState, 'active');
    assert.equal(scene.agent.currentGoal?.position.east, 100);

    scene.tick(0.016);
    const move = getMove();
    assert.ok(move);
    assert.ok(move!.speedMetersPerSecond > 0, '应该有速度');
    assert.ok(move!.east > 0.9, '应该朝东走');
});

test('说「停」后目标被取消，运动归零', () => {
    const { adapter } = fakeScene();
    const { player, getMove } = fakePlayer();
    const scene = createEmbodiedScene({ adapter, player: player as never, log: () => {} });

    scene.handleCommand('去3号风机');
    scene.tick(0.016);
    scene.handleCommand('停');
    assert.equal(scene.agent.currentState, 'cancelled');

    scene.tick(0.016);
    // 交还控制权时 worldMovement 置 null
    assert.equal(getMove(), null);
});

test('没听懂时不瞎猜，目标不变', () => {
    const { adapter } = fakeScene();
    const { player } = fakePlayer();
    const logs: string[] = [];
    const scene = createEmbodiedScene({ adapter, player: player as never, log: l => logs.push(l) });

    scene.handleCommand('去3号风机');
    const before = scene.agent.currentGoal;
    scene.handleCommand('今天天气不错');
    assert.deepEqual(scene.agent.currentGoal, before);
    assert.ok(logs.some(l => l.includes('没听懂')));
});

test('到达后状态变为 arrived', () => {
    const { adapter, pose } = fakeScene();
    const { player } = fakePlayer();
    const scene = createEmbodiedScene({ adapter, player: player as never, log: () => {} });

    scene.handleCommand('去3号风机');
    // 直接把人物挪到目标附近
    pose.east = 99;
    scene.tick(0.016);
    assert.equal(scene.agent.currentState, 'arrived');
});

test('没有 voice 配置时 voice 为 null，文字照常工作', () => {
    const { adapter } = fakeScene();
    const { player } = fakePlayer();
    const scene = createEmbodiedScene({ adapter, player: player as never, log: () => {} });
    assert.equal(scene.voice, null);
    scene.handleCommand('去3号风机');
    assert.equal(scene.agent.currentState, 'active');
});

test('状态回调只在变化时触发', () => {
    const { adapter } = fakeScene();
    const { player } = fakePlayer();
    const states: string[] = [];
    const scene = createEmbodiedScene({
        adapter,
        player: player as never,
        log: () => {},
        onState: s => states.push(s.goalState),
    });
    scene.tick(0.016);
    scene.tick(0.016);
    // idle 只报一次
    assert.deepEqual(states, ['idle']);
});

test('dispose 后不再驱动人物', () => {
    const { adapter } = fakeScene();
    const { player, getMove } = fakePlayer();
    const scene = createEmbodiedScene({ adapter, player: player as never, log: () => {} });
    scene.handleCommand('去3号风机');
    scene.dispose();
    assert.equal(scene.agent.currentState, 'idle');
    assert.equal(getMove(), null);
    const before = getMove();
    scene.tick(0.016);
    assert.equal(getMove(), before, 'dispose 后 tick 不应再写 movement');
});
