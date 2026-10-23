// 意图层（L3）—— 可插拔的决策器。
//
// 设计原则（借鉴 Laya / System-One 的思路，不是照搬）：
//   1. 决策必须是**有界的**：只能在登记过的动作里选，不能凭空发明
//   2. 决策必须**带置信度**：低置信度就该问，而不是猜
//   3. 决策必须是**快的**：规则层 <1ms，模型层是补充不是替代
//   4. 失败必须**可降级**：模型挂了就用规则，不能整个系统瘫掉
//
// 这个文件定义契约。具体实现在 rule-decider.ts / llm-decider.ts。

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
    /** 命中规则名 / 模型名，便于调试与对照。 */
    rule: string;
    /**
     * 置信度 0-1。
     *
     * 规则层命中明确模式时给 1；模型给的概率；听不懂给 0。
     * 低于阈值时上层应该澄清，而不是执行。
     */
    confidence?: number;
}

/** 参照物解析：把「3 号风机」这类说法交给场景。 */
export type ReferenceResolver = (text: string) => Vec3 | null;

export interface ParseContext {
    /** 当前位姿，用于相对方位与修正。 */
    pose: { east: number; north: number; yaw: number };
    /** 当前目标，用于修正。 */
    goal: Goal | null;
    /** 参照物解析器。 */
    resolve: ReferenceResolver;
    /** 默认前进距离（没说数字时）。 */
    defaultStep: number;
    /** 场景里有哪些参照物（给模型看，规则层不用）。 */
    references?: Array<{ name: string; at: Vec3; description?: string }>;
    /** 最近几轮对话（给模型看，规则层不用）。 */
    history?: Array<{ text: string; rule: string }>;
}

/**
 * 意图决策器 —— 规则层和模型层都实现这个接口。
 *
 * 为什么用接口而不是直接调模型：
 *   规则层必须永远可用（零依赖、零延迟、零成本）。
 *   模型层是「锦上添花」，它挂了不能让整个系统瘫掉。
 */
export interface IntentDecider {
    /** 决策器名字，用于日志与降级判断。 */
    readonly name: string;
    /**
     * 是否是异步决策器。
     *
     * 为什么需要显式声明：同步快路径不能「试着调一下看返回的是不是 Promise」——
     * 那等于真的发了一次网络请求，慢路径再调一次就是双倍消耗。
     * 所以异步决策器必须自己说清楚，快路径直接跳过它。
     */
    readonly isAsync?: boolean;
    /** 是否可用（模型层可能没配凭据）。 */
    available(): boolean;
    /**
     * 解析一句话。
     *
     * 返回 null 表示「这个决策器没把握」，上层可以问下一个决策器。
     * 抛异常表示「决策器本身坏了」，上层应该降级到规则层。
     */
    decide(text: string, ctx: ParseContext): Promise<Intent | null> | Intent | null;
}

/** 决策链：按顺序问，第一个给出高置信度答案的胜出。 */
export interface DecisionChainResult {
    intent: Intent | null;
    /** 谁做的决定。 */
    decidedBy: string;
    /** 尝试过的决策器与结果，用于诊断。 */
    trace: Array<{ name: string; outcome: 'hit' | 'miss' | 'error' | 'skipped'; detail?: string }>;
}

/** 置信度低于此值视为「没听懂」，应该澄清而不是执行。 */
export const CONFIDENCE_THRESHOLD = 0.6;
