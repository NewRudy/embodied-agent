// 具身智能体 —— 公开出口。
//
// 四层：
//   L1 steering  目标 → 每帧运动量
//   L2 agent     目标生命周期 + 反射
//   L3 intent    一句话 → 目标操作
//   L4 voice     语音输入 + 播报 + 回声过滤
//
// 核心不依赖 Cesium / 网络 / 模型。
//
// 两条使用路径：
//   1. 只用运动层：new EmbodiedAgent(adapter) + 自己每帧调 update()
//   2. 一站式：createEmbodiedScene({ adapter, player, voice }) —— 文字+语音都能用

// —— 一站式装配 ——
export { createEmbodiedScene } from './create-scene.ts';
export type { EmbodiedScene, EmbodiedSceneOptions, SceneState } from './create-scene.ts';

// —— 核心 ——
export { EmbodiedAgent, goalAt, wrapPi } from './agent.ts';
export { arriveSpeed, headingTo, horizontalDistance, steerToward, turnToward, unitTo } from './steering.ts';
export { parseIntent } from './intent.ts';
export type { Intent, IntentAction, ParseContext, ReferenceResolver } from './intent.ts';
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

// —— Cesium 适配器（用到 Cesium 的模块，按需引入） ——
export { CesiumSceneAdapter, EnuFrame, applyOutput } from './cesium-adapter.ts';
export type { CesiumAdapterOptions, PlayerLike } from './cesium-adapter.ts';

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
