// 具身智能体 —— 公开出口。
//
// 三层：
//   L1 steering  目标 → 每帧运动量
//   L2 agent     目标生命周期 + 反射
//   L3 intent    一句话 → 目标操作
//
// 核心不依赖 Cesium / 网络 / 模型。

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
