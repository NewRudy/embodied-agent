// 空白场景 —— 证明具身智能体不依赖任何具体资产。
//
// 这里没有 3D Tiles、没有 glTF、没有第三方模型、没有 Cesium。
// 只有一个 2D canvas、一块平地、三个人物可去的参照点。
//
// 它要回答的问题：换一个完全陌生的场景，这个包还能不能用？
// 答案应该是「只要你能回答三个问题」——我在哪、地面多高、某某在哪。

import { createEmbodiedScene } from '../../src/create-scene.ts';
import { mountOrbUI } from '../../src/ui/orb.ts';
import { runThresholdIssue } from '../../src/locomotion.ts';
import type { BodyLike, SceneAdapter, Vec3 } from '../../src/index.ts';

// —— 场景定义 ——

interface Place { name: string; at: Vec3; color: string; description: string }

// 每个点都有可区分的描述 —— 模型靠这个把「那个红色的」映射到具体名字。
// 没有描述时它只能拒绝，这是对的：宁可说不懂，也不要瞎走。
const PLACES: Place[] = [
    { name: 'A点', at: { east: -120, north: 90, up: 0 }, color: '#46c48a', description: '西北方向的绿色圆点，带字母 A' },
    { name: 'B点', at: { east: 160, north: 40, up: 0 }, color: '#46c48a', description: '正东偏北的绿色圆点，带字母 B' },
    { name: 'C点', at: { east: 20, north: -150, up: 0 }, color: '#46c48a', description: '正南方向的绿色圆点，带字母 C' },
];

const pose = { east: 0, north: 0, up: 0, yaw: 0, flying: false, onGround: true };

/** 场景适配器：只有三个方法，这是唯一的接缝。 */
const adapter: SceneAdapter = {
    getPose: () => ({ ...pose }),
    // 平地：任何位置的地面高度都是 0
    groundHeightAt: () => 0,
    resolveReference(text: string): Vec3 | null {
        const normalized = text.replace(/\s/g, '');
        for (const p of PLACES) {
            // 支持「A点」「a点」「去A点」
            if (normalized.toLowerCase().includes(p.name.toLowerCase())) return p.at;
        }
        return null;
    },
    // 给模型意图层看：场景里有哪些地方可去、各自长什么样。
    // 不实现这个方法，模型就只能做「方位 + 距离」，做不了「去那个绿点」。
    listReferences: () => PLACES.map(p => ({ name: p.name, at: p.at, description: p.description })),
};

/** 身体：这里只是一个记录器，真正的位移在渲染循环里积分。 */
const body: BodyLike & { move: { east: number; north: number; speedMetersPerSecond: number; run: boolean } | null } = {
    move: null,
    setWorldMovement(input) {
        this.move = input
            ? { east: input.east, north: input.north, speedMetersPerSecond: input.speedMetersPerSecond ?? 0, run: input.run ?? false }
            : null;
    },
    setScriptedYaw(yaw) { if (yaw != null) pose.yaw = yaw; },
};

// —— 装配 ——

// UI 挂载前先缓存日志，挂上后一次补进去。
let orb: ReturnType<typeof mountOrbUI> | null = null;
const pendingLogs: string[] = [];
const log = (...args: unknown[]) => {
    const line = args.join(' ');
    if (orb) orb.log(line);
    else pendingLogs.push(line);
    console.log(...args);
};

// 模型意图层：走 vite 代理（网关不支持 CORS 预检，浏览器直连会失败）。
// 环境变量在构建期注入 —— 浏览器端没有 process.env。
//
// ⚠️ `apiKey: 'proxy'` 只是**本地 demo** 的占位符，不是可用的密钥。
// 它成立的前提是：请求打到同源 `/llm`，由 vite.config.ts 的 proxy 转发到本机网关，
// 网关自身不做鉴权。**不要把这段抄到生产环境**——那等于把模型端点裸奔在公网上。
// 生产环境的正确做法是：自己的后端代理这个端点，后端持有真实 key 并做鉴权 + 限流，
// 浏览器只请求自己的同源路径。
const LLM = (import.meta.env.EMBODIED_LLM_ENABLED === '1' || location.search.includes('llm=1'))
    ? {
        baseUrl: '/llm',
        model: import.meta.env.EMBODIED_LLM_MODEL || 'workbuddy-ai/deepseek-v4.1-flash',
        apiKey: 'proxy', // 占位符，仅本地 demo；生产必须换成后端代理
        timeoutMs: 800,
    }
    : false;

const scene = createEmbodiedScene({
    adapter,
    player: body,
    agent: {
        config: {
            // 4 / 8 是「为了在小画布上看得清」故意调快的，不是真实步行速度。
            //
            // runThreshold 必须跟着抬。默认是 2.4，而 walkSpeed 4 已经超过它 ——
            // 于是 **一出生就在跑**，「跑起来」自然没变化，看起来像指令失灵。
            // 实测（浏览器验收）：距目标从 146 m 走到 107 m，速度全程 8.0 m/s。
            // 抬到 6 之后：走路 4 m/s，说「跑起来」才切 8 m/s。
            walkSpeed: 4,
            runSpeed: 8,
            runThreshold: 6,
            boundsRadius: 800,
        },
    },
    intent: { llm: LLM },
    log,
    // 状态显示由 mountOrbUI 自己同步。
});

// 配置诊断：和 wind demo 的 unusedClips 同一类陷阱 ——
// 配置各自都对，组合起来让一条指令变成空操作。
{
    const issue = runThresholdIssue(scene.agent.config);
    if (issue) log(`ℹ️ ${issue}`);
}

// —— 渲染 ——

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
let scale = 1;
let originX = 0;
let originY = 0;

function resize() {
    // canvas 用 CSS 撑满，绘制尺寸取 clientWidth/Height
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 视野约 600 米
    scale = Math.min(w, h) / 600;
    originX = w / 2;
    originY = h / 2;
}
window.addEventListener('resize', resize);
resize();

/** ENU → 屏幕。北在上，东在右。 */
function toScreen(east: number, north: number): [number, number] {
    return [originX + east * scale, originY - north * scale];
}

function draw() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    ctx.fillStyle = '#0b0e12';
    ctx.fillRect(0, 0, w, h);

    // 网格：每 50 米一条，铺满整个画布
    const halfW = w / 2 / scale + 50;
    const halfH = h / 2 / scale + 50;
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    for (let g = Math.ceil(-halfW / 50) * 50; g <= halfW; g += 50) {
        const [x0, y0] = toScreen(g, -halfH);
        const [x1, y1] = toScreen(g, halfH);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    for (let g = Math.ceil(-halfH / 50) * 50; g <= halfH; g += 50) {
        const [x0, y0] = toScreen(-halfW, g);
        const [x1, y1] = toScreen(halfW, g);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }

    // 参照点
    for (const p of PLACES) {
        const [x, y] = toScreen(p.at.east, p.at.north);
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(230,233,238,0.75)';
        ctx.font = '12px -apple-system, "PingFang SC", sans-serif';
        ctx.fillText(p.name, x + 9, y + 4);
    }

    // 当前目标
    const goal = scene.agent.currentGoal;
    if (goal) {
        const [gx, gy] = toScreen(goal.position.east, goal.position.north);
        ctx.strokeStyle = '#f0a54a';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(gx, gy, 9, 0, Math.PI * 2); ctx.stroke();
        // 人物到目标的连线
        const [px, py] = toScreen(pose.east, pose.north);
        ctx.strokeStyle = 'rgba(240,165,74,0.28)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(gx, gy); ctx.stroke();
        ctx.setLineDash([]);
    }

    // 人物：一个带朝向的三角形
    const [px, py] = toScreen(pose.east, pose.north);
    // yaw: 0 = 北，顺时针为正。canvas 的 0 弧度指向 +x（东）。
    // 北在屏幕上是 -y，所以要把「北」转到「上」：旋转 yaw 后再转 -90°。
    const heading = pose.yaw;
    const size = 9;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(heading - Math.PI / 2);
    ctx.fillStyle = '#4ea8ff';
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.65, size * 0.7);
    ctx.lineTo(-size * 0.65, size * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

// —— 主循环 ——

let last = performance.now();
function tick() {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    scene.tick(dt);

    // 物理积分：真实场景里由物理引擎做，这里手动
    const move = body.move;
    if (move && move.speedMetersPerSecond > 0) {
        pose.east += move.east * move.speedMetersPerSecond * dt;
        pose.north += move.north * move.speedMetersPerSecond * dt;
    }

    draw();
    requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// —— 语音：浏览器内置 Web Speech API，零凭据 ——
// 这是本包之外的第二种语音后端：不需要 ASR 服务、不需要密钥。
// 代价是识别质量依赖浏览器与系统，且只在 Chrome/Edge/Safari 可用。
//
// 它不经过 scene.voice（那套要连本包的语音服务），所以这里自己管麦克风状态，
// 通过 mountOrbUI 的 mic 选项把按钮交给它控制。
type SpeechRecognitionLike = {
    lang: string; continuous: boolean; interimResults: boolean;
    start(): void; stop(): void;
    onstart: (() => void) | null;
    onresult: ((e: any) => void) | null;
    onerror: ((e: any) => void) | null;
    onend: (() => void) | null;
};
const SpeechRecognitionCtor = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

let recognition: SpeechRecognitionLike | null = null;
let listening = false;
let partial = '';

function startVoice() {
    if (!SpeechRecognitionCtor) return;
    const r = new SpeechRecognitionCtor() as SpeechRecognitionLike;
    r.lang = 'zh-CN';
    r.continuous = true;
    r.interimResults = true;
    recognition = r;

    r.onstart = () => {
        listening = true;
        log('🎧 语音已开启（浏览器内置识别）');
    };
    r.onresult = (e: any) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
            const res = e.results[i];
            const text = String(res[0].transcript).trim();
            if (!text) continue;
            if (res.isFinal) {
                partial = '';
                scene.handleCommand(text);
            } else {
                partial = text;
            }
        }
    };
    r.onerror = (e: any) => {
        log(`⚠️ 语音：${e.error}`);
        if (e.error === 'not-allowed') partial = '麦克风权限被拒绝';
    };
    r.onend = () => {
        // continuous 模式下浏览器仍会因静音自动结束，需要自动重启
        if (listening) { try { r.start(); } catch { /* 已在运行 */ } return; }
        partial = '';
    };
    try { r.start(); } catch (err) { log(`⚠️ 无法启动语音：${(err as Error).message}`); }
}

function stopVoice() {
    listening = false;
    recognition?.stop();
    recognition = null;
    partial = '';
}

// —— UI ——
const ui = mountOrbUI(scene, {
    quickCommands: ['去A点', '去B点', '去C点', '往左一点', '跑起来', '停'],
    // 内置识别的临时结果不进 scene，得自己提供读法。
    // 早期版本是在外面 setInterval 直接写 #transcript，会和本组件的同步互相覆盖。
    transcript: () => partial,
    mic: {
        onClick() { if (listening) stopVoice(); else startVoice(); },
        state: () => (listening ? 'listening' : 'off'),
        disabled: !SpeechRecognitionCtor,
        disabledReason: '此浏览器不支持内置语音识别，可用文字或接入 ASR 服务',
    },
});
orb = ui;
for (const line of pendingLogs.reverse()) ui.log(line);
pendingLogs.length = 0;

log('就绪。试试「去A点」「去B点」「往左一点」「跑起来」「停」。');

// 调试出口
(window as any).__scene = { scene, pose, body, PLACES, ui };
