# 具身智能体（Embodied Agent）

给 `cesium-player-controller` 这类「有身体」的 3D 角色，加一层**目标驱动**的自主运动能力。

说一句「去 3 号风机」，人物自己走过去；走到一半说「往左一点」，它平滑偏过去，**不会停下来重算**。

---

## 这个包解决什么问题

`cesium-player-controller` 提供了身体：物理、碰撞、地形、动画混合。
但它的移动是**按键驱动**的——按住 W 就一直走，松手就停。

由此带来两个问题：

1. **单位不对**。「走 10 米」是一次性命令，走完就停，用户得反复下指令
2. **没有自主性**。它不知道「到那儿为止」，也不会在悬崖前刹车

这个包把单位从**命令**改成**目标**：

| | 按键 / 命令模型 | 目标模型（本包） |
|---|---|---|
| 单位 | `move_relative(forward, 10m)` | `Goal{position, tolerance, timeout}` |
| 生命周期 | 执行一次即结束 | active → arrived / failed / cancelled |
| 中途修正 | 重新下一条命令 | `reviseGoal()` 修改同一个目标 |
| 谁在驱动 | 命令解释器 | 运动层每帧解算 |

---

## 三层结构

```
L3 意图   一句话 → 目标操作        src/intent.ts
L2 反射   卡住 / 悬崖 / 超时 / 越界  src/agent.ts
L1 运动   目标 → 每帧运动量        src/steering.ts
L0 身体   cesium-player-controller（不改）
```

**核心不依赖 Cesium、不依赖网络、不依赖模型。** 三者通过 `SceneAdapter` 注入。

---

## 快速开始

### 只跑测试（不需要任何依赖）

```bash
npm test
```

39 项测试，覆盖运动收敛、减速曲线、目标修正、四类反射、意图解析。
纯数学，秒级完成。

### 跑浏览器演示

演示复用巡界仓库的风机场景资源，通过软链引用，不复制大文件：

```bash
# 一次性准备（假设巡界仓库在 ~/Documents/ChatGPT/GuikeSong）
ln -s ~/Documents/ChatGPT/GuikeSong/player-demo/node_modules node_modules
mkdir -p public
ln -s ~/Documents/ChatGPT/GuikeSong/player-demo/example/public public/xunjie-assets

npm run dev
# 打开 http://localhost:5180/demo/wind/index.html
```

试试这些指令：

| 指令 | 行为 |
|---|---|
| 去 3 号风机 | 走向 3 号风机 |
| 往前走 20 米 | 沿当前朝向前进 20 米 |
| 往左一点 | **中途修正**当前目标，不重启 |
| 跑起来 | 提高速度档 |
| 停 | 取消目标并停住 |

或者直接点 **「▶ 自动演示」**，一键跑完整链路（约 25 秒）：

```
往前走 60 米 → 中途往左一点 → 跑起来 → 减速到达 → 去运维点 → 停
```

**演示不用倍速**：`playerController` 拒绝 >12 m/s，超过约 10 m/s 物理会跟不上导致人物打滑。
长距离（如 420 米）只能真实等待。

---

## 核心 API

```ts
import { EmbodiedAgent } from './src/index.ts';

const agent = new EmbodiedAgent(sceneAdapter, {
    origin: { east: 0, north: 0, up: 0 },
    config: { walkSpeed: 5, runSpeed: 9 },
});

agent.setGoal({ position: { east: 300, north: 200, up: 0 }, tolerance: 4, label: '3号风机' });

// 每帧
const out = agent.update(dt);
applyOutput(player, out);   // 位移 + 动画 + 朝向，一次写回
```

**别只写 `setWorldMovement`。** 位移和动画是两条独立通道：
`setWorldMovement` 决定往哪走，`AnimationSystem` 决定播哪个动作，而后者只读按键轴。
只写位移不写按键轴，人物会「滑行」——位移在动，动画恒为 `idle`。
`applyOutput()` 把两件事一起做了。

### SceneAdapter —— 唯一的接缝

```ts
interface SceneAdapter {
    getPose(): Pose;                                          // 我在哪、朝哪、是否悬空
    groundHeightAt(east: number, north: number): number | null; // 这里的地面多高
    resolveReference(text: string): Vec3 | null;              // 「3号风机」在哪
}
```

三个方法。实现这三个，就能接到任意 3D 场景。

Cesium 的现成实现见 `src/cesium-adapter.ts`。

---

## 反射保护

运动层不能只追求「到达」，还要保证**不做出危险的事**：

| 反射 | 触发条件 | 结果 |
|---|---|---|
| `STUCK` | 位移低于阈值持续 2.5 秒 | 判失败，停住 |
| `NO_GROUND_AHEAD` | 前方 2.5 米落差超过 4 米 | 判失败，不前进 |
| `TIMEOUT` | 超过目标时限（默认 90 秒） | 判失败 |
| `OUT_OF_BOUNDS` | 超出活动半径（默认 3000 米） | 判失败 |

失败只返回类型码，不给自然语言——**怎么跟用户说是上层的事**。

---

## 设计取舍

**为什么意图层先用规则，不接 Jev/Laya**

运动层和反射层才是这个包的核心价值，意图层是可替换的。
先用规则把「快层成立」单独证明出来，再接模型时上层不用动。

规则目前覆盖：方向移动、参照物导航、中途修正、原地转向、快慢切换、飞行开关、停止。
听不懂时返回 `null`，**不瞎猜**。

**为什么用目标不用命令**

这是「像遥控车」和「像活的一样」的分界线。
命令模型下，「往左一点」会让它停下来重新算；目标模型下，它是连续调整的。

**为什么转向有角速度上限**

瞬时转向看起来像机器人。`turnRate` 默认 180°/s，转向有重量感。

---

## 当前边界（重要）

本包已验收的是**运动层与反射层**，通过 39 项单元测试 + 浏览器行为验收。

**尚未做**：
- 语音输入（ASR）—— 目前只有文字框
- Jev/Laya 意图模型 —— 目前是规则解析
- 多步任务编排 —— 只有单个目标
- 场景问答 —— 「那是什么」

**已知问题**：
- 第三人称相机在陡坡上会被射线避障压到 0.5 米，可用滚轮拉远
- 没有寻路/避障，只有直线 seek + 悬崖停止。遇到障碍物会卡住，由 `STUCK` 反射兜底
- 出生点在运维点上方 3 米，靠重力落地约需 10 秒。**落地前下指令，人物会在空中「走」**，
  自动演示已加了落地等待

---

## 与巡界（Xunjie）的关系

巡界是**面向具体业务**的：任务状态机、审批、证据链、闭环回执。
本包只保留其中「让人物听懂话并走过去」这一层，去掉了所有业务逻辑。

代码量对比：巡界 `engine/src + player-demo/src` 约 14816 行，本包核心约 900 行。

---

## 文件

```
src/
  types.ts           类型与默认配置
  steering.ts        运动解算（seek / arrive / turn）
  agent.ts           目标生命周期 + 反射
  intent.ts          意图解析（规则）
  cesium-adapter.ts  Cesium 适配器
  index.ts           出口
test/
  agent.test.ts      运动与反射（24 项）
  intent.test.ts     意图解析（15 项）
demo/wind/           风机场景演示
```
