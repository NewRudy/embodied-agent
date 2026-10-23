// 演示：把具身智能体挂到「老鸦岭风电场」场景上。
//
// 与巡界的区别：
//   - 没有任务状态机、没有审批、没有回执
//   - 语音/文字 → 目标 → 每帧解算 → setWorldMovement
//   - 走到一半可以随时改目标，运动不重启
//
// 运行：见项目根目录 README。

import {
    Cartesian3, Cesium3DTileset, Color, HeadingPitchRoll, Math as CMath, Matrix3, Matrix4, Model,
    ModelAnimationLoop, Transforms, Viewer,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { playerController, type PlayerModelOptions } from 'cesium-player-controller';
import type { ColliderSource } from 'cesium-player-controller';

import { EmbodiedAgent } from '../../src/agent.ts';
import { parseIntent } from '../../src/intent.ts';
import { CesiumSceneAdapter, EnuFrame, applyOutput, type PlayerLike } from '../../src/cesium-adapter.ts';
import { RealtimeVoice, isImmediatePause } from '../../src/voice/realtime-voice.ts';
import { SpeechOutput } from '../../src/voice/speech-output.ts';
import type { Goal, Vec3 } from '../../src/types.ts';

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

async function main() {
    const farm: FarmFixture = await fetch(`${ASSET_BASE}wind/farm.json`).then((r) => r.json());

    const origin = Cartesian3.fromDegrees(
        farm.origin.lon, farm.origin.lat, farm.origin.heightM,
    );
    const enuFrame = new EnuFrame(origin);
    const enuToEcef = (o: FarmOffset) => enuFrame.toEcef({ east: o.east, north: o.north, up: o.up });

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
    // 等瓦片真正就绪后再定视角，否则相机落在包围球内部看不到东西
    await tileset.readyPromise;

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
        // 等模型真正就绪后再取动画，否则 activeAnimations 尚未挂上
        await model.readyPromise;
        const anims = model.activeAnimations;
        if (anims && anims.length > 0) {
            const clip = anims.addAll();
            clip.forEach((a) => {
                a.loop = ModelAnimationLoop.REPEAT;
                a.play();
            });
        }
    }

    // —— 人物 ——
    // 出生点抬到运维点上方 3 米，让物理先落地（与巡界 demo 一致）
    const spawnOffset = farm.opsPoint.offset;
    const spawn = enuFrame.toEcef({
        east: spawnOffset.east,
        north: spawnOffset.north,
        up: spawnOffset.up + 3,
    });

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

    const player = new playerController();
    await player.init({
        viewer,
        initPos: spawn,
        // 注意：相机距离会乘以 playerModelConfig.scale（0.01），
        // 所以这里写的是「厘米」。15000 → 150m。
        // 与巡界 demo 一致：50/300 会乘 scale(0.01) → 0.5m / 3m。
        // 配合 fov 90° 和手动拖拽旋转，这是原版验证过的观感。
        minCamDistance: 50,
        maxCamDistance: 300,
        camLookAtHeightRatio: 0.7,
        enableSpringCamera: true,
        springCameraTime: 0.07,
        thirdMouseMode: 2,
        playerModelConfig: playerModel,
        staticCollider: [gltfCollider],
    });
    // 相机俯仰与巡界原版一致（70°），配合 fov 90° 是验证过的观感。
    // 若在陡坡上被射线避障压近，可用滚轮/拖拽自行调整。
    (player as any).setEnableZoom(true);
    player.setPlayerSpeed(500);
    player.setPlayerFlySpeed(3000);

    // —— 参照物表：口语 → ENU ——
    const references = new Map<string, Vec3>();
    references.set(farm.opsPoint.label, { ...spawnOffset });
    references.set('运维点', { ...spawnOffset });
    for (const t of farm.turbines) {
        const v: Vec3 = { ...t.offset };
        references.set(t.label, v);
        references.set(`${t.no}号风机`, v);
        references.set(`${t.no}号机组`, v);
        references.set(`风机${t.no}`, v);
    }

    const adapter = new CesiumSceneAdapter({
        player: player as unknown as PlayerLike,
        frame: enuFrame,
        references,
    });

    const agent = new EmbodiedAgent(adapter, {
        origin: { east: spawnOffset.east, north: spawnOffset.north, up: spawnOffset.up },
        config: { walkSpeed: 5, runSpeed: 9, boundsRadius: 1500 },
    });

    // —— 每帧驱动 ——
    // 注意：playerController 不自己跑主循环，必须外部每帧调用 player.update()。
    // 顺序也很关键：先解算智能体并写入 worldMovement，再 update 让物理消费它。
    let last = performance.now();
    let lastLoggedState = '';
    viewer.scene.preUpdate.addEventListener(() => {
        const now = performance.now();
        const dt = Math.min((now - last) / 1000, 0.1);
        last = now;

        const out = agent.update(dt);
        applyOutput(player as unknown as PlayerLike, out);
        player.update();

        // 状态变化时写日志 + 播报
        const key = `${out.state}:${out.failure ?? ''}`;
        if (key !== lastLoggedState) {
            lastLoggedState = key;
            if (out.justArrived) {
                log(`✅ 到达 ${out.goal?.label ?? ''}`);
                speech?.speak(`已到达${(out.goal?.label ?? '目标').replace(/^(?:去|到|走向)/, '')}`);
            } else if (out.failure) {
                log(`⚠️ 失败：${out.failure}`);
                speech?.speak(failureText(out.failure));
            } else if (out.state === 'active') {
                log(`▶ 出发 → ${out.goal?.label ?? ''} (${(out.distance ?? 0).toFixed(0)}m)`);
            }
        }
        // 距离读数
        const readout = document.getElementById('readout');
        if (readout) {
            const d = out.distance;
            const anim = (player as any).animation?.stateKey ?? '?';
            readout.textContent = d == null
                ? `状态 ${out.state} · 动画 ${anim}`
                : `状态 ${out.state} · 距目标 ${d.toFixed(1)} m · 速度 ${out.movement.speedMetersPerSecond.toFixed(1)} m/s · 动画 ${anim}`;
        }
    });

    // —— 输入处理 ——
    const input = document.getElementById('cmd') as HTMLInputElement | null;

    /**
     * 速度档位：走 / 跑。
     * 注意 playerController 拒绝 >12 m/s，runSpeed 必须留在这个上限内。
     */
    const baseWalkSpeed = agent.config.walkSpeed;
    const baseRunSpeed = agent.config.runSpeed;
    let pace: 'walk' | 'run' = 'walk';
    function applySpeed() {
        agent.config.walkSpeed = pace === 'run' ? baseRunSpeed : baseWalkSpeed;
    }

    // —— 语音（全双工）——
    // 链路移植自巡界：麦克风 → AudioWorklet(16k) → WebSocket → 后端豆包 ASR。
    // 凭据只在后端；浏览器只发原始 PCM。
    const VOICE_URL = (() => {
        const url = new URL('/voice/stream', location.href);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.port = '5181'; // 语音服务独立端口，与 vite 分开
        return url.toString();
    })();

    // 播报先建：语音需要它提供回声参考文本
    const speech = new SpeechOutput({
        onPlaybackGate: (active, text) => voice?.setPlayback(active, text),
    });

    const micBtn = document.getElementById('mic') as HTMLButtonElement | null;
    const transcriptEl = document.getElementById('transcript');

    const voice = new RealtimeVoice({
        url: VOICE_URL,
        workletUrl: '/voice/pcm-capture.js',
        onState(state) {
            if (micBtn) {
                micBtn.dataset.state = state;
                micBtn.textContent = state === 'listening' ? '⏹' : '🎤';
                micBtn.title = state === 'listening' ? '结束持续语音' : '开启持续语音';
                micBtn.setAttribute('aria-pressed', String(state !== 'off'));
            }
            if (state === 'connecting') log('🎧 正在连接麦克风和语音服务…');
            else if (state === 'listening') log('🎧 持续语音已开启 · 说「停」可随时打断');
            else if (transcriptEl) transcriptEl.textContent = '';
        },
        onPartial(text) {
            if (transcriptEl) transcriptEl.textContent = text ? `「${text}」` : '';
            // 临时转写里的「停」立刻生效，不等定稿
            if (text && isImmediatePause(text)) {
                speech.cancel();
                handleCommand('停');
            }
        },
        onInterrupt(event) {
            speech.cancel();
            if (event.reason === 'pause') {
                handleCommand('停');
                log('🎧 语音打断 → 停止');
            } else {
                log('🎧 语音打断播报');
            }
        },
        onCommand(text) {
            handleCommand(text);
        },
        onError(message) {
            log(`⚠️ 语音：${message}`);
            if (transcriptEl) transcriptEl.textContent = message;
        },
    });

    micBtn?.addEventListener('click', () => { void voice.toggle(); });

    // 语音服务未配置时禁用麦克风，别让人点了才发现连不上
    void fetch(VOICE_URL.replace(/^ws/, 'http').replace('/voice/stream', '/voice/health'))
        .then(r => r.ok ? r.json() as Promise<{ voiceConfigured?: boolean }> : null)
        .then(status => {
            if (status && status.voiceConfigured === false && micBtn) {
                micBtn.disabled = true;
                micBtn.title = '语音未配置（缺少 ASR 凭据），可用文字操控';
                log('语音未配置，仅文字可用。要启用：在语音服务上设置 DOUBAO_ASR_* 环境变量。');
            }
        })
        .catch(() => {
            if (micBtn) {
                micBtn.disabled = true;
                micBtn.title = '语音服务未启动，可用文字操控';
            }
            log('语音服务未启动（npm run voice），仅文字可用。');
        });

    function handleCommand(text: string) {
        if (!text.trim()) return;
        log(`🗣 ${text}`);

        const pose = adapter.getPose();
        const intent = parseIntent(text, {
            pose: { east: pose.east, north: pose.north, yaw: pose.yaw },
            goal: agent.currentGoal,
            resolve: (t) => adapter.resolveReference(t),
            defaultStep: 10,
        });

        if (!intent) {
            log('   → 没听懂');
            speech.speak('没听懂，请再说一次');
            return;
        }

        switch (intent.action) {
            case 'stop':
                agent.cancel();
                player.stopHorizontalMotion();
                log('   → 停止');
                break;
            case 'go':
            case 'approach':
                agent.setGoal({
                    position: intent.position!,
                    tolerance: 4,
                    label: text,
                } as Goal);
                break;
            case 'revise':
                agent.reviseGoal({ position: intent.position! });
                log('   → 修正目标');
                break;
            case 'turn':
                player.setScriptedYaw((pose.yaw + intent.yawDelta!) as number);
                log('   → 转向');
                break;
            case 'run':
                pace = intent.pace === 'run' ? 'run' : 'walk';
                applySpeed();
                log(`   → ${pace === 'run' ? '快跑' : '慢走'}`);
                break;
            case 'fly':
                player.setFlightMode(!!intent.fly);
                log(`   → ${intent.fly ? '起飞' : '降落'}`);
                break;
        }
    }

    function failureText(reason: string): string {
        switch (reason) {
            case 'STUCK': return '前面过不去，停下了';
            case 'NO_GROUND_AHEAD': return '前方是陡坡，停下了';
            case 'TIMEOUT': return '走太久了，先停下';
            case 'OUT_OF_BOUNDS': return '超出活动范围了，停下了';
            default: return '没法继续前进了';
        }
    }

    input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            handleCommand(input.value);
            input.value = '';
        }
    });

    // 快捷按钮
    document.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach((btn) => {
        btn.addEventListener('click', () => handleCommand(btn.dataset.cmd!));
    });

    // —— 自动演示 ——
    // 按顺序执行一组指令，每一步等「到达」或超时再走下一步。
    // 目的：让人在 1 分钟内看到完整行为（长距离、修正、变速、到达、返回），
    // 而不是手动敲一条条指令。
    interface DemoStep {
        cmd: string;
        /** 等到什么条件再进入下一步。 */
        wait: 'arrived' | 'seconds';
        seconds?: number;
        /** 步骤说明，显示在 HUD 上。 */
        note: string;
    }

    /**
     * 演示脚本：按顺序执行，每步等到条件满足再走下一步。
     *
     * 关键约束（实测得出，别改回去）：
     * - 不能用倍速。playerController 拒绝 >12 m/s，且 >10 m/s 时物理跟不上会打滑触发 STUCK。
     * - 所以演示用正常 5 m/s 步行，靠「选一个 100 米内的目标」把时长压到 20 秒左右。
     * - 3 号风机离运维点 420 米，步行要 84 秒，不适合做演示目标；
     *   改用「往前走 60 米」这类短目标，同样能展示目标驱动、修正、变速、到达。
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

        // 倍速这条路走不通：playerController.setWorldMovement 拒绝 >12 m/s，
        // 而超过 ~10 m/s 时物理跟不上，人物原地打滑会被 STUCK 反射判失败。
        // 所以演示不用倍速，改用正常的 5 m/s 步行，靠「缩短距离」来控制时长。
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

        // 出生点在运维点上方 3 米，靠重力落地约需 1 秒；
        // 若在落地前下指令，前几秒人物是在空中「走」，看起来像飘。
        await waitFor(() => (player as any).playerIsOnGround, 15_000);

        for (const step of DEMO_SCRIPT) {
            if (banner) banner.textContent = step.note;

            if (step.cmd === '__wait_arrive__') {
                // 等到到达或失败；60 米步行约 15 秒，留 60 秒余量
                await waitFor(() => agent.currentState !== 'active', 60_000);
                continue;
            }

            handleCommand(step.cmd);

            if (step.wait === 'arrived') {
                await waitFor(() => agent.currentState !== 'active', 120_000);
            } else {
                await waitFor(() => false, (step.seconds ?? 2) * 1000);
            }
        }

        pace = 'walk';
        applySpeed();
        demoRunning = false;
        if (btn) { btn.disabled = false; btn.textContent = '▶ 自动演示'; }
        if (banner) banner.textContent = '演示结束';
        log('=== 自动演示结束 ===');
    }

    document.getElementById('demoBtn')?.addEventListener('click', () => runDemo());

    log('就绪。输入「去3号风机」「往前走20米」「往左一点」「停」试试，或点「自动演示」。');
    (window as any).__agent = { agent, player, adapter, runDemo, handleCommand, voice, speech };
}

main().catch((e) => {
    console.error(e);
    log('启动失败：' + (e instanceof Error ? e.message : String(e)));
});
