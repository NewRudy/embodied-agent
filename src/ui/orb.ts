// 悬浮球 UI —— 开箱即用的一套操作界面。
//
// 为什么放进包里：
//   每个接入场景都要一套「说话、打字、看状态」的界面。之前两个 demo 各写了一份
//   （wind 208 行、sandbox 136 行），新场景接进来还得照抄第三份 ——
//   这正是「任意场景即插即用」没做干净的地方。
//
//   接一个场景现在只需要一行：
//     mountOrbUI(scene, { quickCommands: ['去3号风机', '停'] })
//
// 设计原则：
//   1. **默认只有一颗球**。这是个 3D 演示，UI 不该抢戏。
//   2. 状态/转写浮在球上方，输入和快捷指令收进展开面板。
//   3. 不依赖任何框架，不注入全局样式污染 —— 样式挂在 shadow root 里，
//      宿主页面怎么写都不会串味（反过来也一样）。
//
// 无障碍：
//   - 球是真正的 <button>，可 Tab 聚焦、可用 Enter 触发
//   - 面板展开时焦点进输入框，Esc 收起
//   - 状态变化通过 aria-live 播报给读屏

import type { EmbodiedScene, SceneState } from '../create-scene.ts';

export interface OrbUIOptions {
    /** 挂到哪个元素上。默认 document.body。 */
    container?: HTMLElement;
    /**
     * 快捷指令。点一下等于说这句话。
     * 场景相关的，所以必须由调用方给 —— 本包不知道你的场景里有什么。
     */
    quickCommands?: string[];
    /** 是否显示日志按钮，默认 true。 */
    showLog?: boolean;
    /** 初始是否展开面板。默认 false（只有一颗球）。 */
    initiallyOpen?: boolean;
    /** 额外的键盘快捷键（默认 `/` 展开、`Esc` 收起）。 */
    hotkeys?: boolean;
    /**
     * 自定义转写来源。不传则用 `scene.state().transcript`。
     *
     * 用于**不经过本包语音服务**的后端（比如浏览器内置 Web Speech API）：
     * 那类识别的临时结果不会进 scene，场景需要自己提供一个读法。
     * 别在外面直接写 shadow DOM 里的元素 —— 会和本组件的同步互相覆盖。
     */
    transcript?: () => string;
    /**
     * 自己接管麦克风按钮。
     *
     * 不传时：有 `scene.voice` 就调它的 toggle，没有就禁用按钮。
     * 传了时：完全由调用方控制 —— 用于浏览器内置 Web Speech API 这类
     * 不经过本包语音服务的后端。
     *
     * 传了这个就必须同时提供 `micState`，否则按钮外观不会跟着变。
     */
    mic?: {
        onClick(): void;
        /** 当前麦克风状态，用于渲染按钮外观。 */
        state(): 'off' | 'connecting' | 'listening';
        /** 是否禁用（例如浏览器不支持）。 */
        disabled?: boolean;
        /** 禁用时的提示。 */
        disabledReason?: string;
    };
}

export interface OrbUI {
    /** 卸载 UI（移除 DOM、解绑监听）。 */
    dispose(): void;
    /** 展开/收起面板。 */
    setOpen(open: boolean): void;
    /** 往日志区追加一行。 */
    log(line: string): void;
    /** 底层元素，需要自定义时用。 */
    readonly root: ShadowRoot;
}

const STYLE = `
:host {
    --bg: #0f1216;
    --panel: rgba(18, 22, 28, 0.9);
    --border: rgba(255, 255, 255, 0.12);
    --text: #e6e9ee;
    --muted: #8b95a3;
    --accent: #4ea8ff;
    --ok: #46c48a;
    --warn: #f0a54a;
    position: fixed; right: 20px; bottom: 20px;
    z-index: 2147483000;
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
    color: var(--text);
}
* { box-sizing: border-box; }

#dock {
    display: flex; flex-direction: column; align-items: flex-end; gap: 10px;
    pointer-events: none;
}
#dock > * { pointer-events: auto; }

/* 状态信息：浮在球上方，不占场景中心 */
#info {
    display: flex; flex-direction: column; align-items: flex-end;
    gap: 3px; max-width: min(360px, calc(100vw - 40px));
    text-align: right;
}
#transcript {
    font-size: 14px; font-style: italic; color: var(--accent);
    padding: 3px 10px; border-radius: 8px;
    background: rgba(18, 22, 28, .72);
    backdrop-filter: blur(8px);
}
#transcript:empty { display: none; }
#readout {
    font-size: 11px; color: var(--muted);
    font-variant-numeric: tabular-nums;
    padding: 2px 8px; border-radius: 6px;
    background: rgba(18, 22, 28, .6);
}
#readout:empty { display: none; }
#panel {
    width: min(340px, calc(100vw - 40px));
    padding: 10px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 14px;
    backdrop-filter: blur(14px);
    box-shadow: 0 8px 32px rgba(0, 0, 0, .45);
}
#panel[hidden] { display: none; }

#cmd {
    width: 100%; padding: 9px 11px;
    font: inherit; font-size: 13px;
    background: rgba(0, 0, 0, .35);
    border: 1px solid var(--border);
    border-radius: 9px; color: var(--text);
    outline: none;
}
#cmd:focus { border-color: var(--accent); }
#cmd::placeholder { color: rgba(139, 149, 163, .75); }

.chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.chips:empty { display: none; }
.chips button {
    font: inherit; font-size: 12px;
    padding: 4px 9px; border-radius: 999px;
    background: rgba(255, 255, 255, .06);
    border: 1px solid var(--border);
    color: var(--text); cursor: pointer;
    transition: background .15s, border-color .15s;
}
.chips button:hover { background: rgba(78, 168, 255, .18); border-color: rgba(78, 168, 255, .4); }

#orbRow { display: flex; align-items: center; gap: 8px; }

#mic {
    width: 56px; height: 56px;
    display: grid; place-items: center;
    font-size: 22px; line-height: 1;
    border-radius: 50%;
    background: radial-gradient(circle at 32% 28%, rgba(78, 168, 255, .35), rgba(18, 22, 28, .92));
    border: 1px solid rgba(78, 168, 255, .35);
    color: var(--text); cursor: pointer;
    box-shadow: 0 6px 24px rgba(0, 0, 0, .5);
    transition: transform .14s ease, box-shadow .2s ease, border-color .2s ease;
    user-select: none;
}
#mic:hover { transform: scale(1.06); box-shadow: 0 8px 28px rgba(78, 168, 255, .3); }
#mic:active { transform: scale(.96); }
#mic[data-state="connecting"] {
    border-color: var(--warn);
    background: radial-gradient(circle at 32% 28%, rgba(240, 165, 74, .4), rgba(18, 22, 28, .92));
}
#mic[data-state="listening"] {
    border-color: rgba(70, 196, 138, .75);
    background: radial-gradient(circle at 32% 28%, rgba(70, 196, 138, .45), rgba(18, 22, 28, .92));
    animation: pulse 1.8s ease-in-out infinite;
}
#mic:disabled { opacity: .35; cursor: not-allowed; animation: none; }
@keyframes pulse {
    0%, 100% { box-shadow: 0 6px 24px rgba(0, 0, 0, .5), 0 0 0 0 rgba(70, 196, 138, .45); }
    50%      { box-shadow: 0 6px 24px rgba(0, 0, 0, .5), 0 0 0 12px rgba(70, 196, 138, 0); }
}

#toggle {
    width: 34px; height: 34px;
    display: grid; place-items: center;
    font-size: 14px; line-height: 1;
    border-radius: 50%;
    background: rgba(18, 22, 28, .85);
    border: 1px solid var(--border);
    color: var(--muted); cursor: pointer;
    backdrop-filter: blur(10px);
    transition: color .15s, border-color .15s, transform .14s;
}
#toggle:hover { color: var(--text); border-color: rgba(78, 168, 255, .5); transform: scale(1.08); }
#toggle[aria-expanded="true"] { color: var(--accent); border-color: rgba(78, 168, 255, .55); }

/* 日志：左上角，默认隐藏 */
#logWrap {
    position: fixed; left: 16px; top: 16px;
    width: min(320px, calc(100vw - 32px));
    max-height: 42vh; overflow: auto;
    padding: 10px 12px;
    font: 11px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--muted);
    background: rgba(18, 22, 28, .72);
    border: 1px solid var(--border);
    border-radius: 10px;
    backdrop-filter: blur(10px);
    pointer-events: auto;
}
#logWrap[hidden] { display: none; }
#logWrap div { padding: 1px 0; white-space: pre-wrap; word-break: break-all; }
#logWrap div:first-child { color: var(--text); }

@media (max-width: 480px) {
    :host { right: 14px; bottom: 14px; }
    #dock { gap: 8px; }
    #mic { width: 50px; height: 50px; font-size: 20px; }
    #panel { width: calc(100vw - 28px); }
}
`;

/** 状态枚举 → 给人看的中文。不认识的枚举原样显示，方便排查。 */
const STATE_LABELS: Record<string, string> = {
    idle: '待命',
    active: '行进中',
    arrived: '已到达',
    failed: '失败',
    cancelled: '已停止',
};

/** 把场景状态渲染成一行小字。没目标时只显示状态。 */
function formatReadout(state: SceneState): string {
    const label = STATE_LABELS[state.goalState] ?? state.goalState;
    if (state.distance == null) return `状态 ${label}`;
    const speed = state.speed > 0.05 ? ` · ${state.speed.toFixed(1)} m/s` : '';
    return `状态 ${label} · 距目标 ${state.distance.toFixed(1)} m${speed}`;
}

/**
 * 挂一套悬浮球 UI 到场景上。
 *
 * 样式全部在 shadow root 里，不会污染宿主页面，宿主也不会污染它。
 */
export function mountOrbUI(scene: EmbodiedScene, options: OrbUIOptions = {}): OrbUI {
    const host = document.createElement('div');
    host.setAttribute('data-embodied-orb', '');
    (options.container ?? document.body).appendChild(host);
    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);

    // —— 结构 ——
    const logWrap = document.createElement('div');
    logWrap.id = 'logWrap';
    logWrap.hidden = true;

    const dock = document.createElement('div');
    dock.id = 'dock';

    const panel = document.createElement('div');
    panel.id = 'panel';
    panel.hidden = !options.initiallyOpen;

    const input = document.createElement('input');
    input.id = 'cmd';
    input.type = 'text';
    input.autocomplete = 'off';
    input.placeholder = '说或输入目标，例如「去 A 点」';
    panel.appendChild(input);

    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const cmd of options.quickCommands ?? []) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = cmd;
        b.addEventListener('click', () => { scene.handleCommand(cmd); setOpen(false); });
        chips.appendChild(b);
    }
    if (options.showLog !== false) {
        const logBtn = document.createElement('button');
        logBtn.type = 'button';
        logBtn.textContent = '日志';
        logBtn.addEventListener('click', () => {
            logWrap.hidden = !logWrap.hidden;
            logBtn.textContent = logWrap.hidden ? '日志' : '收起日志';
        });
        chips.appendChild(logBtn);
    }
    panel.appendChild(chips);

    const info = document.createElement('div');
    info.id = 'info';
    const transcriptEl = document.createElement('div');
    transcriptEl.id = 'transcript';
    transcriptEl.setAttribute('aria-live', 'polite');
    const readoutEl = document.createElement('div');
    readoutEl.id = 'readout';
    readoutEl.setAttribute('aria-live', 'polite');
    info.append(transcriptEl, readoutEl);

    const orbRow = document.createElement('div');
    orbRow.id = 'orbRow';

    const toggle = document.createElement('button');
    toggle.id = 'toggle';
    toggle.type = 'button';
    toggle.textContent = '⌨';
    toggle.title = '输入指令（按 / 也可）';
    toggle.setAttribute('aria-label', '输入指令');
    toggle.setAttribute('aria-expanded', String(options.initiallyOpen));

    const mic = document.createElement('button');
    mic.id = 'mic';
    mic.type = 'button';
    mic.textContent = '🎤';
    mic.dataset.state = 'off';
    mic.title = '开启持续语音';
    mic.setAttribute('aria-label', '开启持续语音');

    orbRow.append(toggle, mic);
    dock.append(panel, info, orbRow);
    root.append(logWrap, dock);

    // —— 交互 ——
    function setOpen(open: boolean) {
        panel.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        if (open) input.focus();
    }
    toggle.addEventListener('click', () => setOpen(panel.hidden));

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { setOpen(false); input.blur(); return; }
        if (e.key !== 'Enter') return;
        const text = input.value.trim();
        if (!text) return;
        scene.handleCommand(text);
        input.value = '';
        setOpen(false);
    });

    if (options.mic) {
        const custom = options.mic;
        if (custom.disabled) {
            mic.disabled = true;
            mic.title = custom.disabledReason ?? '语音不可用';
        } else {
            mic.addEventListener('click', () => custom.onClick());
        }
    } else if (scene.voice) {
        mic.addEventListener('click', () => { void scene.voice!.toggle(); });
    } else {
        mic.disabled = true;
        mic.title = '语音未启用（未配置 ASR）';
    }

    // 快捷键：/ 展开、Esc 收起。焦点在输入框里时不抢。
    const onKey = (e: KeyboardEvent) => {
        if (e.key === '/' && document.activeElement !== input) {
            // 输入框在 shadow DOM 里，document.activeElement 是 host，
            // 所以还要判断 shadow 内部的焦点。
            if (root.activeElement === input) return;
            e.preventDefault();
            setOpen(true);
        } else if (e.key === 'Escape' && !panel.hidden) {
            setOpen(false);
        }
    };
    if (options.hotkeys !== false) document.addEventListener('keydown', onKey);

    // —— 状态同步 ——
    // 场景每帧调 tick，UI 不该每帧改 DOM。只在文本变化时写。
    let lastReadout = '';
    let lastTranscript = '';
    let lastVoiceState = '';
    const sync = () => {
        const state = scene.state();
        const readout = formatReadout(state);
        if (readout !== lastReadout) { readoutEl.textContent = readout; lastReadout = readout; }

        const transcript = (options.transcript ? options.transcript() : state.transcript) || '';
        const line = transcript ? `「${transcript}」` : '';
        if (line !== lastTranscript) { transcriptEl.textContent = line; lastTranscript = line; }

        // 麦克风外观：自定义控制器优先，否则跟 scene.voice 的状态走。
        const voiceState = options.mic ? options.mic.state() : state.voiceState;
        if (voiceState !== lastVoiceState) {
            mic.dataset.state = voiceState;
            mic.textContent = voiceState === 'listening' ? '⏹' : '🎤';
            mic.setAttribute('aria-label', voiceState === 'listening' ? '停止语音' : '开启持续语音');
            lastVoiceState = voiceState;
        }
    };
    sync();

    // 用 rAF 同步状态：和渲染同频，且后台标签页会自动停 ——
    // 比 setInterval 好（后台还在跑，纯浪费）。
    let raf = 0;
    let running = true;
    const loop = () => {
        if (!running) return;
        sync();
        raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return {
        root,
        setOpen,
        log(line: string) {
            const el = document.createElement('div');
            el.textContent = line;
            logWrap.prepend(el);
            while (logWrap.childElementCount > 60) logWrap.lastElementChild?.remove();
        },
        dispose() {
            running = false;
            cancelAnimationFrame(raf);
            document.removeEventListener('keydown', onKey);
            host.remove();
        },
    };
}
