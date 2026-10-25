// 出生点解算 —— 别信配置里的高度，用物理问地面。
//
// 为什么需要：
//   场景资产里的 `up` 经常是错的（设计标高、椭球高、或者手填）。
//   farm.json 写 `up: 148`，实际地面在 `up: -33.9` —— 差 182 米。
//   照配置出生，人物会从 151 米高处自由落体 4 秒才落地。
//
//   对「任意场景即插即用」来说这是致命的：每接一个新场景，只要高度写错，
//   第一眼看到的就是人从天而降。而且这个错误不报错、不崩溃，只是很难看。
//
// 两种探测方式，优先用第一种：
//   1. `probeClearance`：把角色瞬移到目标位置，读「脚下到地面的距离」。
//      这是 playerController 自己的地面检测，与物理积分用的是同一套，
//      所以一定和人物实际落脚点一致。
//   2. `raycastEcefHit`：从高处往下打射线。快，但依赖碰撞网格的朝向 ——
//      在 3D Tiles 山体上实测全部落空（射线从模型侧面穿过去了）。
//
// 探不到就退回配置值 —— 宁可站着不动，也不要崩掉整个场景加载。

/** 向量：只要求能被 Cesium 的运算读写。单元测试用普通数组当向量，不引入 Cesium。 */
export type Vector = { x?: number; y?: number; z?: number } | number[];

/** 能朝下打射线的物理系统。cesium-player-controller 的 PhysicsSystem 满足它。 */
export interface GroundProbe {
    raycastEcefHit?(
        originEcef: any,
        dirEcef: any,
        maxDist: number,
    ): { distance: number; point: any } | undefined;
    /** 只返回距离的版本（拿不到命中点时用）。 */
    raycastEcef?(originEcef: any, dirEcef: any, maxDist: number): number;
}

export interface ResolveSpawnOptions {
    /** ENU 转换器：把 ENU 坐标变成 ECEF。 */
    toEcef: (enu: { east: number; north: number; up: number }) => any;
    /** ENU 转换器：把 ECEF 变成相对原点的 ENU。 */
    toEnu: (ecef: any) => { east: number; north: number; up: number };
    /** Cesium 命名空间（注入）。只用到 Cartesian3 的几个纯函数。 */
    cesium: { Cartesian3: { subtract: any; add: any; multiplyByScalar: any; normalize: any } };
    /** 物理系统。不给则无法用射线探测。 */
    physics?: GroundProbe;
    /**
     * 把角色瞬移到某处并读出「脚下到地面多远」。
     *
     * 给这个就优先走它 —— 比射线可靠，因为和物理积分用的是同一套地面检测。
     * 返回 null 表示这个位置探不到地面。
     *
     * 实现提示：调用方通常用 player.reset(ecef) + player.getGroundClearanceMeters()。
     * 注意 reset 会清速度，探测完要把角色放到最终位置。
     */
    probeClearance?: (at: { east: number; north: number; up: number }) => number | null;
    /** 配置里的出生点。它的 east/north 是可信的，up 不可信。 */
    configured: { east: number; north: number; up: number };
    /** 从配置高度往上探多少米开始找。默认 500。 */
    probeAbove?: number;
    /** 往下探多少米。默认 2000。 */
    probeBelow?: number;
    /**
     * 逐级下探的步长（米）。默认 150。
     *
     * 为什么需要逐级：`getGroundClearanceMeters` 内部是 `groundDistance(200)`，
     * 只往脚下打 200 米。从配置高度往上抬 500 米处直接测，脚下 680 米开外
     * 一定返回 Infinity —— 实测就是这样，配置 148、地面 -33.9，什么都测不到。
     * 所以从最高点往下按步长扫，第一个测得到的就当作地面。
     *
     * 步长必须 < 200，否则会从两次探测之间漏掉地面。留 50 米余量。
     */
    probeStep?: number;
    /**
     * 找到地面后额外抬高多少米。
     *
     * 默认值按探测方式区分，因为两者算出来的东西不同：
     * - 瞬移测距：`up - clearance` 已经是**胶囊静止站立高度**，精确贴地，
     *   所以默认 0。多抬一点就会超过 `maxH = snapH + rideHeight`（约 1.5 米）
     *   的离地判定，人物反而会掉一下 —— 实测抬 1 米就掉。
     * - 射线：拿到的是**地面表面高度**，人放上去会嵌进地里，所以默认 1。
     */
    lift?: number;
}

export interface ResolvedSpawn {
    /** 最终出生点（ENU）。 */
    at: { east: number; north: number; up: number };
    /** 地面高度（ENU up）。没探到则 null。 */
    groundUp: number | null;
    /** 配置值与实测地面的差（米）。诊断用。 */
    correction: number | null;
    /** 是否用了实测地面。false 表示退回配置值。 */
    measured: boolean;
    /** 用哪种方式测到的。诊断用。 */
    method: 'clearance' | 'raycast' | 'none';
}

/**
 * 解算出生点：在 (east, north) 处找真实地面。探不到就退回配置值。
 */
export function resolveSpawn(options: ResolveSpawnOptions): ResolvedSpawn {
    const { configured, physics, cesium: C } = options;
    const probeAbove = options.probeAbove ?? 500;
    const probeBelow = options.probeBelow ?? 2000;
    const fallback: ResolvedSpawn = {
        at: { ...configured },
        groundUp: null,
        correction: null,
        measured: false,
        method: 'none',
    };

    // —— 方式一：把角色放过去，读脚下距离 ——
    if (options.probeClearance) {
        const step = Math.min(options.probeStep ?? 150, 190);
        // 从配置高度往上抬，这个位置一定在地面之上。
        const top = configured.up + probeAbove;
        const bottom = configured.up - probeBelow;

        // 逐级往下扫。第一次测得到的地方，脚下 200 米内就是地面。
        for (let up = top; up >= bottom; up -= step) {
            let clearance: number | null = null;
            try {
                clearance = options.probeClearance({
                    east: configured.east,
                    north: configured.north,
                    up,
                });
            } catch {
                // 物理没就绪。再往下试也没意义，交给方式二。
                break;
            }
            if (clearance == null || !Number.isFinite(clearance) || clearance < 0) continue;

            // `clearance` 是「胶囊底到地面」，所以 up - clearance 就是
            // 「胶囊中心刚好站在地面上」的高度 —— 人物放在这里就落地了，
            // 不需要知道胶囊半高，也不需要额外抬高。
            const lift = options.lift ?? 0;
            let standUp = up - clearance;

            // 收敛一次：地形起伏时粗扫的落脚点可能还悬空，再测一次补掉。
            try {
                const again = options.probeClearance({
                    east: configured.east,
                    north: configured.north,
                    up: standUp,
                });
                if (again != null && Number.isFinite(again) && again >= 0) standUp -= again;
            } catch {
                // 补测失败就用粗扫结果，已经足够接近。
            }

            return {
                at: { east: configured.east, north: configured.north, up: standUp + lift },
                groundUp: standUp,
                correction: standUp - configured.up,
                measured: true,
                method: 'clearance',
            };
        }
    }

    // —— 方式二：射线 ——
    if (!physics || (!physics.raycastEcefHit && !physics.raycastEcef)) return fallback;

    // 射线起点：配置高度再往上抬 probeAbove 米。这样即使配置值偏低也能找到地面。
    const startEnu = { east: configured.east, north: configured.north, up: configured.up + probeAbove };
    const startEcef = options.toEcef(startEnu);

    // 向下的方向：ENU 里 up=-1。转成 ECEF 要减两个点，得到世界方向向量。
    const downEnu = { east: configured.east, north: configured.north, up: configured.up + probeAbove - 1 };
    const downEcef = options.toEcef(downEnu);
    // 输出参数传 {}：Cesium 的 Cartesian3 运算只读写 x/y/z 三个字段，
    // 不检查原型，所以普通对象也能当向量用。测试里传数组同理。
    const dir = C.Cartesian3.subtract(downEcef, startEcef, {} as any);
    C.Cartesian3.normalize(dir, dir);

    const maxDist = probeAbove + probeBelow;
    // 射线拿到的是地面表面，不抬高会嵌进地里。
    const lift = options.lift ?? 1;

    let groundEcef: any;
    try {
        if (physics.raycastEcefHit) {
            const hit = physics.raycastEcefHit(startEcef, dir, maxDist);
            groundEcef = hit?.point;
        } else if (physics.raycastEcef) {
            const distance = physics.raycastEcef(startEcef, dir, maxDist);
            if (Number.isFinite(distance)) {
                groundEcef = C.Cartesian3.add(
                    startEcef,
                    C.Cartesian3.multiplyByScalar(dir, distance, {} as any),
                    {} as any,
                );
            }
        }
    } catch {
        // 物理世界还没建好、或射线 API 变了。退回配置值。
        return fallback;
    }

    if (!groundEcef) return fallback;

    const groundEnu = options.toEnu(groundEcef);
    if (!Number.isFinite(groundEnu.up)) return fallback;

    return {
        at: { east: configured.east, north: configured.north, up: groundEnu.up + lift },
        groundUp: groundEnu.up,
        correction: groundEnu.up - configured.up,
        measured: true,
        method: 'raycast',
    };
}
