// 发布前自检 —— 把「发出去之后才发现坏了」的情况提前查出来。
//
// npm publish 是不可逆的（72 小时后不能再 unpublish）。发一个坏包比不发更糟：
// 使用者装到的是坏的，而你没法回收。
//
// 用法：
//   node tools/preflight.ts          # 只检查
//   npm publish                      # prepublishOnly 会自动跑 check + build
//
// 检查项都来自真实踩过的坑，不是通用清单：
//   - 包里缺 dist（git 安装时踩过：装完 import 报 Cannot find module）
//   - 三个子入口能不能 import（exports 写错时 npm 不会报，使用者才发现）
//   - 有没有把凭据打进包（.env 被 files 带进去过一次的教训）
//   - README/ACCEPTANCE 是否在包里（npm 页面上会缺文档）
//   - 版本号是否已经存在于 npm（发重复版本会失败，但报错很晚）

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 必须用 fileURLToPath，不能用 new URL(...).pathname ——
// 后者会把中文和空格百分号编码（本仓库路径含「具身智能体包」和空格），
// 结果 readFileSync 报 ENOENT，而报错里的路径看起来「明明是对的」。
const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

interface Check { name: string; ok: boolean; detail: string }
const checks: Check[] = [];
const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

// —— 1. 构建产物 ——
const distFiles = ['dist/index.js', 'dist/index.d.ts', 'dist/cesium.js', 'dist/server/index.js'];
const missing = distFiles.filter(f => !existsSync(join(root, f)));
add('构建产物齐全', missing.length === 0,
    missing.length ? `缺 ${missing.join(', ')}（先 npm run build:lib）` : distFiles.join(', '));

// —— 2. 三个子入口能加载 ——
// 用子进程 import，避免把自己的模块缓存搞乱。
for (const entry of ['embodied-agent', 'embodied-agent/cesium', 'embodied-agent/server']) {
    try {
        const out = execFileSync(process.execPath, ['-e',
            `import('${entry}').then(m => console.log(Object.keys(m).length)).catch(e => { console.error(e.message); process.exit(1); })`,
        ], { encoding: 'utf8', cwd: root, timeout: 30_000 });
        add(`入口 ${entry}`, true, `${out.trim()} 个导出`);
    } catch (e) {
        const msg = e instanceof Error ? (e as { stderr?: string }).stderr ?? e.message : String(e);
        add(`入口 ${entry}`, false, msg.split('\n')[0]!.slice(0, 120));
    }
}

// —— 3. 打包内容 ——
let packList: string[] = [];
try {
    // --ignore-scripts：npm pack 会先跑 prepare（= build:lib），tsup 的日志
    // 会混进 stdout，把 --json 的输出弄成非法 JSON（实测：
    // `Unexpected token 'C', "CLI Buildi"...`）。构建在上一步已经单独验过了。
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'],
        { encoding: 'utf8', cwd: root, timeout: 120_000 });
    const info = JSON.parse(out)[0] as { files: Array<{ path: string }>; size: number };
    packList = info.files.map(f => f.path);
    add('打包内容非空', packList.length > 0, `${packList.length} 个文件`);

    // 文档必须在包里，否则 npm 页面上什么都没有
    for (const doc of ['README.md', 'LICENSE']) {
        add(`包含 ${doc}`, packList.includes(doc), packList.includes(doc) ? '✓' : '缺失');
    }
} catch (e) {
    add('打包内容非空', false, e instanceof Error ? e.message.slice(0, 120) : String(e));
}

// —— 4. 凭据泄露 ——
// 检查两处：包内容里有没有 .env，以及源码里有没有硬编码的长串密钥。
const envInPack = packList.filter(p => /(^|\/)\.env($|\.(?!example))/.test(p));
add('包里没有 .env', envInPack.length === 0,
    envInPack.length ? `危险：${envInPack.join(', ')}` : '只有 .env.example 是安全的');

const SECRET_RE = /(?:api[_-]?key|secret|token|password|access[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/i;
const suspects: string[] = [];
for (const f of packList.filter(p => /\.(ts|js|json|md)$/.test(p))) {
    const abs = join(root, f);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    if (SECRET_RE.test(text)) suspects.push(f);
}
add('源码无硬编码密钥', suspects.length === 0,
    suspects.length ? `可疑：${suspects.join(', ')}` : '未发现');

// —— 5. 版本是否已被占用 ——
try {
    const out = execFileSync('npm', ['view', `${pkg.name}@${pkg.version}`, 'version'],
        { encoding: 'utf8', cwd: root, timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] });
    add('版本未被占用', false, `npm 上已存在 ${pkg.name}@${out.trim()}，需要先改版本号`);
} catch {
    // view 失败 = 版本不存在 = 可以发
    add('版本未被占用', true, `${pkg.name}@${pkg.version} 可发`);
}

// —— 6. 元数据 ——
for (const field of ['repository', 'homepage', 'bugs', 'author', 'license'] as const) {
    add(`元数据 ${field}`, Boolean((pkg as Record<string, unknown>)[field]),
        String((pkg as Record<string, unknown>)[field] ?? '缺失'));
}

// —— 输出 ——
const failed = checks.filter(c => !c.ok);
for (const c of checks) {
    console.log(`${c.ok ? '✓' : '✗'} ${c.name.padEnd(22)} ${c.detail}`);
}
console.log('');
if (failed.length) {
    console.log(`${failed.length} 项不通过，先修好再发。`);
    process.exit(1);
}
console.log('全部通过。可以发布：npm publish');
