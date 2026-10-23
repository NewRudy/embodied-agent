/// <reference types="vite/client" />

// 演示页面用到的构建期变量。
// 浏览器端没有 process.env，模型配置只能在这里注入。
interface ImportMetaEnv {
    /** 设为 '1' 启用模型意图层。 */
    readonly EMBODIED_LLM_ENABLED?: string;
    /** 模型名，例如 workbuddy-ai/deepseek-v4.1-flash。 */
    readonly EMBODIED_LLM_MODEL?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
