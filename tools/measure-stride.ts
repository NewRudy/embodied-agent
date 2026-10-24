// 测量 GLB 里移动动画的「自然速度」。
//
// 为什么需要这个工具：动画速度匹配必须知道每个 clip 的脚底速度，
// 而这个值只存在于骨骼数据里 —— 看动画是估不准的，差 20% 就明显打滑。
//
// 用法：
//   node tools/measure-stride.ts path/to/model.glb
//   node tools/measure-stride.ts path/to/model.glb --clips Walk_Loop,Sprint_Loop
//   node tools/measure-stride.ts path/to/model.glb --height-meters 1.8
//
// 输出直接可以填进 LocomotionProfile。
//
// 算法：
//   1. 采样每帧所有骨骼的世界位置（GLB 里骨骼动画是旋转为主，必须累乘到根）
//   2. 找脚部骨骼（名字含 foot / toe / ankle / ball）
//   3. 自然速度 = 一个循环内单脚前后摆幅 × 2 ÷ 循环时长
//      （×2 是因为一个循环走两步；左右脚各一次）
//
// 局限：假设动画原地播放、没有根位移。带 root motion 的动画不适用。

import { readFileSync } from 'node:fs';

interface GltfJson {
    nodes: Array<{ name?: string; translation?: number[]; rotation?: number[]; scale?: number[]; children?: number[] }>;
    animations: Array<{ name: string; channels: Array<{ sampler: number; target: { node: number; path: string } }>; samplers: Array<{ input: number; output: number }> }>;
    accessors: Array<{ bufferView: number; byteOffset?: number; componentType: number; count: number; type: string }>;
    bufferViews: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }>;
    buffers: Array<{ byteLength: number }>;
    meshes?: Array<{ primitives: Array<{ attributes: Record<string, number> }> }>;
}

/** 从 GLB 容器里拆出 JSON 和 BIN。 */
export function readGlb(path: string): { json: GltfJson; bin: Buffer } {
    const data = readFileSync(path);
    if (data.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB 文件（magic 不对）');
    let offset = 12;
    let json: GltfJson | null = null;
    let bin: Buffer | null = null;
    while (offset < data.length) {
        const length = data.readUInt32LE(offset);
        const type = data.readUInt32LE(offset + 4);
        const body = data.subarray(offset + 8, offset + 8 + length);
        if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8'));
        else if (type === 0x004e4942) bin = body;
        offset += 8 + length;
    }
    if (!json || !bin) throw new Error('GLB 缺少 JSON 或 BIN 块');
    return { json, bin };
}

/** 读一个 accessor 的全部数据。 */
function readAccessor(json: GltfJson, bin: Buffer, index: number): number[][] {
    const acc = json.accessors[index]!;
    const view = json.bufferViews[acc.bufferView]!;
    const components = { SCALAR: 1, VEC3: 3, VEC4: 4 }[acc.type];
    if (!components) throw new Error(`不支持的 accessor 类型 ${acc.type}`);
    const fmt = { 5126: 'f', 5123: 'H', 5125: 'I' }[acc.componentType];
    if (!fmt) throw new Error(`不支持的 componentType ${acc.componentType}`);
    const size = components * (fmt === 'H' ? 2 : 4);
    const stride = view.byteStride ?? size;
    const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const out: number[][] = [];
    for (let i = 0; i < acc.count; i++) {
        const start = base + i * stride;
        const row: number[] = [];
        for (let c = 0; c < components; c++) {
            const at = start + c * (fmt === 'H' ? 2 : 4);
            row.push(fmt === 'H' ? bin.readUInt16LE(at) : fmt === 'I' ? bin.readUInt32LE(at) : bin.readFloatLE(at));
        }
        out.push(row);
    }
    return out;
}

function quatToMatrix(q: number[]): number[] {
    const [x, y, z, w] = q as [number, number, number, number];
    return [
        1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
        2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
        2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
        0, 0, 0, 1,
    ];
}

function multiply(a: number[], b: number[]): number[] {
    const r = new Array<number>(16).fill(0);
    for (let c = 0; c < 4; c++) {
        for (let row = 0; row < 4; row++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[c * 4 + k]!;
            r[c * 4 + row] = sum;
        }
    }
    return r;
}

/** 在时刻 t 采样动画，返回每个节点名的世界位置。 */
function worldPositionsAt(json: GltfJson, bin: Buffer, anim: GltfJson['animations'][number], t: number): Map<string, [number, number, number]> {
    // nodeId -> path -> value
    const local = new Map<number, Map<string, number[]>>();
    for (const ch of anim.channels) {
        const sampler = anim.samplers[ch.sampler]!;
        const times = readAccessor(json, bin, sampler.input).map(r => r[0]!);
        const values = readAccessor(json, bin, sampler.output);
        let v: number[];
        if (t <= times[0]!) v = values[0]!;
        else if (t >= times[times.length - 1]!) v = values[values.length - 1]!;
        else {
            v = values[0]!;
            for (let k = 0; k < times.length - 1; k++) {
                if (times[k]! <= t && t <= times[k + 1]!) {
                    const u = (t - times[k]!) / (times[k + 1]! - times[k]! || 1);
                    v = values[k]!.map((x, i) => x * (1 - u) + values[k + 1]![i]! * u);
                    break;
                }
            }
        }
        if (!local.has(ch.target.node)) local.set(ch.target.node, new Map());
        local.get(ch.target.node)!.set(ch.target.path, v);
    }

    const parent = new Map<number, number>();
    json.nodes.forEach((n, i) => { for (const c of n.children ?? []) parent.set(c, i); });

    const cache = new Map<number, number[]>();
    const world = (id: number): number[] => {
        const hit = cache.get(id);
        if (hit) return hit;
        const node = json.nodes[id]!;
        const L = local.get(id);
        const T = L?.get('translation') ?? node.translation ?? [0, 0, 0];
        const R = L?.get('rotation') ?? node.rotation ?? [0, 0, 0, 1];
        const m = quatToMatrix(R);
        m[12] = T[0]!; m[13] = T[1]!; m[14] = T[2]!;
        const result = parent.has(id) ? multiply(world(parent.get(id)!), m) : m;
        cache.set(id, result);
        return result;
    };

    const out = new Map<string, [number, number, number]>();
    json.nodes.forEach((n, i) => {
        const m = world(i);
        out.set(n.name ?? `node-${i}`, [m[12]!, m[13]!, m[14]!]);
    });
    return out;
}

export interface StrideResult {
    clip: string;
    /** 循环时长（秒）。 */
    duration: number;
    /** 单脚前后摆幅（模型单位）。 */
    strideUnits: number;
    /** 自然速度（模型单位/秒）。 */
    naturalSpeedUnits: number;
    /** 自然速度（米/秒），给了身高才换算。 */
    naturalSpeedMeters: number | null;
    /** 找到的脚部骨骼。 */
    feet: string[];
}

/**
 * 测量一个 clip 的自然速度。
 *
 * `metersPerUnit` 为 null 时只给模型单位的数值。
 */
export function measureStride(
    json: GltfJson,
    bin: Buffer,
    clipName: string,
    metersPerUnit: number | null = null,
    samples = 48,
): StrideResult {
    const anim = json.animations.find(a => a.name === clipName);
    if (!anim) throw new Error(`找不到动画「${clipName}」`);

    const feet = json.nodes
        .map(n => n.name ?? '')
        .filter(n => /foot|toe|ankle|ball/i.test(n) && !/leaf/i.test(n));
    if (feet.length === 0) throw new Error('模型里没有找到脚部骨骼（名字含 foot/toe/ankle/ball）');

    const duration = readAccessor(json, bin, anim.samplers[0]!.input).at(-1)![0]!;

    const spans: number[] = [];
    for (const foot of feet.slice(0, 2)) {
        let minZ = Infinity, maxZ = -Infinity;
        for (let k = 0; k <= samples; k++) {
            const t = (duration * k) / samples;
            const pos = worldPositionsAt(json, bin, anim, t).get(foot);
            if (!pos) continue;
            minZ = Math.min(minZ, pos[2]);
            maxZ = Math.max(maxZ, pos[2]);
        }
        if (Number.isFinite(minZ)) spans.push(maxZ - minZ);
    }
    const strideUnits = spans.reduce((a, b) => a + b, 0) / spans.length;
    // 一个循环走两步（左右脚各一次）
    const naturalSpeedUnits = (strideUnits * 2) / duration;

    return {
        clip: clipName,
        duration,
        strideUnits,
        naturalSpeedUnits,
        naturalSpeedMeters: metersPerUnit == null ? null : naturalSpeedUnits * metersPerUnit,
        feet: feet.slice(0, 2),
    };
}

/** 模型网格包围盒的高度（模型单位）。用来把「米」换算成「模型单位」。 */
export function modelHeight(json: GltfJson): number | null {
    let minY = Infinity, maxY = -Infinity;
    for (const mesh of json.meshes ?? []) {
        for (const prim of mesh.primitives) {
            const posIdx = prim.attributes.POSITION;
            if (posIdx == null) continue;
            const acc = json.accessors[posIdx] as { min?: number[]; max?: number[] };
            if (acc.min && acc.max) {
                minY = Math.min(minY, acc.min[1]!);
                maxY = Math.max(maxY, acc.max[1]!);
            }
        }
    }
    return Number.isFinite(minY) ? maxY - minY : null;
}

// —— CLI ——

/**
 * 判断当前是不是被直接执行（而不是被 import）。
 *
 * 不能用 `import.meta.url === 'file://' + process.argv[1]`：
 * 路径里有空格/中文时 import.meta.url 是百分号编码的，永远不相等，
 * 表现为「跑了但什么都不输出」。
 */
function isMain(): boolean {
    const entry = process.argv[1];
    if (!entry) return false;
    try {
        return import.meta.url === new URL(`file://${entry}`).href;
    } catch {
        return false;
    }
}

if (isMain()) {
    const args = process.argv.slice(2);
    const path = args.find(a => !a.startsWith('--'));
    if (!path) {
        console.error('用法: node tools/measure-stride.ts <model.glb> [--clips A,B] [--height-meters 1.8]');
        process.exit(1);
    }
    const clipArg = args.find(a => a.startsWith('--clips='))?.split('=')[1];
    const heightArg = args.find(a => a.startsWith('--height-meters='))?.split('=')[1];

    const { json, bin } = readGlb(path);
    const height = modelHeight(json);
    // 给了角色实际身高就能换算成米
    const metersPerUnit = heightArg && height ? Number(heightArg) / height : null;

    const defaults = ['Walk_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop', 'Walk_Formal_Loop', 'Run_Loop'];
    const clips = clipArg
        ? clipArg.split(',')
        : json.animations.map(a => a.name).filter(n => defaults.includes(n));

    console.log(`模型: ${path}`);
    if (height) console.log(`包围盒高度: ${height.toFixed(3)} 模型单位${metersPerUnit ? ` → 1 单位 = ${metersPerUnit.toFixed(4)} 米` : ''}`);
    console.log('');

    const results: StrideResult[] = [];
    for (const clip of clips) {
        try {
            const r = measureStride(json, bin, clip, metersPerUnit);
            results.push(r);
            const speed = r.naturalSpeedMeters != null
                ? `${r.naturalSpeedMeters.toFixed(3)} m/s`
                : `${r.naturalSpeedUnits.toFixed(3)} 单位/秒`;
            console.log(`  ${clip.padEnd(20)} 时长 ${r.duration.toFixed(3)}s  步幅 ${r.strideUnits.toFixed(3)}  自然速度 ${speed}`);
        } catch (e) {
            console.log(`  ${clip.padEnd(20)} 跳过: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    if (results.length) {
        console.log('\n可直接填进 LocomotionProfile（按 naturalSpeed 升序）:');
        const sorted = [...results].sort((a, b) => a.naturalSpeedUnits - b.naturalSpeedUnits);
        console.log('clips: [');
        for (const r of sorted) {
            const v = r.naturalSpeedMeters ?? r.naturalSpeedUnits;
            console.log(`  { name: '${r.clip}', naturalSpeed: ${v.toFixed(3)} },`);
        }
        console.log('],');
    }
}
