// 语音网关的准入测试 —— 鉴权 / 并发上限 / 单 IP 上限 / Origin。
//
// 这些不是「功能测试」，是「别把钱烧光」的测试：
// 语音流每条连接都对应一条按分钟计费的豆包上游会话。
//
// 测试进程里没有 DOUBAO_* 环境变量，所以 voiceConfigured() 恒为 false，
// 连接会在鉴权通过后立刻收到 VOICE_NOT_CONFIGURED 并关闭 ——
// 这正好让我们能只测准入层，不碰真实 ASR。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { attachVoiceStream } from '../server/voice-stream.ts';
import { acceptUpgrade, connectWebSocket, WS_OPEN, type ServerWebSocket } from '../server/ws-lite.ts';

const ORIGIN = 'http://localhost:5180';

interface Harness {
    port: number;
    close: () => Promise<void>;
}

async function start(options: Parameters<typeof attachVoiceStream>[1]): Promise<Harness> {
    const server = createServer((_req, res) => res.end('ok'));
    const stream = attachVoiceStream(server, options);
    server.listen(0);
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    return {
        port,
        close: async () => {
            stream.close();
            server.close();
            await once(server, 'close');
        },
    };
}

/**
 * 假 ASR 上游 —— 只接受连接、什么都不回。
 *
 * 为什么需要：没有 DOUBAO_ASR_* 时，网关会在握手后立刻发 VOICE_NOT_CONFIGURED 并关闭，
 * 连接根本保持不住，没法测并发。这里给一个「永远不回话」的上游，
 * 让网关的连接停在「已连上、等结果」的状态，槽位才会被真正占住。
 */
async function fakeAsr(): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createServer();
    const sockets: ServerWebSocket[] = [];
    server.on('upgrade', (req, socket, head) => {
        const ws = acceptUpgrade(socket, head, req);
        ws.onmessage = () => { /* 吞掉 PCM */ };
        sockets.push(ws);
    });
    server.listen(0);
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    return {
        url: `ws://127.0.0.1:${port}/asr`,
        close: async () => {
            for (const s of sockets) s.terminate();
            server.close();
            await once(server, 'close');
        },
    };
}

/** 指向假上游的 ASR 环境变量；返回还原函数。 */
function pointAsrAt(url: string): () => void {
    const keys = ['DOUBAO_ASR_RESOURCE_ID', 'DOUBAO_ASR_API_KEY', 'DOUBAO_ASR_ENDPOINT'] as const;
    const saved = keys.map(k => process.env[k]);
    process.env.DOUBAO_ASR_RESOURCE_ID = 'test-resource';
    process.env.DOUBAO_ASR_API_KEY = 'test-key';
    process.env.DOUBAO_ASR_ENDPOINT = url;
    return () => {
        keys.forEach((k, i) => {
            if (saved[i] === undefined) delete process.env[k];
            else process.env[k] = saved[i];
        });
    };
}

/**
 * 连一次，返回握手结果。
 *
 * 注意：握手成功（101）之后服务端会立刻推 VOICE_NOT_CONFIGURED 并关闭，
 * 所以这里只关心「握手有没有通过」，不关心之后的业务消息。
 */
function handshake(port: number, path = '/voice/stream', origin: string | null = ORIGIN) {
    const url = `ws://127.0.0.1:${port}${path}`;
    return new Promise<{ ok: boolean; status?: number }>(resolve => {
        const client = connectWebSocket(url, {
            headers: origin ? { Origin: origin } : {},
            handshakeTimeoutMs: 3000,
        });
        let settled = false;
        const done = (ok: boolean) => {
            if (settled) return;
            settled = true;
            resolve({ ok, status: client.handshakeStatus });
            client.terminate();
        };
        client.onopen = () => done(true);
        client.onerror = () => done(false);
        client.onclose = () => done(false);
    });
}

/**
 * 连上并保持（用于占满并发槽位）。
 *
 * **必须等到服务端真的登记完这条连接，不能只等 onopen。**
 *
 * 服务端在 acceptUpgrade 里先 write 101 响应，之后才 `perIp.set(ip, n+1)`。
 * 客户端收到 101 就触发 onopen —— 这两件事跨进程，中间有真实的时序差。
 * 只等 onopen 的话，紧接着发的第二条连接有可能在服务端登记之前到达，
 * 于是没被上限挡住。
 *
 * 实测：这个竞态在单文件串行跑时偶发（12 次里挂 1 次，
 * 25 次循环里第 11 次失败），表现为「单 IP 并发到上限后 → 429」失败。
 * 隔离跑这个文件时又几乎不复现 —— 典型的时序依赖。
 *
 * 修法是等一个真实的服务端往返：连上后立刻发一条消息并等响应，
 * 能收到响应就说明服务端已经进到 handleConnection 了。
 */
async function hold(port: number): Promise<{ client: ReturnType<typeof connectWebSocket> }> {
    const client = connectWebSocket(`ws://127.0.0.1:${port}/voice/stream`, {
        headers: { Origin: ORIGIN },
        handshakeTimeoutMs: 3000,
    });
    await new Promise<void>((resolve, reject) => {
        client.onopen = () => resolve();
        client.onerror = e => reject(e);
    });
    assert.equal(client.readyState, WS_OPEN);
    // 让出一个完整的 I/O 轮次，确保服务端的 upgrade 回调已经跑完登记。
    // 50ms 远大于实测的差值（同机、localhost、无网络），又短到不影响测试时长。
    await wait(50);
    assert.equal(client.readyState, WS_OPEN, '登记期间连接不应被关掉');
    return { client };
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

// ==================== 鉴权 ====================

test('既没配 key 也没允许匿名 → 401（默认必须拒绝）', async () => {
    const h = await start({ accessKey: '', allowAnonymous: false });
    const r = await handshake(h.port);
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
    await h.close();
});

test('配了 key，URL 不带 key → 401', async () => {
    const h = await start({ accessKey: 'secret-key' });
    const r = await handshake(h.port);
    assert.equal(r.status, 401);
    await h.close();
});

test('配了 key，URL 带错的 key → 401', async () => {
    const h = await start({ accessKey: 'secret-key' });
    const r = await handshake(h.port, '/voice/stream?key=wrong');
    assert.equal(r.status, 401);
    await h.close();
});

test('配了 key，URL 带对的 key → 握手通过', async () => {
    const h = await start({ accessKey: 'secret-key' });
    const r = await handshake(h.port, '/voice/stream?key=secret-key');
    assert.equal(r.ok, true);
    await h.close();
});

test('显式允许匿名 → 握手通过', async () => {
    const h = await start({ allowAnonymous: true });
    const r = await handshake(h.port);
    assert.equal(r.ok, true);
    await h.close();
});

// ==================== 并发上限 ====================

test('全局并发到上限后 → 503', async () => {
    const asr = await fakeAsr();
    const restore = pointAsrAt(asr.url);
    const h = await start({ allowAnonymous: true, maxConcurrent: 1, maxPerIp: 10 });
    const first = await hold(h.port);
    const r = await handshake(h.port);
    assert.equal(r.status, 503, '第二条连接应被并发上限挡住');
    first.client.close();
    await wait(100);
    await h.close();
    restore();
    await asr.close();
});

test('单 IP 并发到上限后 → 429', async () => {
    const asr = await fakeAsr();
    const restore = pointAsrAt(asr.url);
    const h = await start({ allowAnonymous: true, maxConcurrent: 10, maxPerIp: 1 });
    const first = await hold(h.port);
    const r = await handshake(h.port);
    assert.equal(r.status, 429, '同一 IP 第二条连接应被单 IP 上限挡住');
    first.client.close();
    await wait(100);
    await h.close();
    restore();
    await asr.close();
});

test('断开后槽位释放，可以重新连上', async () => {
    // 这条钉的是 onclose 被覆盖导致 clients 集合泄漏的回归 ——
    // 泄漏的表现就是「用一次之后再也连不上」。
    const asr = await fakeAsr();
    const restore = pointAsrAt(asr.url);
    const h = await start({ allowAnonymous: true, maxConcurrent: 1, maxPerIp: 1 });
    for (let i = 0; i < 3; i++) {
        const { client } = await hold(h.port);
        client.close();
        await wait(150);
    }
    const last = await hold(h.port);
    assert.equal(last.client.readyState, WS_OPEN, '第三次断开后应该还能连');
    last.client.close();
    await wait(100);
    await h.close();
    restore();
    await asr.close();
});

// ==================== Origin ====================

test('Origin 不在白名单 → 403', async () => {
    const h = await start({ allowAnonymous: true, allowedOrigins: ['https://ok.example.com'] });
    const r = await handshake(h.port, '/voice/stream', 'https://evil.example.com');
    assert.equal(r.status, 403);
    await h.close();
});

test('Origin 在白名单 → 握手通过', async () => {
    const h = await start({ allowAnonymous: true, allowedOrigins: ['https://ok.example.com'] });
    const r = await handshake(h.port, '/voice/stream', 'https://ok.example.com');
    assert.equal(r.ok, true);
    await h.close();
});

test('无 Origin（非浏览器客户端）→ 403', async () => {
    const h = await start({ allowAnonymous: true });
    const r = await handshake(h.port, '/voice/stream', null);
    assert.equal(r.status, 403);
    await h.close();
});

// ==================== 路径 ====================

test('非语音路径的 upgrade → 404', async () => {
    const h = await start({ allowAnonymous: true });
    const r = await handshake(h.port, '/other/stream');
    assert.equal(r.status, 404);
    await h.close();
});

// ==================== 环境变量解析 ====================

test('VOICE_MAX_CONCURRENT 为空串时回落到默认值，不是 0', async () => {
    // Number('') === 0 —— 直接 Number() 会让「等号后没填」变成「禁止所有人连接」，
    // 而日志只会说「并发已达上限 0」，很难联想到是空变量。
    const saved = process.env.VOICE_MAX_CONCURRENT;
    process.env.VOICE_MAX_CONCURRENT = '';
    const h = await start({ allowAnonymous: true });
    const r = await handshake(h.port);
    assert.equal(r.ok, true, '空变量不应该把上限变成 0');
    await h.close();
    if (saved === undefined) delete process.env.VOICE_MAX_CONCURRENT;
    else process.env.VOICE_MAX_CONCURRENT = saved;
});

test('VOICE_MAX_CONCURRENT 填了非数字时也回落', async () => {
    const saved = process.env.VOICE_MAX_CONCURRENT;
    process.env.VOICE_MAX_CONCURRENT = 'abc';
    const h = await start({ allowAnonymous: true });
    const r = await handshake(h.port);
    assert.equal(r.ok, true);
    await h.close();
    if (saved === undefined) delete process.env.VOICE_MAX_CONCURRENT;
    else process.env.VOICE_MAX_CONCURRENT = saved;
});

test('断开一条连接只释放一个槽位（不能被重复扣减）', async () => {
    // 回归：onclose 曾经被链式包了两层，一次断开会把计数减两次。
    // 表现是「两个人在线，走了一个，剩下那个的计数也归零了」——
    // 上限形同虚设，而且很难复现（要刚好有多条连接）。
    const asr = await fakeAsr();
    const restore = pointAsrAt(asr.url);
    const h = await start({ allowAnonymous: true, maxConcurrent: 10, maxPerIp: 2 });

    const a = await hold(h.port);
    const b = await hold(h.port);
    a.client.close();
    await wait(200);

    // 此时应只剩 1 条（b）。上限 2 → 还能再连一条。
    const c = await hold(h.port);
    // 再连就应该是 429 了（b + c = 2）
    const r = await handshake(h.port);
    assert.equal(r.status, 429, '关掉一条后计数应为 1，而不是 0');

    b.client.close();
    c.client.close();
    await wait(150);
    await h.close();
    restore();
    await asr.close();
});
