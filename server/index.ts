// 语音服务可执行入口 —— `npm run voice` 跑的就是这个。
//
// 如果你已经有一个 HTTP 服务，不要用这个文件，改用：
//   import { attachVoiceStream } from 'embodied-agent/server';
//
// 启动：
//   npm run voice                     # 默认 5181 端口
//   VOICE_PORT=6000 npm run voice
//
// 环境变量见 .env.example。

import { createServer } from 'node:http';
import { attachVoiceStream } from './voice-stream.ts';
import { voiceStatus } from './lib.ts';

const port = Number(process.env.VOICE_PORT ?? 5181);

const server = createServer((req, res) => {
    // 健康检查：前端用它判断要不要显示麦克风按钮
    if (req.url?.startsWith('/voice/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(voiceStatus()));
        return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('voice service');
});

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
