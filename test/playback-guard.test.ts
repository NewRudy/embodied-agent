// 回声过滤与唤醒词测试。
//
// 这些用例证明「人物不会自己命令自己」。
// 它们不证明真实麦克风下的效果 —— 那必须靠现场说话验证。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    VoicePlaybackGuard,
    classifyPlaybackText,
    isPausePhrase,
    stripWakePrefix,
} from '../src/voice/playback-guard.ts';

const utter = (text: string, extra: Partial<{ id: string; final: boolean; startMs: number; endMs: number }> = {}) => ({
    id: extra.id ?? 'u1',
    text,
    final: extra.final ?? true,
    ...extra,
});

// —— 唤醒词 ——

test('无唤醒词时不剥任何前缀', () => {
    assert.equal(stripWakePrefix('去三号风机'), null);
});

test('有唤醒词时剥掉句首', () => {
    assert.equal(stripWakePrefix('小巡，去三号风机', '小巡'), '去三号风机');
    assert.equal(stripWakePrefix('小巡去三号风机', '小巡'), '去三号风机');
    assert.equal(stripWakePrefix('小巡', '小巡'), '');
});

test('唤醒词在句中不算', () => {
    assert.equal(stripWakePrefix('去小巡那儿', '小巡'), null);
});

// —— 停下短语 ——

test('停下类短语识别', () => {
    for (const t of ['停', '停下', '停下来', '停一下', '站住', '别动', '暂停', '等一下', '停止移动']) {
        assert.ok(isPausePhrase(t), `应识别：${t}`);
    }
});

test('普通移动不是停下', () => {
    for (const t of ['往前走十米', '去三号风机', '跑起来']) {
        assert.ok(!isPausePhrase(t), `不应识别：${t}`);
    }
});

test('「停车」不会被当成停下指令的误伤场景说明', () => {
    // 「停车场」以「停」开头但不是停下的意思；当前规则要求停后接分隔或结尾，
    // 所以「停车场」不匹配 —— 这是刻意的，宁可漏判也不误判成停下。
    assert.ok(!isPausePhrase('停车场'));
});

// —— 播报打断分类 ——

test('播报中说「停」是打断且要执行', () => {
    const r = classifyPlaybackText('停');
    assert.equal(r?.reason, 'pause');
    assert.equal(r?.speechOnly, false);
    assert.equal(r?.commandText, '停');
});

test('播报中说「别说了」只打断播报，不产生动作', () => {
    const r = classifyPlaybackText('别说了');
    assert.equal(r?.reason, 'speech');
    assert.equal(r?.speechOnly, true);
});

test('普通命令在播报期不算打断', () => {
    assert.equal(classifyPlaybackText('去三号风机'), null);
});

// —— 回声过滤 ——

test('播报期间的相似文本被判为回声丢弃', () => {
    const guard = new VoicePlaybackGuard();
    guard.setPlayback(true, '正在前往三号风机，大约需要一分钟', 1000);
    const d = guard.observe({
        utterance: utter('正在前往三号风机大约需要一分钟'),
        now: 1500,
        startAt: 1200,
        endAt: 1800,
    });
    assert.equal(d.kind, 'drop');
});

test('播报期间的「停」能穿透回声过滤', () => {
    const guard = new VoicePlaybackGuard();
    guard.setPlayback(true, '正在前往三号风机，大约需要一分钟', 1000);
    const d = guard.observe({ utterance: utter('停'), now: 1500, startAt: 1200, endAt: 1800 });
    assert.equal(d.kind, 'interrupt');
    assert.equal(d.kind === 'interrupt' && d.reason, 'pause');
});

test('播报结束后的短尾窗内仍然过滤回声', () => {
    const guard = new VoicePlaybackGuard();
    guard.setPlayback(true, '已到达三号风机', 1000);
    guard.setPlayback(false, '', 2000);
    // 尾窗 180ms 内
    const d = guard.observe({ utterance: utter('已到达三号风机'), now: 2100, startAt: 1900, endAt: 2050 });
    assert.equal(d.kind, 'drop');
});

test('没有播报时正常放行', () => {
    const guard = new VoicePlaybackGuard();
    const d = guard.observe({ utterance: utter('去三号风机'), now: 5000 });
    assert.equal(d.kind, 'pass');
    assert.equal(d.kind === 'pass' && d.commandText, '去三号风机');
});

test('唤醒词在播报期触发打断，且剥离后作为命令', () => {
    const guard = new VoicePlaybackGuard({ wakeWord: '小巡' });
    guard.setPlayback(true, '正在前往三号风机', 1000);
    const d = guard.observe({ utterance: utter('小巡，去五号风机'), now: 1500, startAt: 1200, endAt: 1800 });
    assert.equal(d.kind, 'interrupt');
    assert.equal(d.kind === 'interrupt' && d.commandText, '去五号风机');
    assert.equal(d.kind === 'interrupt' && d.reason, 'speech');
});

test('reset 之后不再过滤', () => {
    const guard = new VoicePlaybackGuard();
    guard.setPlayback(true, '正在前往三号风机', 1000);
    guard.reset();
    const d = guard.observe({ utterance: utter('正在前往三号风机'), now: 1100 });
    assert.equal(d.kind, 'pass');
});

// 实测（tools/asr-probe.ts，三次稳定复现）：
// 「停一下」被豆包听成「听一下」。「停」和「听」同音，ASR 选了更常见的词。
// 不认这个错法，用户喊停完全没反应 —— 这是最不能失灵的一条指令。
test('「听一下」作为「停一下」的同音误识被认作停下', () => {
    assert.equal(isPausePhrase('听一下'), true);
    assert.equal(isPausePhrase('听一下。'), true);
    assert.equal(isPausePhrase('听一下，前面有坑'), true, '带后文的也应当算停下');
});

test('但「听」开头的中性说法不能被误判成停下', () => {
    // 只有「听一下」这一个短说法认作误识，其余「听…」不动
    assert.equal(isPausePhrase('听我说'), false);
    assert.equal(isPausePhrase('听声音'), false);
    assert.equal(isPausePhrase('听一下这个声音'), false, '长了就不是误识，是真的在说别的');
});
