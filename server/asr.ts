// 豆包 Seed ASR 客户端（服务端）。
//
// 移植自巡界 engine/src/agent/voice.ts，协议未改：
//   浏览器采 PCM 16k → 本模块按 Seed 二进制帧打包 → WebSocket 发豆包 → 汇总定稿句。
//
// 凭据全走环境变量。不配置 = 功能显式未启用（不外呼、不落库、不报错崩溃）。

import { gzipSync, gunzipSync } from 'node:zlib';
import { connectWebSocket, WS_OPEN } from './ws-lite.ts';
import type { VoiceUtterance } from '../src/voice/protocol.ts';

// —— Seed 二进制帧协议 ——

const PROTOCOL_VERSION_AND_HEADER_SIZE = 0x11;
const FULL_CLIENT_REQUEST = 0x1;
const AUDIO_ONLY_REQUEST = 0x2;
const FULL_SERVER_RESPONSE = 0x9;
const SERVER_ERROR_RESPONSE = 0xf;
const NO_SEQUENCE = 0x0;
const LAST_PACKET_WITHOUT_SEQUENCE = 0x2;
const JSON_SERIALIZATION = 0x1;
const NO_SERIALIZATION = 0x0;
const GZIP_COMPRESSION = 0x1;

function packFrame(header: Buffer, payload: Buffer): Buffer {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(payload.length);
    return Buffer.concat([header, size, payload]);
}

/** 首帧：JSON 配置（gzip 压缩）。 */
export function buildFullClientRequest(request: Record<string, unknown>): Buffer {
    const payload = gzipSync(Buffer.from(JSON.stringify(request), 'utf8'));
    const header = Buffer.from([
        PROTOCOL_VERSION_AND_HEADER_SIZE,
        (FULL_CLIENT_REQUEST << 4) | NO_SEQUENCE,
        (JSON_SERIALIZATION << 4) | GZIP_COMPRESSION,
        0,
    ]);
    return packFrame(header, payload);
}

/** 音频帧（gzip）；final=true 发送空负载结束包。 */
export function buildAudioOnlyRequest(audio: Buffer, final = false): Buffer {
    const payload = gzipSync(audio);
    const flags = final ? LAST_PACKET_WITHOUT_SEQUENCE : NO_SEQUENCE;
    const header = Buffer.from([
        PROTOCOL_VERSION_AND_HEADER_SIZE,
        (AUDIO_ONLY_REQUEST << 4) | flags,
        (NO_SERIALIZATION << 4) | GZIP_COMPRESSION,
        0,
    ]);
    return packFrame(header, payload);
}

export interface SeedResponse {
    messageType: number;
    payload: Record<string, unknown> | null;
    errorCode: number | null;
    errorMessage: string | null;
    isLast: boolean;
}

/** 解析服务端帧（FULL_SERVER_RESPONSE / SERVER_ERROR_RESPONSE）。 */
export function parseServerResponse(frame: Buffer): SeedResponse {
    if (frame.length < 8) throw new Error('Seed frame shorter than header');
    const version = frame[0] >> 4;
    const headerSize = (frame[0] & 0x0f) * 4;
    if (version !== 1 || headerSize < 4 || frame.length < headerSize + 4) throw new Error('unsupported Seed header');
    const messageType = frame[1] >> 4;
    const flags = frame[1] & 0x0f;
    const serialization = frame[2] >> 4;
    const compression = frame[2] & 0x0f;
    let offset = headerSize;
    // flags & 0x1：带 4 字节序号，须跳过再读负载长度
    if ((flags & 0x1) !== 0) {
        if (frame.length < offset + 4) throw new Error('Seed frame missing sequence');
        offset += 4;
    }

    const readPayload = (): Buffer => {
        if (frame.length < offset + 4) throw new Error('Seed frame missing payload size');
        const size = frame.readUInt32BE(offset);
        if (size > frame.length - offset - 4) throw new Error('Seed frame truncated payload');
        const payload = frame.subarray(offset + 4, offset + 4 + size);
        if (compression === GZIP_COMPRESSION) return gunzipSync(payload, { maxOutputLength: 2 * 1024 * 1024 });
        if (compression !== 0) throw new Error('unsupported Seed compression');
        return Buffer.from(payload);
    };

    if (messageType === SERVER_ERROR_RESPONSE) {
        if (frame.length < offset + 8) throw new Error('Seed frame missing error payload');
        const errorCode = frame.readUInt32BE(offset);
        offset += 4; // 错误码之后才是负载长度
        let errorMessage = 'upstream ASR error';
        try {
            const decoded = JSON.parse(readPayload().toString('utf8')) as Record<string, unknown>;
            const msg = decoded.message ?? decoded.error;
            if (typeof msg === 'string' && msg) errorMessage = msg;
        } catch {
            /* 保留默认错误文案 */
        }
        return { messageType, payload: null, errorCode, errorMessage, isLast: true };
    }
    if (messageType !== FULL_SERVER_RESPONSE) throw new Error('unsupported Seed message type');
    const payload = readPayload();
    if (serialization !== JSON_SERIALIZATION) throw new Error('Seed result not JSON');
    const decoded = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
    return { messageType, payload: decoded, errorCode: null, errorMessage: null, isLast: (flags & 0x2) !== 0 };
}

// —— 配置 ——

export interface VoiceConfig {
    endpoint: string;
    resourceKey: { apiKey?: string; appKey?: string; accessKey?: string };
    resourceId: string;
    hotwordTableId?: string;
    correctTableId?: string;
}

/** 从环境变量读取 ASR 配置；未配置返回 null。 */
export function readVoiceConfig(): VoiceConfig | null {
    const endpoint = process.env.DOUBAO_ASR_ENDPOINT || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
    const resourceId = process.env.DOUBAO_ASR_RESOURCE_ID ?? '';
    const apiKey = process.env.DOUBAO_ASR_API_KEY ?? '';
    const appKey = process.env.DOUBAO_ASR_APP_KEY ?? '';
    const accessKey = process.env.DOUBAO_ASR_ACCESS_KEY ?? '';
    if (!resourceId) return null;
    if (!apiKey && !(appKey && accessKey)) return null;
    return {
        endpoint,
        resourceId,
        resourceKey: apiKey ? { apiKey } : { appKey, accessKey },
        ...(process.env.DOUBAO_ASR_HOTWORD_TABLE_ID ? { hotwordTableId: process.env.DOUBAO_ASR_HOTWORD_TABLE_ID } : {}),
        ...(process.env.DOUBAO_ASR_CORRECT_TABLE_ID ? { correctTableId: process.env.DOUBAO_ASR_CORRECT_TABLE_ID } : {}),
    };
}

export const voiceConfigured = (): boolean => readVoiceConfig() !== null;

/**
 * 句末静音判定窗口（毫秒）。
 *
 * 400 是火山默认值，实测说完→定稿稳定在 510~522ms。
 *
 * 试过 250：延迟没有变快（516~519ms），第三次还涨到 1393ms。
 * 说明这个值不是延迟的主导项 —— 上游的处理时间才是。
 * 所以别指望靠调它加速，默认 400 即可。
 *
 * 注意 `Number('') === 0`：环境变量设成空串会变成 0，等于「立刻定稿」，
 * 长句会被切碎。所以空串必须回落默认值，不能直接 Number()。
 */
export function endWindowMs(): number {
    const raw = process.env.DOUBAO_ASR_END_WINDOW_MS;
    if (raw == null || raw.trim() === '') return 400;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 300 || n > 5000) return 400;
    return Math.round(n);
}

/** 优化版本身支持实时结果，不能降级到不支持 Seed ASR 2.0 的旧 bigmodel 端点。 */
export function resolveVoiceStreamEndpoint(configuredEndpoint: string, explicitEndpoint?: string): string {
    return explicitEndpoint?.trim() || configuredEndpoint.replace(/\/bigmodel_nostream(?=$|[?#])/, '/bigmodel_async');
}

/** 双向流式结果既保留临时文本，也保留逐句定稿；句起始时间作为稳定去重键。 */
export function extractStreamingUtterances(
    payload: Record<string, unknown>,
    isLast = false,
): { text: string; utterances: VoiceUtterance[] } {
    const result = payload.result as Record<string, unknown> | undefined;
    if (!result) return { text: '', utterances: [] };
    const fullText = typeof result.text === 'string' ? result.text.trim().slice(-2000) : '';
    const raw = result.utterances;
    if (!Array.isArray(raw)) {
        return { text: fullText, utterances: fullText ? [{ id: 'last', text: fullText, final: isLast }] : [] };
    }
    const utterances: VoiceUtterance[] = raw.flatMap((u: unknown, index): VoiceUtterance[] => {
        if (!u || typeof u !== 'object') return [];
        const item = u as Record<string, unknown>;
        if (typeof item.text !== 'string' || !item.text.trim()) return [];
        const startMs = typeof item.start_time === 'number' && Number.isFinite(item.start_time) && item.start_time >= 0 ? item.start_time : undefined;
        const endMs = typeof item.end_time === 'number' && Number.isFinite(item.end_time) && item.end_time >= 0 ? item.end_time : undefined;
        return [{
            id: startMs == null ? `index-${index}` : `start-${startMs}`,
            text: item.text.trim().slice(0, 300),
            final: item.definite === true || isLast,
            ...(startMs == null ? {} : { startMs }),
            ...(endMs == null ? {} : { endMs }),
        }];
    });
    return { text: fullText, utterances };
}

export interface DoubaoStreamCallbacks {
    ready(): void;
    transcript(result: { text: string; utterances: VoiceUtterance[] }): void;
    error(code: string): void;
    ended(): void;
}

/** 活跃语音会话：约 100ms 原始 PCM 帧进入，不等待松开麦克风。连接/结束均幂等。 */
export function openDoubaoStream(requestId: string, callbacks: DoubaoStreamCallbacks) {
    const cfg = readVoiceConfig();
    if (!cfg) throw new Error('VOICE_NOT_CONFIGURED');
    const endpoint = resolveVoiceStreamEndpoint(cfg.endpoint, process.env.DOUBAO_ASR_STREAM_ENDPOINT);
    const ws = connectWebSocket(endpoint, {
        headers: {
            ...(cfg.resourceKey.apiKey
                ? { 'X-Api-Key': cfg.resourceKey.apiKey }
                : { 'X-Api-App-Key': cfg.resourceKey.appKey!, 'X-Api-Access-Key': cfg.resourceKey.accessKey! }),
            'X-Api-Resource-Id': cfg.resourceId,
            'X-Api-Request-Id': requestId,
            'X-Api-Connect-Id': requestId,
        },
        handshakeTimeoutMs: 10_000,
    });
    let closed = false;
    let finishing = false;
    const pending: Buffer[] = [];
    let pendingBytes = 0;
    let receivedFinal = false;
    const connectTimer = setTimeout(() => fail('ASR_CONNECT_TIMEOUT'), 12_000);
    const sessionTimer = setTimeout(() => fail('ASR_SESSION_LIMIT'), 5 * 60_000);
    let finishTimer: ReturnType<typeof setTimeout> | undefined;

    function cleanup() {
        clearTimeout(connectTimer);
        clearTimeout(sessionTimer);
        clearTimeout(finishTimer);
        pending.length = 0;
        pendingBytes = 0;
    }
    function fail(code: string, detail?: string) {
        if (closed) return;
        closed = true; cleanup(); ws.terminate(); callbacks.error(detail ? `${code}:${detail}` : code);
    }
    function end() {
        if (closed) return;
        closed = true; cleanup(); ws.close(); callbacks.ended();
    }
    function sendAudio(audio: Buffer, final = false) {
        if (ws.bufferedAmount > 128_000) return fail('ASR_BACKPRESSURE');
        ws.send(buildAudioOnlyRequest(audio, final));
    }

    ws.onerror = () => fail(`ASR_CONNECTION_FAILED${ws.handshakeStatus ? `_${ws.handshakeStatus}` : ''}`);
    ws.onclose = () => { if (receivedFinal || finishing) end(); else fail('ASR_DISCONNECTED'); };
    ws.onopen = () => {
        if (closed) return ws.terminate();
        clearTimeout(connectTimer);
        ws.send(buildFullClientRequest({
            user: { uid: requestId },
            audio: { format: 'pcm', codec: 'raw', rate: 16_000, bits: 16, channel: 1 },
            request: {
                model_name: 'bigmodel',
                enable_itn: true,
                enable_punc: true,
                show_utterances: true,
                result_type: 'full',
                enable_nonstream: false,
                force_to_speech_time: 0,
                // 静音多久判定「说完了」。默认 400ms，实测说完→定稿 520~560ms，
                // 其中 400ms 纯粹是在等你闭嘴。
                //
                // 250ms 把这段砍掉 150ms，代价是句中停顿超过 250ms 会被切成两句。
                // 对「走到 3 号风机」这类短指令没影响；说长句要留意。
                // 可用 DOUBAO_ASR_END_WINDOW_MS 覆盖。
                end_window_size: endWindowMs(),
                ...(cfg.hotwordTableId || cfg.correctTableId
                    ? {
                        corpus: {
                            ...(cfg.hotwordTableId ? { boosting_table_id: cfg.hotwordTableId } : {}),
                            ...(cfg.correctTableId ? { correct_table_id: cfg.correctTableId } : {}),
                        },
                    }
                    : {}),
            },
        }));
        for (const frame of pending) sendAudio(frame);
        pending.length = 0; pendingBytes = 0;
        if (finishing) sendAudio(Buffer.alloc(0), true);
        callbacks.ready();
    };
    ws.onmessage = (data: Buffer) => {
        if (closed) return;
        try {
            const frame = parseServerResponse(data);
            // 上游的 errorMessage 以前解析出来就丢了，只剩一个数字码 —— 排查时只能猜。
            // 现在带进日志，服务端 console 里能直接看到火山返回的原因。
            if (frame.errorCode != null) {
                console.warn(`[asr] 上游错误 ${frame.errorCode}: ${frame.errorMessage}`);
                return fail(`ASR_UPSTREAM_${frame.errorCode}`, frame.errorMessage ?? undefined);
            }
            const payloadCode = frame.payload?.code;
            if (typeof payloadCode === 'number' && payloadCode !== 1000 && payloadCode !== 0 && payloadCode !== 20000000) {
                const upstreamMsg = typeof frame.payload?.message === 'string' ? frame.payload.message : undefined;
                console.warn(`[asr] 上游 payload 错误 ${payloadCode}: ${upstreamMsg ?? '(无消息)'}`);
                return fail(`ASR_UPSTREAM_${payloadCode}`, upstreamMsg);
            }
            if (frame.payload) {
                // 排查用：上游每次结果都打一行，看 definite / isLast 到底有没有来。
                // 只在 VOICE_DEBUG=1 时输出，正常跑不刷屏。
                if (process.env.VOICE_DEBUG === '1') {
                    const raw = (frame.payload.result as { utterances?: Array<{ text?: string; definite?: boolean }> } | undefined)?.utterances;
                    console.log(`[asr:debug] isLast=${frame.isLast} utterances=${JSON.stringify(raw ?? null)}`);
                }
                callbacks.transcript(extractStreamingUtterances(frame.payload, frame.isLast));
            }
            if (frame.isLast) { receivedFinal = true; end(); }
        } catch {
            fail('ASR_PROTOCOL_FAILED');
        }
    };
    return {
        write(audio: Buffer) {
            if (closed || finishing) return;
            if (audio.length === 0 || audio.length % 2 || audio.length > 32_000) return fail('INVALID_PCM_FRAME');
            if (ws.readyState === WS_OPEN) sendAudio(audio);
            else {
                pendingBytes += audio.length;
                if (pendingBytes > 96_000) return fail('ASR_CONNECT_TIMEOUT');
                pending.push(Buffer.from(audio));
            }
        },
        finish() {
            if (closed || finishing) return;
            finishing = true;
            if (ws.readyState === WS_OPEN) sendAudio(Buffer.alloc(0), true);
            finishTimer = setTimeout(() => fail('ASR_FINISH_TIMEOUT'), 5000);
        },
        close() { if (!closed) { closed = true; cleanup(); ws.terminate(); } },
    };
}
