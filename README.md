# 具身智能体（Embodied Agent）

给 `cesium-player-controller` 这类「有身体」的 3D 角色，加一层**目标驱动**的自主运动能力，
外加**语音全双工**控制。

说一句「去 3 号风机」，人物自己走过去；走到一半说「往左一点」，它平滑偏过去，**不会停下来重算**。
说话时它也在回话，你随时可以打断它。

---

## 别人怎么引入这个包

```bash
npm install embodied-agent
```

包分成三个入口，按需引入 —— **不用 Cesium 的人不会被强制打包 4MB Cesium**：

```ts
import { createEmbodiedScene } from 'embodied-agent';          // 核心，零依赖
import { EnuFrame } from 'embodied-agent/cesium';              // Cesium 适配器
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
npm install          # 只有 demo 需要依赖；核心零依赖
npm run check        # 类型检查 + 79 项测试
npm run build:lib    # 构建可发布的包
npm run voice        # 语音服务（不配置 ASR 也能起，只是麦克风不可用）
npm run dev          # 演示页面 http://localhost:5180/demo/wind/index.html
```

启用语音只需两步：

```bash
cp .env.example .env      # 填 DOUBAO_ASR_RESOURCE_ID + DOUBAO_ASR_API_KEY
npm run voice
```

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
applyOutput(player, agent.update(dt));
```

**别只写 `setWorldMovement`。** 位移和动画是两条独立通道：
`setWorldMovement` 决定往哪走，`AnimationSystem` 决定播哪个动作，而后者只读按键轴。
只写位移不写按键轴，人物会「滑行」——位移在动，动画恒为 `idle`。
`applyOutput()` 把两件事一起做了，还负责在无目标时交还键鼠控制。

### 引擎无关

`BodyLike` 只有三个方法，任何 3D 引擎都能实现：

```ts
interface BodyLike {
    setWorldMovement(m: MovementCommand | null): void;
    setScriptedYaw?(yaw: number | null): void;
    setInput?(input: { moveX?: number; moveY?: number; shift?: boolean }): void;
}
```

`setInput` 是给 `cesium-player-controller` 专用的（它的动画只读按键轴）。
其他引擎不需要实现它。

### SceneAdapter —— 唯一的接缝

```ts
interface SceneAdapter {
    getPose(): Pose;                                          // 我在哪、朝哪、是否悬空
    groundHeightAt(east: number, north: number): number | null; // 这里的地面多高
    resolveReference(text: string): Vec3 | null;              // 「3号风机」在哪
}
```

`EnuFrame` 需要 Cesium，但**不在加载时 import** —— 构造时显式传入：

```ts
new EnuFrame(originEcef, { Cartesian3, Matrix4, Transforms });
```

不传就报清晰的错误，而不是 `undefined is not a function`。

三个方法。实现这三个，就能接到任意 3D 场景。
Cesium 的现成实现见 `src/cesium-adapter.ts`。

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

**为什么意图层先用规则，不接模型**

运动层和反射层才是这个包的核心价值，意图层是可替换的。
先用规则把「快层成立」单独证明出来，再接模型时上层不用动。

规则覆盖：方向移动、参照物导航、中途修正、原地转向、快慢切换、飞行开关、停止。
听不懂时返回 `null`，**不瞎猜**。

**为什么自己写 WebSocket 而不是用 ws 包**

1. 目标是「引入即用」，零运行时依赖比多一个包更值钱
2. Node 24 自带的 WebSocket 不支持自定义 header，而豆包必须带鉴权头

`server/ws-lite.ts` 只实现协议层（握手、帧编解码、分片、ping/pong），
不实现重连和心跳定时器——上层自己管。10 项测试覆盖帧边界和真实握手。

**为什么用目标不用命令**

这是「像遥控车」和「像活的一样」的分界线。
命令模型下，「往左一点」会让它停下来重新算；目标模型下，它是连续调整的。

**为什么转向有角速度上限**

瞬时转向看起来像机器人。`turnRate` 默认 180°/s，转向有重量感。

---

## 当前边界（重要）

**已验证**（证据层级见 `ACCEPTANCE.md`）：

| 层 | 内容 | 状态 |
|---|---|---|
| 单元测试 | 79 项：运动收敛、减速曲线、反射、意图、回声过滤、帧编解码、数字归一 | ✅ 通过 |
| 构建 | `vite build` 成功 | ✅ 通过 |
| 浏览器 | 目标驱动、中途修正、变速、到达、停止、动画跟随 | ✅ 通过 |
| 浏览器 | 语音服务 → 转写 → 意图 → 动作（假 ASR 上游） | ✅ 通过 |
| 浏览器 | 回声过滤、播报中喊停穿透 | ✅ 通过 |

**未验证**：

- **真实豆包 ASR 未跑过** —— 目前用假上游验证协议链路，需要真实凭据才能证明
- **真实麦克风** —— 需要人在浏览器里说话，无法自动化
- **长距离完整到达** —— 3 号风机距出发点 420 米，步行需 84 秒
- **复杂地形悬崖反射** —— 演示场景为缓坡，无法触发 `NO_GROUND_AHEAD`

**已知问题**：

- 第三人称相机在陡坡上会被射线避障压到 0.5 米，可用滚轮拉远
- 没有寻路/避障，只有直线 seek + 悬崖停止。遇到障碍物会卡住，由 `STUCK` 兜底
- 出生点在运维点上方 3 米，靠重力落地约需 10 秒。**落地前下指令，人物会在空中「走」**，
  自动演示已加落地等待
- TTS 用浏览器本地 `speechSynthesis`，音色取决于操作系统

**尚未做**：

- Jev/Laya 意图模型 —— 目前是规则解析
- 多步任务编排 —— 只有单个目标
- 场景问答 —— 「那是什么」

---

## 目录

```
src/
  index.ts            主入口（不加载 Cesium）
  cesium.ts           Cesium 子入口
  types.ts            类型与默认配置
  steering.ts         运动解算（seek / arrive / turn）
  agent.ts            目标生命周期 + 反射
  intent.ts           意图解析（规则）
  body.ts             把运动量施加到角色（引擎无关）
  cesium-adapter.ts   Cesium 适配器 + 数字归一
  create-scene.ts     一站式装配
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
test/                 79 项测试
demo/wind/            风机场景演示
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
