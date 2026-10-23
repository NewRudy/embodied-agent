// 语音服务的可复用部分 —— 外部项目直接 import 这个。
//
// 用法（把语音挂到自己的 HTTP 服务上）：
//
//   import { createServer } from 'node:http';
//   import { attachVoiceStream } from 'embodied-agent/server';
//
//   const server = createServer(app);
//   attachVoiceStream(server);          // 挂 /voice/stream
//   server.listen(3000);
//
// 凭据从环境变量读（DOUBAO_ASR_*），见 .env.example。
// 不配置 = 语音显式未启用，不影响其他接口。

export { attachVoiceStream } from './voice-stream.ts';
export type { VoiceStreamOptions } from './voice-stream.ts';
export {
    openDoubaoStream,
    readVoiceConfig,
    resolveVoiceStreamEndpoint,
    voiceConfigured,
    buildFullClientRequest,
    buildAudioOnlyRequest,
    parseServerResponse,
    extractStreamingUtterances,
} from './asr.ts';
export type { VoiceConfig, SeedResponse, DoubaoStreamCallbacks } from './asr.ts';
export {
    acceptKey,
    acceptUpgrade,
    connectWebSocket,
    encodeFrame,
    FrameDecoder,
    OPCODE,
    WS_OPEN,
    WS_CLOSED,
} from './ws-lite.ts';
export type { Frame, ServerWebSocket, WebSocketLite } from './ws-lite.ts';

/** 只读配置状态，不含任何凭据 —— 供前端判断要不要显示麦克风按钮。 */
export function voiceStatus(): { voiceConfigured: boolean; streamPath: string } {
    const configured = Boolean(
        process.env.DOUBAO_ASR_RESOURCE_ID
        && (process.env.DOUBAO_ASR_API_KEY || (process.env.DOUBAO_ASR_APP_KEY && process.env.DOUBAO_ASR_ACCESS_KEY)),
    );
    return { voiceConfigured: configured, streamPath: '/voice/stream' };
}
