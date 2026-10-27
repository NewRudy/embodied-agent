// 探测真实 ASR 把某句话听成什么。
//
// 为什么需要这个工具：
//   ASR 的同音误识是**场景相关**的 —— 换麦克风、换口音、换环境都可能出现新的错法，
//   而且错得毫无规律。实测豆包把「回运维点」听成「回韵尾典」，三个字全错，
//   编辑距离等于长度，任何模糊匹配都救不回来
//   （而放宽模糊匹配会让「3号风机」误配到「4号风机」，编辑距离只差 1）。
//
//   所以「这个场景里哪些说法会被听错」只能靠实测，然后把错法登记进
//   ReferenceEntry.aliases。
//
// 用法：
//   node tools/asr-probe.ts "回运维点" "去三号风机" "往前走二十米"
//   node tools/asr-probe.ts --file phrases.txt     # 一行一句
//   node tools/asr-probe.ts --json "回运维点"      # 机器可读输出
//   node tools/asr-probe.ts --voice "Flo (中文（中国大陆）)" "去三号风机"
//                                                  # 换一个嗓音（测 ASR 对不同音色的鲁棒性）
//
// 局限补充：换音色只能模拟「不同嗓音」，模拟不了真人的口音、语速、
// 呼吸和吞音。真人验收仍然只能由真人做。
//
// 依赖：macOS 的 say + afconvert（生成合成语音），以及正在运行的语音服务。
// 服务地址默认 ws://127.0.0.1:5181/voice/stream，用 VOICE_STREAM_URL 覆盖。
//
// 局限：用合成语音，不是真人。它能复现「ASR 对某些词的识别倾向」，
// 但复现不了真人的口音和语速。真人验收见 VOICE-CHECKLIST.md。

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { connectWebSocket } from '../server/ws-lite.ts';

const FRAME_BYTES = 3200; // 100ms @ 16kHz/16bit/mono

interface ProbeResult {
    said: string;
    heard: string | null;
    ms: number | null;
    error?: string;
}

/** 合成语音并转成裸 PCM（16kHz/16bit/mono）。 */
function synthesize(text: string, pcmPath: string): void {
    const aiff = '/tmp/asr-probe.aiff';
    const wav = '/tmp/asr-probe.wav';
    execFileSync('say', ['-v', VOICE, '-o', aiff, text]);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);

    // 剥 WAV 头：遍历 chunk 找 data。不能写死 44 字节 ——
    // afconvert 可能插入 LIST/fact 等 chunk，硬编码偏移会读到元数据当音频。
    const buf = readFileSync(wav);
    let off = 12;
    while (off < buf.length - 8) {
        const id = buf.toString('ascii', off, off + 4);
        const size = buf.readUInt32LE(off + 4);
        if (id === 'data') {
            const pcm = buf.subarray(off + 8, off + 8 + size);
            // 音色没装时 say 会「成功」产出一个全静音的短文件，不报错。
            // 不检查的话，后面看到的是「ASR 没返回结果」，完全查不到真正原因。
            if (pcm.length < 3200) {
                for (const f of [aiff, wav]) { try { unlinkSync(f); } catch { /* 忽略 */ } }
                throw new Error(
                    `音色「${VOICE}」没有产生有效音频（${(pcm.length / 32).toFixed(0)}ms，几乎是静音）。\n`
                    + `这个音色可能没装到系统里 —— say 不会报错，只会留下一个空文件。\n`
                    + `看看有哪些可用音色：say -v '?' | grep zh_`,
                );
            }
            writeFileSync(pcmPath, pcm);
            for (const f of [aiff, wav]) { try { unlinkSync(f); } catch { /* 忽略 */ } }
            return;
        }
        off += 8 + size + (size % 2);
    }
    throw new Error('WAV 里找不到 data chunk');
}

function streamUrl(): string {
    const base = process.env.VOICE_STREAM_URL ?? 'ws://127.0.0.1:5181/voice/stream';
    const key = process.env.VOICE_ACCESS_KEY;
    if (!key) return base;
    const u = new URL(base);
    u.searchParams.set('key', key);
    return u.toString();
}

/** 把 PCM 按真实麦克风节奏喂进去，返回定稿文本和「说完→定稿」耗时。 */
function recognize(pcmPath: string, timeoutMs = 20_000): Promise<ProbeResult['heard'] extends never ? never : { heard: string | null; ms: number | null; error?: string }> {
    const pcm = readFileSync(pcmPath);
    const speechMs = pcm.length / 2 / 16;
    return new Promise((resolve) => {
        const t0 = performance.now();
        let final: string | null = null;
        let finalAt = 0;
        let settled = false;
        const done = (error?: string) => {
            if (settled) return;
            settled = true;
            try { ws.close(); } catch { /* 已关闭 */ }
            resolve({ heard: final, ms: final ? finalAt - t0 - speechMs : null, ...(error ? { error } : {}) });
        };
        const ws = connectWebSocket(streamUrl(), { headers: { Origin: 'http://localhost:5180' } });
        ws.onmessage = (data: Buffer) => {
            let msg: { type?: string; utterances?: Array<{ text: string; final: boolean }>; code?: string };
            try { msg = JSON.parse(data.toString()); } catch { return; }
            if (msg.type === 'ready') send();
            else if (msg.type === 'transcript') {
                for (const u of msg.utterances ?? []) {
                    if (u.final) { final = u.text; finalAt = performance.now(); }
                }
            } else if (msg.type === 'error') done(msg.code ?? 'ERROR');
        };
        ws.onclose = () => done();
        ws.onerror = () => done('CONNECTION_FAILED');
        let i = 0;
        function send() {
            if (settled) return;
            if (i >= pcm.length) { ws.send(JSON.stringify({ type: 'finish' })); return; }
            ws.send(pcm.subarray(i, i + FRAME_BYTES));
            i += FRAME_BYTES;
            setTimeout(send, 100); // 真实麦克风节奏
        }
        setTimeout(() => done('TIMEOUT'), timeoutMs);
    });
}

// —— 主流程 ——

const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
// 嗓音。默认 Tingting；用 --voice 换一个，测 ASR 对不同音色的鲁棒性。
// 系统可用嗓音：say -v '?' | grep zh_
const voiceIdx = args.indexOf('--voice');
const VOICE = voiceIdx >= 0 ? args[voiceIdx + 1] : 'Tingting';
const fileIdx = args.indexOf('--file');

let phrases: string[];
if (fileIdx >= 0) {
    const path = args[fileIdx + 1];
    if (!path || !existsSync(path)) {
        console.error('用法：node tools/asr-probe.ts --file phrases.txt');
        process.exit(1);
    }
    phrases = readFileSync(path, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
} else {
    // 排除所有「选项名 + 它的值」，否则 --voice Flo 里的 Flo 会被当成一句要读的话
    const skip = new Set<string>();
    for (const flag of ['--voice', '--file']) {
        const i = args.indexOf(flag);
        if (i >= 0 && args[i + 1]) skip.add(args[i + 1]);
    }
    phrases = args.filter(a => !a.startsWith('--') && !skip.has(a));
}

if (!phrases.length) {
    console.error('用法：node tools/asr-probe.ts "回运维点" "去三号风机"');
    console.error('  或：node tools/asr-probe.ts --file phrases.txt');
    process.exit(1);
}

const results: ProbeResult[] = [];
for (const said of phrases) {
    const pcmPath = '/tmp/asr-probe.pcm';
    try {
        synthesize(said, pcmPath);
        const r = await recognize(pcmPath);
        results.push({ said, heard: r.heard, ms: r.ms === null ? null : Math.round(r.ms), ...(r.error ? { error: r.error } : {}) });
        try { unlinkSync(pcmPath); } catch { /* 忽略 */ }
    } catch (e) {
        results.push({ said, heard: null, ms: null, error: e instanceof Error ? e.message : String(e) });
    }
    await new Promise(r => setTimeout(r, 300)); // 避免连续会话触发上游限流
}

if (jsonOut) {
    console.log(JSON.stringify(results, null, 1));
} else {
    for (const r of results) {
        const mark = r.error ? '✗' : (r.heard ? '·' : '?');
        const latency = r.ms == null ? '' : `  (${r.ms}ms)`;
        console.log(`${mark} 说「${r.said}」 → ${r.heard == null ? `(${r.error ?? '无结果'})` : `「${r.heard}」`}${latency}`);
    }
    const wrong = results.filter(r => r.heard && r.heard.replace(/[。，！？\s]/g, '') !== r.said.replace(/\s/g, ''));
    if (wrong.length) {
        console.log('');
        console.log('以下说法被听错了，考虑登记进 ReferenceEntry.aliases：');
        for (const r of wrong) console.log(`  '${r.heard!.replace(/[。，！？]/g, '')}'  →  ${r.said}`);
    }
}
process.exit(0);
