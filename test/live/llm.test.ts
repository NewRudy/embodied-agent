// 真实模型层的冒烟测试 —— 打本机 magpie 网关（无鉴权）。
//
// 这不是单元测试：它依赖一个**外部服务**，网络断了、网关没开就会失败。
// 所以它不进 `npm test`，单独跑：
//
//   node --test test/live-llm.test.ts
//
// 目的是回答一个单元测试回答不了的问题：
//   真模型面对真实口语，输出的东西能不能通过我们的校验层？

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LlmDecider } from '../../src/llm-decider.ts';
import { RuleDecider, decideWithChain } from '../../src/intent.ts';
import type { ParseContext } from '../../src/intent-types.ts';
import type { Vec3 } from '../../src/types.ts';

const GATEWAY = process.env.EMBODIED_LLM_BASE_URL ?? 'http://127.0.0.1:3425/v1';
const MODEL = process.env.EMBODIED_LLM_MODEL ?? 'auto/glm-5.3-flash';

const PLACES: Array<{ name: string; at: Vec3 }> = [
    { name: 'A点', at: { east: -120, north: 90, up: 0 } },
    { name: 'B点', at: { east: 160, north: 40, up: 0 } },
    { name: 'C点', at: { east: 20, north: -150, up: 0 } },
];

function ctx(overrides: Partial<ParseContext> = {}): ParseContext {
    return {
        pose: { east: 0, north: 0, yaw: 0 },
        goal: null,
        resolve: (t: string) => PLACES.find(p => t.includes(p.name))?.at ?? null,
        defaultStep: 10,
        references: PLACES,
        ...overrides,
    };
}

function decider() {
    return new LlmDecider({
        baseUrl: GATEWAY,
        apiKey: process.env.EMBODIED_LLM_API_KEY ?? 'no-auth',
        model: MODEL,
        timeoutMs: 15000,
    });
}

async function gatewayUp(): Promise<boolean> {
    try {
        const r = await fetch(`${GATEWAY}/models`, { signal: AbortSignal.timeout(3000) });
        return r.ok;
    } catch {
        return false;
    }
}

const UP = await gatewayUp();
const skip = UP ? false : `网关 ${GATEWAY} 不可用`;

test('真实模型：把「去那个绿色的点」映射到登记过的参照物', { skip }, async () => {
    const r = await decider().decide('去那个绿色的点', ctx());
    // 允许模型选择 A/B/C 中任意一个 —— 三个都是绿的，说不清是哪个
    // 关键是不能编造出不存在的目标
    if (r) {
        assert.equal(r.action, 'go');
        const hit = PLACES.some(p => Math.abs(p.at.east - r.position!.east) < 0.5);
        assert.ok(hit, `目标必须来自登记表，实际 ${JSON.stringify(r.position)}`);
    }
});

test('真实模型：「离A点再近一点」→ revise 相对目标', { skip }, async () => {
    const goal = { position: { ...PLACES[0].at }, tolerance: 3 };
    const r = await decider().decide('离A点再近一点', ctx({ goal }));
    if (r) {
        assert.ok(['revise', 'go'].includes(r.action), `实际 ${r.action}`);
        if (r.action === 'revise') {
            const d = Math.hypot(
                r.position!.east - goal.position.east,
                r.position!.north - goal.position.north,
            );
            assert.ok(d < 30, `修正量应该小，实际偏移 ${d.toFixed(1)}m`);
        }
    }
});

test('真实模型：含糊的话给低置信度', { skip }, async () => {
    const r = await decider().decide('随便走走吧', ctx());
    if (r) {
        assert.ok(
            (r.confidence ?? 0) < 0.6,
            `含糊指令不该给高置信度，实际 ${r.confidence}`,
        );
    }
});

test('真实模型：闲聊不产生动作', { skip }, async () => {
    const r = await decider().decide('今天天气怎么样', ctx());
    assert.equal(r, null, '闲聊不应变成移动指令');
});

test('真实模型：决策链能兜住规则层的漏', { skip }, async () => {
    const r = await decideWithChain('过去瞅瞅那个绿色的点', ctx(), [new RuleDecider(), decider()]);
    // 要么模型给出合规动作，要么判废 —— 两者都可接受，崩溃不可接受
    if (r.intent) {
        assert.ok(['go', 'approach', 'revise'].includes(r.intent.action));
        assert.equal(r.decidedBy, MODEL);
    }
    assert.ok(r.trace.length >= 2, '规则层应该先被问过');
});
