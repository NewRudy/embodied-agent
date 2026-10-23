// 多步任务编排 —— 「先去 A 点，再去 B 点」。
//
// 为什么单独一层，不塞进意图解析：
//   意图解析回答的是「这一句要干什么」，而「先去 A 再去 B」是**一句话里的多个意图**，
//   它们有时间顺序。把顺序塞进解析器会让解析器变成调度器，两者都做不好。
//
// 设计要点：
//   1. 队列是**可中断**的 —— 用户随时能说「停」「别去 B 了」
//   2. 每一步结束（到达/失败）才推进，不会并行跑
//   3. 失败默认跳过继续下一步，可选「失败即中止」
//   4. 不碰渲染、不碰运动层 —— 它只决定「下一个目标是什么」

import type { Goal } from './types.ts';

export interface TaskStep {
    /** 这一步要去哪。 */
    goal: Goal;
    /** 步骤标签，用于日志与播报。 */
    label: string;
}

export interface TaskQueueOptions {
    /** 某一步失败后是否中止整条队列。默认 false（跳过继续）。 */
    abortOnFailure?: boolean;
    /** 队列推进回调。 */
    onAdvance?: (info: { index: number; step: TaskStep; total: number }) => void;
    /** 整条队列结束回调。 */
    onFinish?: (info: { completed: number; failed: number; aborted: boolean }) => void;
}

/**
 * 任务队列。
 *
 * 用法：
 *   const q = new TaskQueue({ onAdvance: i => agent.setGoal(i.step.goal) });
 *   q.enqueue([{ goal: gA, label: '去A点' }, { goal: gB, label: '去B点' }]);
 *   q.start();
 *   // 每帧在 agent.update() 之后：
 *   q.notify(out.justArrived, out.failure);
 */
export class TaskQueue {
    private readonly options: TaskQueueOptions;
    private steps: TaskStep[] = [];
    private index = -1;
    private running = false;
    private completed = 0;
    private failed = 0;

    constructor(options: TaskQueueOptions = {}) {
        this.options = options;
    }

    get isRunning(): boolean { return this.running; }
    get current(): TaskStep | null { return this.steps[this.index] ?? null; }
    get remaining(): number { return Math.max(0, this.steps.length - this.index - 1); }
    get total(): number { return this.steps.length; }

    /** 追加步骤。运行中追加会在末尾接上，不会打断当前步。 */
    enqueue(steps: TaskStep[]): void {
        this.steps.push(...steps);
    }

    /** 开始执行（从第一步起）。已在运行时是空操作。 */
    start(): void {
        if (this.running || this.steps.length === 0) return;
        this.running = true;
        this.index = 0;
        this.completed = 0;
        this.failed = 0;
        this.emitAdvance();
    }

    /**
     * 每帧在 agent.update() 之后调用。
     *
     * 为什么不用回调而是「通知」：运动层已经把到达/失败算出来了，
     * 队列再去监听就是重复计算，还容易和运动层状态不同步。
     */
    notify(justArrived: boolean, failure: string | null): void {
        if (!this.running) return;
        if (!justArrived && !failure) return;

        if (justArrived) {
            this.completed++;
        } else {
            this.failed++;
            if (this.options.abortOnFailure) {
                this.finish(true);
                return;
            }
        }
        this.next();
    }

    /** 取消整条队列。 */
    cancel(): void {
        if (!this.running) return;
        this.finish(false);
    }

    /** 清空并复位。 */
    reset(): void {
        this.steps = [];
        this.index = -1;
        this.running = false;
        this.completed = 0;
        this.failed = 0;
    }

    private next(): void {
        this.index++;
        if (this.index >= this.steps.length) {
            this.finish(false);
            return;
        }
        this.emitAdvance();
    }

    private emitAdvance(): void {
        const step = this.current;
        if (!step) return;
        this.options.onAdvance?.({ index: this.index, step, total: this.steps.length });
    }

    private finish(aborted: boolean): void {
        this.running = false;
        const info = { completed: this.completed, failed: this.failed, aborted };
        this.index = -1;
        this.options.onFinish?.(info);
    }
}

/**
 * 从一句话里切出多个步骤。
 *
 * 只认最明确的连接词：「先…再…」「然后」「接着」「之后」。
 * 不做语义理解 —— 那是模型层的事。这里切不开的句子整句交给意图层。
 *
 * 返回长度为 1 表示没有多步，调用方应按普通指令处理。
 */
export function splitSteps(text: string): string[] {
    const normalized = text.normalize('NFKC').trim();
    if (!normalized) return [];

    // 「先 X 再 Y 最后 Z」—— 按连接词切，保留各自的谓语
    const parts = normalized
        .split(/[，,]?\s*(?:然后|接着|之后|再|最后|顺便)/)
        .map(s => s.trim())
        .filter(Boolean);

    if (parts.length <= 1) return [normalized];

    // 第一段常带「先」，去掉它，否则「先去A点」的「先」会干扰解析
    // （实际不会，但保持文本干净更利于日志阅读）
    return parts.map(p => p.replace(/^先/, '').trim()).filter(Boolean);
}
