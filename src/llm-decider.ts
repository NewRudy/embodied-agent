// 模型意图决策器 —— 规则层听不懂时兜底。
//
// 借鉴 Laya / System-One 的核心思想：模型只做「有界选择」，不做自由生成。
// 具体做法：
//   1. 动作集合是**固定的**（go/stop/revise/turn/run/fly），模型不能发明新动作
//   2. 目标点只能从**场景已登记的参照物**里选，或按方向+距离算，不能凭空给坐标
//   3. 输出必须是严格 JSON，字段集合完全匹配，多一个字段就判废
//   4. 任何失败（超时/JSON 错/校验不过）→ 返回 null，上层继续降级
//
// 这样即使模型幻觉，最坏结果也只是「没听懂」，不会让人物跑去不存在的地方。

import type { Vec3 } from './types.ts';
import type { Intent, IntentDecider, ParseContext } from './intent-types.ts';

export interface LlmDeciderOptions {
    /** OpenAI 兼容端点，默认智谱。 */
    baseUrl?: string;
    /** API Key。不填则读环境变量，仍没有则 available() 返回 false。 */
    apiKey?: string;
    /** 模型名。 */
    model?: string;
    /** 超时毫秒，默认 4000。快层不能被慢模型拖死。 */
    timeoutMs?: number;
    /** 注入 fetch（测试用）。 */
    fetchImpl?: typeof fetch;
}

const ALLOWED_ACTIONS = ['go', 'stop', 'revise', 'turn', 'run', 'fly'] as const;
type AllowedAction = typeof ALLOWED_ACTIONS[number];

function buildSystemPrompt(references: Array<{ name: string; description?: string }>): string {
    const refList = references.length
        ? references
            .map(r => (r.description ? `「${r.name}」（${r.description}）` : `「${r.name}」`))
            .join('、')
        : '（本场景没有登记参照物）';
    return [
        '你是一个具身智能体的意图解析器。把用户的中文口语转成严格 JSON。',
        '只输出 JSON 本体，不要解释、不要 markdown 代码块、不要多余字段。',
        '',
        `场景里可去的参照物只有：${refList}`,
        '',
        '允许的动作（只能从中选一个，不能发明）：',
        '- go：去某个地方。target 必须是上面列出的参照物名；若用户说的是方位，则 target=null 并给 direction+meters',
        '- stop：停下',
        '- revise：在当前目标基础上微调。target=null，给 direction（left/right/forward/backward）+ meters',
        '- turn：原地转向。degrees 为角度，左负右正',
        '- run：切换步速。pace=walk 或 run',
        '- fly：起飞/降落。fly=true/false',
        '',
        '输出格式（严格 JSON，不要 markdown 代码块，不要多余字段）：',
        '{"action":"go","target":"A点","direction":null,"meters":null,"degrees":null,"pace":null,"fly":null,"confidence":0.95}',
        '',
        '规则：',
        '1. 拿不准就把 confidence 调低（低于 0.6），不要硬猜',
        '2. target 只能填上面列出的参照物名，不能编造',
        '3. 用户说「那边」「那里」这类没有具体指向的话，confidence 给 0.3 以下',
        '4. 用户用外观描述指代（「那个绿色的点」「中间那个」）时，只能靠括号里的描述来匹配；描述里没有的特征不要猜',
    ].join('\n');
}

/** 把模型的原始输出校验成 Intent。任何不合规都返回 null。 */
export function validateLlmIntent(
    raw: unknown,
    ctx: ParseContext,
    model: string,
): Intent | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;

    // 严格字段集合：多一个字段就判废（防止模型夹带私货）
    const allowed = new Set(['action', 'target', 'direction', 'meters', 'degrees', 'pace', 'fly', 'confidence']);
    for (const key of Object.keys(o)) {
        if (!allowed.has(key)) return null;
    }

    const action = o.action;
    if (typeof action !== 'string' || !(ALLOWED_ACTIONS as readonly string[]).includes(action)) return null;

    const confidence = typeof o.confidence === 'number' && Number.isFinite(o.confidence)
        ? Math.max(0, Math.min(1, o.confidence))
        : 0;

    const base = { raw: '', rule: `llm:${model}`, confidence };
    const meters = typeof o.meters === 'number' && Number.isFinite(o.meters) ? o.meters : null;
    const direction = typeof o.direction === 'string' ? o.direction : null;
    const target = typeof o.target === 'string' ? o.target : null;

    switch (action as AllowedAction) {
        case 'stop':
            return { ...base, action: 'stop' };

        case 'go': {
            // 路径一：走参照物。必须在场景登记表里。
            if (target) {
                const ref = ctx.resolve(target);
                if (!ref) return null; // 模型编造了不存在的参照物 → 判废
                return { ...base, action: 'go', position: { ...ref } };
            }
            // 路径二：方向 + 距离
            if (!direction || !isDirection(direction)) return null;
            const d = meters ?? ctx.defaultStep;
            if (d <= 0 || d > 500) return null;
            const pos = relativeTo(ctx.pose, direction, d);
            return { ...base, action: 'go', position: pos };
        }

        case 'revise': {
            if (!direction || !isDirection(direction)) return null;
            const d = meters ?? 3;
            if (d <= 0 || d > 100) return null;
            // 修正相对「当前目标」偏移，不是相对人物位置。
            // 按人物位置偏移会把目标拽到脚下，立刻误判到达 —— 规则层踩过这个坑。
            const anchor = ctx.goal
                ? { east: ctx.goal.position.east, north: ctx.goal.position.north, yaw: ctx.pose.yaw }
                : ctx.pose;
            const pos = relativeTo(anchor, direction, d);
            if (ctx.goal) pos.up = ctx.goal.position.up;
            return { ...base, action: 'revise', position: pos };
        }

        case 'turn': {
            const deg = typeof o.degrees === 'number' && Number.isFinite(o.degrees) ? o.degrees : null;
            if (deg == null || Math.abs(deg) > 360 || deg === 0) return null;
            return { ...base, action: 'turn', yawDelta: (deg * Math.PI) / 180 };
        }

        case 'run': {
            const pace = o.pace === 'run' ? 'run' : o.pace === 'walk' ? 'walk' : null;
            if (!pace) return null;
            return { ...base, action: 'run', pace };
        }

        case 'fly': {
            if (typeof o.fly !== 'boolean') return null;
            return { ...base, action: 'fly', fly: o.fly };
        }

        default:
            return null;
    }
}

function isDirection(d: string): d is 'forward' | 'backward' | 'left' | 'right' {
    return d === 'forward' || d === 'backward' || d === 'left' || d === 'right';
}

/** 相对方位 → ENU 坐标。yaw: 0=北，顺时针为正。 */
function relativeTo(pose: { east: number; north: number; yaw: number }, dir: string, meters: number): Vec3 {
    const fE = Math.sin(pose.yaw), fN = Math.cos(pose.yaw);
    const lE = -Math.cos(pose.yaw), lN = Math.sin(pose.yaw);
    switch (dir) {
        case 'forward': return { east: pose.east + fE * meters, north: pose.north + fN * meters, up: 0 };
        case 'backward': return { east: pose.east - fE * meters, north: pose.north - fN * meters, up: 0 };
        case 'left': return { east: pose.east + lE * meters, north: pose.north + lN * meters, up: 0 };
        case 'right': return { east: pose.east - lE * meters, north: pose.north - lN * meters, up: 0 };
        default: return { east: pose.east, north: pose.north, up: 0 };
    }
}

/** 从模型回复里抠出 JSON（兼容它包了 ```json 的情况）。 */
function extractJson(content: string): unknown {
    const trimmed = content.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = fenced ? fenced[1].trim() : trimmed;
    try {
        return JSON.parse(body);
    } catch {
        // 再试一次：从第一个 { 到最后一个 }
        const start = body.indexOf('{');
        const end = body.lastIndexOf('}');
        if (start < 0 || end <= start) return null;
        try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
    }
}

/**
 * 模型决策器。
 *
 * 注意它是**异步**的：调用方必须接受「这一层可能慢」。
 * 本包的铁律是 L4 不能阻塞 L1-L3，所以这里只用于「规则层没听懂」的场合，
 * 且超时默认只有 4 秒。
 */
export class LlmDecider implements IntentDecider {
    readonly name: string;
    /** 模型决策器永远走慢路径。 */
    readonly isAsync = true;
    private readonly options: Required<Omit<LlmDeciderOptions, 'fetchImpl'>> & { fetchImpl: typeof fetch };

    constructor(options: LlmDeciderOptions = {}) {
        const baseUrl = options.baseUrl
            ?? (typeof process !== 'undefined' ? process.env.EMBODIED_LLM_BASE_URL : undefined)
            ?? 'https://open.bigmodel.cn/api/paas/v4';
        const apiKey = options.apiKey
            ?? (typeof process !== 'undefined' ? process.env.EMBODIED_LLM_API_KEY : undefined)
            ?? '';
        const model = options.model
            ?? (typeof process !== 'undefined' ? process.env.EMBODIED_LLM_MODEL : undefined)
            ?? 'glm-4.5-flash';
        this.options = {
            baseUrl: baseUrl.replace(/\/+$/, ''),
            apiKey,
            model,
            timeoutMs: options.timeoutMs ?? 4000,
            // 必须包一层再调。浏览器里 fetch 是 window 的方法，
            // 存成变量再单独调用会丢 this 绑定，报 "Illegal invocation"。
            // Node 里不报，所以单元测试发现不了 —— 这是浏览器验收才抓到的。
            fetchImpl: options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
        };
        this.name = `llm:${this.options.model}`;
    }

    available(): boolean {
        // 不能只判断 apiKey：浏览器场景常用「同源代理」，key 只是占位。
        // 真正的前提是有 fetch 可用。
        return typeof this.options.fetchImpl === 'function'
            && (Boolean(this.options.apiKey) || this.options.baseUrl.startsWith('/'));
    }

    async decide(text: string, ctx: ParseContext): Promise<Intent | null> {
        if (!this.available()) return null;

        const references = ctx.references ?? [];
        const messages = [
            { role: 'system', content: buildSystemPrompt(references) },
            { role: 'user', content: text },
        ];

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
        try {
            const resp = await this.options.fetchImpl(`${this.options.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.options.apiKey}`,
                },
                body: JSON.stringify({
                    model: this.options.model,
                    temperature: 0,
                    // 200 对非推理模型足够（实测 40 token 就出完整 JSON）。
                    // 推理模型要 800+ 才够思考完 —— 那种模型本来就不该用在快层。
                    max_tokens: 200,
                    messages,
                }),
                signal: controller.signal,
            });
            if (!resp.ok) throw new Error(`LLM_HTTP_${resp.status}`);
            const json = await resp.json() as {
                choices?: Array<{
                    message?: { content?: string; reasoning_content?: string };
                    finish_reason?: string;
                }>;
                usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
            };
            const choice = json.choices?.[0];
            const content = choice?.message?.content ?? '';

            // 推理模型会把 token 全花在思考上，正文为空。
            // 实测 glm-5.3-flash 在 max_tokens=200 时 200 个 token 全是 reasoning，
            // content 是空串，finish_reason=length。这类模型不能用作快层。
            if (!content.trim() && choice?.finish_reason === 'length') {
                throw new Error('LLM_TRUNCATED_REASONING');
            }

            const parsed = extractJson(content);
            if (!parsed) throw new Error('LLM_JSON');
            const intent = validateLlmIntent(parsed, ctx, this.options.model);
            return intent ? { ...intent, raw: text } : null;
        } finally {
            clearTimeout(timer);
        }
    }
}
