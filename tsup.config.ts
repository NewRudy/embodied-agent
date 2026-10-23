import { copyFile, mkdir } from 'node:fs/promises';
import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        cesium: 'src/cesium.ts',
        'server/index': 'server/lib.ts',
    },
    format: ['esm'],
    target: 'node22',
    platform: 'neutral',
    dts: true,
    clean: true,
    sourcemap: true,
    splitting: true,
    // cesium 是 peer dependency：不打进来，运行时由使用方提供
    external: ['cesium'],
    async onSuccess() {
        // AudioWorklet 是运行时按 URL 加载的静态文件，必须随包发布
        await mkdir('dist/public/voice', { recursive: true });
        await copyFile('public/voice/pcm-capture.js', 'dist/public/voice/pcm-capture.js');
    },
});
