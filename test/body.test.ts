// body 层的测试 —— 重点是「动画和位移对上了没有」。
//
// 这一层最容易出的 bug 是：动画选了、倍速也设了，但只在第一帧生效，
// 之后 speed 变了却没人再调 —— 表现就是「越走越滑」。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyOutput, releaseBody, resolveBody, type BodyLike } from '../src/body.ts';
import type { AgentOutput, MovementCommand } from '../src/types.ts';
import type { LocomotionProfile } from '../src/locomotion.ts';

const PROFILE: LocomotionProfile = {
    idle: 'Idle_Loop',
    clips: [
        { name: 'Walk_Loop', naturalSpeed: 1.065 },
        { name: 'Jog_Fwd_Loop', naturalSpeed: 2.882 },
        { name: 'Sprint_Loop', naturalSpeed: 3.621 },
    ],
};

function fakeBody() {
    const calls: Array<{ kind: string; value: unknown }> = [];
    let movement: unknown = 'unset';
    const body: BodyLike = {
        setWorldMovement(input) { movement = input; calls.push({ kind: 'move', value: input }); },
        setScriptedYaw(yaw) { calls.push({ kind: 'yaw', value: yaw }); },
        setInput(input) { calls.push({ kind: 'input', value: input }); },
        playPlayerAnimationByClipName(name) { calls.push({ kind: "clip", value: name }); },
        setPlayerAnimationTimeScale(scale) { calls.push({ kind: 'timeScale', value: scale }); },
    };
    return { body, calls, getMovement: () => movement as MovementCommand | null };
}

function output(speed: number, state: AgentOutput['state'] = 'active'): AgentOutput {
    return {
        movement: { east: 1, north: 0, up: 0, run: speed > 5, speedMetersPerSecond: speed },
        yaw: 0,
        state,
        justArrived: false,
        failure: null,
        goal: null,
        distance: 100,
    };
}

const clips = (c: Array<{ kind: string; value: unknown }>) => c.filter(x => x.kind === 'clip').map(x => x.value);
const scales = (c: Array<{ kind: string; value: unknown }>) => c.filter(x => x.kind === 'timeScale').map(x => x.value);

test('没有 locomotion 配置时退回按键轴驱动（老行为）', () => {
    const { body, calls } = fakeBody();
    applyOutput(body, output(3.2));
    assert.equal(clips(calls).length, 0, '没配置就不该碰动画');
    assert.ok(calls.some(c => c.kind === 'input' && (c.value as { moveY: number }).moveY === 1));
});

test('有 locomotion 配置时按速度选 clip 并设倍速', () => {
    const { body, calls } = fakeBody();
    applyOutput(body, output(3.2), { locomotion: PROFILE });
    assert.deepEqual(clips(calls), ['Jog_Fwd_Loop']);
    const s = scales(calls);
    assert.equal(s.length, 1);
    assert.ok(Math.abs((s[0] as number) - 3.2 / 2.882) < 1e-9);
});

test('速度变化超过 5% 时重新下发倍速', () => {
    const { body, calls } = fakeBody();
    applyOutput(body, output(3.2), { locomotion: PROFILE }); // Jog 1.11x
    applyOutput(body, output(3.5), { locomotion: PROFILE }); // 仍在 Jog，1.21x（+9%）
    assert.deepEqual(clips(calls), ['Jog_Fwd_Loop'], '同一个 clip 不该重复 playByName');
    assert.equal(scales(calls).length, 2, '倍速应该更新');
});

test('速度变化小于 5% 时不重复下发（避免每帧重建动画）', () => {
    const { body, calls } = fakeBody();
    applyOutput(body, output(3.2), { locomotion: PROFILE });
    applyOutput(body, output(3.21), { locomotion: PROFILE }); // +0.3%
    assert.equal(scales(calls).length, 1, '微小变化应该跳过');
});

test('4% 变化也跳过：加速阶段每帧都会涨一点，不能每帧重建', () => {
    // 12 m/s² 加速、60fps → 每帧 +0.2 m/s。3.2→3.33 是 +4%，
    // 若按 1% 阈值判定，加速那半秒里几乎每帧都重建 runtime。
    const { body, calls } = fakeBody();
    applyOutput(body, output(3.2), { locomotion: PROFILE });
    applyOutput(body, output(3.33), { locomotion: PROFILE }); // +4%
    assert.equal(scales(calls).length, 1, '4% 变化应该跳过');
});

test('跨 clip 时切换动画', () => {
    const { body, calls } = fakeBody();
    applyOutput(body, output(3.2), { locomotion: PROFILE }); // Jog
    applyOutput(body, output(6.5), { locomotion: PROFILE }); // Sprint
    assert.deepEqual(clips(calls), ['Jog_Fwd_Loop', 'Sprint_Loop']);
});

test('停下时切回 idle', () => {
    const { body, calls } = fakeBody();
    applyOutput(body, output(3.2), { locomotion: PROFILE });
    applyOutput(body, output(0), { locomotion: PROFILE });
    assert.deepEqual(clips(calls), ['Jog_Fwd_Loop', 'Idle_Loop']);
});

test('交还控制权时把倍速还原成 1', () => {
    // 否则用户接手键鼠后会继承我们的 1.8 倍速，脚步快得像快进
    const { body, calls } = fakeBody();
    applyOutput(body, output(6.5), { locomotion: PROFILE });
    applyOutput(body, output(0, 'idle'), { locomotion: PROFILE });
    const s = scales(calls);
    assert.equal(s.at(-1), 1, '交接时应还原倍速');
});

test('releaseBody 也会还原倍速并清掉动画状态', () => {
    const { body, calls } = fakeBody();
    applyOutput(body, output(6.5), { locomotion: PROFILE });
    releaseBody(body);
    assert.equal(scales(calls).at(-1), 1);
    // 必须解锁动画选择，否则用户接手后画面还卡在我们的 Sprint 上
    assert.equal(clips(calls).at(-1), null, '交接时应解锁动画');
    // 重新接管时应该重新下发 clip，而不是以为还在播 Sprint
    applyOutput(body, output(3.2), { locomotion: PROFILE });
    assert.equal(clips(calls).at(-1), 'Jog_Fwd_Loop');
});

test('交出控制权时解锁动画，接管时重新锁定', () => {
    const { body, calls } = fakeBody();
    applyOutput(body, output(3.2), { locomotion: PROFILE });
    applyOutput(body, output(0, 'idle'), { locomotion: PROFILE }); // 到达后自动交还
    assert.equal(clips(calls).at(-1), null, '交还控制权时应解锁');
});

test('引擎没实现动画方法时不崩', () => {
    // 只实现最小 BodyLike 的引擎（比如纯 Node 测试替身）
    const minimal: BodyLike = { setWorldMovement() {} };
    assert.doesNotThrow(() => applyOutput(minimal, output(3.2), { locomotion: PROFILE }));
});

// ==================== 引擎没有 setWorldMovement ====================
//
// 实测来源：wind demo 在真实浏览器里每帧抛
// `setWorldMovement is not a function`，被 tick 的 try/catch 吞掉，
// 表现是「人物站着不动、日志只报一次」。
//
// 根因：setWorldMovement 是本包自己定义的接口，不是所有引擎都有。
// cesium-player-controller 的 94 个方法里就没有 —— 它只接受按键轴。

test('引擎只有 setInput 时，用按键轴驱动而不是抛异常', () => {
    const inputs: Array<{ moveX?: number; moveY?: number; shift?: boolean }> = [];
    // 关键：故意不实现 setWorldMovement
    const body: BodyLike = {
        setInput(input) { inputs.push(input); },
    };
    assert.doesNotThrow(() => applyOutput(body, output(3.2), { locomotion: PROFILE }));
    const last = inputs.at(-1);
    assert.ok(last, '应当喂了按键轴');
    assert.equal(last!.moveY, 1, '有速度时前进轴应为 1');
});

test('只有 setInput 的引擎，停下时前进轴归零', () => {
    const inputs: Array<{ moveX?: number; moveY?: number; shift?: boolean }> = [];
    const body: BodyLike = { setInput(input) { inputs.push(input); } };
    applyOutput(body, output(3.2), { locomotion: PROFILE });
    applyOutput(body, output(0, 'idle'), { locomotion: PROFILE });
    assert.equal(inputs.at(-1)?.moveY, 0, '停下后前进轴必须归零，否则人物一直走');
});

test('配了 locomotion 也要喂按键轴（这是 wind demo 的实际组合）', () => {
    // 之前只在「没配 locomotion」时才 setInput，于是 wind demo
    // 两条路都没走通：setWorldMovement 不存在抛异常，setInput 又没被调用。
    const inputs: unknown[] = [];
    const body: BodyLike = { setInput(input) { inputs.push(input); } };
    applyOutput(body, output(3.2), { locomotion: PROFILE });
    assert.ok(inputs.length > 0, '配了 locomotion 的引擎仍然需要按键轴来产生位移');
});

test('有 setWorldMovement 时不重复喂按键轴（避免两条驱动打架）', () => {
    const { body, calls } = fakeBody();
    applyOutput(body, output(3.2), { locomotion: PROFILE });
    // fakeBody 同时实现了两个方法；有 setWorldMovement 时只走它。
    assert.equal(calls.filter(c => c.kind === 'input').length, 0);
});

// ==================== resolveBody：名字对不上的适配 ====================
//
// 这一组守的是「接口名和引擎实际方法名不一致」导致的静默失败。
// 所有调用都带 `?.`，名字对不上不会报错，只会让功能不生效 ——
// 实测 wind demo 因此在真实浏览器里：人物不动、动起来走反方向、动画一直 idle。

test('resolveBody：playPlayerAnimationByName 被适配成 playPlayerAnimationByClipName', () => {
    const played: string[] = [];
    const engine = {
        playPlayerAnimationByName(n: string) { played.push(n); },
    };
    const body = resolveBody(engine);
    body.playPlayerAnimationByClipName?.('Walk_Loop');
    assert.deepEqual(played, ['Walk_Loop']);
});

test('resolveBody：传 null 时交还按键驱动，而不是播一个叫 null 的动画', () => {
    let pressed = 0;
    const engine = {
        playPlayerAnimationByName() {},
        setAnimationByPressed() { pressed++; },
    };
    const body = resolveBody(engine);
    body.playPlayerAnimationByClipName?.(null);
    assert.equal(pressed, 1);
});

test('resolveBody：setScriptedYaw 改的是相机方位角，不是 player.yaw', () => {
    // 引擎的位移方向由 getCameraYaw() 决定（读源码 updatePlayer 确认）：
    //   dirE = moveY * sin(camYaw) + moveX * cos(camYaw)
    // 只改 player.yaw 的话，人物朝向对了但走的方向还是错的。
    // 实测症状：yaw 从 -1.57 转到 2.65，距目标却从 425 m 涨到 458 m。
    const cam = { theta: 0 };
    const engine = { cam, getCameraYaw: () => cam.theta - Math.PI };
    const body = resolveBody(engine);
    body.setScriptedYaw?.(1.0);
    assert.ok(Math.abs(cam.theta - (1.0 + Math.PI)) < 1e-9, `theta 应为 yaw+π，实际 ${cam.theta}`);
});

test('resolveBody：调用引擎方法时保留 this（解构会丢 this）', () => {
    // 实测踩到：const getYaw = body.getYaw; getYaw() 会抛
    // `Cannot read properties of undefined (reading 'yaw')`，
    // 而这个错被 try/catch 吞掉，表现为「人物朝反方向走」。
    const cam = { theta: 0.5 };
    const engine = {
        cam,
        state: { yaw: 0.5 },
        getCameraYaw() { return this.state.yaw; },
    };
    const body = resolveBody(engine);
    assert.doesNotThrow(() => body.setScriptedYaw?.(1.0));
    assert.ok(Math.abs(cam.theta - (1.0 + Math.PI)) < 1e-9);
});

test('resolveBody 是幂等的：已经是 BodyLike 的对象不被改写', () => {
    const existing = {
        setWorldMovement() {},
        setScriptedYaw() {},
        playPlayerAnimationByClipName() {},
    };
    const body = resolveBody(existing);
    assert.equal(body, existing);
});
