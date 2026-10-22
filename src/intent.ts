// 意图层（L3）：一句话 → 目标操作。
//
// 先用确定性规则，不接模型。理由：
//   1. 运动层和反射层才是这个包的核心价值，意图层可以换
//   2. 规则零依赖、零延迟，能把「快层成立」这件事单独证明出来
//   3. 后面接 Jev/Laya 时，只要换掉 parseIntent 的实现，上层不动
//
// 输出不是「命令」，是「目标操作」——和运动层的单位保持一致。

import type { Goal, Vec3 } from './types.ts';

/** 意图动作。 */
export type IntentAction =
    | 'go'        // 去某处
    | 'approach'  // 靠近参照物
    | 'stop'      // 停下
    | 'revise'    // 中途修正（左一点/右一点/再近点）
    | 'turn'      // 原地转向
    | 'run'       // 切换快慢
    | 'fly'       // 飞行开关
    | 'unknown';

export interface Intent {
    action: IntentAction;
    /** 目标坐标（go / approach / revise 用）。 */
    position?: Vec3;
    /** 原地转向角度（弧度，左负右正）。 */
    yawDelta?: number;
    /** run 意图的目标速度档。 */
    pace?: 'walk' | 'run';
    /** fly 意图的目标状态。 */
    fly?: boolean;
    /** 原始输入，便于日志。 */
    raw: string;
    /** 命中规则名，便于调试与后续模型对照。 */
    rule: string;
}

/** 参照物解析：把「3 号风机」这类说法交给场景。 */
export type ReferenceResolver = (text: string) => Vec3 | null;

const STRIP = /[，。！？,.!?\s]/g;

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

/** 相对方位 → 绝对方位（相对当前朝向）。 */
function relativeToWorld(pose: { east: number; north: number; yaw: number }, forwardMeters: number, leftMeters: number): Vec3 {
    // yaw: 0=北，顺时针为正。前向 = (sin yaw, cos yaw)，左向 = (-cos yaw, sin yaw)
    const fE = Math.sin(pose.yaw), fN = Math.cos(pose.yaw);
    const lE = -Math.cos(pose.yaw), lN = Math.sin(pose.yaw);
    return {
        east: pose.east + fE * forwardMeters + lE * leftMeters,
        north: pose.north + fN * forwardMeters + lN * leftMeters,
        up: 0,
    };
}

export interface ParseContext {
    /** 当前位姿，用于相对方位与修正。 */
    pose: { east: number; north: number; yaw: number };
    /** 当前目标，用于修正。 */
    goal: Goal | null;
    /** 参照物解析器。 */
    resolve: ReferenceResolver;
    /** 默认前进距离（没说数字时）。 */
    defaultStep: number;
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
    const base = { raw: text };

    // —— 1. 停止 ——
    if (/^(停|停下|停止|别动|站住|等一下|暂停|不用了|回来)$/.test(bare)) {
        return { ...base, action: 'stop', rule: 'stop' };
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

    // —— 6. 方向 + 可选距离 ——
    // 顺序有讲究：先判「往左/往右」，最后才是单独的「走」。
    // 否则「往左走」会被「走」当成前进吃掉。
    const meters = extractMeters(text) ?? ctx.defaultStep;
    const dirs: Array<[RegExp, number, number, string]> = [
        [/(?:往左|向左|左边)/, 0, 1, 'go-left'],
        [/(?:往右|向右|右边)/, 0, -1, 'go-right'],
        [/(?:往后|向后|后退|退后|往回)/, -1, 0, 'go-backward'],
        [/(?:往前|向前|前进|往前走|前面走|走)/, 1, 0, 'go-forward'],
    ];
    for (const [re, f, l, rule] of dirs) {
        if (re.test(text)) {
            const p = relativeToWorld(ctx.pose, f * meters, l * meters);
            return { ...base, action: 'go', position: p, rule };
        }
    }

    return null;
}
