// 动画速度匹配（locomotion speed matching）。
//
// 问题：骨骼动画的脚是按某个固定速度设计的。人物以别的速度位移时，
// 脚相对地面就打滑 —— 视觉上是「滑冰」。这不是动画做得不好，
// 是**动画速度和位移速度没对上**。
//
// 解法是游戏行业的标准做法，分两步：
//   1. 按速度挑最合适的 clip（走路 / 慢跑 / 冲刺），而不是只会二选一
//   2. timeScale = 实际速度 / clip 的自然速度，让脚步频率跟上位移
//
// 「自然速度」的定义：一个循环内脚相对地面走过的距离 ÷ 循环时长。
// 实测方法见 tools/measure-stride.ts（从 GLB 的脚部骨骼算出来，不用肉眼看）。

/** 一个可用的移动动画。 */
export interface LocomotionClip {
    /** 动画名，由调用方映射到具体引擎。 */
    name: string;
    /**
     * 自然速度（米/秒）。
     *
     * 一个循环内，脚相对地面走过的水平距离 ÷ 循环时长。
     * 这个值只和模型 + 缩放有关，和你的行走速度无关。
     */
    naturalSpeed: number;
}

/** 一套移动动画配置。 */
export interface LocomotionProfile {
    /** 静止动画名。 */
    idle: string;
    /** 移动动画，**按 naturalSpeed 升序**排列。 */
    clips: readonly LocomotionClip[];
}

export interface LocomotionState {
    /** 该播哪个 clip。 */
    clip: string;
    /** 播放速率倍率。1 = 原速。 */
    timeScale: number;
    /** 是否在移动（false 时应播 idle）。 */
    moving: boolean;
}

export interface LocomotionOptions {
    /** 低于这个速度就当静止（米/秒）。默认 0.15。 */
    minMovingSpeed?: number;
    /**
     * timeScale 下限。默认 0.5。
     *
     * 压得太低（比如 0.3）脚步会慢到像太空步，不如让脚稍微滑一点。
     */
    minTimeScale?: number;
    /**
     * timeScale 上限。默认 2.0。
     *
     * 超过 2 倍时腿会糊成一片。宁可留一点滑动，也不要看起来像快进。
     * 真需要更快就加一个 naturalSpeed 更高的 clip。
     */
    maxTimeScale?: number;
}

const DEFAULTS = { minMovingSpeed: 0.15, minTimeScale: 0.5, maxTimeScale: 2.0 } as const;

/**
 * 按速度选 clip 并算出播放速率。
 *
 * 选片规则：挑 **naturalSpeed 不超过当前速度的最大那个**，也就是尽量「往上加速播放」
 * 而不是「往下减速播放」。
 *
 * 为什么：减速播放一个冲刺动画，会让人物看起来在慢动作里迈大步 —— 比轻微加速更假。
 * 加速播放走路动画（1.2 倍）则几乎看不出来。
 */
export function locomotionFor(
    speed: number,
    profile: LocomotionProfile,
    options: LocomotionOptions = {},
): LocomotionState {
    const minMovingSpeed = options.minMovingSpeed ?? DEFAULTS.minMovingSpeed;
    const minTimeScale = options.minTimeScale ?? DEFAULTS.minTimeScale;
    const maxTimeScale = options.maxTimeScale ?? DEFAULTS.maxTimeScale;

    if (!Number.isFinite(speed) || speed < minMovingSpeed || profile.clips.length === 0) {
        return { clip: profile.idle, timeScale: 1, moving: false };
    }

    const clips = profile.clips;
    // 从后往前找第一个 naturalSpeed <= speed 的
    let chosen = clips[0]!;
    for (const clip of clips) {
        if (clip.naturalSpeed <= speed) chosen = clip;
        else break;
    }

    const raw = speed / Math.max(chosen.naturalSpeed, 1e-6);
    return {
        clip: chosen.name,
        timeScale: Math.max(minTimeScale, Math.min(maxTimeScale, raw)),
        moving: true,
    };
}

/**
 * 当前速度是否已经超出所有 clip 的能力范围。
 *
 * 超出时 locomotionFor 会把 timeScale 夹在上限，脚一定会滑一点。
 * 调用方可以用它来决定要不要警告使用者「你的速度太快了，加个跑步动画」。
 */
export function isSpeedOutOfRange(
    speed: number,
    profile: LocomotionProfile,
    options: LocomotionOptions = {},
): boolean {
    if (profile.clips.length === 0) return false;
    const maxTimeScale = options.maxTimeScale ?? DEFAULTS.maxTimeScale;
    const fastest = profile.clips.reduce((a, b) => (b.naturalSpeed > a.naturalSpeed ? b : a));
    return speed / Math.max(fastest.naturalSpeed, 1e-6) > maxTimeScale;
}

/**
 * 检查这套 clip 配置里有没有「永远用不上」的动画。
 *
 * 反向的陷阱，比 isSpeedOutOfRange 更隐蔽：**你配了跑步动画，但最高速度
 * 刚好低于它的 naturalSpeed，于是它一辈子不会被选中。**
 *
 * 实测踩到过：demo 配 `runSpeed: 3.6`，而 `Sprint_Loop` 的 naturalSpeed 是
 * 3.621 —— 差 0.021，跑步时永远播 `Jog_Fwd_Loop`。不报错、不崩溃，
 * 只是「跑起来」看起来没变快多少，很难判断是配置错了还是模型不行。
 *
 * 返回永远选不中的 clip 名。空数组表示配置有效。
 *
 * @param maxSpeed 场景里实际能达到的最高速度（通常是 runSpeed）。
 */
export function unusedClips(maxSpeed: number, profile: LocomotionProfile): string[] {
    if (profile.clips.length === 0) return [];
    // clips 按 naturalSpeed 升序；能选中的前提是 naturalSpeed <= maxSpeed。
    // 第一个 clip 是兜底，即使速度低于它也照样播（只是会减速播放）。
    return profile.clips.slice(1)
        .filter(clip => clip.naturalSpeed > maxSpeed)
        .map(clip => clip.name);
}

/**
 * 检查「跑」这个动作是不是从一出生就生效了 —— 于是「跑起来」永远没反应。
 *
 * 和 unusedClips 同一类陷阱：**配置本身自洽，但组合起来让一条指令变成空操作。**
 *
 * `steerToward` 判断要不要跑，用的是 `speed > config.runThreshold`。
 * 如果 `walkSpeed` 本身就高于 `runThreshold`，那起步就是跑，
 * 用户说「跑起来」时速度一点没变 —— 不报错、不崩溃，只是指令像失灵。
 *
 * 实测踩到过：sandbox 配 `walkSpeed: 4, runSpeed: 8`，用的是默认
 * `runThreshold: 2.4`。浏览器验收里距目标从 146 m 走到 107 m，
 * 速度全程 8.0 m/s，点「跑起来」毫无变化。
 *
 * 返回一句给人看的诊断；配置没问题时返回 null。
 */
export function runThresholdIssue(config: { walkSpeed: number; runSpeed: number; runThreshold: number }): string | null {
    if (config.runSpeed <= config.walkSpeed) {
        return `runSpeed (${config.runSpeed}) 不大于 walkSpeed (${config.walkSpeed})，「跑起来」不会变快`;
    }
    if (config.walkSpeed > config.runThreshold) {
        return `walkSpeed (${config.walkSpeed}) 高于 runThreshold (${config.runThreshold})，`
            + `一出生就在跑 —— 「跑起来」不会有变化。把 runThreshold 抬到 ${config.walkSpeed} 以上`;
    }
    return null;
}
