// 播报回声过滤 —— 全双工的核心难点。
//
// 移植自巡界 player-demo/example/shared/voicePlaybackGuard.ts。
// 场景：人物正在 TTS 播报，麦克风仍开着（全双工），ASR 会把自己播出来的声音
// 又识别成一句话。不处理的话，人物会「自己命令自己」。
//
// 做法：播报期间记录参考文本，把时间窗重叠且文本相似的转写判为回声丢弃。
// 但「停下」「停」这类短命令要穿透——用户在播报时喊停是最高优先级的。
//
// 边界：无法区分「同一句话的真人和回声」。这是物理限制，不是实现缺陷。

import type { VoiceInterruption, VoiceInterruptionReason, VoiceUtterance } from './protocol.ts';

export const PLAYBACK_TAIL_MS = 180;
export const PLAYBACK_REFERENCE_TTL_MS = 6_000;
const MAX_PLAYBACK_REFERENCES = 4;

export interface PlaybackObservation {
    utterance: VoiceUtterance;
    now: number;
    startAt?: number;
    endAt?: number;
}

export interface PlaybackCommand {
    commandText: string;
    /** true = 只用于打断播报，不产生动作。 */
    speechOnly: boolean;
    reason: VoiceInterruptionReason;
}

export type PlaybackDecision =
    | { kind: 'interrupt'; commandText: string; speechOnly: boolean; reason: VoiceInterruptionReason }
    | { kind: 'pass'; commandText: string; speechOnly: boolean }
    | { kind: 'drop' };

interface PlaybackReference {
    text: string;
    normalized: string;
    startedAt: number;
    endedAt?: number;
}

const trimPunctuation = (text: string): string => text.trim().replace(/[。！!？?，,、；;：:]+$/g, '').trim();

/**
 * 唤醒词处理。
 *
 * 巡界用「巡界」当唤醒词：句首出现就剥掉，并视为一次「主动打断播报」。
 * 本包把它做成可配置项 —— 不配置时不启用唤醒词，任何定稿句都直接执行。
 */
export function stripWakePrefix(text: string, wakeWord?: string): string | null {
    if (!wakeWord) return null;
    const t = text.normalize('NFKC').trim();
    if (t === wakeWord) return '';
    const match = t.match(new RegExp(`^${escapeRegExp(wakeWord)}(?:[，,、：:\\s]+)(.*)$`, 's'));
    if (match) return match[1].trim();
    return t.startsWith(wakeWord) ? t.slice(wakeWord.length).trim() : null;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 是否「停下」类短语。
 *
 * 这条规则必须最宽松：播报中被回声过滤掉的语音，如果是「停下」也要能穿透。
 * 误判的代价只是提前停一下，漏判的代价是用户喊停没反应。
 *
 * **同音误识要一并认。** 实测豆包（`tools/asr-probe.ts`，三次稳定复现）
 * 把「停一下」听成「听一下」—— 「停」和「听」同音，ASR 选了更常见的词。
 * 不认这个错法的话，用户喊停完全没反应，而这恰恰是最不能失灵的指令。
 * 「停下来」「站住」都能正确识别，所以只需要补这一条。
 */
export function isPausePhrase(text: string, wakeWord?: string): boolean {
    const stripped = stripWakePrefix(text, wakeWord);
    const t = trimPunctuation((stripped == null ? text : stripped).normalize('NFKC'));
    return /^(?:请|你)?(?:马上|立即|快|先)?(?:停下(?:来)?|停一下|听一下|停住|停|停止(?:移动|前进|走动)?|暂停(?:一下)?|别动|别走了|不要走了|站住|等一下)(?:[，,\s]|$)/.test(t)
        || /^(?:不对|算了|改成|换成|先别)(?:[，,\s]|$)/.test(t);
}

/** 播报期间的文本分类：是打断、是纯语音控制、还是普通命令。 */
export function classifyPlaybackText(text: string, wakeWord?: string): PlaybackCommand | null {
    const raw = trimPunctuation(text.normalize('NFKC'));
    const wake = stripWakePrefix(raw, wakeWord);
    const commandText = wake == null ? raw : wake;
    if (wake !== null && !commandText) return { commandText: '', speechOnly: true, reason: 'speech' };
    if (/^(?:请)?(?:别说了|停止播报|停止播放|别播了|听我说)$/.test(commandText)) {
        return { commandText: '', speechOnly: true, reason: 'speech' };
    }
    if (isPausePhrase(commandText, wakeWord)) return { commandText, speechOnly: false, reason: 'pause' };
    if (wake !== null) return { commandText, speechOnly: false, reason: 'speech' };
    return null;
}

export function isPlaybackInterruption(text: string, wakeWord?: string): boolean {
    return classifyPlaybackText(text, wakeWord) != null;
}

function normalizeEchoText(text: string): string {
    return text.normalize('NFKC').toLowerCase().replace(/[\s　。。！？!?，,、；;：:「」『』（）()【】[\]"“”‘’'`~～]+/g, '');
}

function textMatches(a: string, b: string): boolean {
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.length < 3 || b.length < 3) return false;
    return a.includes(b) || b.includes(a);
}

function rangesOverlap(startAt: number | undefined, endAt: number | undefined, ref: PlaybackReference, now: number): boolean {
    if (startAt == null && endAt == null) return false;
    const start = startAt ?? endAt!;
    const end = endAt ?? startAt!;
    const refEnd = ref.endedAt ?? now;
    return start <= refEnd && end >= ref.startedAt;
}

/**
 * 播报期间保持收音，把播报文本与有限时间窗用于回声过滤。
 * 不声称能区分同文真人和回声。
 */
export class VoicePlaybackGuard {
    private active = false;
    private tailUntil = 0;
    private current: PlaybackReference | null = null;
    private references: PlaybackReference[] = [];
    private readonly wakeWord?: string;

    constructor(options: { wakeWord?: string } = {}) {
        this.wakeWord = options.wakeWord;
    }

    setPlayback(active: boolean, text = '', now = performance.now()): void {
        this.prune(now);
        if (active) {
            const nextText = text.trim() || this.current?.text || '';
            if (this.active && this.current?.text === nextText) return;
            this.finishCurrent(now);
            this.active = true;
            this.tailUntil = 0;
            this.current = { text: nextText, normalized: normalizeEchoText(nextText), startedAt: now };
            return;
        }
        if (!this.active) return;
        this.finishCurrent(now);
        this.active = false;
        this.tailUntil = now + PLAYBACK_TAIL_MS;
    }

    reset(): void {
        this.active = false;
        this.tailUntil = 0;
        this.current = null;
        this.references = [];
    }

    observe(observation: PlaybackObservation): PlaybackDecision {
        const { utterance: u, now, startAt, endAt } = observation;
        this.prune(now);
        const candidate = classifyPlaybackText(u.text, this.wakeWord);
        const inWindow = this.active || now < this.tailUntil;
        const echo = this.isEcho(u.text, startAt, endAt, now);
        const overlapsPlayback = this.overlapsPlayback(startAt, endAt, now);
        const uncertainRecentSpeech = startAt == null && endAt == null && this.hasRecentPlaybackReference(now);
        if (candidate && !echo) {
            if (inWindow) return { kind: 'interrupt', ...candidate };
            return { kind: 'pass', commandText: candidate.commandText, speechOnly: candidate.speechOnly };
        }
        if (inWindow || echo || overlapsPlayback || uncertainRecentSpeech) return { kind: 'drop' };
        return candidate
            ? { kind: 'pass', commandText: candidate.commandText, speechOnly: candidate.speechOnly }
            : { kind: 'pass', commandText: u.text.trim(), speechOnly: false };
    }

    private finishCurrent(now: number): void {
        if (!this.current) return;
        this.references.push({ ...this.current, endedAt: now });
        this.references = this.references.slice(-MAX_PLAYBACK_REFERENCES);
        this.current = null;
    }

    private isEcho(text: string, startAt: number | undefined, endAt: number | undefined, now: number): boolean {
        const normalized = normalizeEchoText(text);
        if (!normalized) return false;
        const refs = this.current ? [this.current, ...this.references] : [...this.references];
        for (const ref of refs) {
            if (!textMatches(normalized, ref.normalized)) continue;
            if (rangesOverlap(startAt, endAt, ref, now)) return true;
            if (startAt == null && endAt == null && now - (ref.endedAt ?? ref.startedAt) <= PLAYBACK_REFERENCE_TTL_MS) return true;
        }
        return false;
    }

    private overlapsPlayback(startAt: number | undefined, endAt: number | undefined, now: number): boolean {
        if (startAt == null && endAt == null) return false;
        const refs = this.current ? [this.current, ...this.references] : [...this.references];
        return refs.some(ref => rangesOverlap(startAt, endAt, ref, now));
    }

    private hasRecentPlaybackReference(now: number): boolean {
        return this.current != null || this.references.some(ref => ref.endedAt != null && now - ref.endedAt <= PLAYBACK_REFERENCE_TTL_MS);
    }

    private prune(now: number): void {
        this.references = this.references.filter(ref => ref.endedAt == null || now - ref.endedAt <= PLAYBACK_REFERENCE_TTL_MS);
    }
}

export type { VoiceInterruption };
