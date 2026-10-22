// 意图层测试 —— 纯文本解析，不依赖场景。
//
// 这些测试固定「规则解析器现在能听懂什么」。
// 接 Jev/Laya 之后，同一批用例应全部仍然通过（模型是补充，不是替换）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseIntent, type ParseContext } from '../src/intent.ts';
import type { Goal, Vec3 } from '../src/types.ts';

function ctx(overrides: Partial<ParseContext> = {}): ParseContext {
    return {
        pose: { east: 0, north: 0, yaw: 0 },   // 朝北
        goal: null,
        resolve: () => null,
        defaultStep: 10,
        ...overrides,
    };
}

const near = (a: Vec3, b: Vec3, eps = 0.5) =>
    Math.abs(a.east - b.east) < eps && Math.abs(a.north - b.north) < eps;

// ==================== 停止 ====================

test('停止：多种说法都能识别', () => {
    for (const t of ['停', '停下', '停止', '别动', '站住', '等一下', '暂停']) {
        const r = parseIntent(t, ctx());
        assert.equal(r?.action, 'stop', `「${t}」未识别为停止`);
    }
});

// ==================== 方向移动 ====================

test('往前走：默认 10 米，朝北', () => {
    const r = parseIntent('往前走', ctx());
    assert.equal(r?.action, 'go');
    assert.ok(near(r!.position!, { east: 0, north: 10, up: 0 }), JSON.stringify(r!.position));
});

test('往前走 20 米：按数字走', () => {
    const r = parseIntent('往前走20米', ctx());
    assert.ok(near(r!.position!, { east: 0, north: 20, up: 0 }));
});

test('后退 5 米：朝南', () => {
    const r = parseIntent('后退5米', ctx());
    assert.ok(near(r!.position!, { east: 0, north: -5, up: 0 }), JSON.stringify(r!.position));
});

test('往左走：朝西（朝北时左是西）', () => {
    const r = parseIntent('往左走 8 米', ctx());
    assert.ok(near(r!.position!, { east: -8, north: 0, up: 0 }), JSON.stringify(r!.position));
});

test('往右走：朝东', () => {
    const r = parseIntent('往右走 8 米', ctx());
    assert.ok(near(r!.position!, { east: 8, north: 0, up: 0 }), JSON.stringify(r!.position));
});

test('转向后方向跟着变：朝东时「往前」= 向东', () => {
    const r = parseIntent('往前走 10 米', ctx({ pose: { east: 0, north: 0, yaw: Math.PI / 2 } }));
    assert.ok(near(r!.position!, { east: 10, north: 0, up: 0 }), JSON.stringify(r!.position));
});

// ==================== 参照物 ====================

test('参照物优先于方位词', () => {
    const turbine: Vec3 = { east: 100, north: 200, up: 0 };
    const r = parseIntent('去3号风机', ctx({ resolve: (t) => (t.includes('3号风机') ? turbine : null) }));
    assert.equal(r?.action, 'go');
    assert.ok(near(r!.position!, turbine));
    assert.equal(r?.rule, 'go-reference');
});

test('参照物解析失败时退回方位解析', () => {
    const r = parseIntent('往前走', ctx({ resolve: () => null }));
    assert.equal(r?.action, 'go');
});

// ==================== 中途修正 ====================

test('没有活动目标时，「往左一点」不算修正', () => {
    const r = parseIntent('往左一点', ctx({ goal: null }));
    assert.notEqual(r?.action, 'revise');
});

test('有活动目标时，「往左一点」是修正而不是新目标', () => {
    const goal: Goal = { position: { east: 100, north: 0, up: 0 }, tolerance: 3 };
    const r = parseIntent('往左一点', ctx({ goal }));
    assert.equal(r?.action, 'revise', '应判为修正');
    // 朝北时「左」= 西 = east 减小；修正相对当前目标偏移，幅度 3 米
    assert.ok(Math.abs(r!.position!.east - (100 - 3)) < 0.01, `east 应为 97，实际 ${r!.position!.east}`);
    assert.ok(Math.abs(r!.position!.north - 0) < 0.01, `north 应不变，实际 ${r!.position!.north}`);
});

test('修正不会把目标拽到人物脚下', () => {
    const goal: Goal = { position: { east: 300, north: 300, up: 0 }, tolerance: 3 };
    const r = parseIntent('往左一点', ctx({ goal, pose: { east: 0, north: 0, yaw: 0 } }));
    const d = Math.hypot(r!.position!.east - goal.position.east, r!.position!.north - goal.position.north);
    assert.ok(d < 10, `修正偏移应很小，实际 ${d}`);
    assert.ok(Math.hypot(r!.position!.east, r!.position!.north) > 100, '目标应仍远离人物');
});

test('「再近一点」把目标往当前朝向推', () => {
    const goal: Goal = { position: { east: 100, north: 0, up: 0 }, tolerance: 3 };
    const r = parseIntent('再近一点', ctx({ goal, pose: { east: 0, north: 0, yaw: Math.PI / 2 } }));
    assert.equal(r?.action, 'revise');
    assert.ok(r!.position!.east > 0, '应向前（东）推进');
});

// ==================== 转向 ====================

test('左转 45 度：负角度', () => {
    const r = parseIntent('左转45度', ctx());
    assert.equal(r?.action, 'turn');
    assert.ok(Math.abs(r!.yawDelta! + Math.PI / 4) < 1e-6);
});

test('右转：正角度', () => {
    const r = parseIntent('右转', ctx());
    assert.equal(r?.action, 'turn');
    assert.ok(Math.abs(r!.yawDelta! - Math.PI / 2) < 1e-6, '默认 90 度');
});

// ==================== 快慢与飞行 ====================

test('快慢切换', () => {
    assert.equal(parseIntent('跑起来', ctx())?.pace, 'run');
    assert.equal(parseIntent('慢点', ctx())?.pace, 'walk');
});

test('飞行开关', () => {
    assert.equal(parseIntent('起飞', ctx())?.fly, true);
    assert.equal(parseIntent('降落', ctx())?.fly, false);
});

// ==================== 边界 ====================

test('听不懂时返回 null，不瞎猜', () => {
    for (const t of ['今天天气怎么样', '你是谁', '这个系统用了什么技术', '']) {
        assert.equal(parseIntent(t, ctx()), null, `「${t}」不应被解析成动作`);
    }
});

test('「停下」不会被当成「往下」', () => {
    const r = parseIntent('停下', ctx());
    assert.equal(r?.action, 'stop');
});
