// WebSocket 最小实现的测试 —— 帧编解码 + 真实握手回环。
//
// 这里不测业务，只测「协议层没写错」。
// 语音链路的失败往往是静默的（帧切错 → 解析抛异常 → 连接断），
// 所以帧边界必须单独证明。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import net from 'node:net';

import {
    acceptKey,
    acceptUpgrade,
    connectWebSocket,
    encodeFrame,
    FrameDecoder,
    generateClientKey,
    OPCODE,
    WS_OPEN,
} from '../server/ws-lite.ts';

test('acceptKey 符合 RFC 6455 示例', () => {
    // RFC 6455 §1.3 的标准示例
    assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('解码器：一个完整帧', () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(encodeFrame(OPCODE.text, Buffer.from('hi'), false));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].opcode, OPCODE.text);
    assert.equal(frames[0].payload.toString(), 'hi');
});

test('解码器：字节流被切成两半也能拼回来', () => {
    const whole = encodeFrame(OPCODE.binary, Buffer.from([1, 2, 3, 4, 5]), false);
    const decoder = new FrameDecoder();
    assert.deepEqual(decoder.push(whole.subarray(0, 3)), []);
    const frames = decoder.push(whole.subarray(3));
    assert.equal(frames.length, 1);
    assert.deepEqual([...frames[0].payload], [1, 2, 3, 4, 5]);
});

test('解码器：一次收到三帧全部切出来', () => {
    const decoder = new FrameDecoder();
    const chunk = Buffer.concat([
        encodeFrame(OPCODE.text, Buffer.from('a'), false),
        encodeFrame(OPCODE.text, Buffer.from('bb'), false),
        encodeFrame(OPCODE.text, Buffer.from('ccc'), false),
    ]);
    const frames = decoder.push(chunk);
    assert.deepEqual(frames.map(f => f.payload.toString()), ['a', 'bb', 'ccc']);
});

test('解码器：126 长度的扩展头', () => {
    const payload = Buffer.alloc(300, 7);
    const frames = new FrameDecoder().push(encodeFrame(OPCODE.binary, payload, false));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].payload.length, 300);
    assert.equal(frames[0].payload[299], 7);
});

test('解码器：带掩码的客户端帧能解开', () => {
    const frames = new FrameDecoder().push(encodeFrame(OPCODE.binary, Buffer.from('masked'), true));
    assert.equal(frames[0].payload.toString(), 'masked');
});

test('编码：服务端帧不带掩码位', () => {
    const frame = encodeFrame(OPCODE.text, Buffer.from('x'), false);
    assert.equal(frame[1] & 0x80, 0);
});

test('编码：客户端帧带掩码位', () => {
    const frame = encodeFrame(OPCODE.text, Buffer.from('x'), true);
    assert.equal(frame[1] & 0x80, 0x80);
});

test('端到端：真实 HTTP 服务 + 双向收发', async () => {
    const server = createServer();
    const received: string[] = [];
    // 用 holder 而不是 let：赋值发生在回调里，TS 的控制流分析会把 let 收窄成 null
    const holder: { socket: ReturnType<typeof acceptUpgrade> | null } = { socket: null };

    server.on('upgrade', (req, socket, head) => {
        const serverSocket = acceptUpgrade(socket, head, req);
        holder.socket = serverSocket;
        serverSocket.onmessage = (data, binary) => {
            received.push(binary ? `<bin:${data.length}>` : data.toString());
            serverSocket.send(`echo:${binary ? data.length : data.toString()}`);
        };
    });

    server.listen(0);
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;

    const client = connectWebSocket(`ws://127.0.0.1:${port}/voice/stream`);
    await new Promise<void>((resolve, reject) => {
        client.onopen = () => resolve();
        client.onerror = e => reject(e);
    });
    assert.equal(client.readyState, WS_OPEN);

    const replies: string[] = [];
    client.onmessage = data => replies.push(data.toString());

    client.send('你好');
    client.send(Buffer.alloc(64, 1));
    await new Promise(r => setTimeout(r, 120));

    assert.deepEqual(received, ['你好', '<bin:64>']);
    assert.deepEqual(replies, ['echo:你好', 'echo:64']);

    client.close();
    await new Promise(r => setTimeout(r, 50));
    holder.socket?.terminate();
    server.close();
});

test('握手被拒绝时回调错误，不挂起', async () => {
    const server = createServer((_req, res) => { res.writeHead(401); res.end(); });
    server.listen(0);
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;

    const client = connectWebSocket(`ws://127.0.0.1:${port}/nope`);
    const error = await new Promise<Error>(resolve => { client.onerror = resolve; });
    assert.match(error.message, /WS_HTTP_401/);
    server.close();
});

// ==================== 长度上限 ====================
//
// 这两条防的是「声明一个巨大长度然后一直等」的攻击：
// 解码器会一直 Buffer.concat 到够一帧为止，没有上限就是 OOM。

test('解码器：127 扩展头声明超大长度 → 立刻报错，不继续攒', () => {
    // 手工构造一个声明 1GB 的帧头（FIN=1, opcode=binary, 127 长度）
    const header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(1024 * 1024 * 1024), 2);
    const decoder = new FrameDecoder();
    assert.throws(() => decoder.push(header), /WS_FRAME_TOO_LARGE/);
});

test('解码器：127 长度但没带够字节时先返回空（不误报）', () => {
    const header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(1024), 2);
    // 只给了头，没有负载 —— 应该安静地等，而不是抛异常
    assert.deepEqual(new FrameDecoder().push(header), []);
});

test('分片累积超上限 → 报错', async () => {
    // 直接连一个只做 acceptUpgrade 的服务端，发超量分片，确认收到 WS_MESSAGE_TOO_LARGE。
    //
    // 这里必须用裸 TCP 而不是 connectWebSocket：后者的 send() 永远发 FIN=1 的完整帧，
    // 造不出分片。手工握手 + 手工改 FIN 位才是唯一能测到 FragmentBuffer 的办法。
    const server = createServer();
    const errors: string[] = [];
    server.on('upgrade', (req, socket, head) => {
        const ws = acceptUpgrade(socket, head, req);
        ws.onerror = e => errors.push(e.message);
    });
    server.listen(0);
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;

    const socket = net.connect(port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write([
        'GET /x HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${generateClientKey()}`,
        '',
        '',
    ].join('\r\n'));
    // 等到 101 之后再发帧，否则可能和服务端握手写冲突
    await new Promise<void>(resolve => {
        let buf = '';
        const onData = (chunk: Buffer) => {
            buf += chunk.toString('latin1');
            if (buf.includes('\r\n\r\n')) {
                socket.off('data', onData);
                resolve();
            }
        };
        socket.on('data', onData);
    });

    /** 发一帧，可指定 FIN 与 opcode（客户端帧必须带掩码）。 */
    const sendFrame = (opcode: number, payload: Buffer, fin: boolean) => {
        const frame = encodeFrame(opcode, payload, true);
        frame[0] = (fin ? 0x80 : 0) | opcode;
        socket.write(frame);
    };

    // 单片 12MB 合法（< 16MB 单帧上限），三片合计 36MB > 32MB 消息上限。
    const chunk = Buffer.alloc(12 * 1024 * 1024, 1);
    sendFrame(OPCODE.binary, chunk, false);      // 首片，FIN=0
    sendFrame(OPCODE.continuation, chunk, false); // 续片，FIN=0
    sendFrame(OPCODE.continuation, chunk, true);  // 续片，FIN=1 → 累计超限

    await new Promise(r => setTimeout(r, 800));
    assert.deepEqual(errors, ['WS_MESSAGE_TOO_LARGE']);
    socket.destroy();
    server.close();
});
