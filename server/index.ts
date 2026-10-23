// 语音服务入口 —— 一个独立的小 HTTP 服务，只挂语音流。
//
// 为什么单独一个服务而不是塞进 vite：
//   生产环境里前端是静态文件，不需要 vite；凭据必须留在服务端。
//   这个文件就是「引入一个包 + 配几个环境变量」里的那个服务。
//
// 启动：
//   npm run voice                     # 默认 5181 端口
//   VOICE_PORT=6000 npm run voice
//
// 环境变量（全部可选，不配置 = 语音显式未启用）：
//   DOUBAO_ASR_RESOURCE_ID      火山引擎资源 ID（必填才能启用）
//   DOUBAO_ASR_API_KEY          API Key（与下面两项二选一）
//   DOUBAO_ASR_APP_KEY          App Key
//   DOUBAO_ASR_ACCESS_KEY       Access Key
//   DOUBAO_ASR_ENDPOINT         默认 wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async
//   DOUBAO_ASR_HOTWORD_TABLE_ID 可选：热词表
//   DOUBAO_ASR_CORRECT_TABLE_ID 可选：纠错表
//   VOICE_PORT                  监听端口，默认 5181
//   VOICE_ACCESS_KEY            可选：访问密钥，配置后浏览器需带 ?key=
//   VOICE_ALLOWED_ORIGINS       可选：逗号分隔的额外允许来源

import { createServer } from 'node:http';
import { attachVoiceStream } from './voice-stream.ts';

const port = Number(process.env.VOICE_PORT ?? 5181);

const server = createServer((req, res) => {
    // 健康检查：前端用它判断要不要显示麦克风按钮
    if (req.url?.startsWith('/voice/health')) {
        const voice = attachVoiceInfo();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(voice));
        return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('voice service');
});

// 只读配置状态，不回传任何凭据
function attachVoiceInfo() {
    const configured = Boolean(
        process.env.DOUBAO_ASR_RESOURCE_ID
        && (process.env.DOUBAO_ASR_API_KEY || (process.env.DOUBAO_ASR_APP_KEY && process.env.DOUBAO_ASR_ACCESS_KEY)),
    );
    return { voiceConfigured: configured, streamPath: '/voice/stream' };
}

const stream = attachVoiceStream(server);

server.listen(port, () => {
    console.log(`语音服务已启动 http://localhost:${port}`);
    console.log(`  语音流路径：${stream.path}`);
    if (!stream.configured) {
        console.log('  ⚠️  ASR 未配置，语音流会返回 VOICE_NOT_CONFIGURED。文字操控不受影响。');
        console.log('      需要设置 DOUBAO_ASR_RESOURCE_ID 与 DOUBAO_ASR_API_KEY（或 APP_KEY+ACCESS_KEY）。');
    }
});

const shutdown = () => { stream.close(); server.close(() => process.exit(0)); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
