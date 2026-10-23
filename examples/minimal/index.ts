// 最小示例 —— 不用 Cesium、不用浏览器，纯 Node 跑通「说话 → 走路」。
//
// 这个文件的目的是证明：本包的核心不绑定任何引擎。
// 你的场景只要有「我在哪、地面多高、某某在哪」三个信息，就能接上。
//
// 运行：node examples/minimal/index.ts

import { createEmbodiedScene, type BodyLike, type SceneAdapter, type Vec3 } from '../../src/index.ts';

// —— 1. 描述你的场景 ——
// 这里用一块平地 + 两个虚构的参照物代替真实 3D 场景。
const PLACES: Record<string, Vec3> = {
    '3号风机': { east: 120, north: 80, up: 0 },
    '运维点': { east: 0, north: 0, up: 0 },
};

const pose = { east: 0, north: 0, up: 0, yaw: 0, flying: false, onGround: true };

const adapter: SceneAdapter = {
    getPose: () => ({ ...pose }),
    groundHeightAt: () => 0,
    resolveReference(text) {
        for (const [name, at] of Object.entries(PLACES)) {
            if (text.includes(name)) return at;
            // ASR 会说「三号」，场景里是「3号」—— 这一层归一由 cesium 适配器提供，
            // 自研场景可以按自己的 ID 规则实现。
        }
        if (text.includes('三号')) return PLACES['3号风机'];
        return null;
    },
};

// —— 2. 描述你的角色 ——
// 这里只是一个计数器。真实场景里这些方法会驱动骨骼动画和物理体。
const body: BodyLike & { lastMove: unknown } = {
    lastMove: null,
    setWorldMovement(input) { this.lastMove = input; },
    setScriptedYaw() { /* 转向 */ },
    setInput() { /* 动画状态 */ },
};

// —— 3. 装配 ——
let lastPrintAt = -1;
const scene = createEmbodiedScene({
    adapter,
    player: body,
    agent: { config: { walkSpeed: 4, runSpeed: 8 } },
    log: line => console.log(`  ${line}`),
    onState: s => {
        // 每秒打一行，别刷屏
        const sec = Math.floor(performance.now() / 1000);
        if (s.distance != null && sec !== lastPrintAt) {
            lastPrintAt = sec;
            console.log(`    状态=${s.goalState} 距离=${s.distance.toFixed(1)}m 速度=${s.speed.toFixed(1)}m/s`);
        }
    },
});

// —— 4. 说话，然后每帧推进 ——
console.log('说：「去三号风机」');
scene.handleCommand('去三号风机');

// 模拟 60 帧/秒，把人物往目标推进。
// 144 米 / 4 m/s ≈ 36 秒，留 60 秒余量。
const DT = 1 / 60;
for (let frame = 0; frame < 60 * 60; frame++) {
    scene.tick(DT);
    const move = body.lastMove as { east: number; north: number; speedMetersPerSecond: number } | null;
    if (move && move.speedMetersPerSecond > 0) {
        // 真实场景里物理引擎会做这件事；这里手动积分
        pose.east += move.east * move.speedMetersPerSecond * DT;
        pose.north += move.north * move.speedMetersPerSecond * DT;
    }
    if (scene.agent.currentState !== 'active') break;
}

console.log(`\n最终状态：${scene.agent.currentState}`);
console.log(`最终位置：east=${pose.east.toFixed(1)} north=${pose.north.toFixed(1)}`);
console.log(`目标位置：east=${PLACES['3号风机'].east} north=${PLACES['3号风机'].north}`);

scene.dispose();
