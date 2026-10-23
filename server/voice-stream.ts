// 语音 WebSocket 代理 —— 服务端。
//
// 移植自巡界 engine/src/agent/voice-stream.ts。
//
// 存在的唯一理由：供应商凭据不能出现在浏览器里。
// 浏览器只发原始 PCM，本模块持有密钥、连豆包、把结果转成 JSON 事件回传。

import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { acceptUpgrade, WS_OPEN, type ServerWebSocket } from './ws-lite.ts';
import { openDoubaoStream, voiceConfigured } from './asr.ts';
import type { VoiceStreamEvent } from '../src/voice/protocol.ts';

export interface VoiceStreamOptions {
    /** WebSocket 路径，默认 /voice/stream。 */
    path?: string;
    /**
     * 访问密钥。配置后要求 URL 带 ?key=。
     *
     * **默认从环境变量 VOICE_ACCESS_KEY 读；两者都为空时拒绝启动语音流。**
     * 之前这里是「空 = 不鉴权」，等于默认裸奔：知道地址就能烧你的 ASR 额度。
     * 现在宁可让使用者显式设置 VOICE_ALLOW_ANONYMOUS=1 来接受这个风险。
     */
    accessKey?: string;
    /** 额外允许的 Origin（localhost 永远允许）。 */
    allowedOrigins?: string[];
    /** 最大并发语音会话数，默认 8。超出时新连接收到 BUSY 错误。 */
    maxConcurrent?: number;
    /** 单 IP 最大并发会话数，默认 3。 */
    maxPerIp?: number;
    /** 显式允许匿名访问（不校验 key）。仅用于内网/本地调试。 */
    allowAnonymous?: boolean;
}

const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_MAX_PER_IP = 3;

/**
 * 读正整数上限。
 *
 * 必须处理空串：`Number('') === 0`，如果直接 `Number(process.env.X ?? 8)`，
 * 一个 `VOICE_MAX_CONCURRENT=`（等号后没填）就会把上限变成 0，
 * 表现是「所有人都连不上」，而且日志里只看到「并发已达上限 0」，很难联想到是空变量。
 */
function positiveInt(value: string | number | undefined, fallback: number): number {
    if (value === undefined || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** 恒定时间字符串比较，避免按字节提前返回泄露长度/前缀信息。 */
function safeEqual(a: string, b: string): boolean {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    // 长度不同时也要走一次比较，避免长度本身成为旁路
    if (ba.length !== bb.length) {
        timingSafeEqual(ba, ba);
        return false;
    }
    return timingSafeEqual(ba, bb);
}

/** 取客户端 IP。优先 X-Forwarded-For 首段（反向代理场景），否则用 socket 地址。 */
function clientIp(request: IncomingMessage, socket: Duplex): string {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded) {
        return forwarded.split(',')[0]!.trim();
    }
    return (socket as Duplex & { remoteAddress?: string }).remoteAddress ?? 'unknown';
}

/**
 * 把语音流挂到已有 HTTP 服务上。
 * 只升级语音路径，其余 upgrade 请求直接拒绝。
 */
export function attachVoiceStream(server: HttpServer, options: VoiceStreamOptions = {}) {
    const path = options.path ?? '/voice/stream';
    const accessKey = options.accessKey ?? process.env.VOICE_ACCESS_KEY ?? '';
    const allowAnonymous = options.allowAnonymous ?? process.env.VOICE_ALLOW_ANONYMOUS === '1';
    const maxConcurrent = options.maxConcurrent ?? positiveInt(process.env.VOICE_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT);
    const maxPerIp = options.maxPerIp ?? positiveInt(process.env.VOICE_MAX_PER_IP, DEFAULT_MAX_PER_IP);
    const configured = options.allowedOrigins
        ?? (process.env.VOICE_ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const clients = new Set<ServerWebSocket>();
    /** 每个 IP 当前活跃会话数。断开时递减。 */
    const perIp = new Map<string, number>();

    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (url.pathname !== path) {
            socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
            return;
        }

        // —— 鉴权 ——
        // 没有配置 key 且没有显式允许匿名 → 直接拒绝。
        // 这是刻意的：语音流会消耗真金白银的 ASR 额度，默认必须是「关」。
        if (!accessKey && !allowAnonymous) {
            console.warn('[voice] 拒绝连接：未配置 VOICE_ACCESS_KEY，且未显式允许匿名');
            socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            return;
        }
        if (accessKey && !safeEqual(url.searchParams.get('key') ?? '', accessKey)) {
            socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            return;
        }

        // —— 并发上限 ——
        // 每个客户端会开一条豆包上游连接，按分钟计费。
        // 不设上限的话，一个脚本起 100 个并发就能把额度烧穿。
        if (clients.size >= maxConcurrent) {
            console.warn(`[voice] 拒绝连接：并发已达上限 ${maxConcurrent}`);
            socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
            return;
        }
        const ip = clientIp(request, socket);
        const ipCount = perIp.get(ip) ?? 0;
        if (ipCount >= maxPerIp) {
            console.warn(`[voice] 拒绝连接：IP ${ip} 并发已达上限 ${maxPerIp}`);
            socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
            return;
        }

        // —— Origin ——
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
        perIp.set(ip, ipCount + 1);
        // 释放槽位。**幂等**：onclose 可能因为链式赋值被调用多次，
        // 计数多减一次会让上限失效（两条连接断一条就把计数清零）。
        let released = false;
        const releaseSlot = () => {
            if (released) return;
            released = true;
            clients.delete(client);
            const n = (perIp.get(ip) ?? 1) - 1;
            if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
        };
        client.onclose = releaseSlot;
        handleConnection(client, releaseSlot);
    });

    function handleConnection(client: ServerWebSocket, releaseSlot: () => void) {
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
        // 链式赋值，不能直接覆盖 —— releaseSlot 还挂在 client.onclose 上。
        // 覆盖掉它 = 槽位永不释放 = 连过一次之后所有人都连不上。
        const beforeUpstreamClose = client.onclose;
        client.onclose = () => { upstream.close(); beforeUpstreamClose?.(); };
        // releaseSlot 参数在这里没有直接用到（它已经通过上面的 onclose 链挂好），
        // 保留参数是为了让「谁负责释放」在调用点一眼可见。
        void releaseSlot;
    }

    const shutdown = () => {
        for (const client of clients) client.terminate();
        clients.clear();
    };
    server.on('close', shutdown);

    return { path, configured: voiceConfigured(), close: shutdown };
}
