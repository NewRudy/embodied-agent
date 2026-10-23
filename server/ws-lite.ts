// 最小 WebSocket 实现 —— 只为语音链路服务。
//
// 为什么不用 ws 包：
//   1. 本包的目标是「引入即用」，零运行时依赖比多一个包更值钱。
//   2. Node 24 自带的 WebSocket 不支持自定义 header，而豆包 ASR 必须带鉴权头。
//
// 实现范围刻意最小：文本/二进制帧、分片、ping/pong、close。
// 不支持扩展协商（permessage-deflate）—— 豆包不需要，我们自己也不用。
//
// 注意：这里只做协议编解码和握手，不做重连、不做心跳定时器。
// 上层（asr.ts / voice-stream.ts）自己管生命周期。

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE = {
    continuation: 0x0,
    text: 0x1,
    binary: 0x2,
    close: 0x8,
    ping: 0x9,
    pong: 0xa,
} as const;

/** 计算服务端握手应答值。 */
export function acceptKey(clientKey: string): string {
    return createHash('sha1').update(clientKey + GUID).digest('base64');
}

/** 生成客户端握手用的随机 key。 */
export function generateClientKey(): string {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
}

// —— 帧编码 ——

/** 编码一帧。mask=true 时按客户端要求加掩码。 */
export function encodeFrame(opcode: number, payload: Buffer, mask: boolean): Buffer {
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN=1
    if (!mask) {
        return Buffer.concat([header, payload]);
    }
    header[1] |= 0x80;
    const key = crypto.getRandomValues(new Uint8Array(4));
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ key[i & 3];
    return Buffer.concat([header, Buffer.from(key), masked]);
}

export interface Frame {
    opcode: number;
    payload: Buffer;
    fin: boolean;
}

/**
 * 增量帧解码器。
 *
 * TCP 不保证消息边界：一次 data 事件可能带来半个帧，也可能带来三个帧。
 * 所以必须攒够再切，不能假设一次读完。
 */
export class FrameDecoder {
    private buffer: Buffer = Buffer.alloc(0);

    /** 喂入新数据，返回本次能完整解析出的帧。 */
    push(chunk: Buffer): Frame[] {
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
        const frames: Frame[] = [];
        for (;;) {
            const frame = this.tryReadFrame();
            if (!frame) break;
            frames.push(frame);
        }
        return frames;
    }

    private tryReadFrame(): Frame | null {
        const buf = this.buffer;
        if (buf.length < 2) return null;
        const fin = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let offset = 2;

        if (len === 126) {
            if (buf.length < offset + 2) return null;
            len = buf.readUInt16BE(offset);
            offset += 2;
        } else if (len === 127) {
            if (buf.length < offset + 8) return null;
            const big = buf.readBigUInt64BE(offset);
            if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WS_FRAME_TOO_LARGE');
            len = Number(big);
            offset += 8;
        }

        let key: Buffer | null = null;
        if (masked) {
            if (buf.length < offset + 4) return null;
            key = buf.subarray(offset, offset + 4);
            offset += 4;
        }
        if (buf.length < offset + len) return null;

        let payload = buf.subarray(offset, offset + len);
        if (key) {
            const unmasked = Buffer.alloc(len);
            for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ key[i & 3];
            payload = unmasked;
        } else {
            payload = Buffer.from(payload); // 脱离原 buffer，避免持有大块内存
        }
        this.buffer = buf.subarray(offset + len);
        return { opcode, payload, fin };
    }
}

// —— 客户端 ——

export interface WebSocketLite {
    send(data: Buffer | string): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    readonly readyState: number;
    readonly bufferedAmount: number;
    onopen?: () => void;
    onmessage?: (data: Buffer) => void;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    /** 握手阶段的 HTTP 状态码（非 101 时用于报错）。 */
    readonly handshakeStatus?: number;
}

export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const WS_CLOSED = 3;

export interface ConnectOptions {
    headers?: Record<string, string>;
    handshakeTimeoutMs?: number;
}

/**
 * 建立 WebSocket 连接。
 *
 * 用 node:http/https 的 upgrade 事件，而不是手搓 TLS：
 * 握手、证书、SNI 全部交给标准库，我们只处理升级之后的帧。
 */
export function connectWebSocket(url: string, options: ConnectOptions = {}): WebSocketLite {
    const parsed = new URL(url);
    const secure = parsed.protocol === 'wss:';
    const key = generateClientKey();
    const doRequest = secure ? httpsRequest : httpRequest;
    const path = `${parsed.pathname || '/'}${parsed.search}`;

    let socket: Duplex | null = null;
    let state: number = WS_CONNECTING;
    let handshakeStatus: number | undefined;
    let buffered = 0;
    const decoder = new FrameDecoder();
    let fragmentOpcode: number | null = null;
    let fragments: Buffer[] = [];

    const api: WebSocketLite = {
        get readyState() { return state; },
        get bufferedAmount() { return buffered; },
        get handshakeStatus() { return handshakeStatus; },
        send(data) {
            if (state !== WS_OPEN || !socket) return;
            const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
            const frame = encodeFrame(typeof data === 'string' ? OPCODE.text : OPCODE.binary, payload, true);
            buffered += frame.length;
            socket.write(frame, () => { buffered = Math.max(0, buffered - frame.length); });
        },
        close(code = 1000, reason = '') {
            if (state !== WS_OPEN || !socket) { api.terminate(); return; }
            state = WS_CLOSING;
            const body = Buffer.alloc(2 + Buffer.byteLength(reason));
            body.writeUInt16BE(code, 0);
            body.write(reason, 2);
            socket.write(encodeFrame(OPCODE.close, body, true));
            socket.end();
        },
        terminate() {
            state = WS_CLOSED;
            socket?.destroy();
        },
    };

    const req = doRequest({
        hostname: parsed.hostname,
        port: parsed.port || (secure ? 443 : 80),
        path,
        method: 'GET',
        headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': key,
            ...(options.headers ?? {}),
        },
    });

    const timeout = setTimeout(() => {
        if (state === WS_CONNECTING) {
            state = WS_CLOSED;
            req.destroy();
            api.onerror?.(new Error('WS_HANDSHAKE_TIMEOUT'));
        }
    }, options.handshakeTimeoutMs ?? 10_000);

    req.on('upgrade', (res: IncomingMessage, sock: Duplex, head: Buffer) => {
        clearTimeout(timeout);
        socket = sock;
        if (res.headers['sec-websocket-accept'] !== acceptKey(key)) {
            state = WS_CLOSED;
            sock.destroy();
            api.onerror?.(new Error('WS_BAD_ACCEPT'));
            return;
        }
        state = WS_OPEN;
        (sock as Duplex & { setNoDelay?: (v: boolean) => void }).setNoDelay?.(true);
        sock.on('data', (chunk: Buffer) => {
            let frames: Frame[];
            try {
                frames = decoder.push(chunk);
            } catch (e) {
                api.onerror?.(e instanceof Error ? e : new Error('WS_DECODE_FAILED'));
                api.terminate();
                return;
            }
            for (const frame of frames) handleFrame(frame);
        });
        sock.on('error', (e: Error) => { api.onerror?.(e); });
        sock.on('close', () => {
            state = WS_CLOSED;
            api.onclose?.();
        });
        if (head?.length) {
            for (const frame of decoder.push(head)) handleFrame(frame);
        }
        api.onopen?.();
    });

    req.on('response', (res: IncomingMessage) => {
        // 非 101：服务端明确拒绝（鉴权失败、路径错误等）
        clearTimeout(timeout);
        handshakeStatus = res.statusCode;
        state = WS_CLOSED;
        res.resume();
        api.onerror?.(new Error(`WS_HTTP_${res.statusCode}`));
    });

    req.on('error', (e: Error) => {
        clearTimeout(timeout);
        if (state !== WS_CLOSED) {
            state = WS_CLOSED;
            api.onerror?.(e);
        }
    });

    req.end();

    function handleFrame(frame: Frame) {
        switch (frame.opcode) {
            case OPCODE.ping:
                if (socket && state === WS_OPEN) socket.write(encodeFrame(OPCODE.pong, frame.payload, true));
                return;
            case OPCODE.pong:
                return;
            case OPCODE.close:
                state = WS_CLOSED;
                socket?.end();
                api.onclose?.();
                return;
            case OPCODE.continuation:
                if (fragmentOpcode == null) return;
                fragments.push(frame.payload);
                if (frame.fin) {
                    const whole = Buffer.concat(fragments);
                    const op = fragmentOpcode;
                    fragments = [];
                    fragmentOpcode = null;
                    if (op === OPCODE.text || op === OPCODE.binary) api.onmessage?.(whole);
                }
                return;
            default: {
                if (!frame.fin) {
                    fragmentOpcode = frame.opcode;
                    fragments = [frame.payload];
                    return;
                }
                api.onmessage?.(frame.payload);
            }
        }
    }

    return api;
}

// —— 服务端 ——

export interface ServerWebSocket {
    send(data: Buffer | string): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    readonly readyState: number;
    onmessage?: (data: Buffer, binary: boolean) => void;
    onclose?: () => void;
    onerror?: (error: Error) => void;
}

/**
 * 在已升级的 socket 上完成服务端握手。
 *
 * 调用方负责判断路径/来源/鉴权，本函数只管协议层。
 */
export function acceptUpgrade(socket: Duplex, head: Buffer, request: IncomingMessage): ServerWebSocket {
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string' || !key) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        throw new Error('WS_MISSING_KEY');
    }
    socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey(key)}`,
        '',
        '',
    ].join('\r\n'));
    (socket as Duplex & { setNoDelay?: (v: boolean) => void }).setNoDelay?.(true);

    let state = WS_OPEN;
    const decoder = new FrameDecoder();
    let fragmentOpcode: number | null = null;
    let fragments: Buffer[] = [];

    const api: ServerWebSocket = {
        get readyState() { return state; },
        send(data) {
            if (state !== WS_OPEN) return;
            const isText = typeof data === 'string';
            const payload = isText ? Buffer.from(data, 'utf8') : data;
            // 服务端帧不加掩码（RFC 6455 §5.1）
            socket.write(encodeFrame(isText ? OPCODE.text : OPCODE.binary, payload, false));
        },
        close(code = 1000, reason = '') {
            if (state !== WS_OPEN) { socket.destroy(); return; }
            state = WS_CLOSING;
            const body = Buffer.alloc(2 + Buffer.byteLength(reason));
            body.writeUInt16BE(code, 0);
            body.write(reason, 2);
            socket.write(encodeFrame(OPCODE.close, body, false));
            socket.end();
        },
        terminate() { state = WS_CLOSED; socket.destroy(); },
    };

    socket.on('data', (chunk: Buffer) => {
        let frames: Frame[];
        try {
            frames = decoder.push(chunk);
        } catch (e) {
            api.onerror?.(e instanceof Error ? e : new Error('WS_DECODE_FAILED'));
            api.terminate();
            return;
        }
        for (const frame of frames) handleFrame(frame);
    });
    socket.on('error', (e: Error) => api.onerror?.(e));
    socket.on('close', () => {
        if (state !== WS_CLOSED) { state = WS_CLOSED; api.onclose?.(); }
    });
    if (head?.length) {
        for (const frame of decoder.push(head)) handleFrame(frame);
    }

    function handleFrame(frame: Frame) {
        switch (frame.opcode) {
            case OPCODE.ping:
                if (state === WS_OPEN) socket.write(encodeFrame(OPCODE.pong, frame.payload, false));
                return;
            case OPCODE.pong:
                return;
            case OPCODE.close:
                state = WS_CLOSED;
                socket.end(encodeFrame(OPCODE.close, frame.payload.subarray(0, 2), false));
                api.onclose?.();
                return;
            case OPCODE.continuation:
                if (fragmentOpcode == null) return;
                fragments.push(frame.payload);
                if (frame.fin) {
                    const whole = Buffer.concat(fragments);
                    const op = fragmentOpcode;
                    fragments = [];
                    fragmentOpcode = null;
                    if (op === OPCODE.text || op === OPCODE.binary) api.onmessage?.(whole, op === OPCODE.binary);
                }
                return;
            default:
                if (!frame.fin) {
                    fragmentOpcode = frame.opcode;
                    fragments = [frame.payload];
                    return;
                }
                api.onmessage?.(frame.payload, frame.opcode === OPCODE.binary);
        }
    }

    return api;
}
