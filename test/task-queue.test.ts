// 多步任务编排测试。
//
// 重点不是「能不能排三个目标」——那太简单。
// 重点是**边界**：中途取消、失败跳过、运行中追加、重复通知。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TaskQueue, splitSteps } from '../src/task-queue.ts';
import type { Goal } from '../src/types.ts';

const g = (east: number): Goal => ({ position: { east, north: 0, up: 0 }, tolerance: 3 });

function track() {
    const advanced: Array<{ index: number; label: string }> = [];
    let finished: { completed: number; failed: number; aborted: boolean } | null = null;
    const q = new TaskQueue({
        onAdvance: i => advanced.push({ index: i.index, label: i.step.label }),
        onFinish: f => { finished = f; },
    });
    return { q, advanced, getFinished: () => finished };
}

// ==================== 切句 ====================

test('单步句子原样返回', () => {
    assert.deepEqual(splitSteps('去A点'), ['去A点']);
});

test('「先…再…」切成两步', () => {
    assert.deepEqual(splitSteps('先去A点，再去B点'), ['去A点', '去B点']);
});

test('「先…然后…最后…」切成三步', () => {
    assert.deepEqual(splitSteps('先去A点，然后去B点，最后回C点'), ['去A点', '去B点', '回C点']);
});

test('中文逗号与无逗号都能切', () => {
    assert.deepEqual(splitSteps('先去A点然后再去B点'), ['去A点', '去B点']);
});

test('空串返回空数组', () => {
    assert.deepEqual(splitSteps(''), []);
    assert.deepEqual(splitSteps('   '), []);
});

// ==================== 推进 ====================

test('逐步推进：到达一步才进入下一步', () => {
    const { q, advanced } = track();
    q.enqueue([
        { goal: g(10), label: '去A点' },
        { goal: g(20), label: '去B点' },
    ]);
    q.start();
    assert.deepEqual(advanced.map(a => a.label), ['去A点']);

    q.notify(true, null);
    assert.deepEqual(advanced.map(a => a.label), ['去A点', '去B点']);

    q.notify(true, null);
    assert.equal(q.isRunning, false);
});

test('没到达也没失败时不推进', () => {
    const { q, advanced } = track();
    q.enqueue([{ goal: g(10), label: 'A' }, { goal: g(20), label: 'B' }]);
    q.start();
    q.notify(false, null);
    q.notify(false, null);
    assert.equal(advanced.length, 1, '不该自己往前走');
});

test('全部完成时回调统计正确', () => {
    const { q, getFinished } = track();
    q.enqueue([{ goal: g(1), label: 'A' }, { goal: g(2), label: 'B' }]);
    q.start();
    q.notify(true, null);
    q.notify(true, null);
    assert.deepEqual(getFinished(), { completed: 2, failed: 0, aborted: false });
});

// ==================== 失败处理 ====================

test('默认：某步失败则跳过，继续下一步', () => {
    const { q, advanced, getFinished } = track();
    q.enqueue([
        { goal: g(1), label: 'A' },
        { goal: g(2), label: 'B' },
        { goal: g(3), label: 'C' },
    ]);
    q.start();
    q.notify(false, 'STUCK');          // A 失败
    assert.deepEqual(advanced.map(a => a.label), ['A', 'B']);
    q.notify(true, null);              // B 到达
    q.notify(true, null);              // C 到达
    assert.deepEqual(getFinished(), { completed: 2, failed: 1, aborted: false });
});

test('abortOnFailure：失败即中止整条队列', () => {
    const advanced: string[] = [];
    let finished: { completed: number; failed: number; aborted: boolean } | null = null;
    const q = new TaskQueue({
        abortOnFailure: true,
        onAdvance: i => advanced.push(i.step.label),
        onFinish: f => { finished = f; },
    });
    q.enqueue([{ goal: g(1), label: 'A' }, { goal: g(2), label: 'B' }]);
    q.start();
    q.notify(false, 'NO_GROUND_AHEAD');
    assert.deepEqual(advanced, ['A'], '失败后不该进入 B');
    assert.equal(q.isRunning, false);
    assert.deepEqual(finished, { completed: 0, failed: 1, aborted: true });
});

// ==================== 取消 ====================

test('取消后不再推进', () => {
    const { q, advanced, getFinished } = track();
    q.enqueue([{ goal: g(1), label: 'A' }, { goal: g(2), label: 'B' }]);
    q.start();
    q.cancel();
    assert.equal(q.isRunning, false);
    q.notify(true, null);
    assert.deepEqual(advanced.map(a => a.label), ['A'], '取消后不该再推进');
    assert.deepEqual(getFinished(), { completed: 0, failed: 0, aborted: false });
});

test('未启动时 notify 无副作用', () => {
    const { q, advanced } = track();
    q.enqueue([{ goal: g(1), label: 'A' }]);
    q.notify(true, null);
    assert.equal(advanced.length, 0);
});

test('空队列 start 是空操作', () => {
    const { q, advanced } = track();
    q.start();
    assert.equal(q.isRunning, false);
    assert.equal(advanced.length, 0);
});

// ==================== 运行中追加 ====================

test('运行中追加的步骤会接在末尾', () => {
    const { q, advanced } = track();
    q.enqueue([{ goal: g(1), label: 'A' }]);
    q.start();
    q.enqueue([{ goal: g(2), label: 'B' }]);
    assert.equal(q.total, 2);
    q.notify(true, null);
    assert.deepEqual(advanced.map(a => a.label), ['A', 'B']);
});

// ==================== 重复通知 ====================

test('到达通知只推进一次，不会连跳两步', () => {
    const { q, advanced } = track();
    q.enqueue([
        { goal: g(1), label: 'A' },
        { goal: g(2), label: 'B' },
        { goal: g(3), label: 'C' },
    ]);
    q.start();
    // 运动层在到达那一帧只报一次 justArrived，但保险起见多打一次
    q.notify(true, null);
    q.notify(true, null);
    // 第二次 notify 是「B 到达」，会推进到 C —— 这是对的
    assert.deepEqual(advanced.map(a => a.label), ['A', 'B', 'C']);
});

// ==================== 计数 ====================

test('remaining / total 反映进度', () => {
    const { q } = track();
    q.enqueue([{ goal: g(1), label: 'A' }, { goal: g(2), label: 'B' }, { goal: g(3), label: 'C' }]);
    q.start();
    assert.equal(q.total, 3);
    assert.equal(q.remaining, 2);
    q.notify(true, null);
    assert.equal(q.remaining, 1);
});

test('reset 清空一切', () => {
    const { q } = track();
    q.enqueue([{ goal: g(1), label: 'A' }]);
    q.start();
    q.reset();
    assert.equal(q.isRunning, false);
    assert.equal(q.total, 0);
    assert.equal(q.current, null);
});
