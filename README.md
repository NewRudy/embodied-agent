# 具身智能体（Embodied Agent）

[![CI](https://github.com/NewRudy/embodied-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/NewRudy/embodied-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

给 `cesium-player-controller` 这类「有身体」的 3D 角色，加一层**目标驱动**的自主运动能力，
外加**语音全双工**控制。

说一句「去 3 号风机」，人物自己走过去；走到一半说「往左一点」，它平滑偏过去，**不会停下来重算**。
说话时它也在回话，你随时可以打断它。

> **状态**：`0.1.0`，未发布到 npm。当前通过 git 安装。
> 已验证的范围与证据层级见 [`ACCEPTANCE.md`](ACCEPTANCE.md) —— 请按那份文档判断可用性，
> 不要按这个 README 的宣传语判断。

---

## 别人怎么引入这个包

```bash
# 尚未发布到 npm，先这样装：
npm install github:NewRudy/embodied-agent
```

包分成三个入口，按需引入 —— **不用 Cesium 的人不会被强制打包 4MB Cesium**：

```ts
import { createEmbodiedScene } from 'embodied-agent';          // 核心，零依赖
import { setupCesiumScene } from 'embodied-agent/cesium';      // Cesium 场景装配
import { attachVoiceStream } from 'embodied-agent/server';     // 语音服务
```

最小可运行示例（纯 Node，无浏览器、无 Cesium）：

```bash
node examples/minimal/index.ts
```

它做完了整件事：说「去三号风机」→ 解析意图 → 算路径 → 每帧出运动量 →
144 米后自动减速停在目标 4 米内。

### 在本仓库里开发

```bash
npm install          # 装开发依赖（typescript / tsup / vite / cesium）
npm run check        # 类型检查 + 226 项测试
npm run build:lib    # 构建可发布的包
npm run voice        # 语音服务（不配置 ASR 也能起，只是麦克风不可用）
npm run dev          # 演示页面 http://localhost:5180/demo/sandbox/index.html
```

**需要 Node ≥ 22.18。** 测试直接跑 `.ts` 文件，依赖 Node 的类型剥离，
而这个特性从 22.18 才有 —— 22.9 会报 `ERR_UNKNOWN_FILE_EXTENSION`。

`demo/sandbox/` 不依赖任何外部资产，clone 下来就能跑。
`demo/wind/` 需要自备 3D Tiles 地形与人物模型（资产不进仓库），
只能跑前者不影响验证本包的核心能力。

启用语音只需两步（`.env` 由 `npm run voice` 自动加载，Node 24 内置）：

```bash
cp .env.example .env      # 填 DOUBAO_ASR_RESOURCE_ID + DOUBAO_ASR_API_KEY
npm run voice
```

**语音流默认要求访问密钥**（`VOICE_ACCESS_KEY`）。没配 key 时语音服务会拒绝所有连接，
浏览器侧表现为「连上了又立刻断开」。配置后打开页面时带上同一个 key：

```
http://localhost:5180/demo/wind/index.html?key=你的key
```

生成一个：`node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`

为什么默认必填：每条语音连接都对应一条按分钟计费的 ASR 上游会话。之前「空 key = 不鉴权」
等于知道地址就能烧钱。只想本地随便试试的话，可以在 `.env` 里设 `VOICE_ALLOW_ANONYMOUS=1`
显式接受这个风险 —— **不要用于公网**。

**不配置 ASR 也能用**：文字指令、按钮、自动演示全部正常，只是麦克风按钮置灰。
这是刻意设计——凭据缺失不应该让整个场景不可用。

---

## 这个包解决什么问题

`cesium-player-controller` 提供了身体：物理、碰撞、地形、动画混合。
但它的移动是**按键驱动**的——按住 W 就一直走，松手就停。

由此带来三个问题：

1. **单位不对**。「走 10 米」是一次性命令，走完就停，用户得反复下指令
2. **没有自主性**。它不知道「到那儿为止」，也不会在悬崖前刹车
3. **只能手控**。说不了话，也没有任何「智能体」的感觉

本包把单位从**命令**改成**目标**，并补上语音：

| | 按键 / 命令模型 | 目标模型（本包） |
|---|---|---|
| 单位 | `move_relative(forward, 10m)` | `Goal{position, tolerance, timeout}` |
| 生命周期 | 执行一次即结束 | active → arrived / failed / cancelled |
| 中途修正 | 重新下一条命令 | `reviseGoal()` 修改同一个目标 |
| 输入 | 键盘 | 文字 / 语音（全双工） |
| 谁在驱动 | 命令解释器 | 运动层每帧解算 |

---

## 四层结构

```
L4 语音   麦克风 → ASR → 文本；播报 → 回声过滤     src/voice/
L3 意图   一句话 → 目标操作                        src/intent.ts
L2 反射   卡住 / 悬崖 / 超时 / 越界                src/agent.ts
L1 运动   目标 → 每帧运动量                        src/steering.ts
L0 身体   cesium-player-controller（不改）
```

**核心不依赖 Cesium、不依赖网络、不依赖模型。** 三者通过 `SceneAdapter` 注入。
语音层在服务端运行，凭据不出后端。

---

## 两种用法

### 用法一：一站式（推荐）

```ts
import { createEmbodiedScene } from 'embodied-agent';

const scene = createEmbodiedScene({
    adapter,          // 你的 SceneAdapter
    player,           // playerController 实例
    agent: { origin: { east: 0, north: 0, up: 0 }, config: { walkSpeed: 5 } },
    voice: {
        url: 'ws://localhost:5181/voice/stream',
        wakeWord: '小巡',   // 可选，不配则任何定稿句都执行
    },
});

scene.handleCommand('去3号风机');   // 文字
// 语音会自动走同一条路径

// 每帧
scene.tick(dt);
```

### 用法二：只用运动层
```ts
import { EmbodiedAgent, applyOutput } from 'embodied-agent';

const agent = new EmbodiedAgent(adapter, { config: { walkSpeed: 5 } });
agent.setGoal({ position: { east: 300, north: 200, up: 0 }, tolerance: 4 });

// 每帧
applyOutput(player, agent.update(dt), { locomotion: LOCOMOTION });
```

**别只写 `setWorldMovement`。** 位移和动画是两条独立通道：
`setWorldMovement` 决定往哪走，`AnimationSystem` 决定播哪个动作，而后者只读按键轴。
只写位移不写按键轴，人物会「滑行」——位移在动，动画恒为 `idle`。
`applyOutput()` 把两件事一起做了，还负责在无目标时交还键鼠控制。

**想要脚不打滑，再传 `locomotion`：**

```ts
const LOCOMOTION = {
    idle: 'Idle_Loop',
    clips: [
        { name: 'Walk_Loop',     naturalSpeed: 1.065 },
        { name: 'Jog_Fwd_Loop',  naturalSpeed: 2.882 },
        { name: 'Sprint_Loop',   naturalSpeed: 3.621 },
    ],
};
```

`naturalSpeed` 是**量出来的**，不是估的：

```bash
node tools/measure-stride.ts public/xunjie-assets/glb/UAL1_Standard.glb --height-meters=1.8
```

不给 `locomotion` 时退回按键轴驱动 —— 能用，但脚会滑。换模型必须重量，
否则倍速算错，脚照样滑，而且很难靠肉眼判断对错。

### 引擎无关

`BodyLike` 只有三个核心方法，任何 3D 引擎都能实现：

```ts
interface BodyLike {
    setWorldMovement(m: MovementCommand | null): void;
    setScriptedYaw?(yaw: number | null): void;
    setInput?(input: { moveX?: number; moveY?: number; shift?: boolean }): void;
    // 想要动画速度匹配才需要下面两个
    playPlayerAnimationByClipName?(clipName: string | null): void;
    setPlayerAnimationTimeScale?(scale: number): void;
}
```

`setInput` 是给 `cesium-player-controller` 专用的（它的动画只读按键轴）。
其他引擎不需要实现它。

`playPlayerAnimationByClipName` 传 `null` 表示**解锁**，把动画选择权交还引擎。
外部接管时必须能锁 —— 否则引擎每帧按按键重选一次，下发的 clip 立刻被覆盖。

### SceneAdapter —— 唯一的接缝

```ts
interface SceneAdapter {
    getPose(): Pose;                                          // 我在哪、朝哪、是否悬空
    groundHeightAt(east: number, north: number): number | null; // 这里的地面多高
    resolveReference(text: string): Vec3 | null;              // 「3号风机」在哪

    // 可选：只给模型意图层用
    listReferences?(): Array<{ name: string; at: Vec3; description?: string }>;
}
```

`listReferences` 不实现也能跑 —— 只是模型层做不了「去那个绿点」，
只能做「方位 + 距离」。`description` 是给模型看的（「白色风力发电机」），
没有描述时模型会（正确地）拒绝猜测。

`EnuFrame` 需要 Cesium，但**不在加载时 import** —— 构造时显式传入：

```ts
new EnuFrame(originEcef, { Cartesian3, Matrix4, Transforms });
```

不传就报清晰的错误，而不是 `undefined is not a function`。

三个方法。实现这三个，就能接到任意 3D 场景。
Cesium 的现成实现见 `src/cesium-adapter.ts`。

### 接一个新 Cesium 场景：只写配置，不写逻辑

`setupCesiumScene()` 把场景专属的东西收成一个对象。它负责三件容易写错的事：

1. **建 ENU 坐标系**（原点 + 换算）
2. **建人物**并完成 `init`
3. **实测出生点地面高度** —— 别信配置里的 `up`

```ts
import { setupCesiumScene } from 'embodied-agent/cesium';
import { createEmbodiedScene } from 'embodied-agent';

const setup = await setupCesiumScene({
    viewer,
    origin: { lon: 106.6, lat: 26.4, heightM: 1200 },
    cesium: { Cartesian3, Matrix4, Transforms, fromDegrees: Cartesian3.fromDegrees },
    // 只有 east/north 可信。up 会被物理实测覆盖。
    spawn: { east: 200, north: 240, up: 148 },
    references: [
        { name: '3号风机', at: { east: 420, north: 180, up: 150 },
          aliases: ['风机3', '3号机组'], description: '白色风力发电机' },
    ],
    getPhysics: (p) => p.physics,
    log: console.log,
    async createPlayer({ viewer, spawn }) {
        const player = new playerController();
        await player.init({ viewer, initPos: spawn, /* 模型、碰撞体… */ });
        return player;
    },
});

const scene = createEmbodiedScene({
    adapter: setup.adapter,
    player: setup.player,
    locomotion: LOCOMOTION,
});
```

**`up` 为什么不可信。** 场景资产里的 `up` 经常是设计标高、椭球高、或者手填的。
实测的 `farm.json` 写 `up: 148`，实际地面在 `up: -33.9` —— 差 182 米。
照配置出生，人物从 151 米高处自由落体 4 秒才落地。
这个错误不报错、不崩溃，只是第一眼很难看 —— 而「任意场景即插即用」的
第一眼恰恰最重要。

`setupCesiumScene` 会把角色瞬移到目标位置、读「脚下到地面的距离」，
反推出真实地面高度，然后把角色放上去：

```
📍 地面实测 up=-33.9（配置写 148.0，差 -182 米，已纠正）
```

这行日志是**诊断**：差值大说明场景资产写错了，值得回头改。
探不到地面时退回配置值并打警告，不会崩。

**引擎需要提供什么：** `reset(ecef)` + `getGroundClearanceMeters()`。
`playerController` 两个都有。都没有时退回射线探测 —— 但射线在 3D Tiles
山体上实测全部落空，所以基本等于「退回配置值」。

**三个坑**（都实测过，换引擎时会重新踩）：

- Rapier 的 `queryPipeline` 只在 `world.step()` 里重建。`init` 之后没步进过，
  此刻射线对**任何位置**都返回 `Infinity`。必须先补一步再探测。
- `getGroundClearanceMeters()` 内部是 `groundDistance(200)`，只往脚下打 200 米。
  从高处直接测必然失败，要逐级下探。
- 瞬移测距算出来的**已经是站立高度**，不能再额外抬高。抬 1 米就超过
  离地判定阈值（约 1.5 米），人物反而会掉一下。

完整可运行的最小例子见 `demo/sandbox/`（无 Cesium、无资产）和
`demo/wind/`（真实 3D Tiles 场景）。

---

## 意图层：规则 + 模型

一句话进来，先问规则层（零延迟、零成本），它没把握再问模型。

```ts
const scene = createEmbodiedScene({
    adapter,
    intent: {
        llm: { baseUrl: '...', apiKey: '...', model: 'glm-4.5-flash' },
    },
});
```

不传 `intent.llm` 就是纯规则层，一切照常工作。**模型是补充，不是替代。**

### 决策链

```
规则层（同步，<1ms）  ── 命中且置信度 ≥0.6 ──→ 执行
       │
       └─ 没命中 / 置信度低
              ↓
模型层（异步，约 1.7s）── 通过严格校验 ──→ 执行
              │
              └─ 失败 → 返回 null → 「没听懂」
```

每层都会在日志里留一行 trace，出问题能看出是谁做的决定：

```
· rule:miss(置信度 0.30 过低) llm:deepseek-v4.1-flash:hit
```

### 规则层能听懂什么

| 类别 | 例子 |
|---|---|
| 停止 | 停 / 停下 / 别走了 / 别往东走 |
| 相对方向 | 往前走 20 米 / 往左一点 / 往后退 |
| **绝对方位** | 往东走三十米 / 向西南走 15 米 / 朝北 |
| 参照物 | 去 A 点 / 去 3 号风机 |
| 中途修正 | 往左一点 / 再近一点 / 退一点（相对**当前目标**，不是人物位置） |
| 转向 | 左转 45 度 / 右转 |
| 快慢 / 飞行 | 跑起来 / 慢点 / 起飞 / 降落 |

### 模型层能补什么

规则层按字面匹配，「过去瞅瞅那个绿点」这种话它听不懂。
模型层能看到场景登记表（含描述），把口语映射到具体参照物。

**但它只能做有界选择** —— 见上文「模型层怎么做有界决策」。

---

## 多步任务

「先去 A 点，再去 B 点，最后去 C 点」会被切成三步顺序执行。

```ts
await scene.handleCommandAsync('先去A点，再去B点，最后去C点');
// 📋 拆成 3 步：去A点 → 去B点 → 去C点
// ▶ 第 1/3 步：去A点
// ▶ 第 2/3 步：去B点      ← A 到达的那一帧就切过去，不停顿
// ▶ 第 3/3 步：去C点
// ✅ 任务完成（3 步）
```

规则：

- 只认明确的连接词：`先…再…` `然后` `接着` `之后` `最后`
- **只支持移动类步骤**（去某处）。「先跑起来再转向」这种时序动作请分两句说
- 有一步听不懂或没把握 → 整条任务不执行，不会跑到一半卡住
- 某步失败默认跳过继续下一步；`abortOnFailure: true` 则中止
- 随时可以「停」，队列一并中止

单步指令不进队列，走原来的直接路径 —— 队列只处理真正有序的任务。

---

## 语音全双工

这是移植自巡界（Xunjie）的成熟链路，做了去业务化改造。

```
浏览器                          服务端                      豆包
麦克风 → AudioWorklet(16k)
       → WebSocket ──────────→ /voice/stream
                                 → Seed 协议 ────────────→ ASR
       ←──── JSON 事件 ─────────┘ ←──── 二进制帧 ─────────┘
       → 意图解析 → 目标
```

### 为什么凭据必须在服务端

豆包 ASR 需要 `X-Api-Key` 等鉴权头，浏览器直连等于把密钥发给所有人。
所以浏览器只发**原始 PCM**，服务端持有密钥并转发。

### 回声过滤（全双工最难的部分）

人物正在说话时麦克风不关，ASR 会把播报内容又识别成一句话。
不处理的话，人物会**自己命令自己**。

`VoicePlaybackGuard` 的做法：
- 播报期间记录参考文本与时间窗
- 转写与参考文本相似且时间重叠 → 判为回声丢弃
- **但「停」类短语永远穿透** —— 用户喊停的优先级高于一切

**边界**：无法区分「同一句话的真人和回声」。这是物理限制，不是实现缺陷。

### 中文数字归一（踩过的坑）

ASR 几乎总把「3 号」识别成「三号」，而场景里的 ID 是阿拉伯数字。
不做归一的话，**文字指令能用、语音指令一直「没听懂」**，且极难排查。

`normalizeNumerals()` 在适配层做这层转换，只在数字后面跟 ID 或单位时生效
（`三号 → 3号`、`二十米 → 20米`），量词不转换（`往左一点` 保持不变）。

---

## 反射保护

运动层不能只追求「到达」，还要保证**不做出危险的事**：

| 反射 | 触发条件 | 结果 |
|---|---|---|
| `STUCK` | 位移低于阈值持续 2.5 秒 | 判失败，停住 |
| `NO_GROUND_AHEAD` | 前方 2.5 米落差超过 4 米 | 判失败，不前进 |
| `TIMEOUT` | 超过目标时限（默认 600 秒） | 判失败 |
| `OUT_OF_BOUNDS` | 超出活动半径（默认 3000 米） | 判失败 |

失败只返回类型码，不给自然语言——**怎么跟用户说是上层的事**。

---

## 设计取舍

**为什么意图层先用规则，再接模型**

运动层和反射层才是这个包的核心价值，意图层是可替换的。
先用规则把「快层成立」单独证明出来，再接模型时上层不用动。

规则覆盖：方向移动、绝对方位、参照物导航、中途修正、原地转向、快慢切换、飞行开关、停止。
听不懂时返回 `null`，**不瞎猜**。

**规则层为什么要带置信度**

规则层不是「更聪明的正则」。一个「走」字就能命中，
但「大概往那边走吧」里的「走」根本不是方向指令——照字面执行会让人物朝当前朝向闷头走 10 米。

所以规则命中时也带置信度：
- 明确模式（「去A点」「往东走三十米」「停」）→ `1.0`
- 含糊指代（「大概往那边走吧」「随便走走」）→ `0.35`
- 方位当定语（「去南边的楼」——目标在「楼」，不是往南挪一步）→ `0.3`

低于 `0.6` 不执行，继续问下一个决策器。这是「宁可说没听懂，也不要瞎走」的工程化。

**模型层怎么做「有界决策」**

接模型不是把整句话丢给 LLM 让它自由发挥。借鉴 Laya / System-One 的思路：

1. 动作集合固定（`go/stop/revise/turn/run/fly`），模型不能发明新动作
2. 目标只能从**场景登记的参照物**里选，或按方向+距离算，不能凭空给坐标
3. 输出必须是严格 JSON，字段集合完全匹配，多一个字段就判废
4. 任何失败（超时/JSON 错/校验不过/幻觉参照物）→ 返回 `null`，降级到规则层

最坏结果是「没听懂」，不是「跑去不存在的地方」。

**踩到的坑：推理模型不能做快层**

实测 `glm-5.3-flash` 在 `max_tokens=200` 时，200 个 token 全花在 `reasoning_content` 上，
`content` 是空串，`finish_reason=length`，延迟 18~29 秒。
这种模型做不了 4 秒超时的意图层。

换成 `deepseek-v4.1-flash`（无推理、约 1.7 秒）才成立。
代码里对「正文为空 + finish_reason=length」做了专门判定，报 `LLM_TRUNCATED_REASONING`
而不是笼统的 `LLM_JSON`——否则排查时看不出真正原因。

**为什么自己写 WebSocket 而不是用 ws 包**

1. 目标是「引入即用」，零运行时依赖比多一个包更值钱
2. Node 24 自带的 WebSocket 不支持自定义 header，而豆包必须带鉴权头

`server/ws-lite.ts` 只实现协议层（握手、帧编解码、分片、ping/pong），
不实现重连和心跳定时器——上层自己管。13 项测试覆盖帧边界、真实握手、帧/消息长度上限。

**为什么用目标不用命令**

这是「像遥控车」和「像活的一样」的分界线。
命令模型下，「往左一点」会让它停下来重新算；目标模型下，它是连续调整的。

**为什么转向有角速度上限**

瞬时转向看起来像机器人。`turnRate` 默认 180°/s，转向有重量感。

**为什么「先转再走」**

有了角速度上限，转 90° 要 0.5 秒、掉头要 1 秒。如果这期间还全速前进，
人物就是**横着滑过去** —— 侧滑比慢更假。

所以偏离目标方向超过 `turnFirstAngle`（默认 90°）时速度压到 0，先原地转身；
在 `alignAngle`（40°）到 90° 之间按比例降速过渡；小于 40° 边走边修，不打断。

横着走是最难看的动作，90° 正好是它的边界。

**为什么动画要按速度匹配（脚不打滑）**

位移和动画是**两条独立通道**：位移由 `setWorldMovement` 驱动，
动画由 `AnimationSystem` 按键盘状态在 `walking` / `running` 里二选一。
不管位移多快，动画都按 clip 自己的固定节奏播 —— 人物以 5 m/s 位移、
脚却按 1.07 m/s 倒腾，就是滑冰。

修法只有一条：`timeScale = 实际速度 / clip 的自然速度`。

难点在「自然速度」怎么来。估出来的数差 20%，脚就明显滑；而且这个很难靠肉眼判断。
所以写了 `tools/measure-stride.ts`，从 GLB 骨骼读脚的前后摆幅 ÷ 循环时长：

```
Walk_Loop        1.333s  步幅 0.722  自然速度 1.065 m/s
Jog_Fwd_Loop     0.917s  步幅 1.342  自然速度 2.882 m/s
Sprint_Loop      0.667s  步幅 1.226  自然速度 3.621 m/s
```

选片规则是「挑自然速度不超过当前速度的最大 clip」，不是「挑最接近的」。
5 m/s 时 Walk 要 4.7 倍速（一眼假），Jog 只要 1.7 倍 —— 宁可略快，不要快进。

倍速夹在 [0.5, 2.0]：再慢像太空步，再快像快放。超出范围时宁可留一点滑。

**换模型必须重新量。** 这就是 `measure-stride` 存在的理由。

**响应速度**

| 环节 | 实测 | 说明 |
|---|---|---|
| ASR 说完 → 定稿 | ~415 ms | 真实豆包 Seed ASR |
| 规则层解析 | ~0.02 ms | 纯同步，不碰网络 |
| 定稿 → 下一帧执行 | ≤ 16.7 ms | 一帧 |
| **合计** | **~430 ms** | 明确指令的端到端 |
| 模型兜底 | 800 ms 超时 | 超时即降级为「没听懂」 |

模型层超时从 4 秒降到 800 毫秒，是因为实测非推理模型往返 3.1–4.6 秒 ——
4 秒超时等于「几乎每次都等到超时」。到模型层的都是规则层听不懂的模糊说法，
这类话宁可快速失败，也不该把链路拖到 4 秒。

---

## 当前边界（重要）

**已验证**（证据层级见 `ACCEPTANCE.md`）：

| 层 | 内容 | 状态 |
|---|---|---|
| 单元测试 | 226 项：运动收敛、减速曲线、反射、意图、置信度、模型校验、多步队列、回声过滤、帧编解码、数字归一、动画速度匹配、出生点解算 | ✅ 通过 |
| 构建 | `vite build` 成功 | ✅ 通过 |
| 浏览器 | 目标驱动、中途修正、变速、到达、停止、动画跟随 | ✅ 通过 |
| 浏览器 | 动画速度匹配：实测 4.775 m/s ↔ 动画隐含 5.000 m/s，clip 随速度切 Walk→Jog→Sprint | ✅ 通过 |
| 浏览器 | 语音服务 → 转写 → 意图 → 动作（假 ASR 上游） | ✅ 通过 |
| 浏览器 | 回声过滤、播报中喊停穿透 | ✅ 通过 |
| 浏览器 | 模型意图层兜底（规则低置信 → 模型命中 → 人物走过去） | ✅ 通过 |
| 浏览器 | 多步任务（A→B→C 三步连续，约 600 米） | ✅ 通过 |
| 浏览器 | 出生点自动贴地（配置 up 差 182 米，实测纠正，加载即落地） | ✅ 通过 |
| 集成 | 全新项目 `npm install`，无 Cesium 下多步任务/模型降级均可用 | ✅ 通过 |

**未验证**：

- **真人对着麦克风说话** —— 真实 ASR、真实浏览器全链路已通过（见 ACCEPTANCE L9），差声学输入这一步
- **长距离完整到达** —— 3 号风机距出发点 420 米，步行需 84 秒
- **复杂地形悬崖反射** —— 演示场景为缓坡，无法触发 `NO_GROUND_AHEAD`

**已知问题**：

- 第三人称相机在陡坡上会被射线避障压到 0.5 米，可用滚轮拉远
- 没有寻路/避障，只有直线 seek + 悬崖停止。遇到障碍物会卡住，由 `STUCK` 兜底
- 动画速度匹配只验证了 `UAL1_Standard.glb`。换模型必须先跑 `measure-stride` 重量，
  否则倍速算错、脚照滑，而且肉眼很难判断
- 倍速上限 2.0，超过约 7.2 m/s 时脚会轻微打滑（物理上限 12 m/s 之前就会到）
- 转向时速度归零，视觉上是「站住、转身、走」而不是「边走边转」，代价是转向多花 0.3~0.5 s
- TTS 用浏览器本地 `speechSynthesis`，音色取决于操作系统

**尚未做**：

- 场景问答 —— 「那是什么」
- 多步任务里的条件分支 —— 目前只有顺序执行，没有「如果 X 就 Y」
- 真实豆包 ASR（见上「未验证」）

---

## 目录

```
src/
  index.ts            主入口（不加载 Cesium）
  cesium.ts           Cesium 子入口
  types.ts            类型与默认配置
  steering.ts         运动解算（seek / arrive / turn）
  agent.ts            目标生命周期 + 反射
  intent.ts           意图解析（规则层 + 决策链）
  intent-types.ts     意图契约（可插拔决策器）
  llm-decider.ts      模型决策层（有界选择 + 严格校验）
  task-queue.ts       多步任务编排
  locomotion.ts       动画速度匹配（选 clip + 算倍速，脚不打滑）
  body.ts             把运动量施加到角色（引擎无关）
  cesium-adapter.ts   Cesium 适配器 + 数字归一
  cesium-scene.ts     Cesium 场景装配（ENU、人物、出生点实测、参照物）
  spawn.ts            出生点解算（别信配置高度，用物理实测）
  create-scene.ts     一站式装配（引擎无关）
  voice/
    protocol.ts       语音协议类型
    realtime-voice.ts 浏览器侧语音客户端
    playback-guard.ts 回声过滤 + 唤醒词
    speech-output.ts  TTS 播报
server/
  lib.ts              可复用出口（import 这个）
  index.ts            可执行入口（npm run voice）
  voice-stream.ts     WebSocket 代理
  asr.ts              豆包 Seed ASR 协议
  ws-lite.ts          最小 WebSocket 实现
public/voice/
  pcm-capture.js      AudioWorklet（16k 重采样分帧）
examples/minimal/     最小可运行示例（纯 Node）
tools/
  measure-stride.ts   从 GLB 量 clip 的自然速度（换模型必须跑）
test/                 226 项测试
test/live/            打真实模型的冒烟测试（不进 npm test）
.github/workflows/    CI：Node 22.18 + 24 上跑 typecheck + 全部测试
demo/wind/            风机场景演示
demo/sandbox/         空白场景（无 Cesium、无资产）
```

---

## 与巡界（Xunjie）的关系

巡界是**面向具体业务**的：任务状态机、审批、证据链、闭环回执。
本包只保留其中「让人物听懂话并走过去」这一层，去掉了所有业务逻辑。

语音链路（`pcm-capture.js`、`voice-stream.ts`、`asr.ts`、`realtimeVoice.ts`、
`voicePlaybackGuard.ts`、`speechOutput.ts`）**直接移植**自巡界，做了三处改造：

1. 唤醒词从硬编码「巡界」改为可配置
2. `ws` 依赖换成自研 `ws-lite.ts`，实现零运行时依赖
3. 播报文本、失败文案改为通用表述，不再绑定电力业务

代码量对比：巡界 `engine/src + player-demo/src` 约 14816 行，本包核心约 2600 行。
