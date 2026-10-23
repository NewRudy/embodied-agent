// 模型意图层测试 —— 重点不是「模型准不准」，而是「模型错了会不会出事」。
//
// 这里全部用注入的假 fetch，不打真实网络：
//   - 真实模型的输出不可重复，测不了确定性行为
//   - 我们要钉住的是**校验层**：越界、幻觉、格式错，都必须变成 null

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LlmDecider, validateLlmIntent } from '../src/llm-decider.ts';
import { RuleDecider, decideWithChain } from '../src/intent.ts';
import { CONFIDENCE_THRESHOLD } from '../src/intent-types.ts';
import type { ParseContext } from '../src/intent-types.ts';
import type { Vec3 } from '../src/types.ts';

function ctx(overrides: Partial<ParseContext> = {}): ParseContext {
    return {
        pose: { east: 0, north: 0, yaw: 0 },
        goal: null,
        resolve: (t: string) => (t.includes('A点') ? { east: 100, north: 0, up: 0 } : null),
        defaultStep: 10,
        references: [{ name: 'A点', at: { east: 100, north: 0, up: 0 } }],
        ...overrides,
    };
}

const near = (a: Vec3, b: Vec3, eps = 0.5) =>
    Math.abs(a.east - b.east) < eps && Math.abs(a.north - b.north) < eps;

// ==================== 校验层：模型说错话 ====================

test('合法输出：去参照物', () => {
    const r = validateLlmIntent(
        { action: 'go', target: 'A点', direction: null, meters: null, degrees: null, pace: null, fly: null, confidence: 0.9 },
        ctx(), 'test',
    );
    assert.equal(r?.action, 'go');
    assert.ok(near(r!.position!, { east: 100, north: 0, up: 0 }));
    assert.equal(r!.confidence, 0.9);
});

test('模型编造不存在的参照物 → 判废', () => {
    const r = validateLlmIntent(
        { action: 'go', target: '火星基地', confidence: 0.99 },
        ctx(), 'test',
    );
    assert.equal(r, null, '不能让人物跑去不存在的地方');
});

test('动作不在白名单 → 判废', () => {
    for (const action of ['dance', 'attack', 'teleport', 'unknown', '']) {
        const r = validateLlmIntent({ action, confidence: 1 }, ctx(), 'test');
        assert.equal(r, null, `动作「${action}」不应被接受`);
    }
});

test('多带字段 → 判废（防止模型夹带私货）', () => {
    const r = validateLlmIntent(
        { action: 'stop', confidence: 1, position: { east: 999, north: 999, up: 0 } },
        ctx(), 'test',
    );
    assert.equal(r, null);
});

test('非对象 / 数组 / null → 判废', () => {
    for (const bad of [null, undefined, 'go', 42, [], [1, 2]]) {
        assert.equal(validateLlmIntent(bad, ctx(), 'test'), null);
    }
});

test('距离越界 → 判废', () => {
    assert.equal(
        validateLlmIntent({ action: 'go', target: null, direction: 'forward', meters: 10000, confidence: 1 }, ctx(), 'test'),
        null, '500 米以上不接受',
    );
    assert.equal(
        validateLlmIntent({ action: 'go', target: null, direction: 'forward', meters: -5, confidence: 1 }, ctx(), 'test'),
        null, '负距离不接受',
    );
});

test('方向词不在枚举内 → 判废', () => {
    const r = validateLlmIntent(
        { action: 'go', target: null, direction: 'northwest', meters: 20, confidence: 1 },
        ctx(), 'test',
    );
    assert.equal(r, null);
});

test('置信度缺失按 0 处理，不是按 1', () => {
    const r = validateLlmIntent({ action: 'stop' }, ctx(), 'test');
    assert.equal(r!.confidence, 0, '缺 confidence 必须当「没把握」，不能当「很有把握」');
});

test('置信度超界被夹紧', () => {
    const hi = validateLlmIntent({ action: 'stop', confidence: 5 }, ctx(), 'test');
    assert.equal(hi!.confidence, 1);
    const lo = validateLlmIntent({ action: 'stop', confidence: -3 }, ctx(), 'test');
    assert.equal(lo!.confidence, 0);
});

test('revise 相对当前目标，不相对人物', () => {
    const goal = { position: { east: 200, north: 0, up: 0 }, tolerance: 3 };
    // 人物在原点朝北，「向左 5 米」应把目标推到 (195, 0)，而不是推到人物旁边
    const r = validateLlmIntent(
        { action: 'revise', direction: 'left', meters: 5, confidence: 0.9 },
        ctx({ goal }), 'test',
    );
    assert.equal(r?.action, 'revise');
    assert.ok(near(r!.position!, { east: 195, north: 0, up: 0 }), JSON.stringify(r!.position));
});

test('turn 角度为 0 或超 360 → 判废', () => {
    assert.equal(validateLlmIntent({ action: 'turn', degrees: 0, confidence: 1 }, ctx(), 'test'), null);
    assert.equal(validateLlmIntent({ action: 'turn', degrees: 400, confidence: 1 }, ctx(), 'test'), null);
    const ok = validateLlmIntent({ action: 'turn', degrees: -45, confidence: 1 }, ctx(), 'test');
    assert.ok(Math.abs(ok!.yawDelta! + Math.PI / 4) < 1e-9, '左转为负');
});

test('run / fly 缺关键字段 → 判废', () => {
    assert.equal(validateLlmIntent({ action: 'run', confidence: 1 }, ctx(), 'test'), null);
    assert.equal(validateLlmIntent({ action: 'fly', confidence: 1 }, ctx(), 'test'), null);
    assert.equal(validateLlmIntent({ action: 'fly', fly: 'yes', confidence: 1 }, ctx(), 'test'), null);
});

// ==================== 决策器：网络与降级 ====================

function fakeFetch(reply: unknown, status = 200) {
    return (async () => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => reply,
    })) as unknown as typeof fetch;
}

function chatReply(content: string) {
    return { choices: [{ message: { content } }] };
}

test('没配 key 时 available() 为 false，decide 直接返回 null', async () => {
    const d = new LlmDecider({ apiKey: '', fetchImpl: fakeFetch(chatReply('{}')) });
    assert.equal(d.available(), false);
    assert.equal(await d.decide('去A点', ctx()), null);
});

test('正常回复 → 解析成 Intent', async () => {
    const content = JSON.stringify({
        action: 'go', target: 'A点', direction: null, meters: null,
        degrees: null, pace: null, fly: null, confidence: 0.92,
    });
    const d = new LlmDecider({ apiKey: 'k', fetchImpl: fakeFetch(chatReply(content)) });
    const r = await d.decide('过去那边那个绿点', ctx());
    assert.equal(r?.action, 'go');
    assert.ok(near(r!.position!, { east: 100, north: 0, up: 0 }));
    assert.equal(r!.raw, '过去那边那个绿点', 'raw 应是原始输入');
});

test('模型包了 markdown 代码块也能抠出来', async () => {
    const content = '```json\n{"action":"stop","confidence":1}\n```';
    const d = new LlmDecider({ apiKey: 'k', fetchImpl: fakeFetch(chatReply(content)) });
    const r = await d.decide('别走了', ctx());
    assert.equal(r?.action, 'stop');
});

test('模型在 JSON 前后加废话也能抠出来', async () => {
    const content = '好的，解析结果如下：{"action":"stop","confidence":0.8} 希望有帮助';
    const d = new LlmDecider({ apiKey: 'k', fetchImpl: fakeFetch(chatReply(content)) });
    assert.equal((await d.decide('停一下', ctx()))?.action, 'stop');
});

test('HTTP 错误 → 抛异常（由决策链兜住）', async () => {
    const d = new LlmDecider({ apiKey: 'k', fetchImpl: fakeFetch({}, 500) });
    await assert.rejects(() => d.decide('去A点', ctx()), /LLM_HTTP_500/);
});

test('回复不是 JSON → 抛异常', async () => {
    const d = new LlmDecider({ apiKey: 'k', fetchImpl: fakeFetch(chatReply('我不太明白')) });
    await assert.rejects(() => d.decide('嗯', ctx()), /LLM_JSON/);
});

test('超时会中断请求', async () => {
    const slow = ((_url: string, init?: RequestInit) => new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
    })) as unknown as typeof fetch;
    const d = new LlmDecider({ apiKey: 'k', fetchImpl: slow, timeoutMs: 30 });
    await assert.rejects(() => d.decide('去A点', ctx()), /aborted/);
});

// ==================== 决策链：多层协作 ====================

test('规则层命中时不调模型', async () => {
    let called = 0;
    const counting = new LlmDecider({
        apiKey: 'k',
        fetchImpl: (async () => { called++; return { ok: true, json: async () => chatReply('{}') }; }) as unknown as typeof fetch,
    });
    const r = await decideWithChain('去A点', ctx(), [new RuleDecider(), counting]);
    assert.equal(r.intent?.action, 'go');
    assert.equal(r.decidedBy, 'rule');
    assert.equal(called, 0, '规则层命中就不该花模型的钱');
});

test('规则层听不懂时落到模型层', async () => {
    const content = JSON.stringify({ action: 'stop', confidence: 0.9 });
    const llm = new LlmDecider({ apiKey: 'k', fetchImpl: fakeFetch(chatReply(content)) });
    const r = await decideWithChain('过去瞅瞅那个绿点', ctx(), [new RuleDecider(), llm]);
    assert.equal(r.intent?.action, 'stop');
    assert.equal(r.decidedBy, llm.name);
    assert.deepEqual(r.trace.map(t => t.outcome), ['miss', 'hit']);
});

test('模型抛异常 → 整条链不崩，返回 null', async () => {
    const llm = new LlmDecider({ apiKey: 'k', fetchImpl: fakeFetch({}, 503) });
    const r = await decideWithChain('过去瞅瞅那个绿点', ctx(), [new RuleDecider(), llm]);
    assert.equal(r.intent, null);
    assert.equal(r.decidedBy, 'none');
    assert.deepEqual(r.trace.map(t => t.outcome), ['miss', 'error']);
});

test('模型低置信度 → 不执行，继续往后问', async () => {
    const low = JSON.stringify({ action: 'go', target: null, direction: 'forward', meters: 5, confidence: 0.2 });
    const llm = new LlmDecider({ apiKey: 'k', fetchImpl: fakeFetch(chatReply(low)) });
    const r = await decideWithChain('大概往那边走吧', ctx(), [new RuleDecider(), llm]);
    assert.equal(r.intent, null, '低置信度不能直接执行');
    assert.ok(r.trace.some(t => t.detail?.includes('置信度')), JSON.stringify(r.trace));
});

test('没配凭据的决策器被跳过，不影响其它层', async () => {
    const off = new LlmDecider({ apiKey: '' });
    const r = await decideWithChain('去A点', ctx(), [off, new RuleDecider()]);
    assert.equal(r.decidedBy, 'rule');
    assert.equal(r.trace[0].outcome, 'skipped');
});

test('模型幻觉的参照物不会穿透决策链', async () => {
    const content = JSON.stringify({ action: 'go', target: '月亮', confidence: 0.99 });
    const llm = new LlmDecider({ apiKey: 'k', fetchImpl: fakeFetch(chatReply(content)) });
    const r = await decideWithChain('去月亮上', ctx(), [new RuleDecider(), llm]);
    assert.equal(r.intent, null, '校验层必须拦住');
});

test('阈值是可解释的：0.6 以下不执行', () => {
    assert.equal(CONFIDENCE_THRESHOLD, 0.6);
});

// ==================== 推理模型的坑 ====================

test('推理模型烧光 token 导致正文为空 → 抛可辨识错误', async () => {
    // 真实踩到的：glm-5.3-flash 在 max_tokens=200 时 200 个 token 全是
    // reasoning_content，content 为空串，finish_reason=length。
    // 若不特判，会报成 LLM_JSON，排查时看不出真正原因。
    const reply = {
        choices: [{
            message: { content: '', reasoning_content: '用户说要去绿色的点，但没说哪个……' },
            finish_reason: 'length',
        }],
        usage: { completion_tokens_details: { reasoning_tokens: 200 } },
    };
    const d = new LlmDecider({ apiKey: 'k', fetchImpl: fakeFetch(reply) });
    await assert.rejects(() => d.decide('去那个绿色的点', ctx()), /LLM_TRUNCATED_REASONING/);
});

test('正文为空但 finish_reason 是 stop → 仍按 JSON 错处理', async () => {
    const reply = { choices: [{ message: { content: '' }, finish_reason: 'stop' }] };
    const d = new LlmDecider({ apiKey: 'k', fetchImpl: fakeFetch(reply) });
    await assert.rejects(() => d.decide('嗯', ctx()), /LLM_JSON/);
});

test('模型决策器自报异步，快路径不会误调它', () => {
    const d = new LlmDecider({ apiKey: 'k' });
    assert.equal(d.isAsync, true);
});
