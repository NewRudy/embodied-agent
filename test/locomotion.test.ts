// 动画速度匹配的测试。
//
// 这里钉的是「脚不打滑」的数学：给定速度和一组 clip 的自然速度，
// 选哪个、播多快，必须是确定的。
//
// 不能证明的是「看起来像不像在走」—— 那要人眼看。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { locomotionFor, isSpeedOutOfRange, type LocomotionProfile } from '../src/locomotion.ts';

// 实测自 public/xunjie-assets/glb/UAL1_Standard.glb
// （node tools/measure-stride.ts ... --height-meters=1.8）
const PROFILE: LocomotionProfile = {
    idle: 'Idle_Loop',
    clips: [
        { name: 'Walk_Loop', naturalSpeed: 1.065 },
        { name: 'Jog_Fwd_Loop', naturalSpeed: 2.882 },
        { name: 'Sprint_Loop', naturalSpeed: 3.621 },
    ],
};

test('静止时播 idle，倍速 1', () => {
    const s = locomotionFor(0, PROFILE);
    assert.equal(s.clip, 'Idle_Loop');
    assert.equal(s.moving, false);
    assert.equal(s.timeScale, 1);
});

test('低于阈值的小速度也当静止', () => {
    // 0.1 m/s 是「几乎没动」，播走路动画反而怪
    assert.equal(locomotionFor(0.1, PROFILE).moving, false);
    assert.equal(locomotionFor(0.1, PROFILE).clip, 'Idle_Loop');
});

test('走路速度选中 Jog（最接近且不超过），倍速略大于 1', () => {
    // 3.2 m/s：Walk(1.065) 要 3.0 倍速，Jog(2.882) 只要 1.11 倍。
    // 选 Jog —— 轻微加速几乎看不出来，3 倍速的走路一眼就假。
    const s = locomotionFor(3.2, PROFILE);
    assert.equal(s.clip, 'Jog_Fwd_Loop');
    assert.ok(Math.abs(s.timeScale - 3.2 / 2.882) < 1e-9);
    assert.ok(s.timeScale > 1 && s.timeScale < 1.2, '应该只轻微加速');
    assert.equal(s.moving, true);
});

test('跑步速度选中 Sprint，倍速也在合理范围', () => {
    // 6.5 m/s 跑 → Sprint 3.621 → 1.80 倍，在上限内
    const s = locomotionFor(6.5, PROFILE);
    assert.equal(s.clip, 'Sprint_Loop');
    assert.ok(Math.abs(s.timeScale - 6.5 / 3.621) < 1e-9);
});

test('倍速上限 2.0：超出时宁可留一点滑，也不要做成快进', () => {
    // 9 m/s 远超 Sprint 能力 → 倍速 2.49 被夹到 2.0
    const s = locomotionFor(9, PROFILE);
    assert.equal(s.timeScale, 2.0);
});

test('选片规则：挑不超过当前速度的最大 clip', () => {
    // 2.5 m/s：Walk(1.065) 能到，Jog(2.882) 超过 → 选 Walk
    assert.equal(locomotionFor(2.5, PROFILE).clip, 'Walk_Loop');
    // 3.0 m/s：Jog(2.882) 能到 → 选 Jog
    assert.equal(locomotionFor(3.0, PROFILE).clip, 'Jog_Fwd_Loop');
    // 5.0 m/s：Sprint(3.621) 是能到的最大
    assert.equal(locomotionFor(5.0, PROFILE).clip, 'Sprint_Loop');
});

test('低于最慢 clip 的速度仍用最慢 clip，但降到下限倍速', () => {
    // 0.5 m/s 比 Walk 的 1.065 慢 → 倍速 0.47，被夹到下限 0.5
    const s = locomotionFor(0.5, PROFILE);
    assert.equal(s.clip, 'Walk_Loop');
    assert.equal(s.timeScale, 0.5);
});

test('倍速下限 0.5：再慢脚步会像太空步', () => {
    const s = locomotionFor(0.2, PROFILE, { minMovingSpeed: 0.1 });
    assert.equal(s.timeScale, 0.5);
});

test('自然速度正好等于当前速度时倍速为 1', () => {
    const s = locomotionFor(2.882, PROFILE);
    assert.equal(s.clip, 'Jog_Fwd_Loop');
    assert.equal(s.timeScale, 1);
});

test('空 clip 列表不会崩，退回 idle', () => {
    const s = locomotionFor(3, { idle: 'Idle_Loop', clips: [] });
    assert.equal(s.clip, 'Idle_Loop');
    assert.equal(s.moving, false);
});

test('NaN / Infinity 速度不会算出 NaN 倍速', () => {
    for (const bad of [NaN, Infinity, -1]) {
        const s = locomotionFor(bad, PROFILE);
        assert.equal(s.clip, 'Idle_Loop', `速度 ${bad} 应当当静止处理`);
        assert.equal(s.timeScale, 1);
    }
});

test('超出所有 clip 能力时能报出来', () => {
    // Sprint 自然速度 3.621，上限 2.0 → 能覆盖到 7.242
    assert.equal(isSpeedOutOfRange(7.0, PROFILE), false);
    assert.equal(isSpeedOutOfRange(8.0, PROFILE), true);
});

test('自定义倍速上下限生效', () => {
    // 9 m/s 在 Sprint 上要 2.49 倍，放宽到 4 就该用真实值
    const s = locomotionFor(9, PROFILE, { maxTimeScale: 4 });
    assert.ok(Math.abs(s.timeScale - 9 / 3.621) < 1e-9, '放宽上限后应该用真实倍速');
});
