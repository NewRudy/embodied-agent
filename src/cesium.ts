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
