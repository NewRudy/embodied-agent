// TTS 播报 —— 浏览器本地 speechSynthesis。
//
// 移植自巡界 player-demo/example/shared/speechOutput.ts。
// 作用不只是「说话」：它还向 RealtimeVoice 提供播报参考文本，
// 让回声过滤器知道哪些转写是人物自己在说话。
//
// 不用云端 TTS：本地播报没有网络延迟，且不产生额外费用。

export interface SpeechPlayback {
    status: 'idle' | 'queued' | 'speaking' | 'ended' | 'cancelled' | 'error';
    text: string;
    voice?: string;
    startedAt?: number;
    endedAt?: number;
    error?: string;
}

export interface SpeechOutputOptions {
    synthesis?: Pick<SpeechSynthesis, 'getVoices' | 'speak' | 'cancel'>;
    /** 自定义 utterance 构造（测试用）。 */
    createUtterance?(text: string): SpeechSynthesisUtterance;
    onState?(state: SpeechPlayback): void;
    /** 播报开始/结束通知，用于回声过滤。 */
    onPlaybackGate?(active: boolean, text: string): void;
    /** 语速，默认 1.05。 */
    rate?: number;
    /** 语言，默认 zh-CN。 */
    lang?: string;
}

/** 浏览器播报生命周期：提供回声参考文本，旧回调不能结束新播报的保护窗口。 */
export class SpeechOutput {
    private epoch = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private state: SpeechPlayback = { status: 'idle', text: '' };
    private readonly synthesis: Pick<SpeechSynthesis, 'getVoices' | 'speak' | 'cancel'> | null;
    private readonly options: SpeechOutputOptions;

    constructor(options: SpeechOutputOptions = {}) {
        this.options = options;
        // 非浏览器环境（Node / SSR / 单元测试）没有 speechSynthesis。
        // 静默降级为「不播报」，不能让整个装配失败。
        this.synthesis = options.synthesis
            ?? (typeof window !== 'undefined' && window.speechSynthesis ? window.speechSynthesis : null);
    }

    /** 当前环境是否支持播报。 */
    get supported(): boolean { return this.synthesis != null; }

    get current(): SpeechPlayback { return { ...this.state }; }

    cancel() {
        ++this.epoch; clearTimeout(this.timer);
        this.synthesis?.cancel();
        this.options.onPlaybackGate?.(false, this.state.text);
        if (['queued', 'speaking'].includes(this.state.status)) {
            this.publish({ ...this.state, status: 'cancelled', endedAt: Date.now() });
        }
    }

    speak(text: string) {
        if (!text.trim()) return;
        const synthesis = this.synthesis;
        if (!synthesis) return; // 无 TTS 环境：静默跳过
        this.cancel();
        const epoch = this.epoch;
        const utter = this.options.createUtterance?.(text) ?? new SpeechSynthesisUtterance(text);
        const voices = synthesis.getVoices();
        const lang = this.options.lang ?? 'zh-CN';
        const prefix = lang.slice(0, 2);
        utter.voice = voices.find(v => new RegExp(`^${prefix}[-_]`, 'i').test(v.lang) && v.localService)
            ?? voices.find(v => new RegExp(`^${prefix}[-_]`, 'i').test(v.lang))
            ?? voices.find(v => new RegExp(`^${prefix}`, 'i').test(v.lang))
            ?? null;
        utter.lang = lang;
        utter.rate = this.options.rate ?? 1.05;
        utter.pitch = 1;
        const base = { text, ...(utter.voice ? { voice: utter.voice.name } : {}) };
        let started = false;
        const finish = (status: 'ended' | 'error', error?: string) => {
            if (epoch !== this.epoch) return;
            clearTimeout(this.timer);
            this.options.onPlaybackGate?.(false, text);
            this.publish({ ...this.state, status, endedAt: Date.now(), ...(error ? { error } : {}) });
        };
        utter.onstart = () => {
            if (epoch !== this.epoch) return;
            started = true;
            clearTimeout(this.timer);
            this.publish({ ...base, status: 'speaking', startedAt: Date.now() });
            this.timer = setTimeout(() => {
                synthesis.cancel();
                finish('error', 'playback_timeout');
            }, Math.min(180_000, Math.max(10_000, text.length * 350 + 10_000)));
        };
        utter.onend = () => started ? finish('ended') : finish('error', 'playback_not_started');
        utter.onerror = event => finish('error', (event as SpeechSynthesisErrorEvent).error);
        this.options.onPlaybackGate?.(true, text);
        this.publish({ ...base, status: 'queued' });
        this.timer = setTimeout(() => {
            synthesis.cancel();
            finish('error', 'playback_not_started');
        }, 8000);
        try { synthesis.speak(utter); } catch { finish('error', 'playback_unavailable'); }
    }

    private publish(state: SpeechPlayback) {
        this.state = state;
        this.options.onState?.({ ...state });
    }
}
