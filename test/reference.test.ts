// 参照物解析与数字归一测试。
//
// 这一组用例的由来：语音输入会把「3号」识别成「三号」，
// 而场景里的 ID 是阿拉伯数字。不归一的话，文字指令能用、语音指令一直「没听懂」。
// 这种 bug 只在真实语音下暴露，单元测试必须先把它钉住。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CesiumSceneAdapter, normalizeNumerals } from '../src/cesium-adapter.ts';
import type { Vec3 } from '../src/types.ts';

// —— 数字归一 ——

test('中文数字在 ID 前转换', () => {
    assert.equal(normalizeNumerals('去三号风机'), '去3号风机');
    assert.equal(normalizeNumerals('去十二号'), '去12号');
    assert.equal(normalizeNumerals('去二十号'), '去20号');
    assert.equal(normalizeNumerals('去二十三号'), '去23号');
});

test('中文数字在单位前转换', () => {
    assert.equal(normalizeNumerals('往前走二十米'), '往前走20米');
    assert.equal(normalizeNumerals('三号楼'), '3号楼');
    assert.equal(normalizeNumerals('两台机组'), '2台机组');
});

test('量词「一点」不被误转', () => {
    // 这是上一版写错的地方：无条件转换会把「往左一点」变成「往左1点」
    assert.equal(normalizeNumerals('往左一点'), '往左一点');
    assert.equal(normalizeNumerals('再近一些'), '再近一些');
});

test('阿拉伯数字原样保留', () => {
    assert.equal(normalizeNumerals('去3号风机'), '去3号风机');
});

// —— 参照物解析 ——

function makeAdapter() {
    // EnuFrame 需要 ECEF 原点；这里只测 resolveReference，用最小构造绕过
    const adapter = Object.create(CesiumSceneAdapter.prototype) as CesiumSceneAdapter;
    (adapter as unknown as { references: Map<string, Vec3> }).references = new Map([
        ['3号风机', { east: 460, north: -90, up: 134 }],
        ['10号风机', { east: 100, north: 200, up: 0 }],
    ]);
    (adapter as unknown as { aliases: Map<string, string> }).aliases = new Map();
    return adapter;
}

test('阿拉伯数字参照物直接命中', () => {
    const a = makeAdapter();
    assert.deepEqual(a.resolveReference('去3号风机'), { east: 460, north: -90, up: 134 });
});

test('中文数字参照物经归一后命中', () => {
    const a = makeAdapter();
    assert.deepEqual(a.resolveReference('去三号风机'), { east: 460, north: -90, up: 134 });
    assert.deepEqual(a.resolveReference('去十号风机'), { east: 100, north: 200, up: 0 });
});

test('不存在的参照物返回 null，不瞎猜', () => {
    const a = makeAdapter();
    assert.equal(a.resolveReference('去七号风机'), null);
    assert.equal(a.resolveReference('去那个地方'), null);
});

test('最长匹配优先：3号风机 不会被 3号 抢走', () => {
    const a = makeAdapter();
    (a as unknown as { references: Map<string, Vec3> }).references.set('3号', { east: 1, north: 2, up: 3 });
    assert.deepEqual(a.resolveReference('去3号风机'), { east: 460, north: -90, up: 134 });
});

// —— 名称里的空格 ——
//
// 这一组来自真实场景验收：farm.json 的 label 是「3 号风机」（数字和「号」之间有空格，
// 因为排版好看），而 ASR 转写和用户输入都是「3号风机」/「三号风机」。
// 不做空格归一，`"3号风机".includes("3 号风机") === false` ——
// 语音和文字**都**永远匹配不上，而且失败得毫无线索（规则层只是安静地没命中）。

function makeSpacedAdapter() {
    const adapter = Object.create(CesiumSceneAdapter.prototype) as CesiumSceneAdapter;
    (adapter as unknown as { references: Map<string, Vec3> }).references = new Map([
        ['3 号风机', { east: 460, north: -90, up: 134 }],
        ['10 号风机', { east: 100, north: 200, up: 0 }],
        ['运维点', { east: 200, north: 240, up: 148 }],
    ]);
    (adapter as unknown as { aliases: Map<string, string> }).aliases = new Map([
        ['风机3', '3 号风机'],
        ['3 号机组', '3 号风机'],
    ]);
    return adapter;
}

test('参照物名带空格时，阿拉伯数字输入也能命中', () => {
    const a = makeSpacedAdapter();
    assert.deepEqual(a.resolveReference('去3号风机'), { east: 460, north: -90, up: 134 });
    assert.deepEqual(a.resolveReference('去10号风机'), { east: 100, north: 200, up: 0 });
});

test('参照物名带空格时，中文数字输入（真实 ASR 输出）也能命中', () => {
    const a = makeSpacedAdapter();
    // 豆包实际返回的是「去三号风机。」，带句号
    assert.deepEqual(a.resolveReference('去三号风机。'), { east: 460, north: -90, up: 134 });
    assert.deepEqual(a.resolveReference('去三号风机'), { east: 460, north: -90, up: 134 });
});

test('参照物名带空格时，别名也能命中', () => {
    const a = makeSpacedAdapter();
    assert.deepEqual(a.resolveReference('去风机3'), { east: 460, north: -90, up: 134 });
    assert.deepEqual(a.resolveReference('去3号机组'), { east: 460, north: -90, up: 134 });
});

test('不带数字的名称不受空格归一影响', () => {
    const a = makeSpacedAdapter();
    assert.deepEqual(a.resolveReference('回运维点'), { east: 200, north: 240, up: 148 });
});

test('归一空格后仍然不瞎猜', () => {
    const a = makeSpacedAdapter();
    assert.equal(a.resolveReference('去七号风机'), null);
    assert.equal(a.resolveReference('去 那个 地方'), null);
});
