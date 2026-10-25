// Cesium 专用出口 —— 单独子路径，避免污染主入口。
//
//   import { EnuFrame, CesiumSceneAdapter, normalizeNumerals } from 'embodied-agent/cesium'

export {
    CesiumSceneAdapter,
    EnuFrame,
    normalizeNumerals,
    attachToViewer,
} from './cesium-adapter.ts';
export type { CesiumAdapterOptions, PlayerLike, CesiumApi } from './cesium-adapter.ts';
export { applyOutput, releaseBody, STOP_MOVEMENT } from './body.ts';
export type { BodyLike } from './body.ts';
// 场景装配：接一个新 Cesium 场景只需要配一个对象，不用写装配逻辑。
export { setupCesiumScene, adapterFor } from './cesium-scene.ts';
export type {
    CesiumSceneSetup,
    CesiumSceneSetupResult,
    ReferenceEntry,
} from './cesium-scene.ts';
// 出生点解算：单独导出，方便已有 player 的场景自己调。
export { resolveSpawn } from './spawn.ts';
export type { ResolveSpawnOptions, ResolvedSpawn, GroundProbe } from './spawn.ts';
