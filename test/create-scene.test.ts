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
    function advance(_dt: number, _speed: number) {
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
    const { adapter, pose } = fakeScene();
    const { player, getMove } = fakePlayer();
    const scene = createEmbodiedScene({ adapter, player: player as never, log: () => {} });

    scene.handleCommand('去3号风机');
    assert.equal(scene.agent.currentState, 'active');
    assert.equal(scene.agent.currentGoal?.position.east, 100);

    // 初始朝北（yaw=0），目标正东 —— 偏 90°，正好在 turnFirstAngle 上。
    // 第一帧应该是「站定转身」，不是横着滑出去。
    scene.tick(0.016);
    const first = getMove();
    assert.ok(first);
    assert.equal(first!.speedMetersPerSecond, 0, '偏离 90° 应先转身');
    assert.ok(first!.east > 0.9, '但方向指令已经指向东，转身要朝这边转');

    // 转到位之后（0.5s ≈ 31 帧）才开始移动
    pose.yaw = Math.PI / 2; // 模拟转向完成
    scene.tick(0.016);
    const move = getMove();
    assert.ok(move!.speedMetersPerSecond > 0, '转完身应该有速度');
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

// ==================== 多步任务编排 ====================

/** 一个能真正走起来的场景：每 tick 把人物朝目标推进。 */
function walkingScene() {
    const pose: Pose = { east: 0, north: 0, up: 0, yaw: 0, flying: false, onGround: true };
    const places: Record<string, Vec3> = {
        'A点': { east: 30, north: 0, up: 0 },
        'B点': { east: 0, north: 30, up: 0 },
        'C点': { east: -30, north: 0, up: 0 },
    };
    const adapter: SceneAdapter = {
        getPose: () => ({ ...pose }),
        groundHeightAt: () => 0,
        resolveReference: (text: string) => {
            for (const [name, at] of Object.entries(places)) {
                if (text.includes(name)) return at;
            }
            return null;
        },
        listReferences: () => Object.entries(places).map(([name, at]) => ({ name, at })),
    };
    /** 把人物朝当前目标推进一步，模拟物理。 */
    function step(speed = 5, dt = 0.2) {
        const scene = holder.scene;
        const goal = scene?.agent.currentGoal;
        if (!goal) return;
        const dx = goal.position.east - pose.east;
        const dy = goal.position.north - pose.north;
        const d = Math.hypot(dx, dy);
        if (d < 1e-6) return;
        const move = Math.min(speed * dt, d);
        pose.east += (dx / d) * move;
        pose.north += (dy / d) * move;
        pose.yaw = Math.atan2(dx, dy);
    }
    const holder: { scene?: ReturnType<typeof createEmbodiedScene> } = {};
    return { pose, adapter, step, holder, places };
}

test('「先去A点，再去B点」逐步执行', async () => {
    const { adapter, step, holder } = walkingScene();
    const logs: string[] = [];
    const scene = createEmbodiedScene({ adapter, log: l => logs.push(l), intent: { llm: false } });
    holder.scene = scene;

    await scene.handleCommandAsync('先去A点，再去B点');
    assert.ok(logs.some(l => l.includes('拆成 2 步')), logs.join('\n'));
    assert.equal(scene.tasks.total, 2);
    assert.equal(scene.tasks.isRunning, true);

    // 走到 A 点
    for (let i = 0; i < 200 && scene.agent.currentGoal?.position.north !== 30; i++) {
        step();
        scene.tick(0.2);
    }
    // 到达 A 的那一帧队列立刻切到 B，所以 currentState 已经是 active 了。
    // 这是设计意图：两步之间不该停一帧。
    assert.equal(scene.agent.currentGoal?.position.north, 30, '应已切到 B 点');
    assert.ok(scene.tasks.isRunning, '还有第二步，队列不该结束');

    // 走到 B 点
    for (let i = 0; i < 200 && scene.tasks.isRunning; i++) {
        step();
        scene.tick(0.2);
    }
    assert.equal(scene.tasks.isRunning, false);
    assert.ok(logs.some(l => l.includes('任务完成')), logs.join('\n'));
});

test('多步任务中喊停会中止队列', async () => {
    const { adapter, holder } = walkingScene();
    const scene = createEmbodiedScene({ adapter, log: () => {}, intent: { llm: false } });
    holder.scene = scene;

    await scene.handleCommandAsync('先去A点，再去B点');
    assert.equal(scene.tasks.isRunning, true);

    scene.handleCommand('停');
    assert.equal(scene.tasks.isRunning, false);
    assert.equal(scene.agent.currentState, 'cancelled');
});

test('多步任务里有一步听不懂 → 整条不执行', async () => {
    const { adapter, holder } = walkingScene();
    const logs: string[] = [];
    const scene = createEmbodiedScene({ adapter, log: l => logs.push(l), intent: { llm: false } });
    holder.scene = scene;

    await scene.handleCommandAsync('先去A点，再去看极光');
    assert.equal(scene.tasks.isRunning, false, '有一步听不懂就不该开始');
    assert.equal(scene.agent.currentState, 'idle');
    assert.ok(logs.some(l => l.includes('没听懂')), logs.join('\n'));
});

test('单步句子不进队列', async () => {
    const { adapter, holder } = walkingScene();
    const scene = createEmbodiedScene({ adapter, log: () => {}, intent: { llm: false } });
    holder.scene = scene;

    await scene.handleCommandAsync('去A点');
    assert.equal(scene.tasks.isRunning, false);
    assert.equal(scene.tasks.total, 0);
    assert.equal(scene.agent.currentState, 'active');
});

test('非移动类步骤被拒绝', async () => {
    const { adapter, holder } = walkingScene();
    const logs: string[] = [];
    const scene = createEmbodiedScene({ adapter, log: l => logs.push(l), intent: { llm: false } });
    holder.scene = scene;

    await scene.handleCommandAsync('先去A点，再跑起来');
    assert.equal(scene.tasks.isRunning, false);
    assert.ok(logs.some(l => l.includes('只支持移动类步骤')), logs.join('\n'));
});

// ==================== 帧回调容错 ====================
//
// tick() 跑在调用方的渲染循环里。任何异常如果漏出去，整个场景就停了。
// Cesium 在 tileset 加载完成之前，getPose() 抛异常或返回垃圾值是常态，
// 所以「跳过这一帧、继续下一帧」必须是默认行为。

test('场景适配器抛异常时跳过本帧，不中断循环', () => {
    let boom = false;
    const pose: Pose = { east: 0, north: 0, up: 0, yaw: 0, flying: false, onGround: true };
    const adapter: SceneAdapter = {
        getPose: () => {
            if (boom) throw new Error('tileset 还没加载完');
            return { ...pose };
        },
        groundHeightAt: () => 0,
        resolveReference: (t: string) => (t.includes('风机') ? { east: 100, north: 0, up: 0 } : null),
    };
    const { player } = fakePlayer();
    const logs: string[] = [];
    const scene = createEmbodiedScene({ adapter, player: player as never, log: l => logs.push(l) });

    scene.handleCommand('去3号风机');
    scene.tick(0.016);

    boom = true;
    assert.doesNotThrow(() => scene.tick(0.016), '单帧异常不能漏出渲染循环');

    boom = false;
    assert.doesNotThrow(() => scene.tick(0.016), '恢复后应继续正常工作');
    assert.ok(logs.some(l => l.includes('tick 异常')), logs.join('\n'));
});

test('同一个异常连续出现只报一次', () => {
    const adapter: SceneAdapter = {
        getPose: () => { throw new Error('同一个错'); },
        groundHeightAt: () => 0,
        resolveReference: () => null,
    };
    const logs: string[] = [];
    const scene = createEmbodiedScene({ adapter, log: l => logs.push(l) });
    scene.handleCommand('去3号风机');

    for (let i = 0; i < 10; i++) scene.tick(0.016);
    const warnings = logs.filter(l => l.includes('tick 异常'));
    assert.equal(warnings.length, 1, '每帧刷屏会把控制台冲掉');
});

// state() 是 UI 的唯一数据来源（悬浮球、日志面板都读它）。
// 早先这里 distance 写死 null、speed 写死 0，界面上就永远只有「状态 active」——
// 功能没坏，但用户看不到「还差多远」，会以为没动。
test('state() 返回真实的距离与速度', () => {
    const { adapter, pose } = fakeScene();
    const { player } = fakePlayer();
    const scene = createEmbodiedScene({ adapter, player: player as never, log: () => {} });

    assert.equal(scene.state().distance, null, '没目标时距离应为 null，而不是 0');

    scene.handleCommand('去3号风机');
    scene.tick(0.016);
    const started = scene.state();
    assert.equal(started.goalState, 'active');
    assert.equal(started.distance, 100, '目标在正东 100 米');

    // 走一段：距离必须跟着变小，速度必须非零
    pose.east = 40;
    pose.yaw = Math.PI / 2;
    for (let i = 0; i < 30; i++) scene.tick(0.016);
    const moving = scene.state();
    assert.equal(moving.distance, 60, '人物前进 40 米，剩余距离应同步变小');
    assert.ok(moving.speed > 0, `行进中速度应大于 0，实际 ${moving.speed}`);

    scene.handleCommand('停');
    scene.tick(0.016);
    const stopped = scene.state();
    assert.equal(stopped.distance, null);
    assert.equal(stopped.speed, 0);
});
