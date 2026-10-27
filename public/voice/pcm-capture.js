/* 16000Hz / 16bit / mono，40ms 一帧；兼容 48k/44.1k 设备，输出通道静音。
 *
 * 移植自巡界 example/public/voice/pcm-capture.js。
 * 只做一件事：把浏览器采样率重采样到 ASR 要求的 16k，切成 640 采样点一帧。
 *
 * 重采样用线性插值 —— 语音识别对相位不敏感，够用且零依赖。
 *
 * 帧长为什么是 40ms 而不是原来的 100ms：
 * 说完最后一个字之后，剩余音频要等当前帧攒满才发出去 —— 平均白等半帧。
 * 100ms 帧平均白等 50ms，40ms 帧平均白等 20ms。实测端到端 571ms，
 * 这 30ms 是其中唯一能靠本包优化掉的部分（其余都在 ASR 上游）。
 * 再往下切收益递减：帧越小，WebSocket 包越多，而 ASR 本身有最小处理粒度。
 */
/** 每帧采样点数。640 / 16000 = 40ms。 */
const FRAME_SAMPLES = 640;

class EmbodiedPcmCapture extends AudioWorkletProcessor {
    constructor() {
        super();
        this.ratio = sampleRate / 16000;
        this.phase = 0;
        this.previous = 0;
        this.buffer = new Int16Array(FRAME_SAMPLES);
        this.offset = 0;
        this.squareSum = 0;
    }
    process(inputs, outputs) {
        for (const channel of outputs[0] || []) channel.fill(0);
        const input = inputs[0]?.[0];
        if (!input) return true;
        for (let i = 0; i < input.length; i++) {
            const current = input[i];
            this.phase += 1;
            if (this.phase >= this.ratio) {
                this.phase -= this.ratio;
                const blend = 1 - Math.min(1, this.phase);
                const value = Math.max(-1, Math.min(1, this.previous + (current - this.previous) * blend));
                this.squareSum += value * value;
                this.buffer[this.offset++] = Math.round(value < 0 ? value * 32768 : value * 32767);
                if (this.offset === this.buffer.length) {
                    const pcm = this.buffer.buffer;
                    this.port.postMessage({ pcm, rms: Math.sqrt(this.squareSum / this.buffer.length) }, [pcm]);
                    this.buffer = new Int16Array(FRAME_SAMPLES);
                    this.offset = 0;
                    this.squareSum = 0;
                }
            }
            this.previous = current;
        }
        return true;
    }
}
registerProcessor('embodied-pcm-capture', EmbodiedPcmCapture);
