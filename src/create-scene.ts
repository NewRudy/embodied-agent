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
import { RuleDecider, decideFast, decideWithChain } from './intent.ts';
import { CONFIDENCE_THRESHOLD, type Intent, type IntentDecider, type ParseContext } from './intent-types.ts';
import { LlmDecider, type LlmDeciderOptions } from './llm-decider.ts';
import { TaskQueue, splitSteps, type TaskStep } from './task-queue.ts';
import { applyOutput, releaseBody, type BodyLike } from './body.ts';
import type { LocomotionProfile } from './locomotion.ts';
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
    /**
     * 意图层配置。
     *
     * 不传时只有规则层 —— 零依赖、零延迟、零成本，能听懂「去A点」「往左一点」。
     * 传 `llm: {...}` 或设置 EMBODIED_LLM_* 环境变量后，规则层听不懂的话会再问模型。
     */
    intent?: {
        /** 模型决策器配置。传 false 明确关闭。 */
        llm?: LlmDeciderOptions | false;
        /** 自定义决策器，会排在规则层之后、模型层之前。 */
        extraDeciders?: IntentDecider[];
    };
    /**
     * 移动动画配置。给了才会做动画速度匹配。
     *
     * 不给时动画由引擎按 walk/run 二选一播放 —— 那时位移速度和动画速度
     * 对不上，人物看起来像滑冰。用 tools/measure-stride.ts 量出你模型的
     * 自然速度后填进来。
     */
    locomotion?: LocomotionProfile;
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
    /** 多步任务队列。单步指令不经过它。 */
    tasks: TaskQueue;
    /**
     * 处理一句话（文字或语音转写都走这里）。
     *
     * **同步返回**：规则层能听懂就当场执行完，「停」不会等一个 microtask。
     * 规则层听不懂且配了模型时，模型在后台跑，结果回来再生效 ——
     * 用序号保证「后说的指令永远赢过先说的」。
     */
    handleCommand(text: string): void;
    /** 同 handleCommand，但等模型层跑完。给需要确定性的调用方（测试、脚本）。 */
    handleCommandAsync(text: string): Promise<void>;
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
    /**
     * 最近一帧的运动快照，供 `state()` 返回。
     *
     * 为什么不现算：距离和速度只在 `agent.update()` 的返回值里，
     * 而 update 有副作用（累计超时、卡住计时、速度爬坡），
     * 不能为了读一个数字再调一次。
     */
    let lastOutput: { state: string; distance: number | null; speed: number } = {
        state: 'idle',
        distance: null,
        speed: 0,
    };

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
        taskQueue.cancel();
        agent.cancel();
        if (options.player) {
            (options.player as unknown as { stopHorizontalMotion?: () => void }).stopHorizontalMotion?.();
        }
    }

    // —— 多步任务队列 ——
    // 「先去A点，再去B点」这类句子会被切成多步，逐步执行。
    // 单步指令不进队列，走原来的直接路径 —— 队列只处理真正有序的任务。
    const taskQueue = new TaskQueue({
        onAdvance: ({ index, step, total }) => {
            log(`▶ 第 ${index + 1}/${total} 步：${step.label}`);
            agent.setGoal(step.goal);
        },
        onFinish: ({ completed, failed, aborted }) => {
            if (aborted) {
                log(`⏹ 任务中止（完成 ${completed}，失败 ${failed}）`);
                speech?.speak('任务中止');
            } else {
                log(`✅ 任务完成（${completed} 步）`);
                speech?.speak('任务完成');
            }
        },
    });

    // —— 意图决策链 ——
    // 顺序：规则 → 自定义 → 模型。规则层永远先上，它命中就不花模型的钱。
    const deciders: IntentDecider[] = [new RuleDecider()];
    if (options.intent?.extraDeciders) deciders.push(...options.intent.extraDeciders);
    if (options.intent?.llm !== false) {
        const llm = new LlmDecider(options.intent?.llm || {});
        if (llm.available()) {
            deciders.push(llm);
            log(`🧠 模型意图层已启用：${llm.name}`);
        } else {
            log('🧠 未配置模型意图层（EMBODIED_LLM_API_KEY），只用规则层');
        }
    }

    /** 最近几轮，给模型做上下文。只留 5 轮，避免 prompt 无限膨胀。 */
    const history: Array<{ text: string; rule: string }> = [];
    /** 并发保护：新指令作废旧指令，防止慢模型返回时覆盖用户最新意图。 */
    let commandSeq = 0;

    /**
     * 构造解析上下文。适配器还没准备好时返回 null。
     *
     * 为什么不在外面 try：`getPose()` 抛异常时我们**不知道人物在哪**，
     * 「往东走 20 米」这种指令就没有基准点了。正确的做法是明确告诉用户
     * 「场景还没准备好」，而不是拿一个 (0,0) 去算，让人物跑到地图原点。
     */
    function buildContext(): ParseContext | null {
        let pose;
        try {
            pose = adapter.getPose();
        } catch (error) {
            log(`⚠️ 场景尚未就绪，忽略本次指令：${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
        return {
            pose: { east: pose.east, north: pose.north, yaw: pose.yaw },
            goal: agent.currentGoal,
            resolve: t => adapter.resolveReference(t),
            defaultStep: 10,
            references: adapter.listReferences?.(),
            history: history.slice(-5),
        };
    }

    function formatTrace(trace: Array<{ name: string; outcome: string; detail?: string }>): string {
        // 错误一定要带上原因。只打「llm:error」等于没打 —— 排查时得靠猜。
        return trace
            .map(t => (t.detail ? `${t.name}:${t.outcome}(${t.detail})` : `${t.name}:${t.outcome}`))
            .join(' ');
    }

    /** 拿到意图之后统一走这里。seq 不符说明已有更新指令，丢弃。 */
    function finish(text: string, intent: Intent | null, seq: number): void {
        // 慢模型返回时用户已经说了别的话 —— 丢弃，不要抢方向盘
        if (seq !== commandSeq) {
            log('   ↳ 已被更新的指令取代，忽略');
            return;
        }

        if (!intent) {
            log('   → 没听懂');
            speech?.speak('没听懂，请再说一次');
            emit();
            return;
        }

        if ((intent.confidence ?? 1) < CONFIDENCE_THRESHOLD) {
            log(`   → 没把握（置信度 ${(intent.confidence ?? 0).toFixed(2)}），不执行`);
            speech?.speak('我不太确定，请再说一次');
            emit();
            return;
        }

        history.push({ text, rule: intent.rule });
        if (history.length > 20) history.shift();

        applyIntent(intent, text);
        emit();
    }

    /**
     * 多步句子的处理路径。
     *
     * 只支持「走」类步骤（go / approach）。原因：队列表达的是**空间顺序**，
     * 「先跑起来再转向」这种时序动作塞进队列会变成四不像 ——
     * 那类句子请拆成两句说，或者等以后做真正的行为树。
     */
    async function finishMultiStep(parts: string[], seq: number): Promise<void> {
        const steps: TaskStep[] = [];
        for (const part of parts) {
            const ctx = buildContext();
            if (!ctx) return;
            let intent: Intent | null = null;
            try {
                const slow = await decideWithChain(part, ctx, deciders);
                intent = slow.intent;
            } catch (e) {
                log(`   ⚠️ 「${part}」解析失败：${e instanceof Error ? e.message : String(e)}`);
            }

            if (seq !== commandSeq) {
                log('   ↳ 已被更新的指令取代，忽略');
                return;
            }

            if (!intent) {
                log(`   → 「${part}」没听懂，整条任务不执行`);
                speech?.speak('有一步没听懂，任务取消');
                return;
            }
            if ((intent.confidence ?? 1) < CONFIDENCE_THRESHOLD) {
                log(`   → 「${part}」没把握，整条任务不执行`);
                speech?.speak('有一步没把握，任务取消');
                return;
            }
            if (intent.action !== 'go' && intent.action !== 'approach') {
                log(`   → 「${part}」是 ${intent.action}，多步任务只支持移动类步骤`);
                speech?.speak('多步任务只支持去某处的步骤');
                return;
            }
            steps.push({
                goal: { position: intent.position!, tolerance: 4, label: part },
                label: part,
            });
        }

        if (steps.length === 0) return;
        log(`📋 拆成 ${steps.length} 步：${steps.map(s => s.label).join(' → ')}`);
        taskQueue.reset();
        taskQueue.enqueue(steps);
        taskQueue.start();
        emit();
    }

    /**
     * 是否是多步句子。
     *
     * 返回 Promise<boolean> 而不是 boolean：解析每一步都要走决策链，
     * 调用方（尤其 handleCommandAsync）必须能等它，否则测试和脚本会在
     * 队列还没建好时就去断言。
     * handleCommand 走 fire-and-forget，不等。
     */
    async function tryMultiStep(text: string, seq: number): Promise<boolean> {
        const parts = splitSteps(text);
        if (parts.length <= 1) return false;
        await finishMultiStep(parts, seq);
        return true;
    }

    /**
     * 同步入口。规则层命中时**当场执行完**，不等 microtask。
     *
     * 这不是微优化：语音回调里调它，如果「停」要等一个 microtask 才生效，
     * 人物会在喊停之后还多走一帧。调用方也不该为了「停」而写 await。
     */
    function handleCommand(text: string): void {
        if (!text.trim()) return;
        const seq = ++commandSeq;
        log(`🗣 ${text}`);

        // 多步句子异步解析，不等它 —— 结果回来再生效，seq 会保护
        if (splitSteps(text).length > 1) {
            void tryMultiStep(text, seq);
            return;
        }

        const ctx = buildContext();
        if (!ctx) return;
        const fast = decideFast(text, ctx, deciders);
        if (fast.done) {
            if (fast.trace.length > 1) log(`   · ${formatTrace(fast.trace)}`);
            finish(text, fast.intent, seq);
            return;
        }

        // 规则层没搞定 —— 问模型，结果回来再生效。
        // 这里**不打** fast.trace：它全是「异步，留给慢路径」这种噪音，
        // 慢路径自己会打一份完整的。
        void (async () => {
            let intent: Intent | null = null;
            try {
                const slow = await decideWithChain(text, ctx, deciders);
                if (slow.trace.length > 1) log(`   · ${formatTrace(slow.trace)}`);
                intent = slow.intent;
            } catch (e) {
                log(`   ⚠️ 意图层异常：${e instanceof Error ? e.message : String(e)}`);
            }
            finish(text, intent, seq);
        })();
    }

    /** 等模型层跑完的版本。测试和脚本用。 */
    async function handleCommandAsync(text: string): Promise<void> {
        if (!text.trim()) return;
        const seq = ++commandSeq;
        log(`🗣 ${text}`);

        if (splitSteps(text).length > 1) {
            await tryMultiStep(text, seq);
            return;
        }

        const ctx = buildContext();
        if (!ctx) return;
        const fast = decideFast(text, ctx, deciders);
        if (fast.done) {
            if (fast.trace.length > 1) log(`   · ${formatTrace(fast.trace)}`);
            finish(text, fast.intent, seq);
            return;
        }

        let intent: Intent | null = null;
        try {
            const slow = await decideWithChain(text, ctx, deciders);
            if (slow.trace.length > 1) log(`   · ${formatTrace(slow.trace)}`);
            intent = slow.intent;
        } catch (e) {
            log(`   ⚠️ 意图层异常：${e instanceof Error ? e.message : String(e)}`);
        }
        finish(text, intent, seq);
    }

    function applyIntent(intent: Intent, text: string) {
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
                if (!agent.currentGoal) {
                    // 没有活动目标时「往左一点」没有参照，按原地侧移处理
                    agent.setGoal({ position: intent.position!, tolerance: 4, label: text });
                    log('   → 出发（无活动目标，按侧移处理）');
                } else {
                    agent.reviseGoal({ position: intent.position! });
                    log('   → 修正目标');
                }
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
            default:
                log('   → 未支持的动作');
        }
    }

    /** 上一帧的异常信息，用于「同一个错只报一次」。 */
    let lastTickError = '';

    /**
     * 每帧解算。
     *
     * **异常不能冒到调用方** —— 这个方法通常直接放在 requestAnimationFrame 里，
     * 抛一次异常整个渲染循环就停了，用户看到的是「页面卡死」，日志里什么都没有。
     *
     * 具体防的是场景适配器：Cesium 场景在 tileset 加载完之前，getPose() 可能抛
     * 或返回垃圾值。这时候正确的做法是跳过这一帧，而不是让整个场景死掉。
     */
    function tick(dt: number) {
        if (disposed) return;
        try {
            const out = agent.update(dt);
            // 缓存本帧结果供 state() 使用 —— agent 只把距离和速度放在
            // update() 的返回值里，不提供 getter。
            lastOutput = {
                state: String(out.state),
                distance: out.distance ?? null,
                speed: out.movement.speedMetersPerSecond,
            };
            if (options.player) applyOutput(options.player, out, { locomotion: options.locomotion });

            // 队列推进必须在到达回调之前 —— 这样「到达并开始下一步」在同一帧内完成，
            // 人物不会在两步之间停一帧。
            taskQueue.notify(out.justArrived, out.failure);

            // 到达/失败时说话
            // 队列运行中由队列自己播报，这里不重复播
            if (!taskQueue.isRunning) {
                if (out.justArrived) {
                    const label = out.goal?.label ?? '目标';
                    log(`✅ 到达 ${label}`);
                    speech?.speak(`已到达${cleanLabel(label)}`);
                } else if (out.failure) {
                    log(`⚠️ 失败：${out.failure}`);
                    speech?.speak(failureText(out.failure));
                }
            } else if (out.failure) {
                log(`⚠️ 任务步失败：${out.failure}`);
            }
            emit(out);
        } catch (error) {
            // 连续报同一个错只打一次，避免每帧刷屏把控制台冲掉
            const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            if (message !== lastTickError) {
                lastTickError = message;
                log(`⚠️ tick 异常（已跳过本帧）：${message}`);
            }
        }
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
        tasks: taskQueue,
        handleCommand,
        handleCommandAsync,
        tick,
        setGoal: goal => agent.setGoal(goal),
        stop,
        state: () => ({
            // goalState 直接问 agent：它比 lastOutput 更即时 ——
            // handleCommand('停') 之后还没 tick 过时，lastOutput 仍是上一帧的 'active'。
            goalState: agent.currentState,
            distance: lastOutput.distance,
            speed: lastOutput.speed,
            voiceState,
            transcript,
        }),
        dispose() {
            disposed = true;
            voice?.stop();
            speech?.cancel();
            taskQueue.cancel();
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
