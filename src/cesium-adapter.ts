// Cesium 适配器 —— 把 EmbodiedAgent 接到 cesium-player-controller。
//
// 这是「包」和「具体场景」之间唯一的接缝。
// 使用者只需要：一个 playerController 实例 + 一个坐标基准点。

import { Cartesian3, Matrix4, Transforms } from 'cesium';
import type { EmbodiedAgent, AgentOutput, Pose, SceneAdapter, Vec3 } from './index.ts';

/**
 * playerController 里本包用到的部分。
 * 用结构类型而不是 import 具体类，避免把 cesium-player-controller 变成硬依赖。
 */
export interface PlayerLike {
    position?: Cartesian3;
    posEcef: Cartesian3;
    isFlying: boolean;
    playerIsOnGround: boolean;
    getPlayerHeading?: () => number;
    setWorldMovement(input: {
        east: number; north: number; up?: number;
        run?: boolean; speedMetersPerSecond?: number; maxTravelMeters?: number;
    } | null): void;
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
 */
export class EnuFrame {
    private readonly origin: Cartesian3;
    private readonly matrix: Matrix4;
    private readonly inverse: Matrix4;

    constructor(originEcef: Cartesian3) {
        this.origin = originEcef;
        this.matrix = Transforms.eastNorthUpToFixedFrame(originEcef);
        this.inverse = Matrix4.inverse(this.matrix, new Matrix4());
    }

    /** ECEF → 相对原点的 ENU（米）。 */
    toEnu(ecef: Cartesian3): Vec3 {
        const local = Matrix4.multiplyByPoint(this.inverse, ecef, new Cartesian3());
        return { east: local.x, north: local.y, up: local.z };
    }

    /** 相对原点的 ENU（米）→ ECEF。 */
    toEcef(enu: Vec3): Cartesian3 {
        return Matrix4.multiplyByPoint(
            this.matrix,
            new Cartesian3(enu.east, enu.north, enu.up),
            new Cartesian3(),
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
        return null;
    }

    /** 运行期注册参照物（场景加载后调用）。 */
    addReference(name: string, position: Vec3): void {
        this.references.set(name, position);
    }
}

/**
 * 把智能体的输出写回 playerController。每帧调用一次。
 */
export function applyOutput(player: PlayerLike, out: AgentOutput): void {
    if (out.movement.speedMetersPerSecond <= 0) {
        player.setWorldMovement({ east: 0, north: 0, up: 0, run: false, speedMetersPerSecond: 0 });
    } else {
        player.setWorldMovement({
            east: out.movement.east,
            north: out.movement.north,
            up: out.movement.up,
            run: out.movement.run,
            speedMetersPerSecond: out.movement.speedMetersPerSecond,
        });
    }
    player.setScriptedYaw(out.yaw);
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
