// Cesium 适配器 —— 把 EmbodiedAgent 接到 cesium-player-controller。
//
// 这是「包」和「具体场景」之间唯一的接缝。
// 使用者只需要：一个 playerController 实例 + 一个坐标基准点。
//
// 注意：本文件依赖 cesium，所以**不在主入口里**导出。
// 不用 Cesium 的人引入本包时，不应该被迫加载 4MB 的 Cesium。
// 引入方式：import { EnuFrame } from 'embodied-agent/cesium'

import type { Cartesian3, Matrix4 } from 'cesium';
import type { Pose, SceneAdapter, Vec3 } from './types.ts';
import type { EmbodiedAgent } from './agent.ts';
import { applyOutput, type BodyLike } from './body.ts';

export { applyOutput };
export type { BodyLike } from './body.ts';

/**
 * playerController 里本包用到的部分。
 * 用结构类型而不是 import 具体类，避免把 cesium-player-controller 变成硬依赖。
 */
export interface PlayerLike extends BodyLike {
    position?: Cartesian3;
    posEcef: Cartesian3;
    isFlying: boolean;
    playerIsOnGround: boolean;
    getPlayerHeading?: () => number;
    setScriptedYaw(yaw: number | null): void;
    setFlightMode(enabled: boolean): void;
    getGroundClearanceMeters(): number;
    viewer: { scene: { globe: { getHeight: (c: Cartesian3) => number | undefined } } };
}

/**
 * 以某个 ENU 原点为基准，建立 ECEF ↔ ENU 的转换。
 *
 * 场景里的场站偏移量（如 farm.json 的 offset）都是相对这个原点的 ENU 米，
 * 所以智能体内部一律用 ENU 计算，只在写回 playerController 时转成世界方向。
 *
 * 构造函数接收 Cesium 命名空间（注入而非 import），这样：
 *   - 本模块可以做纯类型依赖，不在加载时拉入 4MB Cesium
 *   - 单元测试可以传假的 Cesium
 */
export class EnuFrame {
    private readonly matrix: Matrix4;
    private readonly inverse: Matrix4;
    private readonly C: CesiumApi;

    constructor(originEcef: Cartesian3, cesium?: CesiumApi) {
        const C = cesium ?? getCesium();
        this.C = C;
        this.matrix = C.Transforms.eastNorthUpToFixedFrame(originEcef);
        this.inverse = C.Matrix4.inverse(this.matrix, new C.Matrix4());
    }

    /** ECEF → 相对原点的 ENU（米）。 */
    toEnu(ecef: Cartesian3): Vec3 {
        const local = this.C.Matrix4.multiplyByPoint(this.inverse, ecef, new this.C.Cartesian3());
        return { east: local.x, north: local.y, up: local.z };
    }

    /** 相对原点的 ENU（米）→ ECEF。 */
    toEcef(enu: Vec3): Cartesian3 {
        return this.C.Matrix4.multiplyByPoint(
            this.matrix,
            new this.C.Cartesian3(enu.east, enu.north, enu.up),
            new this.C.Cartesian3(),
        );
    }

    /** ENU 位置处的地表高度（相对原点的 up 分量）。无法判定返回 null。 */
    surfaceHeightAt(viewer: PlayerLike['viewer'], east: number, north: number): number | null {
        const globe = viewer.scene.globe;
        if (!globe) return null;
        // globe 未就绪时 getHeight 会抛 DeveloperError（"left is required"），
        // 必须吞掉：探测失败只让反射层放弃判断，不应中断运动解算。
        try {
            const ecef = this.toEcef({ east, north, up: 0 });
            const h = globe.getHeight(ecef);
            if (h == null || !Number.isFinite(h)) return null;
            return this.toEnu(ecef).up;
        } catch {
            return null;
        }
    }
}

/** 本包用到的 Cesium 成员（注入用）。 */
export interface CesiumApi {
    Cartesian3: typeof import('cesium').Cartesian3;
    Matrix4: typeof import('cesium').Matrix4;
    Transforms: typeof import('cesium').Transforms;
}

let cachedCesium: CesiumApi | null = null;

/**
 * 取 Cesium 命名空间。
 *
 * 优先用全局的 Cesium（页面用 script 标签引入的场景），否则报错并提示。
 * 不做静态 import —— 那会让不用 Cesium 的人也被迫打包它。
 */
function getCesium(): CesiumApi {
    if (cachedCesium) return cachedCesium;
    const globalCesium = (globalThis as { Cesium?: CesiumApi }).Cesium;
    if (globalCesium?.Cartesian3 && globalCesium.Matrix4 && globalCesium.Transforms) {
        cachedCesium = globalCesium;
        return globalCesium;
    }
    throw new Error(
        'EnuFrame 需要 Cesium。请显式传入：new EnuFrame(origin, Cesium)，' +
        '或把 Cesium 挂到全局（window.Cesium）。',
    );
}

export interface CesiumAdapterOptions {
    player: PlayerLike;
    frame: EnuFrame;
    /** 可选的参照物表：口语名 → ENU 坐标。 */
    references?: Map<string, Vec3>;
    /** 可选的别名表：口语名 → 正式名。 */
    aliases?: Map<string, string>;
}

/**
 * 把 playerController 包装成 SceneAdapter。
 */
export class CesiumSceneAdapter implements SceneAdapter {
    private readonly player: PlayerLike;
    private readonly frame: EnuFrame;
    private readonly references: Map<string, Vec3>;
    private readonly aliases: Map<string, string>;

    constructor(opts: CesiumAdapterOptions) {
        this.player = opts.player;
        this.frame = opts.frame;
        this.references = opts.references ?? new Map();
        this.aliases = opts.aliases ?? new Map();
    }

    getPose(): Pose {
        const enu = this.frame.toEnu(this.player.posEcef);
        const yaw = this.player.getPlayerHeading?.() ?? 0;
        return {
            east: enu.east,
            north: enu.north,
            up: enu.up,
            yaw,
            flying: this.player.isFlying,
            onGround: this.player.playerIsOnGround,
        };
    }

    groundHeightAt(east: number, north: number): number | null {
        return this.frame.surfaceHeightAt(this.player.viewer, east, north);
    }

    resolveReference(text: string): Vec3 | null {
        // 最长匹配优先：「3 号风机」优先于「3 号」
        const keys = [...this.references.keys()].sort((a, b) => b.length - a.length);
        for (const key of keys) {
            if (text.includes(key)) return this.references.get(key)!;
        }
        for (const [alias, target] of this.aliases) {
            if (text.includes(alias)) {
                const v = this.references.get(target);
                if (v) return v;
            }
        }
        // ASR 几乎总把「3 号」识别成「三号」，而场景里的 ID 是阿拉伯数字。
        // 不做这层归一，语音输入会一直「没听懂」，而文字输入却正常 —— 极难排查。
        const normalized = normalizeNumerals(text);
        if (normalized !== text) {
            for (const key of keys) {
                if (normalized.includes(key)) return this.references.get(key)!;
            }
        }
        return null;
    }

    /** 运行期注册参照物（场景加载后调用）。 */
    addReference(name: string, position: Vec3): void {
        this.references.set(name, position);
    }
}

const CN_DIGITS: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
    五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/**
 * 中文数字 → 阿拉伯数字。
 *
 * 为什么在适配层做而不是意图层：这是 ASR 的输入特征，不是场景语义。
 * 文字输入「3号」、语音输入「三号」，两者应该解析到同一个参照物。
 *
 * 只在数字后面紧跟 ID 或单位时才转换（号/米/台/层…）。
 * 不能无条件转换 ——「往左一点」的「一」是量词，转成「1点」就毁了。
 */
export function normalizeNumerals(text: string): string {
    return text.replace(
        /([零〇一二两三四五六七八九十]+)(?=号|米|公里|千米|台|座|层|楼|个|#)/g,
        (match) => chineseToNumber(match) ?? match,
    );
}

/** 中文数字 → 数字；无法解析返回 null。只支持 1-99。 */
function chineseToNumber(s: string): string | null {
    if (s.length === 1) {
        const v = CN_DIGITS[s];
        return v == null ? null : String(v);
    }
    if (s.startsWith('十')) {
        const rest = s.slice(1);
        if (rest.length !== 1) return null;
        const unit = CN_DIGITS[rest];
        return unit == null ? null : String(10 + unit);
    }
    const parts = s.split('十');
    if (parts.length !== 2) return null;
    const [tensPart, onesPart] = parts;
    if (tensPart.length !== 1) return null;
    const tens = CN_DIGITS[tensPart];
    if (tens == null || tens === 10) return null;
    if (onesPart === '') return String(tens * 10);          // 二十、三十
    if (onesPart.length !== 1) return null;
    const ones = CN_DIGITS[onesPart];
    if (ones == null || ones === 10) return null;
    return String(tens * 10 + ones);                         // 二十三
}
/**
 * 便捷驱动：把智能体挂到 Cesium 的 postRender 上，自动每帧解算并施加。
 * 返回卸载函数。
 */
export function attachToViewer(
    viewer: { scene: { preRender?: { addEventListener: (fn: () => void) => void; removeEventListener: (fn: () => void) => void } } },
    agent: EmbodiedAgent,
    player: PlayerLike,
): () => void {
    let last = performance.now();
    const tick = () => {
        const now = performance.now();
        const dt = Math.min((now - last) / 1000, 0.1); // 防止切后台后大跳
        last = now;
        const out = agent.update(dt);
        applyOutput(player, out);
    };
    viewer.scene.preRender?.addEventListener(tick);
    return () => viewer.scene.preRender?.removeEventListener(tick);
}
