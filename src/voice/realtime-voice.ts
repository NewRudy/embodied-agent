// 持续语音客户端 —— 浏览器侧。
//
// 移植自巡界 player-demo/example/shared/realtimeVoice.ts。
// 链路：麦克风 → AudioWorklet（16k/16bit/mono，约 100ms 一帧）→ WebSocket → 后端 ASR。
//
// 三个必须保留的设计：
//   1. 凭据只在后端。浏览器只发原始 PCM，不碰供应商握手。
//   2. 全双工。播报时麦克风不关，靠 VoicePlaybackGuard 过滤回声。
//   3. epoch 守卫。快速开关时旧连接的回调不能污染新会话。

import {
    VoicePlaybackGuard,
    classifyPlaybackText,
    isPausePhrase,
} from './playback-guard.ts';
import type { VoiceInterruption, VoiceStreamEvent, VoiceUtterance } from './protocol.ts';

export type VoiceState = 'off' | 'connecting' | 'listening';

export interface VoiceCommandTiming {
    transcriptAt: number;
    /** 这句话在音频里结束的时刻（performance.now 基准）。 */
    speechEndAt?: number;
}

export const AUDIO_WORKLET_STARTUP_TIMEOUT_MS = 10_000;
const AUDIO_WORKLET_STARTUP_TIMEOUT = 'AUDIO_WORKLET_STARTUP_TIMEOUT';
const AUDIO_WORKLET_STARTUP_CANCELLED = 'AUDIO_WORKLET_STARTUP_CANCELLED';

/** 仅「停」「改口」允许从临时转写触发；普通移动只使用定稿句。 */
export function isImmediatePause(text: string, wakeWord?: string): boolean {
    return isPausePhrase(text, wakeWord);
}

export interface RealtimeVoiceOptions {
    /** 语音流 WebSocket 地址（wss://.../voice/stream）。 */
    url: string;
    /** AudioWorklet 处理器的 URL。 */
    workletUrl: string;
    /** 唤醒词。不配置则任何定稿句都直接执行。 */
    wakeWord?: string;
    onState(state: VoiceState): void;
    /** 临时转写（未定稿）。 */
    onPartial(text: string): void;
    /** 定稿命令。 */
    onCommand(text: string, timing: VoiceCommandTiming): void;
    onInterrupt?(event: VoiceInterruption): void;
    onError(message: string): void;
    /** 麦克风音量（0-1），用于 UI 反馈。 */
    onLevel?(level: number): void;
}

export class RealtimeVoice {
    private desired = false;
    private epoch = 0;
    private socket: WebSocket | null = null;
    private media: MediaStream | null = null;
    private context: AudioContext | null = null;
    private worklet: AudioWorkletNode | null = null;
    private source: MediaStreamAudioSourceNode | null = null;
    private streamReady = false;
    private audioStartAt: number | undefined;
    private sentSamples = 0;
    private discardBeforeMs = 0;
    private partialIds = new Set<string>();
    private finalIds = new Set<string>();
    private discardedIds = new Set<string>();
    private playbackBlockedIds = new Set<string>();
    private interruptedIds = new Set<string>();
    private acceptedInterruptions = new Map<string, { commandText: string; speechOnly: boolean }>();
    private connectTimer: ReturnType<typeof setTimeout> | undefined;
    private startupAbort: (() => void) | undefined;
    private state: VoiceState = 'off';
    private readonly playbackGuard: VoicePlaybackGuard;
    private readonly options: RealtimeVoiceOptions;

    constructor(options: RealtimeVoiceOptions) {
        this.options = options;
        this.playbackGuard = new VoicePlaybackGuard({ wakeWord: options.wakeWord });
    }

    get active() { return this.desired; }
    get currentState() { return this.state; }

    async toggle() { if (this.desired) this.stop(); else await this.start(); }

    /** 显式停止之后，停止前已在识别中的语句不能再启动动作；麦克风继续听下一句。 */
    discardPendingUtterances() {
        this.discardBeforeMs = Math.max(this.sentSamples / 16, this.audioStartAt == null ? 0 : performance.now() - this.audioStartAt);
        for (const id of new Set([...this.partialIds, ...this.playbackBlockedIds])) this.discard(id);
        this.partialIds.clear();
        this.playbackBlockedIds.clear();
        this.interruptedIds.clear();
        this.acceptedInterruptions.clear();
        this.options.onPartial('');
    }

    /** 播报期间仍发送真实 PCM；播报文本只用于有界回声过滤和可信打断。 */
    setPlayback(active: boolean, text = '') {
        if (active) {
            for (const id of this.partialIds) this.playbackBlockedIds.add(id);
            if (this.partialIds.size) { this.partialIds.clear(); this.options.onPartial(''); }
        }
        this.playbackGuard.setPlayback(active, text);
    }

    private discard(id: string) {
        this.remember(this.discardedIds, id);
    }

    private remember(set: Set<string>, id: string) {
        set.add(id);
        if (set.size > 512) set.delete(set.values().next().value!);
    }

    private setState(state: VoiceState) { if (state !== this.state) { this.state = state; this.options.onState(state); } }

    private utteranceTimes(u: VoiceUtterance): { startAt?: number; endAt?: number } {
        if (this.audioStartAt == null) return {};
        const elapsedMs = this.sentSamples / 16 + 200;
        const at = (value: number | undefined) => value != null && Number.isFinite(value) && value >= 0 && value <= elapsedMs
            ? this.audioStartAt! + value : undefined;
        return { startAt: at(u.startMs), endAt: at(u.endMs) };
    }

    private receiveUtterance(u: VoiceUtterance) {
        if (!u.text.trim()) return;
        if (u.final) {
            if (this.finalIds.has(u.id)) return;
            this.remember(this.finalIds, u.id);
        }
        if (this.discardedIds.has(u.id)) return;
        if (u.startMs != null && u.startMs < this.discardBeforeMs) return;
        const now = performance.now();
        const { startAt, endAt } = this.utteranceTimes(u);
        const wasPlaybackBlocked = this.playbackBlockedIds.has(u.id);
        if (wasPlaybackBlocked && !classifyPlaybackText(u.text, this.options.wakeWord)) {
            if (u.final) { this.discard(u.id); this.playbackBlockedIds.delete(u.id); this.partialIds.delete(u.id); this.options.onPartial(''); }
            return;
        }
        const accepted = this.interruptedIds.has(u.id) ? this.acceptedInterruptions.get(u.id) : undefined;
        const refreshed = accepted ? classifyPlaybackText(u.text, this.options.wakeWord) : undefined;
        if (accepted && u.final && !refreshed) {
            this.discard(u.id);
            this.interruptedIds.delete(u.id);
            this.acceptedInterruptions.delete(u.id);
            this.partialIds.delete(u.id);
            this.playbackBlockedIds.delete(u.id);
            this.options.onPartial('');
            return;
        }
        const decision = accepted
            ? { kind: 'pass' as const, commandText: refreshed?.commandText ?? accepted.commandText, speechOnly: refreshed?.speechOnly ?? accepted.speechOnly }
            : this.playbackGuard.observe({ utterance: u, now, startAt, endAt });
        if (decision.kind === 'drop') {
            if (!u.final) this.playbackBlockedIds.add(u.id);
            else this.discard(u.id);
            if (u.final) { this.partialIds.delete(u.id); this.options.onPartial(''); }
            return;
        }
        if (decision.kind === 'interrupt') {
            this.playbackBlockedIds.delete(u.id);
            this.interruptedIds.add(u.id);
            const acceptedDecision = { commandText: decision.commandText, speechOnly: decision.speechOnly };
            this.acceptedInterruptions.set(u.id, acceptedDecision);
            if (this.acceptedInterruptions.size > 512) this.acceptedInterruptions.delete(this.acceptedInterruptions.keys().next().value!);
            this.options.onInterrupt?.({ text: u.text, utteranceId: u.id, transcriptAt: now, reason: decision.reason });
        }
        if (!u.final) { this.partialIds.add(u.id); this.options.onPartial(u.text); return; }
        this.partialIds.delete(u.id);
        this.playbackBlockedIds.delete(u.id);
        let speechEndAt: number | undefined;
        if (this.audioStartAt != null && u.endMs != null && u.endMs > 0 && u.endMs <= this.sentSamples / 16 + 200) {
            const proposed = this.audioStartAt + u.endMs;
            if (proposed <= now + 100) speechEndAt = Math.min(proposed, now);
        }
        this.options.onPartial('');
        const commandText = decision.commandText.trim();
        if (!commandText || decision.speechOnly) return;
        this.options.onCommand(commandText, { transcriptAt: now, ...(speechEndAt == null ? {} : { speechEndAt }) });
    }

    async start() {
        if (this.desired) return;
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
            this.options.onError('实时语音需要在 localhost 或 HTTPS 中打开，并使用支持麦克风的浏览器。');
            return;
        }
        this.desired = true;
        this.playbackGuard.reset();
        const epoch = ++this.epoch;
        this.setState('connecting');
        try {
            const media = await navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
            if (!this.desired || epoch !== this.epoch) { media.getTracks().forEach(t => t.stop()); return; }
            this.media = media;
            const context = new AudioContext();
            this.context = context;
            let startupTimer: ReturnType<typeof setTimeout> | undefined;
            let cancelStartup: () => void = () => undefined;
            const startupCancelled = new Promise<never>((_, reject) => {
                cancelStartup = () => reject(new Error(AUDIO_WORKLET_STARTUP_CANCELLED));
            });
            const startupTimeout = new Promise<never>((_, reject) => {
                startupTimer = setTimeout(() => reject(new Error(AUDIO_WORKLET_STARTUP_TIMEOUT)), AUDIO_WORKLET_STARTUP_TIMEOUT_MS);
            });
            this.startupAbort = cancelStartup;
            try {
                await Promise.race([context.audioWorklet.addModule(this.options.workletUrl), startupCancelled, startupTimeout]);
            } finally {
                clearTimeout(startupTimer);
                if (this.startupAbort === cancelStartup) this.startupAbort = undefined;
            }
            if (!this.desired || epoch !== this.epoch) return;
            const source = context.createMediaStreamSource(media);
            const worklet = new AudioWorkletNode(context, 'embodied-pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
            this.source = source; this.worklet = worklet;
            this.audioStartAt = undefined; this.sentSamples = 0;
            this.discardBeforeMs = 0; this.partialIds.clear(); this.finalIds.clear(); this.discardedIds.clear();
            this.playbackBlockedIds.clear(); this.interruptedIds.clear(); this.acceptedInterruptions.clear();
            const socket = new WebSocket(this.options.url);
            socket.binaryType = 'arraybuffer';
            this.socket = socket;
            this.connectTimer = setTimeout(() => {
                if (epoch !== this.epoch || this.streamReady) return;
                this.options.onError('语音连接超时，请重新开启。'); this.stop();
            }, 15_000);
            worklet.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
                if (!this.desired || epoch !== this.epoch || !this.streamReady) return;
                const { pcm, rms } = event.data;
                this.options.onLevel?.(Math.min(1, rms * 12));
                if (socket.readyState !== WebSocket.OPEN) return;
                if (socket.bufferedAmount > 64_000) { this.options.onError('语音发送跟不上，请重新开启。'); this.stop(); return; }
                if (this.audioStartAt == null) this.audioStartAt = performance.now() - pcm.byteLength / 32;
                this.sentSamples += pcm.byteLength / 2;
                socket.send(pcm);
            };
            socket.onmessage = event => {
                if (!this.desired || epoch !== this.epoch) return;
                try {
                    const message = JSON.parse(String(event.data)) as VoiceStreamEvent;
                    if (message.type === 'ready') { clearTimeout(this.connectTimer); this.streamReady = true; this.setState('listening'); }
                    else if (message.type === 'transcript') for (const u of message.utterances) this.receiveUtterance(u);
                    else if (message.type === 'error') { this.options.onError(message.message); this.stop(); }
                    else if (message.type === 'ended') this.stop();
                } catch { this.options.onError('语音结果格式异常，请重新开启。'); this.stop(); }
            };
            socket.onerror = () => { if (epoch === this.epoch && this.desired) { this.options.onError('语音服务未连接，请检查后端或使用文字操控。'); this.stop(); } };
            socket.onclose = () => { if (epoch === this.epoch && this.desired) { this.options.onError('语音会话已结束，可以重新开启。'); this.stop(); } };
            media.getAudioTracks()[0]?.addEventListener('ended', () => { if (epoch === this.epoch) this.stop(); });
            source.connect(worklet); worklet.connect(context.destination);
            await context.resume();
        } catch (error) {
            if (epoch !== this.epoch) return;
            const name = error instanceof DOMException ? error.name : '';
            const message = error instanceof Error && error.message === AUDIO_WORKLET_STARTUP_TIMEOUT
                ? '语音音频模块启动超时，请重新开启。'
                : name === 'NotAllowedError' ? '麦克风权限未开启，请允许后再点击。' : '麦克风启动失败，请检查设备或浏览器权限。';
            this.options.onError(message);
            this.stop();
        }
    }

    stop() {
        if (!this.desired && !this.context && !this.socket) return;
        this.desired = false; ++this.epoch; this.streamReady = false;
        const cancelStartup = this.startupAbort;
        this.startupAbort = undefined;
        cancelStartup?.();
        this.playbackGuard.reset();
        clearTimeout(this.connectTimer);
        const socket = this.socket; this.socket = null;
        if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'finish' }));
            setTimeout(() => { if (socket.readyState !== WebSocket.CLOSED) socket.close(); }, 1200);
        } else socket?.close();
        this.worklet?.disconnect(); this.source?.disconnect();
        this.worklet = null; this.source = null;
        this.media?.getTracks().forEach(t => t.stop()); this.media = null;
        const context = this.context; this.context = null;
        if (context && context.state !== 'closed') void context.close().catch(() => undefined);
        this.options.onLevel?.(0); this.options.onPartial(''); this.setState('off');
    }
}
