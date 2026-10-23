// 一站式装配 —— 「引入一个包，配置几个环境变量」的入口。
//
// 目标：使用者不需要理解 L1/L2/L3 分层，也不需要知道 setWorldMovement 和
// setInput 是两条独立通道。调一次 createEmbodiedScene() 就得到能听懂话的虚拟人。
//
// 用法（Cesium 场景）：
//
//   const scene = await createEmbodiedScene({
//       viewer,
//       player,                       // playerController 实例
//       frame,                        // EnuFrame，由场景原点构造
//       references: { '3号风机': { east, north, up } },
//       agent: { walkSpeed: 5 },
//       voice: { enabled: true, url: 'ws://localhost:5181/voice/stream' },
//   });
//   scene.handleCommand('去3号风机');
//
// 设计约束：
//   - 不接管渲染循环。调用方决定何时 tick。
//   - 语音是可选的。没配 ASR 时文字指令照常工作。
//   - 所有外部依赖通过参数注入，核心逻辑不 import Cesium。

import type { Goal, Vec3 } from './types.ts';
import { EmbodiedAgent } from './agent.ts';
import { parseIntent } from './intent.ts';
import { applyOutput, releaseBody, type BodyLike } from './body.ts';
import { RealtimeVoice, type VoiceState } from './voice/realtime-voice.ts';
import { SpeechOutput } from './voice/speech-output.ts';
import type { VoiceInterruption } from './voice/protocol.ts';

export interface EmbodiedSceneOptions {
    /** 场景适配器（Cesium 用户通常传 CesiumSceneAdapter）。 */
    adapter: import('./types.ts').SceneAdapter;
    /** 角色的「身体」。Cesium 用户传 playerController 实例。不传则只算目标不出运动。 */
    player?: BodyLike;
    /** 智能体参数。 */
    agent?: { origin?: Vec3; config?: Partial<import('./types.ts').AgentConfig> };
    /** 语音配置。不传则只有文字输入。 */
    voice?: {
        /** 语音流地址，例如 ws://localhost:5181/voice/stream */
        url: string;
        /** AudioWorklet 处理器地址，默认 /voice/pcm-capture.js */
        workletUrl?: string;
        /** 唤醒词，不配置则任何定稿句都直接执行 */
        wakeWord?: string;
        /** 人物回话（TTS）。默认开启。 */
        speak?: boolean;
    };
    /** 日志出口，默认 console.log。 */
    log?: (line: string) => void;
    /** 状态变化回调（供 UI 显示）。 */
    onState?: (state: SceneState) => void;
}

export interface SceneState {
    goalState: string;
    distance: number | null;
    speed: number;
    voiceState: VoiceState;
    /** 最近一次听到的话（含临时转写）。 */
    transcript: string;
}

export interface EmbodiedScene {
    agent: EmbodiedAgent;
    voice: RealtimeVoice | null;
    speech: SpeechOutput | null;
    /** 处理一句话（文字或语音转写都走这里）。 */
    handleCommand(text: string): void;
    /** 每帧调用。返回是否需要重绘。 */
    tick(dt: number): void;
    /** 当前状态快照。 */
    state(): SceneState;
    /** 直接设定目标（跳过意图解析）。 */
    setGoal(goal: Goal): void;
    /** 停止并交还控制权。 */
    stop(): void;
    /** 卸载：停语音、停播报、交还控制权。 */
    dispose(): void;
}

/**
 * 装配一个具身场景。
 *
 * 注意：这里不启动渲染循环，也不接管相机。
 * 调用方在自己的每帧回调里调 tick(dt)。
 */
export function createEmbodiedScene(options: EmbodiedSceneOptions): EmbodiedScene {
    const log = options.log ?? ((line: string) => console.log(line));
    const adapter = options.adapter;
    const agent = new EmbodiedAgent(adapter, {
        origin: options.agent?.origin,
        config: options.agent?.config,
    });

    let transcript = '';
    let voiceState: VoiceState = 'off';
    let disposed = false;

    // —— 播报：先建，因为语音需要它提供回声参考 ——
    const speech = options.voice?.speak === false ? null : new SpeechOutput({
        onPlaybackGate: (active, text) => voice?.setPlayback(active, text),
    });

    // —— 语音 ——
    let voice: RealtimeVoice | null = null;
    if (options.voice) {
        voice = new RealtimeVoice({
            url: options.voice.url,
            workletUrl: options.voice.workletUrl ?? '/voice/pcm-capture.js',
            wakeWord: options.voice.wakeWord,
            onState: state => { voiceState = state; emit(); },
            onPartial: text => { transcript = text; emit(); },
            onCommand: text => { handleCommand(text); },
            onInterrupt: event => handleInterrupt(event),
            onError: message => log(`⚠️ 语音：${message}`),
        });
    }

    function handleInterrupt(event: VoiceInterruption) {
        speech?.cancel();
        if (event.reason === 'pause') {
            stop();
            log('🗣 语音打断 → 停止');
        } else {
            log('🗣 语音打断播报');
        }
    }

    function stop() {
        agent.cancel();
        if (options.player) {
            (options.player as unknown as { stopHorizontalMotion?: () => void }).stopHorizontalMotion?.();
        }
    }

    function handleCommand(text: string) {
        if (!text.trim()) return;
        log(`🗣 ${text}`);

        const pose = adapter.getPose();
        const intent = parseIntent(text, {
            pose: { east: pose.east, north: pose.north, yaw: pose.yaw },
            goal: agent.currentGoal,
            resolve: t => adapter.resolveReference(t),
            defaultStep: 10,
        });

        if (!intent) {
            log('   → 没听懂');
            speech?.speak('没听懂，请再说一次');
            emit();
            return;
        }

        switch (intent.action) {
            case 'stop':
                stop();
                log('   → 停止');
                break;
            case 'go':
            case 'approach':
                agent.setGoal({ position: intent.position!, tolerance: 4, label: text });
                log(`   → 出发 → ${text}`);
                break;
            case 'revise':
                agent.reviseGoal({ position: intent.position! });
                log('   → 修正目标');
                break;
            case 'turn': {
                const p = adapter.getPose();
                (options.player as unknown as { setScriptedYaw?: (y: number) => void })
                    ?.setScriptedYaw?.(p.yaw + intent.yawDelta!);
                log('   → 转向');
                break;
            }
            case 'run':
                agent.config.walkSpeed = intent.pace === 'run'
                    ? agent.config.runSpeed
                    : agent.config.walkSpeed;
                log(`   → ${intent.pace === 'run' ? '快跑' : '慢走'}`);
                break;
            case 'fly':
                (options.player as unknown as { setFlightMode?: (v: boolean) => void })
                    ?.setFlightMode?.(!!intent.fly);
                log(`   → ${intent.fly ? '起飞' : '降落'}`);
                break;
        }
        emit();
    }

    function tick(dt: number) {
        if (disposed) return;
        const out = agent.update(dt);
        if (options.player) applyOutput(options.player, out);

        // 到达/失败时说话
        if (out.justArrived) {
            const label = out.goal?.label ?? '目标';
            log(`✅ 到达 ${label}`);
            speech?.speak(`已到达${cleanLabel(label)}`);
        } else if (out.failure) {
            log(`⚠️ 失败：${out.failure}`);
            speech?.speak(failureText(out.failure));
        }
        emit(out);
    }

    let lastKey = '';
    function emit(out?: ReturnType<EmbodiedAgent['update']>) {
        if (!options.onState) return;
        const snapshot = out ?? { state: agent.currentState, distance: null, movement: { speedMetersPerSecond: 0 } };
        const state: SceneState = {
            goalState: String(snapshot.state),
            distance: 'distance' in snapshot ? (snapshot.distance ?? null) : null,
            speed: snapshot.movement.speedMetersPerSecond,
            voiceState,
            transcript,
        };
        const key = `${state.goalState}:${state.distance?.toFixed(1)}:${state.speed.toFixed(1)}:${state.voiceState}:${state.transcript}`;
        if (key === lastKey) return;
        lastKey = key;
        options.onState(state);
    }

    return {
        agent,
        voice,
        speech,
        handleCommand,
        tick,
        setGoal: goal => agent.setGoal(goal),
        stop,
        state: () => ({
            goalState: agent.currentState,
            distance: null,
            speed: 0,
            voiceState,
            transcript,
        }),
        dispose() {
            disposed = true;
            voice?.stop();
            speech?.cancel();
            agent.release();
            if (options.player) releaseBody(options.player);
        },
    };
}

/** 把「往前走20米」这类原始指令清成能念的短句。 */
function cleanLabel(label: string): string {
    return label.replace(/^(?:去|到|走向|往前走|往|向)/, '').slice(0, 20);
}

function failureText(reason: string): string {
    switch (reason) {
        case 'STUCK': return '前面过不去，停下了';
        case 'NO_GROUND_AHEAD': return '前方是陡坡或悬崖，停下了';
        case 'TIMEOUT': return '走太久了，先停下';
        case 'OUT_OF_BOUNDS': return '超出活动范围了，停下了';
        default: return '没法继续前进了';
    }
}
