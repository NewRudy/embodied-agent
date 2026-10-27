import path from 'node:path';
import { defineConfig } from 'vite';

// Cesium 静态资源（Workers/Assets/Widgets）来自巡界仓库的 example/public/cesium，
// 通过 public/xunjie-assets 软链引用，不复制大文件。
const CESIUM_BASE = '/xunjie-assets/cesium/';

export default defineConfig({
    root: __dirname,
    server: {
        host: true,
        port: 5180,
        // 模型网关不支持 CORS 预检（OPTIONS 返回 404），浏览器不能直连。
        // 开发期用 vite 代理绕开；生产环境必须由使用者自己的后端转发。
        proxy: {
            '/llm': {
                target: 'http://127.0.0.1:3425',
                changeOrigin: true,
                rewrite: p => p.replace(/^\/llm/, '/v1'),
            },
        },
    },
    define: {
        CESIUM_BASE_URL: JSON.stringify(CESIUM_BASE),
    },
    resolve: {
        // 默认用 npm 装好的 cesium-player-controller（不设 alias，走正常的模块解析）。
        // 本机开发时可以用 PLAYER_CONTROLLER_SRC 指向源码目录，避免每次改它都要重新发包：
        //   PLAYER_CONTROLLER_SRC=/path/to/player-demo/src/index.ts npm run dev
        //
        // 注意：alias 的值是包名时 vite 会当成文件路径去 open，报
        // `ENOENT ... open 'cesium-player-controller'`。所以默认必须不设 alias。
        ...(process.env.PLAYER_CONTROLLER_SRC
            ? { alias: { 'cesium-player-controller': process.env.PLAYER_CONTROLLER_SRC } }
            : {}),
    },
    build: {
        // 必须是 dist-demo，不能是 dist ——
        // dist 是 tsup（build:lib）的产物目录，两边都设了清空：
        //   vite 的 emptyOutDir: true 会删掉整个 dist/
        //   tsup 的 clean: true 会删掉整个 dist/
        // 实测：先 build:lib 再 build，dist/index.js、cesium.js、server/、
        // public/voice/ 全部消失，只剩 demo 产物 —— 包就废了。
        // 两个产物目录必须分开，否则谁后跑谁把对方删掉。
        outDir: 'dist-demo',
        emptyOutDir: true,
        rollupOptions: {
            input: {
                wind: path.resolve(__dirname, 'demo/wind/index.html'),
                sandbox: path.resolve(__dirname, 'demo/sandbox/index.html'),
            },
        },
    },
});
