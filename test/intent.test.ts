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

// ==================== 置信度 ====================

test('明确的规则命中给满置信度', () => {
    for (const t of ['停', '去A点', '往前走20米', '往左一点', '跑起来']) {
        const r = parseIntent(t, ctx({ resolve: (x: string) => (x.includes('A点') ? { east: 1, north: 1, up: 0 } : null) }));
        assert.equal(r?.confidence, 1, `「${t}」应是明确指令`);
    }
});

test('含糊指代降置信度，不按字面执行', () => {
    // 这些句子里都有「走」，正则能命中，但用户没说是哪边
    for (const t of ['大概往那边走吧', '随便走走吧', '那边看看']) {
        const r = parseIntent(t, ctx());
        if (r) {
            assert.ok(
                (r.confidence ?? 1) < 0.6,
                `「${t}」不该被当成明确指令，实际置信度 ${r.confidence}`,
            );
        }
    }
});

test('含糊词不影响明确方向', () => {
    // 「往左」本身是明确的，即使带了「大概」
    const r = parseIntent('大概往左一点', ctx({ goal: { position: { east: 10, north: 10, up: 0 }, tolerance: 3 } }));
    assert.equal(r?.action, 'revise');
    assert.equal(r?.confidence, 1, '明确方位不该因为「大概」而降级');
});

test('否定式停止', () => {
    for (const t of ['别走了', '不要过去', '别跑了', '不用往前了']) {
        assert.equal(parseIntent(t, ctx())?.action, 'stop', `「${t}」应识别为停止`);
    }
});

// ==================== 绝对方位 ====================

test('绝对方位与人物朝向无关', () => {
    // 朝东站着说「往北走」，应该往北，不是往东
    const r = parseIntent('往北走10米', ctx({ pose: { east: 0, north: 0, yaw: Math.PI / 2 } }));
    assert.equal(r?.action, 'go');
    assert.ok(near(r!.position!, { east: 0, north: 10, up: 0 }), JSON.stringify(r!.position));
});

test('「往东走二十米」不被「走」兜底成前进', () => {
    // 这是真实踩到的 bug：规则层靠一个「走」字命中，把人往当前朝向送
    const r = parseIntent('往东走二十米', ctx());
    assert.equal(r?.rule, 'go-e', `实际 ${r?.rule}`);
    assert.ok(near(r!.position!, { east: 20, north: 0, up: 0 }), JSON.stringify(r!.position));
});

test('八个方位都对', () => {
    const cases: Array<[string, number, number]> = [
        ['往北走10米', 0, 10],
        ['往东北走10米', 7.07, 7.07],
        ['往东走10米', 10, 0],
        ['往东南走10米', 7.07, -7.07],
        ['往南走10米', 0, -10],
        ['往西南走10米', -7.07, -7.07],
        ['往西走10米', -10, 0],
        ['往西北走10米', -7.07, 7.07],
    ];
    for (const [text, e, n] of cases) {
        const r = parseIntent(text, ctx());
        assert.equal(r?.action, 'go', `「${text}」没解析`);
        assert.ok(near(r!.position!, { east: e, north: n, up: 0 }, 0.1),
            `「${text}」→ ${JSON.stringify(r!.position)}，期望 (${e}, ${n})`);
    }
});

test('方位是定语时降置信度，不当成纯方向', () => {
    // 「去南边的楼」要找的是楼，不是往南挪 10 米
    const r = parseIntent('去南边的楼', ctx());
    assert.ok(r, '应能识别出方位');
    assert.ok((r!.confidence ?? 1) < 0.6, `置信度应低，实际 ${r!.confidence}`);
});

test('「东西」不被当成东', () => {
    // 「把那个东西拿过来」里有个「东」，但那是「东西」
    const r = parseIntent('把那个东西拿过来', ctx());
    assert.equal(r, null, '不该解析成向东走');
});

test('否定式方位移动 → 停止', () => {
    for (const t of ['别往东走', '不要往南去', '甭朝西边走']) {
        assert.equal(parseIntent(t, ctx())?.action, 'stop', `「${t}」应识别为停止`);
    }
});

test('方位后面跟指示词 → 是定语，降置信度', () => {
    // 「带我去南边那个绿点看看」的目标是「绿点」，不是往南挪 10 米
    for (const t of ['带我去南边那个绿点看看', '去东边的塔', '往北边那个门走']) {
        const r = parseIntent(t, ctx());
        assert.ok(r, `「${t}」应能识别`);
        assert.ok((r!.confidence ?? 1) < 0.6, `「${t}」置信度应低，实际 ${r!.confidence}`);
    }
});

test('方位后面直接跟动词 → 是方向，满置信度', () => {
    for (const t of ['往东走三十米', '朝西边走', '向西南走15米', '往北']) {
        const r = parseIntent(t, ctx());
        assert.equal(r?.confidence, 1, `「${t}」应是明确方向`);
    }
});

// ==================== 真人口语（TTS 测不出来的那一类）====================
//
// 之前所有测试都基于 TTS 合成语音，而 TTS 说得**干净**：没有语气词、
// 不重复、不自我修正、不说「你先」「给我」这种客气话。
// 真人的停指令几乎不会只说一个「停」字，所以这一组专门补口语形态。
//
// 这些用例不是想象出来的：是把真人口语清单跑一遍之后，把**实际失败**的挑出来固化。

test('口语停指令：前缀后缀组合不会让它失灵', () => {
    // 前缀和前缀、后缀和后缀是乘法关系，全枚举写不完。
    // 之前用全串相等判定，「停一下」「你先停一下」直接落到 null —— 喊停没反应。
    for (const t of ['停一下', '你先停一下', '先停一下', '马上停', '赶紧停下吧', '快停下来啊', '停一下下']) {
        assert.equal(parseIntent(t, ctx())?.action, 'stop', `「${t}」未识别为停止`);
    }
});

test('「先别走了」必须停止，不能变成出发', () => {
    // 这是最坏的一类错误：前缀「先」把否定词从句首挤开，
    // 否定规则匹配不到，最后被「走」兜底成 go-forward、置信度 1。
    // 用户想停，人物反而动了。实测确认修复前就是这个行为。
    for (const t of ['先别走了', '你先别动', '还是别去了', '别走了']) {
        const r = parseIntent(t, ctx());
        assert.equal(r?.action, 'stop', `「${t}」应该是停止，实际是 ${r?.action ?? 'null'}`);
    }
});

test('叠词停指令：等一下等一下 / 停停停', () => {
    // 真人在着急时会重复。不处理的话前者落到 null，后者是未知词。
    for (const t of ['等一下等一下', '停停停', '等等等等']) {
        assert.equal(parseIntent(t, ctx())?.action, 'stop', `「${t}」未识别为停止`);
    }
});

test('口语调速：你跑快点 / 走快一点', () => {
    // 之前只认「跑」「快跑」「跑起来」这类干净说法，「你跑快点」落到 null。
    assert.equal(parseIntent('你跑快点', ctx())?.action, 'run');
    assert.equal(parseIntent('你跑快点', ctx())?.pace, 'run');
    assert.equal(parseIntent('走快一点', ctx())?.pace, 'walk');
    assert.equal(parseIntent('快点走', ctx())?.pace, 'walk');
});

test('口语调速不能吃掉「跑过去看看那个风机」这种带目标的话', () => {
    // 放宽调速模式的风险是误判。这条守着边界：
    // 句子里还有别的成分时，不能被当成纯调速。
    const r = parseIntent('跑过去看看那个风机', ctx());
    assert.notEqual(r?.rule, 'pace-run', '带目标的话不该被当成调速');
});
