// WebSocket 最小实现的测试 —— 帧编解码 + 真实握手回环。
//
// 这里不测业务，只测「协议层没写错」。
// 语音链路的失败往往是静默的（帧切错 → 解析抛异常 → 连接断），
// 所以帧边界必须单独证明。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import {
    acceptKey,
    acceptUpgrade,
    connectWebSocket,
    encodeFrame,
    FrameDecoder,
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
    let serverSocket: Awaited<ReturnType<typeof acceptUpgrade>> | null = null;

    server.on('upgrade', (req, socket, head) => {
        serverSocket = acceptUpgrade(socket, head, req);
        serverSocket.onmessage = (data, binary) => {
            received.push(binary ? `<bin:${data.length}>` : data.toString());
            serverSocket!.send(`echo:${binary ? data.length : data.toString()}`);
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
    serverSocket?.terminate();
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
