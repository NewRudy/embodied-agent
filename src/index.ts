// 具身智能体 —— 公开出口（主入口）。
//
// 这个入口**不加载 Cesium**。不用 Cesium 的场景（Three.js / Babylon / 自研引擎）
// 引入本包时不应该被迫打包 4MB 的 Cesium。
//
// Cesium 相关实现单独走子路径：
//   import { EnuFrame, CesiumSceneAdapter } from 'embodied-agent/cesium'
//
// 四层：
//   L1 steering  目标 → 每帧运动量
//   L2 agent     目标生命周期 + 反射
//   L3 intent    一句话 → 目标操作
//   L4 voice     语音输入 + 播报 + 回声过滤
//
// 两条使用路径：
//   1. 一站式：createEmbodiedScene({ adapter, player, voice })
//   2. 只用运动层：new EmbodiedAgent(adapter) + 自己每帧调 update()

// —— 一站式装配 ——
export { createEmbodiedScene } from './create-scene.ts';
export type { EmbodiedScene, EmbodiedSceneOptions, SceneState } from './create-scene.ts';

// —— 核心 ——
export { EmbodiedAgent, goalAt, wrapPi } from './agent.ts';
export { arriveSpeed, headingTo, horizontalDistance, steerToward, turnToward, unitTo } from './steering.ts';
export { parseIntent, RuleDecider, decideFast, decideWithChain } from './intent.ts';
export type { Intent, IntentAction, ParseContext, ReferenceResolver } from './intent.ts';

// —— 意图决策层（可插拔） ——
export { CONFIDENCE_THRESHOLD } from './intent-types.ts';
export type { DecisionChainResult, IntentDecider } from './intent-types.ts';
export { LlmDecider, validateLlmIntent } from './llm-decider.ts';
export type { LlmDeciderOptions } from './llm-decider.ts';

// —— 多步任务编排 ——
export { TaskQueue, splitSteps } from './task-queue.ts';
export type { TaskQueueOptions, TaskStep } from './task-queue.ts';
export { DEFAULT_CONFIG, STOP } from './types.ts';
export type {
    AgentConfig,
    AgentOutput,
    FailReason,
    Goal,
    GoalState,
    MovementCommand,
    Pose,
    SceneAdapter,
    Vec3,
} from './types.ts';

// —— 施加到角色身体（引擎无关） ——
export { applyOutput, releaseBody, STOP_MOVEMENT } from './body.ts';
export type { BodyLike } from './body.ts';

// —— 语音 ——
export { RealtimeVoice, isImmediatePause } from './voice/realtime-voice.ts';
export type { RealtimeVoiceOptions, VoiceCommandTiming, VoiceState } from './voice/realtime-voice.ts';
export { SpeechOutput } from './voice/speech-output.ts';
export type { SpeechOutputOptions, SpeechPlayback } from './voice/speech-output.ts';
export {
    VoicePlaybackGuard,
    classifyPlaybackText,
    isPausePhrase,
    isPlaybackInterruption,
    stripWakePrefix,
} from './voice/playback-guard.ts';
export type {
    PlaybackDecision,
    PlaybackObservation,
} from './voice/playback-guard.ts';
export type {
    VoiceInterruption,
    VoiceInterruptionReason,
    VoiceStreamEvent,
    VoiceUtterance,
} from './voice/protocol.ts';
