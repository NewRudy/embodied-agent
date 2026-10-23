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
        // 直接用源码，避免依赖已发布的 dist
        alias: {
            'cesium-player-controller': '/Users/rudy/Documents/ChatGPT/GuikeSong/player-demo/src/index.ts',
        },
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        rollupOptions: {
            input: {
                wind: path.resolve(__dirname, 'demo/wind/index.html'),
                sandbox: path.resolve(__dirname, 'demo/sandbox/index.html'),
            },
        },
    },
});
