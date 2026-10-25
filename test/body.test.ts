// body 层的测试 —— 重点是「动画和位移对上了没有」。
//
// 这一层最容易出的 bug 是：动画选了、倍速也设了，但只在第一帧生效，
// 之后 speed 变了却没人再调 —— 表现就是「越走越滑」。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyOutput, releaseBody, type BodyLike } from '../src/body.ts';
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
