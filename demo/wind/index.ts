// 演示：把具身智能体挂到「老鸦岭风电场」场景上。
//
// 这个文件只做三件事：
//   1. 加载本场景的资产（地形瓦片、风机）
//   2. 告诉装配层「原点在哪、参照物有哪些、怎么建人物」
//   3. 接上 UI（输入框、按钮、自动演示）
//
// 其余（语音、意图、每帧驱动、出生点解算、动画匹配）都在 src/scene.ts 里，
// 换场景不用重写。想看「接一个新场景」最少要写什么，看 demo/sandbox/。

import {
    Cartesian3, Cesium3DTileset, Color, HeadingPitchRoll, Math as CMath, Matrix3, Matrix4, Model,
    ModelAnimationLoop, Transforms, Viewer,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { playerController, type PlayerModelOptions } from 'cesium-player-controller';
import type { ColliderSource } from 'cesium-player-controller';

import { createEmbodiedScene, type EmbodiedScene } from '../../src/create-scene.ts';
import { setupCesiumScene, type ReferenceEntry } from '../../src/cesium-scene.ts';
import { applyOutput } from '../../src/body.ts';
import type { BodyLike } from '../../src/body.ts';
import type { LocomotionProfile } from '../../src/locomotion.ts';
import type { Vec3 } from '../../src/types.ts';

// 资源从巡界仓库直接引用，避免复制大文件
const ASSET_BASE = '/xunjie-assets/';

interface FarmOffset { east: number; north: number; up: number }
interface FarmTurbine {
    id: string; label: string; no: number; checkpointId: string;
    offset: FarmOffset; headingDeg: number; riskLevel: string; stateNote: string;
}
interface FarmFixture {
    sceneId: string; sceneRevision: string; name: string;
    origin: { lon: number; lat: number; heightM: number };
    assets: {
        mountain: { tilesetUrl: string; gltfUrl: string; colliderModelMatrix: number[]; credit: string };
        turbine: { gltfUrl: string; scale: number; rotorAnimation: string; credit: string };
        player: { glbUrl: string; scale: number };
    };
    opsPoint: { id: string; label: string; offset: FarmOffset };
    turbines: FarmTurbine[];
}

const log = (...args: unknown[]) => {
    const el = document.getElementById('log');
    if (el) {
        const line = document.createElement('div');
        line.textContent = args.join(' ');
        el.prepend(line);
        while (el.childElementCount > 60) el.lastElementChild?.remove();
    }
    console.log(...args);
};

/**
 * 动画速度匹配。
 *
 * 这些 naturalSpeed 是**量出来的**，不是估的：
 *   node tools/measure-stride.ts public/xunjie-assets/glb/UAL1_Standard.glb --height-meters=1.8
 *
 * 换模型时必须重新量。数值错了脚就会打滑，而这个很难靠肉眼判断。
 */
const LOCOMOTION: LocomotionProfile = {
    idle: 'Idle_Loop',
    clips: [
        { name: 'Walk_Loop', naturalSpeed: 1.065 },
        { name: 'Jog_Fwd_Loop', naturalSpeed: 2.882 },
        { name: 'Sprint_Loop', naturalSpeed: 3.621 },
    ],
};

async function main() {
    const farm: FarmFixture = await fetch(`${ASSET_BASE}wind/farm.json`).then((r) => r.json());

    // —— 场景：viewer + 地形 + 风机 ——
    const viewer = new Viewer('cesiumContainer', {
        timeline: false,
        animation: false,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        infoBox: false,
        selectionIndicator: false,
        // 本演示不依赖 Cesium ion；去掉默认影像与地形，避免无 token 时报错
        baseLayer: false,
        terrainProvider: undefined,
    });
    viewer.scene.globe.depthTestAgainstTerrain = true;
    // 广角视野：窄 FOV 会把近处地形裁出画面
    (viewer.camera.frustum as any).fov = CMath.toRadians(90);
    viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 1.5);
    // 深色底，与巡界原版一致
    viewer.scene.globe.baseColor = Color.fromCssColorString('#0d141b');
    viewer.clock.shouldAnimate = true;

    // —— 地形瓦片 ——
    const tileset = await Cesium3DTileset.fromUrl(`${ASSET_BASE}${farm.assets.mountain.tilesetUrl}`);
    viewer.scene.primitives.add(tileset);
    await tileset.readyPromise;

    // 场景原点。ENU 坐标都相对它。
    const origin = Cartesian3.fromDegrees(
        farm.origin.lon, farm.origin.lat, farm.origin.heightM,
    );
    const enuToEcef = (o: FarmOffset) => {
        // 只为摆风机用；装配层内部有自己的 EnuFrame
        const m = Transforms.eastNorthUpToFixedFrame(origin);
        const local = new Cartesian3(o.east, o.north, o.up);
        return Matrix4.multiplyByPoint(m, local, new Cartesian3());
    };

    // —— 风机 ——
    for (const t of farm.turbines) {
        const position = enuToEcef(t.offset);
        const hpr = new HeadingPitchRoll(CMath.toRadians(t.headingDeg), 0, 0);
        const modelMatrix = Transforms.headingPitchRollToFixedFrame(position, hpr);
        const model = await Model.fromGltfAsync({
            url: `${ASSET_BASE}${farm.assets.turbine.gltfUrl}`,
            modelMatrix,
            scale: farm.assets.turbine.scale,
        });
        viewer.scene.primitives.add(model);
        await model.readyPromise;
        const anims = model.activeAnimations;
        if (anims && anims.length > 0) {
            anims.addAll().forEach((a) => {
                a.loop = ModelAnimationLoop.REPEAT;
                a.play();
            });
        }
    }

    // —— 参照物表：口语 → ENU ——
    const references: ReferenceEntry[] = [
        {
            name: farm.opsPoint.label,
            at: { ...farm.opsPoint.offset },
            aliases: ['运维点', '出发点', '起点'],
            description: '运维基地，人物出生点',
        },
        ...farm.turbines.map((t) => ({
            name: t.label,
            at: { ...t.offset },
            aliases: [`${t.no}号机组`, `风机${t.no}`, `${t.no}号`],
            description: `第 ${t.no} 号风力发电机`,
        })),
    ];

    // —— 碰撞体 ——
    // 碰撞矩阵 = colliderModelMatrix × RotX(+90°)，把 glTF 的 Y-up 校正到 Rapier 的 Z-up。
    // 漏掉这步三角网会整体转向，人物直接从山体里穿下去。
    const yUpToZUp = Matrix4.fromRotationTranslation(
        Matrix3.fromRotationX(CMath.PI_OVER_TWO), Cartesian3.ZERO, new Matrix4());
    const colliderMatrix = Matrix4.multiply(
        Matrix4.fromColumnMajorArray(farm.assets.mountain.colliderModelMatrix, new Matrix4()),
        yUpToZUp, new Matrix4());
    const gltfCollider: ColliderSource = {
        type: 'gltf',
        url: `${ASSET_BASE}${farm.assets.mountain.gltfUrl}`,
        modelMatrix: Matrix4.toArray(colliderMatrix),
    };

    const playerModel: PlayerModelOptions = {
        url: `${ASSET_BASE}${farm.assets.player.glbUrl}`,
        scale: farm.assets.player.scale,
        idleAnim: 'Idle_Loop',
        walkAnim: 'Walk_Loop',
        runAnim: 'Sprint_Loop',
        jumpAnim: ['Jump_Start', 'Jump_Loop', 'Jump_Land'],
        flyAnim: 'fly',
        flyIdleAnim: 'flyIdle',
        flyHoverForwardAnim: 'flyHoverForward',
        flyHoverBackAnim: 'flyHoverBack',
        flyHoverLeftAnim: 'flyHoverLeft',
        flyHoverRightAnim: 'flyHoverRight',
        flyHoverUpAnim: 'flyHoverUp',
        flyHoverDownAnim: 'flyHoverDown',
        rotateY: -Math.PI / 2,
        facingOffset: Math.PI / 2,
    };

    // —— 语音 ——
    // 访问密钥从页面 URL 的 ?key= 带进来，转给语音服务。
    // 漏掉这步的话，页面能开、能打字，但麦克风永远连不上 —— 而且失败得
    // 很安静（服务端 401，浏览器只看到「连接已结束」）。
    const VOICE_KEY = new URLSearchParams(location.search).get('key') ?? '';
    const voiceUrl = (() => {
        const url = new URL('/voice/stream', location.href);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.port = '5181'; // 语音服务独立端口，与 vite 分开
        if (VOICE_KEY) url.searchParams.set('key', VOICE_KEY);
        return url.toString();
    })();

    // —— 装配：Cesium 侧（ENU 原点、人物、出生点实测）——
    const cesium = { Cartesian3, Matrix4, Transforms, fromDegrees: Cartesian3.fromDegrees };
    const setup = await setupCesiumScene({
        viewer,
        origin: farm.origin,
        cesium: cesium as any,
        // 只有 east/north 可信。up 会被物理射线实测覆盖 ——
        // farm.json 写 148，实际地面 -33.9，照它出生就是从 151 米高处掉下来。
        spawn: { east: farm.opsPoint.offset.east, north: farm.opsPoint.offset.north, up: farm.opsPoint.offset.up },
        references,
        getPhysics: (p) => (p as any).physics,
        log,
        async createPlayer({ viewer: v, spawn }) {
            const player = new playerController();
            await player.init({
                viewer: v,
                initPos: spawn as any,
                // 相机距离会乘以 playerModelConfig.scale（0.01），所以这里写的是「厘米」。
                minCamDistance: 50,
                maxCamDistance: 300,
                camLookAtHeightRatio: 0.7,
                enableSpringCamera: true,
                springCameraTime: 0.07,
                thirdMouseMode: 2,
                playerModelConfig: playerModel,
                staticCollider: [gltfCollider],
            });
            (player as any).setEnableZoom(true);
            player.setPlayerSpeed(500);
            player.setPlayerFlySpeed(3000);
            return player as any;
        },
    });

    // —— 装配：引擎无关侧（意图、语音、每帧解算）——
    const scene = createEmbodiedScene({
        adapter: setup.adapter,
        player: setup.player as unknown as BodyLike,
        agent: {
            origin: { east: farm.opsPoint.offset.east, north: farm.opsPoint.offset.north, up: 0 },
            config: { walkSpeed: 1.4, runSpeed: 3.6, boundsRadius: 1500 },
        },
        locomotion: LOCOMOTION,
        voice: {
            url: voiceUrl,
            workletUrl: '/voice/pcm-capture.js',
        },
        log,
        onState(state) {
            const mic = document.getElementById('mic') as HTMLButtonElement | null;
            if (mic) {
                mic.dataset.state = state.voiceState;
                mic.textContent = state.voiceState === 'listening' ? '⏹' : '🎤';
            }
            const t = document.getElementById('transcript');
            if (t) t.textContent = state.transcript ? `「${state.transcript}」` : '';
        },
    });

    const { agent, handleCommand, voice, speech } = scene;
    const player = setup.player as any;

    // —— 每帧驱动 ——
    let last = performance.now();
    const readout = document.getElementById('readout');
    const tickLoop = () => {
        const now = performance.now();
        const dt = Math.min((now - last) / 1000, 0.1);
        last = now;
        scene.tick(dt);
        player.update?.(dt);
        if (readout) {
            const clip = player.animation?.stateKey ?? '?';
            const g = agent.currentGoal;
            if (!g) readout.textContent = `状态 ${agent.currentState} · 动画 ${clip}`;
            else {
                const p = setup.adapter.getPose();
                const d = Math.hypot(g.position.east - p.east, g.position.north - p.north);
                readout.textContent = `状态 ${agent.currentState} · 距目标 ${d.toFixed(1)} m · 动画 ${clip}`;
            }
        }
    };
    viewer.scene.preUpdate.addEventListener(tickLoop);

    // —— 自动演示 ——
    interface DemoStep {
        cmd: string;
        wait: 'arrived' | 'seconds';
        seconds?: number;
        note: string;
    }

    /**
     * 演示脚本。
     *
     * 关键约束（实测得出，别改回去）：
     * - 不能用倍速。playerController 拒绝 >12 m/s，且 >10 m/s 时物理跟不上会打滑触发 STUCK。
     * - 所以演示用正常步行速度，靠「选一个短目标」把时长压到 20 秒左右。
     */
    const DEMO_SCRIPT: DemoStep[] = [
        { cmd: '往前走60米', wait: 'seconds', seconds: 3, note: '目标驱动：给它一个点，它自己走过去' },
        { cmd: '往左一点', wait: 'seconds', seconds: 3, note: '中途修正 —— 注意没有停下重算' },
        { cmd: '跑起来', wait: 'seconds', seconds: 2, note: '变速 —— 同一目标继续' },
        { cmd: '__wait_arrive__', wait: 'arrived', note: '减速、到达、自动停住' },
        { cmd: '去运维点', wait: 'seconds', seconds: 3, note: '新目标抢占旧目标' },
        { cmd: '停', wait: 'seconds', seconds: 2, note: '停止 —— 清空目标' },
    ];

    let demoRunning = false;

    async function runDemo() {
        if (demoRunning) return;
        demoRunning = true;
        const btn = document.getElementById('demoBtn') as HTMLButtonElement | null;
        const banner = document.getElementById('demoNote');
        if (btn) { btn.disabled = true; btn.textContent = '演示中…'; }
        log('=== 自动演示开始 ===');

        const waitFor = (predicate: () => boolean, timeoutMs: number) =>
            new Promise<void>((resolve) => {
                const t0 = performance.now();
                const tick = () => {
                    if (predicate() || performance.now() - t0 > timeoutMs) resolve();
                    else requestAnimationFrame(tick);
                };
                tick();
            });

        // 出生点已经由装配层实测过地面，正常应该立刻着地。
        // 这里只是兜底（物理世界刚建好时可能需要几帧）。
        await waitFor(() => player.playerIsOnGround, 5_000);

        for (const step of DEMO_SCRIPT) {
            if (banner) banner.textContent = step.note;
            if (step.cmd === '__wait_arrive__') {
                await waitFor(() => agent.currentState !== 'active', 120_000);
                continue;
            }
            handleCommand(step.cmd);
            if (step.wait === 'arrived') await waitFor(() => agent.currentState !== 'active', 120_000);
            else await waitFor(() => false, (step.seconds ?? 2) * 1000);
        }

        agent.config.walkSpeed = 1.4;
        demoRunning = false;
        if (btn) { btn.disabled = false; btn.textContent = '▶ 自动演示'; }
        if (banner) banner.textContent = '演示结束';
        log('=== 自动演示结束 ===');
    }

    // —— UI ——
    const micBtn = document.getElementById('mic') as HTMLButtonElement | null;
    const transcriptEl = document.getElementById('transcript');
    if (voice) {
        micBtn?.addEventListener('click', () => { void voice.toggle(); });
    } else if (micBtn) {
        micBtn.disabled = true;
        micBtn.title = '语音未启用';
    }
    // 语音状态由 scene.onState 驱动（见上方的 onState 配置）
    void transcriptEl;

    const input = document.getElementById('cmd') as HTMLInputElement | null;
    input?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const text = input.value.trim();
        if (text) { handleCommand(text); input.value = ''; }
    });
    document.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach((btn) => {
        btn.addEventListener('click', () => handleCommand(btn.dataset.cmd!));
    });
    document.getElementById('demoBtn')?.addEventListener('click', () => { void runDemo(); });

    log('就绪。输入「去3号风机」「往前走20米」「往左一点」「停」试试，或点「自动演示」。');
    // 自动化验收要手动逐帧驱动：只调 agent.update 而不施加输出的话，
    // worldMovement 一直是 null，人物不动。applyOutput 一起导出。
    (window as any).__agent = {
        ...scene,
        runDemo,
        LOCOMOTION,
        player,
        adapter: setup.adapter,
        enu: setup.enu,
        spawn: setup.spawn,
        applyOutput,
    };
}

main().catch((e) => {
    console.error(e);
    log('启动失败：' + (e instanceof Error ? e.message : String(e)));
});
