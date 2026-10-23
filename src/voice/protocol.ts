// 语音协议类型 —— 浏览器端与服务端共用。
//
// 移植自巡界（contracts/avatar-control.ts），去掉业务字段，只保留语音流本身。

/** 一句识别结果。 */
export interface VoiceUtterance {
    /** 稳定去重键：句起始时间（毫秒）或 index-N。 */
    id: string;
    text: string;
    /** true = 这句话已经定稿，可以驱动动作；false = 临时转写。 */
    final: boolean;
    /** 相对本轮语音起始的毫秒偏移。 */
    startMs?: number;
    endMs?: number;
}

/** 服务端 → 浏览器的消息。 */
export type VoiceStreamEvent =
    | { type: 'ready'; sessionId: string }
    | { type: 'transcript'; sessionId: string; utterances: VoiceUtterance[]; text: string }
    | { type: 'error'; code: string; message: string }
    | { type: 'ended'; sessionId: string };

/** 浏览器 → 服务端的控制消息（音频走二进制帧）。 */
export type VoiceClientMessage = { type: 'finish' };

/** 打断原因。 */
export type VoiceInterruptionReason = 'pause' | 'speech';

/** 播报期间被接受的一次打断。 */
export interface VoiceInterruption {
    text: string;
    utteranceId: string;
    transcriptAt: number;
    reason: VoiceInterruptionReason;
}
