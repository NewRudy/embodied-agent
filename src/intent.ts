// 规则意图层（L3）—— 永远可用的保底层。
//
// 为什么规则层必须存在：
//   模型会超时、会没凭据、会输出不合法。规则层零依赖零延迟，
//   保证「最坏情况下人物还能听懂基本指令」。
//
// 输出不是「命令」，是「目标操作」——和运动层的单位保持一致。

import type { Vec3 } from './types.ts';
import type { Intent, ParseContext } from './intent-types.ts';
import { CONFIDENCE_THRESHOLD, type IntentDecider } from './intent-types.ts';

export type { Intent, IntentAction, ParseContext, ReferenceResolver } from './intent-types.ts';

const STRIP = /[，。！？,.!?\s]/g;

/**
 * 含糊词 —— 出现这些词说明用户在指代不明的地方，不该按字面执行。
 *
 * 「大概往那边走吧」里有个「走」，正则能匹配到，但用户根本没说是哪边。
 * 规则层若按置信度 1 执行，人物就会朝当前朝向闷头走 10 米 —— 这是瞎猜。
 * 所以这类句子要主动降置信度，让决策链继续去问模型（或干脆澄清）。
 */
const HEDGE = /大概|可能|也许|好像|似乎|随便|那边|这边|那里|这里|那儿|这儿|附近|周围|看看|瞅瞅|转转|待着/;

/** 从文本里抽出距离数字（米）。 */
function extractMeters(text: string): number | null {
    const m = text.match(/(\d+(?:\.\d+)?)\s*(?:米|m\b|公尺)/i);
    if (m) return Number.parseFloat(m[1]);
    const cn: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const c = text.match(/([一二两三四五六七八九十]+)\s*(?:米|公尺)/);
    if (c) {
        const s = c[1];
        if (s === '十') return 10;
        if (s.length === 1) return cn[s] ?? null;
        // 十几 / 几十
        if (s.startsWith('十')) return 10 + (cn[s[1]] ?? 0);
        if (s.endsWith('十')) return (cn[s[0]] ?? 0) * 10;
        if (s.includes('十')) {
            const [a, b] = s.split('十');
            return (cn[a] ?? 0) * 10 + (cn[b] ?? 0);
        }
    }
    return null;
}

/**
 * 绝对方位 → 从北顺时针的角度（度）。
 *
 * 「往东」「朝西南」「往北边」—— 这类话与人物当前朝向无关，
 * 不能和「往前/往左」那套相对方位混用。
 *
 * 返回 null 表示没有绝对方位词。注意「左」「右」不在这里：
 * 它们是相对的，属于另一条规则。
 */
export function parseAbsoluteDirection(bare: string): { key: string; deg: number } | null {
    // 三字方位优先，否则「东北」会被「东」先吃掉
    const table: Array<[RegExp, string, number]> = [
        [/东北|北东/, 'ne', 45],
        [/东南|南东/, 'se', 135],
        [/西南|南西/, 'sw', 225],
        [/西北|北西/, 'nw', 315],
        [/东/, 'e', 90],
        [/南/, 's', 180],
        [/西/, 'w', 270],
        [/北/, 'n', 0],
    ];
    // 必须先出现方位介词，避免把「东西」（物品）当成东
    if (!/(?:往|向|朝|奔|去|走)/.test(bare)) return null;
    for (const [re, key, deg] of table) {
        if (re.test(bare)) return { key, deg };
    }
    return null;
}

/** 相对方位 → 绝对方位（相对当前朝向）。 */function relativeToWorld(pose: { east: number; north: number; yaw: number }, forwardMeters: number, leftMeters: number): Vec3 {
    // yaw: 0=北，顺时针为正。前向 = (sin yaw, cos yaw)，左向 = (-cos yaw, sin yaw)
    const fE = Math.sin(pose.yaw), fN = Math.cos(pose.yaw);
    const lE = -Math.cos(pose.yaw), lN = Math.sin(pose.yaw);
    return {
        east: pose.east + fE * forwardMeters + lE * leftMeters,
        north: pose.north + fN * forwardMeters + lN * leftMeters,
        up: 0,
    };
}

/**
 * 解析一句话。返回 null 表示没听懂，上层应澄清而不是瞎执行。
 *
 * 规则顺序很重要：先判「修正」，再判「停止」，最后才是「移动」。
 * 因为「往左一点」包含「左」，「停下」包含「下」，顺序错了会误判。
 */
export function parseIntent(raw: string, ctx: ParseContext): Intent | null {
    const text = raw.normalize('NFKC').trim();
    if (!text) return null;
    const bare = text.replace(STRIP, '');
    // 规则命中即为高置信度：这些模式是明确写死的，不存在「可能」
    const base = { raw: text, confidence: 1 };

    // —— 1. 停止 ——
    if (/^(停|停下|停止|别动|站住|等一下|暂停|不用了|回来)$/.test(bare)) {
        return { ...base, action: 'stop', rule: 'stop' };
    }
    // 否定式停止。必须先于方向规则，否则「先别走了」会被「走」当成前进。
    // 「别走了」「不要过去」「别往东走」—— 否定副词后面可以隔一个方位词。
    // 注意：只认句首的否定词。「别」出现在句中（「把别的东西拿过来」）不算。
    if (/^(?:别|不要|不用|甭|不许|勿|莫)(?:再)?(?:往|向|朝)?[一-龥]{0,4}?(?:过去|走|动|去|跑|往前|前进)/.test(bare)) {
        return { ...base, action: 'stop', rule: 'stop-negation' };
    }
    // 「停止前进」「停止移动」这类不带「别」的
    if (/^(?:停止|终止)(?:再)?(?:走|动|去|跑|前进|移动)/.test(bare)) {
        return { ...base, action: 'stop', rule: 'stop-negation' };
    }

    // —— 2. 中途修正（只在有活动目标时成立） ——
    // 修正必须相对「当前目标」偏移，而不是相对人物位置。
    // 按人物位置偏移会把目标拽到脚下，立刻误判到达。
    if (ctx.goal) {
        const cur = ctx.goal;
        const step = extractMeters(text) ?? 3;
        const shift = (forward: number, left: number): Vec3 => ({
            east: cur.position.east + forward * Math.sin(ctx.pose.yaw) + left * (-Math.cos(ctx.pose.yaw)),
            north: cur.position.north + forward * Math.cos(ctx.pose.yaw) + left * Math.sin(ctx.pose.yaw),
            up: cur.position.up,
        });
        // 「往左一点」「再靠右些」
        if (/(?:往|向)?左(?:一点|一些|边|点儿)?$/.test(bare) || /^左(?:一点|一些|点儿)?$/.test(bare)) {
            return { ...base, action: 'revise', position: shift(0, step), rule: 'revise-left' };
        }
        if (/(?:往|向)?右(?:一点|一些|边|点儿)?$/.test(bare) || /^右(?:一点|一些|点儿)?$/.test(bare)) {
            return { ...base, action: 'revise', position: shift(0, -step), rule: 'revise-right' };
        }
        if (/(?:再)?(?:近|靠近|往前|前进)(?:一点|一些|点儿)?$/.test(bare)) {
            return { ...base, action: 'revise', position: shift(step, 0), rule: 'revise-nearer' };
        }
        if (/(?:再)?(?:远|退|后退|往后)(?:一点|一些|点儿)?$/.test(bare)) {
            return { ...base, action: 'revise', position: shift(-step, 0), rule: 'revise-farther' };
        }
    }

    // —— 3. 快慢与飞行 ——
    if (/^(跑|快跑|快点|加速|用跑的|跑起来)$/.test(bare)) return { ...base, action: 'run', pace: 'run', rule: 'pace-run' };
    if (/^(走|慢点|慢一点|别跑|用走的)$/.test(bare)) return { ...base, action: 'run', pace: 'walk', rule: 'pace-walk' };
    if (/^(飞|起飞|飞起来|升空)$/.test(bare)) return { ...base, action: 'fly', fly: true, rule: 'fly-on' };
    if (/^(降落|落地|着陆|下来)$/.test(bare)) return { ...base, action: 'fly', fly: false, rule: 'fly-off' };

    // —— 4. 原地转向 ——
    const turnM = bare.match(/^(?:向|往)?(左|右)(?:转|转身|转个身)?(?:(\d+(?:\.\d+)?)|([一二两三四五六七八九十]+))?(?:度|°)?$/);
    if (turnM) {
        const deg = turnM[2] ? Number.parseFloat(turnM[2]) : (turnM[3] ? extractMeters(turnM[3] + '米') ?? 90 : 90);
        const sign = turnM[1] === '左' ? -1 : 1;
        return { ...base, action: 'turn', yawDelta: (sign * deg * Math.PI) / 180, rule: 'turn' };
    }

    // —— 5. 去某处（参照物优先） ——
    const ref = ctx.resolve(text);
    if (ref) {
        return { ...base, action: 'go', position: { ...ref, up: ref.up }, rule: 'go-reference' };
    }

    // —— 6. 绝对方位（东/南/西/北/东北…） ——
    // 必须先于「方向 + 距离」那一组。否则「往东走二十米」会被「走」兜底成
    // 「朝当前朝向走二十米」—— 用户说东，人物往北走，还自信满满（置信度 1）。
    // 这是真实场景里一定会出现的话，不是边缘情况。
    const absolute = parseAbsoluteDirection(bare);
    if (absolute) {
        const meters = extractMeters(text) ?? ctx.defaultStep;
        const rad = (absolute.deg * Math.PI) / 180;
        // 「去南边的楼」「带我去南边那个绿点」——方位是**定语**，真正的目标在后面。
        // 按纯方向走 10 米是错的：用户要找的是那个东西，不是往南挪一步。
        // 这种句子交给模型层或澄清，规则层主动降置信度。
        //
        // 判定：方位词后面跟了「的/那个/这个/那边…」而不是距离或动词。
        // 「往东走三十米」不算 —— 东后面直接是动词。
        const qualified = /(?:东|南|西|北|东北|东南|西南|西北)(?:边|面|侧|方)?(?:的|那个|这个|那|这|里|上|附近|一带)/.test(bare);
        return {
            raw: text,
            confidence: qualified ? 0.3 : 1,
            action: 'go',
            // 绝对方位与朝向无关：yaw=0 时 deg 就是「从北顺时针转多少度」
            position: {
                east: ctx.pose.east + Math.sin(rad) * meters,
                north: ctx.pose.north + Math.cos(rad) * meters,
                up: 0,
            },
            rule: `go-${absolute.key}`,
        };
    }

    // —— 7. 方向 + 可选距离 ——
    // 顺序有讲究：先判「往左/往右」，最后才是单独的「走」。
    // 否则「往左走」会被「走」当成前进吃掉。
    //
    // 这一组规则最松：一个「走」字就能命中。所以命中后要检查有没有含糊词 ——
    // 「大概往那边走吧」不能被当成「朝当前朝向走 10 米」。
    const hedged = HEDGE.test(bare);
    const weak = { raw: text, confidence: hedged ? 0.35 : 1 };
    const meters = extractMeters(text) ?? ctx.defaultStep;
    const dirs: Array<[RegExp, number, number, string]> = [
        [/(?:往左|向左|左边)/, 0, 1, 'go-left'],
        [/(?:往右|向右|右边)/, 0, -1, 'go-right'],
        [/(?:往后|向后|后退|退后|往回)/, -1, 0, 'go-backward'],
        [/(?:往前|向前|前进|往前走|前面走|走)/, 1, 0, 'go-forward'],
    ];
    for (const [re, f, l, rule] of dirs) {
        if (re.test(text)) {
            // 「往左/往右/往后」本身是明确的，只有靠「走」字兜底的那条才算含糊
            const vague = hedged && rule === 'go-forward' && !/往前|向前|前进/.test(text);
            const p = relativeToWorld(ctx.pose, f * meters, l * meters);
            return {
                raw: text,
                confidence: vague ? 0.35 : weak.confidence,
                action: 'go',
                position: p,
                rule,
            };
        }
    }

    return null;
}


// —— 决策器实现 ——

/** 规则决策器：永远可用，永远最快。 */
export class RuleDecider implements IntentDecider {
    readonly name = 'rule';
    available() { return true; }
    decide(text: string, ctx: ParseContext): Intent | null {
        return parseIntent(text, ctx);
    }
}

/**
 * 决策链：按顺序问每个决策器，第一个给出高置信度答案的胜出。
 *
 * 顺序原则：先便宜后贵。规则层先上，它命中就不必花模型的钱和时间。
 * 模型层的价值在规则层听不懂的那些话（「过去瞅瞅那个风车」「离近点看看」）。
 */
export async function decideWithChain(
    text: string,
    ctx: ParseContext,
    deciders: IntentDecider[],
): Promise<{ intent: Intent | null; decidedBy: string; trace: Array<{ name: string; outcome: string; detail?: string }> }> {
    const trace: Array<{ name: string; outcome: string; detail?: string }> = [];

    for (const decider of deciders) {
        if (!decider.available()) {
            trace.push({ name: decider.name, outcome: 'skipped', detail: '不可用' });
            continue;
        }
        try {
            const intent = await decider.decide(text, ctx);
            if (!intent) {
                trace.push({ name: decider.name, outcome: 'miss' });
                continue;
            }
            const confidence = intent.confidence ?? 1;
            if (confidence < CONFIDENCE_THRESHOLD) {
                // 低置信度：记下来但继续问下一个，不要贸然执行
                trace.push({ name: decider.name, outcome: 'miss', detail: `置信度 ${confidence.toFixed(2)} 过低` });
                continue;
            }
            trace.push({ name: decider.name, outcome: 'hit', detail: intent.rule });
            return { intent, decidedBy: decider.name, trace };
        } catch (e) {
            // 决策器坏了不是致命的：记下来，继续问下一个
            trace.push({ name: decider.name, outcome: 'error', detail: e instanceof Error ? e.message : String(e) });
        }
    }

    return { intent: null, decidedBy: 'none', trace };
}

/**
 * 同步快路径 —— 只问**同步**决策器，命中就立刻返回。
 *
 * 为什么需要它：`handleCommand` 是 UI 直接调用的。若每次都走 async，
 * 「停」这种指令也要等一个 microtask 才生效，调用方还得改成 await。
 * 规则层本来就是同步的，不该被模型的异步性拖下水。
 *
 * `done: true` 表示同步层已经给出结论（命中，或**没有异步决策器可等了**）。
 * `done: false` 表示还有异步决策器在排队，调用方应该继续走异步链。
 */
export function decideFast(
    text: string,
    ctx: ParseContext,
    deciders: IntentDecider[],
): { intent: Intent | null; decidedBy: string; trace: Array<{ name: string; outcome: string; detail?: string }>; done: boolean } {
    const trace: Array<{ name: string; outcome: string; detail?: string }> = [];
    let hasAsync = false;

    for (const decider of deciders) {
        if (!decider.available()) {
            trace.push({ name: decider.name, outcome: 'skipped', detail: '不可用' });
            continue;
        }
        // 异步决策器在快路径里不等待，留给慢路径。
        // 这里靠 isAsync 声明来判断，不去试探性地调用 —— 试探就是发一次真实请求。
        if (decider.isAsync) {
            hasAsync = true;
            trace.push({ name: decider.name, outcome: 'skipped', detail: '异步，留给慢路径' });
            continue;
        }
        let result: Intent | null | Promise<Intent | null>;
        try {
            result = decider.decide(text, ctx);
        } catch (e) {
            trace.push({ name: decider.name, outcome: 'error', detail: e instanceof Error ? e.message : String(e) });
            continue;
        }
        if (result && typeof (result as Promise<Intent | null>).then === 'function') {
            // 声明成同步却返回 Promise —— 保守处理：不阻塞，交给慢路径
            void (result as Promise<Intent | null>).catch(() => {});
            hasAsync = true;
            trace.push({ name: decider.name, outcome: 'skipped', detail: '意外异步' });
            continue;
        }
        const intent = result as Intent | null;
        if (!intent) {
            trace.push({ name: decider.name, outcome: 'miss' });
            continue;
        }
        if ((intent.confidence ?? 1) < CONFIDENCE_THRESHOLD) {
            trace.push({ name: decider.name, outcome: 'miss', detail: `置信度 ${(intent.confidence ?? 0).toFixed(2)} 过低` });
            continue;
        }
        trace.push({ name: decider.name, outcome: 'hit', detail: intent.rule });
        return { intent, decidedBy: decider.name, trace, done: true };
    }

    // 没有异步决策器 → 同步层就是最终答案，不必再等一轮 microtask
    return { intent: null, decidedBy: 'none', trace, done: !hasAsync };
}
