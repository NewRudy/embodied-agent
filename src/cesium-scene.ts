// Cesium 场景装配 —— 把「一个 3D 场景」接到 createEmbodiedScene 上。
//
// 分工：
//   create-scene.ts  引擎无关的装配（意图、语音、每帧解算）
//   本文件           Cesium 专属的装配（viewer、ENU 原点、出生点实测、参照物）
//
// 为什么要分开：引擎无关那层要能被 Three.js / Babylon 复用，不该 import cesium。
// 本文件依赖 Cesium，所以只从 `embodied-agent/cesium` 子入口导出。

import type { Viewer } from 'cesium';
import type { Vec3 } from './types.ts';
import { CesiumSceneAdapter, EnuFrame, type CesiumApi, type PlayerLike } from './cesium-adapter.ts';
import { resolveSpawn, type GroundProbe, type ResolvedSpawn } from './spawn.ts';

/** 口语名 → ENU 坐标。 */
export interface ReferenceEntry {
    /** 正式名，日志里显示的就是它。 */
    name: string;
    /** ENU 坐标（相对场景原点）。 */
    at: Vec3;
    /** 额外别名，比如「3号风机」同时登记「风机3」「3号机组」。 */
    aliases?: string[];
    /** 给模型看的描述（「白色风力发电机」）。 */
    description?: string;
}

export interface CesiumSceneSetup {
    /** Cesium Viewer 实例。 */
    viewer: Viewer;
    /** 场景原点。ENU 坐标都相对它。 */
    origin: { lon: number; lat: number; heightM: number };
    /** Cesium 命名空间（注入，避免本包在加载时 import cesium）。 */
    cesium: CesiumApi & { fromDegrees: (lon: number, lat: number, heightM: number) => unknown };
    /**
     * 创建 playerController 并完成 init。
     *
     * 用回调而不是让本包直接 new：init 参数与场景强相关（碰撞体、模型路径、
     * 相机距离），而且本包不应该硬依赖 cesium-player-controller。
     */
    createPlayer: (ctx: { viewer: Viewer; enu: EnuFrame; spawn: unknown }) => Promise<PlayerLike>;
    /**
     * 配置里的出生点（ENU）。
     *
     * **只有 east/north 可信，up 不可信** —— 会从配置高度往上探 500 米、
     * 往下探 2000 米打物理射线找真实地面。
     * 为什么：场景资产里的 up 经常是设计标高或椭球高，跟实际地面差几百米。
     * 照它出生，人物会从天而降好几秒 —— 不报错、不崩溃，只是很难看。
     */
    spawn: Vec3;
    /** 参照物表。 */
    references?: ReferenceEntry[];
    /** 从 player 上取物理系统，用于实测地面。 */
    getPhysics?: (player: PlayerLike) => GroundProbe | undefined;
    /** 找到地面后抬高多少米。默认 1。 */
    spawnLift?: number;
    /**
     * 逐级下探的步长（米）。默认 150，上限 190。
     *
     * 底层 `getGroundClearanceMeters()` 只往脚下打 200 米，所以不能一次到位，
     * 必须逐级扫。见 spawn.ts 里 probeStep 的注释。
     */
    probeStep?: number;
    /** 日志。 */
    log?: (line: string) => void;
}

export interface CesiumSceneSetupResult {
    adapter: CesiumSceneAdapter;
    player: PlayerLike;
    enu: EnuFrame;
    /** 出生点解算结果。measured=false 表示没探到地面，用了配置值。 */
    spawn: ResolvedSpawn;
}

/**
 * 建立 Cesium 场景的三样东西：ENU 坐标系、人物、适配器。
 *
 * 不负责渲染循环 —— 那是 createEmbodiedScene 的 tick 或者调用方自己的事。
 */
export async function setupCesiumScene(options: CesiumSceneSetup): Promise<CesiumSceneSetupResult> {
    const log = options.log ?? (() => {});
    const C = options.cesium;

    const originEcef = C.fromDegrees(
        options.origin.lon, options.origin.lat, options.origin.heightM,
    ) as Parameters<typeof EnuFrame.prototype.toEnu>[0];
    const enu = new EnuFrame(originEcef as never, C);

    // —— 人物 ——
    // 先按配置出生：物理世界是在 init 里建的，而 init 需要出生点，所以只能两段。
    const configured = options.spawn;
    const spawnEcef = enu.toEcef(configured);
    const player = await options.createPlayer({ viewer: options.viewer, enu, spawn: spawnEcef });

    // —— 出生点校正 ——
    // 优先用「把角色瞬移过去、读脚下距离」：这和物理积分用同一套地面检测，
    // 一定和人物实际落脚点一致。射线在 3D Tiles 山体上会落空（实测）。
    const p = player as unknown as {
        reset?: (position?: unknown) => void;
        setPosition?: (position: unknown) => void;
        getGroundClearanceMeters?: () => number;
        physics?: { step?: (delta?: number) => void };
    };
    const canTeleport = typeof p.reset === 'function' || typeof p.setPosition === 'function';
    const teleport = (target: unknown) => {
        if (typeof p.reset === 'function') p.reset(target);
        else if (typeof p.setPosition === 'function') p.setPosition(target);
    };

    // Rapier 的 queryPipeline 只在 world.step() 里重建。init 只是把碰撞体加进去，
    // 没步进过，所以此刻 castRay 对任何位置都返回 Infinity —— 实测就是这样：
    // 同一位置在 step 前测得 Infinity、step 后测得 181.9。
    // 补一步再探测，否则出生点校正永远失败。
    if (p.physics?.step) {
        try { p.physics.step(); } catch { /* 物理还没就绪，探测会走退回路径 */ }
    }

    const resolved = resolveSpawn({
        toEcef: (o) => enu.toEcef(o),
        toEnu: (c) => enu.toEnu(c),
        cesium: C as never,
        ...(options.getPhysics ? { physics: options.getPhysics(player) } : {}),
        ...(canTeleport && typeof p.getGroundClearanceMeters === 'function'
            ? {
                probeClearance: (at: { east: number; north: number; up: number }) => {
                    teleport(enu.toEcef(at));
                    const c = p.getGroundClearanceMeters!();
                    return Number.isFinite(c) ? c : null;
                },
            }
            : {}),
        configured,
        ...(options.spawnLift != null ? { lift: options.spawnLift } : {}),
        ...(options.probeStep != null ? { probeStep: options.probeStep } : {}),
    });

    if (resolved.measured) {
        const delta = resolved.correction ?? 0;
        log(`📍 地面实测 up=${resolved.groundUp!.toFixed(1)}` +
            (Math.abs(delta) > 1
                ? `（配置写 ${configured.up.toFixed(1)}，差 ${delta.toFixed(0)} 米，已纠正）`
                : ''));
        if (canTeleport) teleport(enu.toEcef(resolved.at));
        else log('⚠️ 引擎既没有 reset 也没有 setPosition，出生点未纠正 —— 人物会从空中落下');
    } else {
        // 探测过程中角色被瞬移到过各种高度，必须放回去。
        // 漏这步的话，探测失败时人物会停在最后一个探测点（通常在地底），
        // 然后一直往下掉 —— 比不做校正还糟。
        if (canTeleport) teleport(spawnEcef);
        log(`📍 出生点用配置值 up=${configured.up.toFixed(1)}（无法实测地面）`);
    }

    // —— 适配器 ——
    const references = new Map<string, Vec3>();
    const aliases = new Map<string, string>();
    const descriptions = new Map<string, string>();
    for (const entry of options.references ?? []) {
        references.set(entry.name, entry.at);
        for (const a of entry.aliases ?? []) aliases.set(a, entry.name);
        if (entry.description) descriptions.set(entry.name, entry.description);
    }

    const adapter = new CesiumSceneAdapter({
        player,
        frame: enu,
        references,
        aliases,
        descriptions,
    });

    return { adapter, player, enu, spawn: resolved };
}

/** 只算适配器，不建人物（已有 player 时用）。 */
export function adapterFor(options: {
    player: PlayerLike;
    enu: EnuFrame;
    references?: ReferenceEntry[];
}): CesiumSceneAdapter {
    const references = new Map<string, Vec3>();
    const aliases = new Map<string, string>();
    const descriptions = new Map<string, string>();
    for (const entry of options.references ?? []) {
        references.set(entry.name, entry.at);
        for (const a of entry.aliases ?? []) aliases.set(a, entry.name);
        if (entry.description) descriptions.set(entry.name, entry.description);
    }
    return new CesiumSceneAdapter({
        player: options.player,
        frame: options.enu,
        references,
        aliases,
        descriptions,
    });
}
