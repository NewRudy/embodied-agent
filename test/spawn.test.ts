// 出生点解算的测试。
//
// 这里钉的是「别信配置高度」这条规则：场景资产里的 up 经常是错的，
// 照它出生就是从天上掉下来。用物理射线实测，探不到才退回配置。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSpawn, type GroundProbe } from '../src/spawn.ts';

// 假的 Cesium：把 ECEF 当成 ENU 三元组直接存，转换就是恒等 + 平移。
// 够用来验证「射线打出去、命中点转回来」这条逻辑，不需要真 Cesium。
const C = {
    Cartesian3: {
        subtract(a: number[], b: number[], out: number[]) {
            out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2];
            return out;
        },
        add(a: number[], b: number[], out: number[]) {
            out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2];
            return out;
        },
        multiplyByScalar(a: number[], s: number, out: number[]) {
            out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s;
            return out;
        },
        normalize(a: number[], out: number[]) {
            const len = Math.hypot(a[0], a[1], a[2]) || 1;
            out[0] = a[0] / len; out[1] = a[1] / len; out[2] = a[2] / len;
            return out;
        },
    },
};

const toEcef = (o: { east: number; north: number; up: number }) => [o.east, o.north, o.up];
const toEnu = (c: number[]) => ({ east: c[0]!, north: c[1]!, up: c[2]! });

function probeAt(groundUp: number): GroundProbe {
    return {
        raycastEcefHit(origin) {
            // 假设射线垂直向下，命中点就是 (east, north, groundUp)
            const distance = origin[2]! - groundUp;
            if (distance < 0) return undefined;
            return { distance, point: [origin[0]!, origin[1]!, groundUp] };
        },
    };
}

test('配置高度错了也能找到真实地面', () => {
    // 配置写 148，实际地面 -33.9 —— 就是 farm.json 的真实情况
    const r = resolveSpawn({
        toEcef, toEnu, cesium: C as any,
        physics: probeAt(-33.9),
        configured: { east: 200, north: 240, up: 148 },
    });
    assert.equal(r.measured, true);
    assert.ok(Math.abs(r.groundUp! - (-33.9)) < 1e-6);
    // 抬 1 米，避免嵌进地面
    assert.ok(Math.abs(r.at.up - (-32.9)) < 1e-6);
    // 水平位置不动 —— 只有高度不可信
    assert.equal(r.at.east, 200);
    assert.equal(r.at.north, 240);
    // 差值要报出来，方便发现资产配置写错了
    assert.ok(Math.abs(r.correction! - (-181.9)) < 1e-6);
});

test('配置高度正确时也不改水平位置', () => {
    const r = resolveSpawn({
        toEcef, toEnu, cesium: C as any,
        physics: probeAt(10),
        configured: { east: 5, north: 7, up: 10 },
    });
    assert.equal(r.measured, true);
    assert.equal(r.at.east, 5);
    assert.equal(r.at.north, 7);
    assert.ok(Math.abs(r.at.up - 11) < 1e-6);
});

test('探不到地面时退回配置值，不崩', () => {
    const r = resolveSpawn({
        toEcef, toEnu, cesium: C as any,
        physics: { raycastEcefHit: () => undefined },
        configured: { east: 1, north: 2, up: 3 },
    });
    assert.equal(r.measured, false);
    assert.deepEqual(r.at, { east: 1, north: 2, up: 3 });
    assert.equal(r.groundUp, null);
});

test('没有物理系统时退回配置值', () => {
    const r = resolveSpawn({
        toEcef, toEnu, cesium: C as any,
        configured: { east: 1, north: 2, up: 3 },
    });
    assert.equal(r.measured, false);
    assert.deepEqual(r.at, { east: 1, north: 2, up: 3 });
});

test('射线抛异常时退回配置值，不中断场景加载', () => {
    // 物理世界还没建好时 castRay 会抛
    const r = resolveSpawn({
        toEcef, toEnu, cesium: C as any,
        physics: { raycastEcefHit: () => { throw new Error('world not ready'); } },
        configured: { east: 1, north: 2, up: 3 },
    });
    assert.equal(r.measured, false);
    assert.deepEqual(r.at, { east: 1, north: 2, up: 3 });
});

test('只有距离版射线也能用', () => {
    const r = resolveSpawn({
        toEcef, toEnu, cesium: C as any,
        physics: { raycastEcef: (origin) => origin[2]! - (-5) },
        configured: { east: 0, north: 0, up: 20 },
    });
    assert.equal(r.measured, true);
    assert.ok(Math.abs(r.groundUp! - (-5)) < 1e-6);
});

test('从配置高度往上探，配置偏低也能找到地面', () => {
    // 配置写 -100，实际地面 -33.9（配置偏低 66 米）。
    // 射线起点是 -100 + 500 = 400，能打到 -33.9。
    const r = resolveSpawn({
        toEcef, toEnu, cesium: C as any,
        physics: probeAt(-33.9),
        configured: { east: 0, north: 0, up: -100 },
    });
    assert.equal(r.measured, true);
    assert.ok(Math.abs(r.groundUp! - (-33.9)) < 1e-6);
});

test('lift 可调：贴地出生时设 0', () => {
    const r = resolveSpawn({
        toEcef, toEnu, cesium: C as any,
        physics: probeAt(0),
        configured: { east: 0, north: 0, up: 0 },
        lift: 0,
    });
    assert.ok(Math.abs(r.at.up - 0) < 1e-6);
});

// ==================== 瞬移测距（优先方式） ====================
//
// 为什么优先用这个：它和物理积分用的是同一套地面检测，
// 所以一定和人物实际落脚点一致。射线依赖碰撞网格朝向，在 3D Tiles 山体上会落空。

test('瞬移测距：配置高度错了也能找到真实地面', () => {
    const r = resolveSpawn({
        toEcef, toEnu, cesium: C as any,
        // 角色放在 startUp = 148+500 = 648，脚下距离 = 648 - (-33.9)
        probeClearance: (at) => at.up - (-33.9),
        configured: { east: 200, north: 240, up: 148 },
    });
    assert.equal(r.measured, true);
    assert.equal(r.method, 'clearance');
    assert.ok(Math.abs(r.groundUp! - (-33.9)) < 1e-6);
    // 瞬移测距算出来的已经是站立高度，默认不再额外抬高 ——
    // 抬 1 米会超过 maxH 离地阈值，人物反而掉一下（实测）。
    assert.ok(Math.abs(r.at.up - (-33.9)) < 1e-6, '不额外抬高');
});

test('瞬移测距优先于射线', () => {
    // 射线会返回 -99，但瞬移测距给 -33.9。应该用后者。
    const r = resolveSpawn({
        toEcef, toEnu, cesium: C as any,
        physics: probeAt(-99),
        probeClearance: (at) => at.up - (-33.9),
        configured: { east: 0, north: 0, up: 0 },
    });
    assert.equal(r.method, 'clearance');
    assert.ok(Math.abs(r.groundUp! - (-33.9)) < 1e-6);
});

test('瞬移测距返回 null 时退回射线', () => {
    const r = resolveSpawn({
        toEcef, toEnu, cesium: C as any,
        physics: probeAt(-50),
        probeClearance: () => null,
        configured: { east: 0, north: 0, up: 0 },
    });
    assert.equal(r.measured, true);
    assert.equal(r.method, 'raycast');
    assert.ok(Math.abs(r.groundUp! - (-50)) < 1e-6);
});

test('瞬移测距抛异常时退回射线，不中断', () => {
    const r = resolveSpawn({
        toEcef, toEnu, cesium: C as any,
        physics: probeAt(-50),
        probeClearance: () => { throw new Error('physics not ready'); },
        configured: { east: 0, north: 0, up: 0 },
    });
    assert.equal(r.method, 'raycast');
});

test('瞬移测距返回 Infinity 时视为探不到', () => {
    // getGroundClearanceMeters 在没命中时返回 Infinity
    const r = resolveSpawn({
        toEcef, toEnu, cesium: C as any,
        probeClearance: () => Infinity,
        configured: { east: 1, north: 2, up: 3 },
    });
    assert.equal(r.measured, false);
    assert.deepEqual(r.at, { east: 1, north: 2, up: 3 });
});

// ==================== 逐级下探 ====================
//
// 底层 getGroundClearanceMeters 是 groundDistance(200) —— 只往脚下打 200 米。
// 从 648 米高处直接测，脚下 682 米，必然 Infinity。所以必须逐级扫。

/** 模拟真实引擎：只有脚下 200 米内有地面才返回距离，否则 Infinity。 */
function probeWithRange(groundUp: number, range = 200) {
    const calls: number[] = [];
    return {
        calls,
        fn(at: { up: number }) {
            calls.push(at.up);
            const c = at.up - groundUp;
            return c >= 0 && c <= range ? c : Infinity;
        },
    };
}

test('从高处逐级下探能找到地面（复现真实引擎的 200 米探测上限）', () => {
    const p = probeWithRange(-33.9);
    const r = resolveSpawn({
        toEcef, toEnu, cesium: C as any,
        probeClearance: p.fn,
        configured: { east: 200, north: 240, up: 148 },
    });
    assert.equal(r.measured, true);
    assert.equal(r.method, 'clearance');
    // 648 → 498 → 348 → 198 → 48 → 48 测得到（脚下 81.9）
    assert.ok(Math.abs(r.groundUp! - (-33.9)) < 1e-6, `实际 ${r.groundUp}`);
    // 步长必须小于探测上限，否则会从两次探测之间漏过去
    assert.ok(p.calls.length >= 4, `探测次数 ${p.calls.length}`);
});

test('配置高度偏低时往下扫也能找到', () => {
    // 配置写 -300，实际地面 -33.9 —— 配置在**地面以下**，从上方扫下来第一个命中的就是地面
    const p = probeWithRange(-33.9);
    const r = resolveSpawn({
        toEcef, toEnu, cesium: C as any,
        probeClearance: p.fn,
        configured: { east: 0, north: 0, up: -300 },
    });
    assert.equal(r.measured, true);
    assert.ok(Math.abs(r.groundUp! - (-33.9)) < 1e-6);
});

test('逐级下探收敛：粗扫落脚点悬空时再测一次', () => {
    // 真实场景：射线先打到 30 米高的一块岩台，以为地面在那里，
    // 把角色放上去仍然悬空。补测一次就能落到真地面。
    const ground = -33.9;
    let n = 0;
    const r = resolveSpawn({
        toEcef, toEnu, cesium: C as any,
        probeClearance: (at) => {
            const c = at.up - ground;
            if (c > 200) return Infinity;          // 超出探测上限
            n++;
            if (n === 1) return c - 30;            // 粗扫：以为地面高 30 米
            return at.up - ground;                 // 补测：真地面
        },
        configured: { east: 0, north: 0, up: 0 },
    });
    assert.equal(r.measured, true);
    assert.ok(n >= 2, '应该补测一次');
    assert.ok(Math.abs(r.groundUp! - ground) < 1e-6, `实际 ${r.groundUp}`);
});

test('全程探不到时退回配置值', () => {
    const r = resolveSpawn({
        toEcef, toEnu, cesium: C as any,
        probeClearance: () => Infinity,
        configured: { east: 1, north: 2, up: 3 },
    });
    assert.equal(r.measured, false);
    assert.equal(r.method, 'none');
    assert.deepEqual(r.at, { east: 1, north: 2, up: 3 });
});

test('probeStep 被限制在 190 以内，避免漏掉地面', () => {
    const p = probeWithRange(-33.9);
    resolveSpawn({
        toEcef, toEnu, cesium: C as any,
        probeClearance: p.fn,
        configured: { east: 0, north: 0, up: 148 },
        probeStep: 500,  // 大于探测上限，会被压到 190
    });
    for (let i = 1; i < p.calls.length; i++) {
        assert.ok(p.calls[i - 1]! - p.calls[i]! <= 190, `步长 ${p.calls[i - 1]! - p.calls[i]!}`);
    }
});

test('lift 可显式指定：瞬移测距也能额外抬高', () => {
    const r = resolveSpawn({
        toEcef, toEnu, cesium: C as any,
        probeClearance: (at) => at.up - (-33.9),
        configured: { east: 0, north: 0, up: 0 },
        lift: 5,
    });
    assert.equal(r.method, 'clearance');
    assert.ok(Math.abs(r.at.up - (-28.9)) < 1e-6);
});
