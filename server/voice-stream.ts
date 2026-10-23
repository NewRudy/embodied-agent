// 语音 WebSocket 代理 —— 服务端。
//
// 移植自巡界 engine/src/agent/voice-stream.ts。
//
// 存在的唯一理由：供应商凭据不能出现在浏览器里。
// 浏览器只发原始 PCM，本模块持有密钥、连豆包、把结果转成 JSON 事件回传。

import { randomUUID } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { acceptUpgrade, WS_OPEN, type ServerWebSocket } from './ws-lite.ts';
import { openDoubaoStream, voiceConfigured } from './asr.ts';
import type { VoiceStreamEvent } from '../src/voice/protocol.ts';

export interface VoiceStreamOptions {
    /** WebSocket 路径，默认 /voice/stream。 */
    path?: string;
    /** 访问密钥；配置后要求 URL 带 ?key=。 */
    accessKey?: string;
    /** 额外允许的 Origin（localhost 永远允许）。 */
    allowedOrigins?: string[];
}

/**
 * 把语音流挂到已有 HTTP 服务上。
 * 只升级语音路径，其余 upgrade 请求直接拒绝。
 */
export function attachVoiceStream(server: HttpServer, options: VoiceStreamOptions = {}) {
    const path = options.path ?? '/voice/stream';
    const accessKey = options.accessKey ?? process.env.VOICE_ACCESS_KEY ?? '';
    const configured = options.allowedOrigins
        ?? (process.env.VOICE_ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const clients = new Set<ServerWebSocket>();

    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (url.pathname !== path) {
            socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
            return;
        }
        if (accessKey && url.searchParams.get('key') !== accessKey) {
            socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            return;
        }
        const origin = request.headers.origin;
        let localOrigin = false;
        try {
            const parsed = new URL(origin ?? '');
            localOrigin = ['http:', 'https:'].includes(parsed.protocol)
                && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
        } catch { /* 浏览器必须带 Origin */ }
        if (!origin || (!localOrigin && !configured.includes(origin))) {
            // 这条最容易踩：Origin 不在白名单时连接直接被拒，
            // 浏览器侧只看到「连接已结束」，完全看不出是跨域问题。
            console.warn(`[voice] 拒绝连接：Origin=${origin ?? '(无)'}`);
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            return;
        }
        let client: ServerWebSocket;
        try {
            client = acceptUpgrade(socket, head, request);
        } catch {
            return; // acceptUpgrade 已回 400 并结束 socket
        }
        clients.add(client);
        client.onclose = () => clients.delete(client);
        handleConnection(client);
    });
    function handleConnection(client: ServerWebSocket) {
        const sessionId = `voice-${randomUUID()}`;
        const send = (event: VoiceStreamEvent) => {
            if (client.readyState === WS_OPEN) client.send(JSON.stringify(event));
        };
        if (!voiceConfigured()) {
            send({ type: 'error', code: 'VOICE_NOT_CONFIGURED', message: '语音尚未配置，可以使用文字操控。' });
            client.close();
            return;
        }
        const seen = new Set<string>();
        let finals = 0;
        const upstream = openDoubaoStream(sessionId, {
            ready: () => {
                console.log(`[voice] ${sessionId} 上游就绪`);
                send({ type: 'ready', sessionId });
            },
            transcript: result => {
                // 去重：同一句的临时结果会反复推送，定稿只处理一次
                const utterances = result.utterances.filter(u => {
                    if (seen.has(u.id)) return false;
                    if (u.id === 'last' && u.final && finals > 0) return false;
                    if (u.final) { seen.add(u.id); finals++; }
                    return true;
                });
                if (utterances.length) send({ type: 'transcript', sessionId, utterances, text: result.text });
            },
            error: code => {
                console.warn(`[voice] ${sessionId} 上游错误：${code}`);
                send({
                    type: 'error',
                    code,
                    message: code === 'ASR_SESSION_LIMIT'
                        ? '本轮持续语音已结束，请重新开启。'
                        : '语音连接中断，请重新开启或使用文字操控。',
                });
                client.close();
            },
            ended: () => { send({ type: 'ended', sessionId }); client.close(); },
        });

        client.onmessage = (data, binary) => {
            if (binary) { upstream.write(data); return; }
            try {
                const body = JSON.parse(data.toString('utf8')) as { type?: string };
                if (body.type === 'finish') upstream.finish();
                else {
                    send({ type: 'error', code: 'BAD_VOICE_MESSAGE', message: '语音输入格式无效。' });
                    upstream.close();
                    client.close();
                }
            } catch {
                upstream.close();
                client.close();
            }
        };
        client.onerror = () => upstream.close();
        client.onclose = () => upstream.close();
    }

    const shutdown = () => {
        for (const client of clients) client.terminate();
        clients.clear();
    };
    server.on('close', shutdown);

    return { path, configured: voiceConfigured(), close: shutdown };
}
