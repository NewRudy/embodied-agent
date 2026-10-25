// 具身智能体核心类型
//
// 设计原则：核心层不依赖 Cesium、不依赖网络、不依赖模型。
// 它只做一件事——把「目标」变成每帧的运动量。所有外部世界通过 SceneAdapter 注入。

/** ENU 局部坐标（米）。east 向东、north 向北、up 向上。 */
export interface Vec3 {
    east: number;
    north: number;
    up: number;
}

/** 人物位姿。yaw 为弧度，0 = 正北，顺时针为正（π/2 = 正东）。 */
export interface Pose extends Vec3 {
    yaw: number;
    /** 是否处于飞行模式。地面模式受重力和跳跃约束。 */
    flying: boolean;
    /** 是否站在地面上。用于跳跃与坠落反射。 */
    onGround: boolean;
}

/**
 * 运动指令 —— 字段与 cesium-player-controller 的 setWorldMovement 完全一致。
 * 方向会被控制器归一化，速度由 speedMetersPerSecond 单独控制。
 */
export interface MovementCommand {
    east: number;
    north: number;
    up: number;
    run: boolean;
    speedMetersPerSecond: number;
}

/** 静止指令。 */
export const STOP: MovementCommand = Object.freeze({
    east: 0, north: 0, up: 0, run: false, speedMetersPerSecond: 0,
});

/** 目标。单位从「命令」变成「目标」是这一层的核心。 */
export interface Goal {
    /** 目标点 ENU。 */
    position: Vec3;
    /** 到达半径（米）。进入该半径即视为到达。 */
    tolerance: number;
    /** 可选：到达后转向的绝对方位（弧度）。不填则保持行进方向。 */
    faceYaw?: number;
    /** 可选：目标标签，仅用于日志与调试，不参与解算。 */
    label?: string;
    /** 可选：超时秒数。超时判失败，防止无限卡住。 */
    timeoutSeconds?: number;
}

/** 目标状态机。 */
export type GoalState = 'idle' | 'active' | 'arrived' | 'failed' | 'cancelled';

/** 失败原因 —— 只给类型码，不给自然语言，便于上层决定怎么跟用户说。 */
export type FailReason =
    | 'TIMEOUT'
    | 'STUCK'
    | 'NO_GROUND_AHEAD'
    | 'OUT_OF_BOUNDS';

/** 每帧的解算结果。 */
export interface AgentOutput {
    movement: MovementCommand;
    /** 脚本化朝向；null 表示交还相机/移动方向驱动。 */
    yaw: number | null;
    state: GoalState;
    /** 本帧是否刚从 active 变为 arrived。 */
    justArrived: boolean;
    /** 本帧是否刚失败。 */
    failure: FailReason | null;
    /** 当前目标（无则 null）。 */
    goal: Goal | null;
    /** 到当前目标的水平距离；无目标为 null。 */
    distance: number | null;
}

/**
 * 场景适配器 —— 使用者实现这 3 个方法，就能把智能体接到任意 3D 场景。
 *
 * 刻意保持最小：不做场景包、不做适配器注册、不做路由白名单。
 */
export interface SceneAdapter {
    /** 当前位姿。每帧调用一次。 */
    getPose(): Pose;
    /** 给定水平位置的地面高度；无法判定（未加载/悬空）返回 null。 */
    groundHeightAt(east: number, north: number): number | null;
    /** 把口语参照物解析为坐标；解析不了返回 null。例如「3 号风机」→ 位置。 */
    resolveReference(text: string): Vec3 | null;
    /**
     * 可选：列出场景里所有可去的参照物。
     *
     * 只有模型意图层会用到 —— 它需要知道「有哪些地方可选」，才能把
     * 「那个大风车」映射到登记过的名字，而不是自己编一个坐标。
     * 不实现这个方法时，模型层只能做「方位 + 距离」，做不了「去某物」。
     */
    listReferences?(): Array<{
        name: string;
        at: Vec3;
        /**
         * 可选：给人/模型看的描述。
         *
         * 「去那个绿色的点」这类话，模型必须知道哪个点是绿的才能答。
         * 没有描述时它只能瞎猜，或者（正确地）拒绝。
         */
        description?: string;
    }>;
}

/** 调参。全部有默认值，使用者通常只需改 1-2 个。 */
export interface AgentConfig {
    /** 步行速度（米/秒）。 */
    walkSpeed: number;
    /** 跑步速度（米/秒）。 */
    runSpeed: number;
    /** 进入减速区的距离（米）。越大越早开始减速。 */
    slowRadius: number;
    /** 最低速度，避免接近目标时以龟速蠕动。 */
    minSpeed: number;
    /** 默认到达半径（米）。 */
    arriveTolerance: number;
    /** 超过该速度自动切跑步。 */
    runThreshold: number;
    /**
     * 起步加速度（米/秒²）。默认 12。
     *
     * 为什么要有：速度从 0 直接跳到 3.2 m/s 时，人物是「弹射」出去的，
     * 但动画还停在第一步的起始姿势 —— 两者对不上，看起来像被推着走。
     * 12 m/s² 让 3.2 m/s 在 0.27 秒内到速，和真人起步接近。
     *
     * 设成 Infinity 可关闭（瞬间到速）。
     */
    accel: number;
    /**
     * 刹车减速度（米/秒²）。默认 20。
     *
     * 比 accel 大：真人停下比起步快。设成 Infinity 可关闭。
     */
    decel: number;
    /** 转向角速度上限（弧度/秒）。 */
    turnRate: number;
    /**
     * 偏离目标方向超过这个角度就**先原地转身，不往前走**。
     *
     * 为什么需要：转向受 turnRate 限制，转 180° 要 1 秒。如果这 1 秒里
     * 还全速前进，人物就是「横着滑过去」—— 侧滑感比慢更假。
     * 真人转身时是先站定转过来再走。
     *
     * 90°：横着走（侧身平移）是最难看的动作，正好落在边界上要触发；
     * 小角度修正不会打断行走。
     */
    turnFirstAngle: number;
    /** 偏离小于这个角度就完全不减速。中间区间按比例降速，避免突变。 */
    alignAngle: number;
    /** 卡住判定：位移低于 stuckDistance 持续 stuckSeconds 秒即判失败。 */
    stuckDistance: number;
    stuckSeconds: number;
    /**
     * 默认目标超时（秒）。
     * 必须容得下最长路径：420 米 / 步行 5m/s ≈ 84 秒，留足余量。
     * 超时只是兜底，真正的「卡住」由 stuckSeconds 检测。
     */
    defaultTimeout: number;
    /** 前方探测距离（米）。 */
    probeDistance: number;
    /** 前方落差超过该值视为悬崖，拒绝前进。 */
    maxStepDown: number;
    /** 活动边界半径（米），防止跑出场景。 */
    boundsRadius: number;
    /** 到达后是否停住（false 则保持朝向继续等待）。 */
    stopOnArrive: boolean;
}

export const DEFAULT_CONFIG: AgentConfig = Object.freeze({
    // 1.4 / 3.6：真人步行与慢跑速度。
    //
    // 以前是 3.2 / 6.5 —— 那是竞走和冲刺。配合动画速度匹配会选中
    // Jog/Sprint，于是「走」的时候人在冲刺。速度选对，动画自然对。
    walkSpeed: 1.4,
    runSpeed: 3.6,
    slowRadius: 12,
    minSpeed: 0.6,
    arriveTolerance: 3,
    runThreshold: 2.4,
    accel: 12,                  // 0 → 1.4 m/s 约 0.12 秒
    decel: 20,                  // 停下比起步快，真人也是这样
    turnRate: Math.PI,          // 180°/s
    // 90°/40°：横着走和掉头先站定转过来；小角度修正边走边转。
    // 90° 这个边界是量出来的 —— 90° 时如果还保持速度，屏幕上就是标准的侧滑。
    turnFirstAngle: (90 * Math.PI) / 180,
    alignAngle: (40 * Math.PI) / 180,
    stuckDistance: 0.15,
    stuckSeconds: 2.5,
    defaultTimeout: 600,
    probeDistance: 2.5,
    maxStepDown: 4,
    boundsRadius: 3000,
    stopOnArrive: true,
});
