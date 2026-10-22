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
            },
        },
    },
});
