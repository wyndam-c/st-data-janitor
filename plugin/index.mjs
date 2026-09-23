/**
 * ST Data Janitor — SillyTavern 服务端插件
 *
 * 自动/手动清理 `data` 目录里的「没用数据」和「多余数据」：
 *   同步冲突副本 / 同步临时残留 / 系统垃圾文件 / 空目录 / 过量旧备份 / 孤儿缩略图 / 空文件 / 重复文件去重
 *
 * 路由（挂载在 /api/plugins/st-data-janitor 下）：
 *   GET  /status        状态 + 配置 + 最近一次报告
 *   GET  /config        读取配置
 *   POST /config        保存配置
 *   POST /scan          开始扫描（后台跑，结果进 /status）
 *   POST /scan/stream   扫描并**流式**回报进度（NDJSON，供前端进度条用）
 *   POST /clean         开始清理  body: { rules?: string[], rels?: string[], dryRun?: boolean, permanent?: boolean }
 *                        permanent=true → **彻底删除**（不进回收站，不可恢复）
 *   POST /clean/stream  清理并流式回报进度（同上；带 rels 则只清勾选的那些）
 *   GET  /trash         回收站批次列表
 *   POST /restore       还原批次  body: { batch }
 *   POST /empty-trash   清空回收站（body 可带 { keepDays }）
 *   GET  /update-check  检查是否有新版本（返回更新内容）
 *   POST /update-apply  一键更新（git pull / tar 覆盖 plugin + extension）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express from 'express';
import { DEFAULT_CONFIG, RULE_LABELS, scan, clean, listTrash, restoreTrash, emptyTrash, autoIntervalMs, autoIntervalText } from './lib/janitor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

// ---- 更新检查 -----
const REPO_SLUG = 'wyndam-c/st-data-janitor';
const RAW = `https://raw.githubusercontent.com/${REPO_SLUG}`;
const CODELOAD = `https://codeload.github.com/${REPO_SLUG}/tar.gz/refs/heads`;
const DIST_BRANCH = { plugin: 'plugin-dist', extension: 'ext-dist' };
const REPO_URL = `https://github.com/${REPO_SLUG}`;

export const info = {
    id: 'st-data-janitor',
    name: 'ST Data Janitor',
    version: '1.6.0',
    description: '自动清理 SillyTavern data 目录中的无用/多余数据（冲突副本、临时残留、垃圾文件、过量备份、角色卡/世界书/预设去重等），删除前先入回收站。',
};

const CONFIG_PATH = path.join(__dirname, 'config.json');

/** 自动探测本机 data 目录：<ST>/plugins/<plugin>/../../data */
function autodetectDataRoot() {
    const guess = path.resolve(__dirname, '../../data');
    return fs.existsSync(guess) ? guess : '';
}

function loadConfig() {
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* 首次运行 */ }
    const cfg = {
        ...DEFAULT_CONFIG,
        ...saved,
        dataRoot: saved.dataRoot || autodetectDataRoot(),
        rules: { ...DEFAULT_CONFIG.rules, ...(saved.rules || {}) },
    };
    for (const key of Object.keys(DEFAULT_CONFIG.rules)) {
        cfg.rules[key] = { ...DEFAULT_CONFIG.rules[key], ...(saved.rules?.[key] || {}) };
    }
    return cfg;
}

function saveConfig(patch) {
    const cur = loadConfig();
    const next = {
        ...cur,
        ...patch,
        rules: { ...cur.rules, ...(patch.rules || {}) },
    };
    for (const key of Object.keys(cur.rules)) {
        if (patch.rules?.[key]) next.rules[key] = { ...cur.rules[key], ...patch.rules[key] };
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    return next;
}

// ---- 后台任务状态（单任务） ----
const job = { running: false, kind: null, startedAt: null, finishedAt: null, lastReport: null, error: null };
let autoTimer = null;
let lastAutoRunAt = null;

// ---- 彻底删除的“先试运行”闸门（内存态，重启即清）----
const DRY_RUN_TTL = 15 * 60 * 1000;
let lastDryRun = null;   // { key, at, count, bytes }
const DRY_RUN_REQUIRED = '彻底删除前必须先试运行一次（先看清会删什么）。请在面板里重新操作，或先调用 POST /clean { dryRun: true }。';

function permKey(body) {
    const rels = Array.isArray(body?.rels) && body.rels.length ? [...body.rels].map(String).sort() : null;
    const rules = Array.isArray(body?.rules) && body.rules.length ? [...body.rules].map(String).sort() : null;
    return JSON.stringify({ rels, rules });
}
function dryRunOk(body) {
    return !!(lastDryRun && lastDryRun.key === permKey(body) && (Date.now() - lastDryRun.at) < DRY_RUN_TTL);
}
function noteDryRun(body, rep) {
    const by = Object.values(rep?.byRule || {});
    lastDryRun = {
        key: permKey(body), at: Date.now(),
        count: by.reduce((a, r) => a + (r.count || 0), 0),
        bytes: by.reduce((a, r) => a + (r.bytes || 0), 0),
    };
}

function runJob(kind, fn) {
    if (job.running) throw new Error(`已有任务在跑（${job.kind}），请稍候`);
    job.running = true; job.kind = kind; job.startedAt = new Date().toISOString(); job.error = null; job.finishedAt = null;
    setImmediate(() => {
        try {
            job.lastReport = { kind, at: job.startedAt, ...fn() };
        } catch (e) {
            job.error = String(e?.message || e);
        } finally {
            job.running = false; job.finishedAt = new Date().toISOString();
        }
    });
}

/**
 * 跑一个任务并把进度**流式**写回前端（NDJSON：每行一个 JSON 事件）。
 * 事件：{type:'start'} → {type:'progress',phase,...}* → {type:'result'} → {type:'done'}
 * 出错时：{type:'error'}。任务结束后把报告存进 job.lastReport（/status 也能看到）。
 */
function streamJob(res, kind, makeFn) {
    if (job.running) {
        res.status(409).json({ ok: false, error: `已有任务在跑（${job.kind}），请稍候` });
        return;
    }
    job.running = true; job.kind = kind; job.startedAt = new Date().toISOString(); job.error = null; job.finishedAt = null;

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');   // 告诉 nginx 别缓冲
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let aborted = false;
    res.on('close', () => { aborted = true; });
    const send = (obj) => {
        if (aborted) return;
        try {
            res.write(JSON.stringify(obj) + '\n');
            if (typeof res.flush === 'function') res.flush();   // 绕过 compression 缓冲
        } catch { /* 连接断了就算了 */ }
    };

    send({ type: 'start', kind, at: job.startedAt });
    setImmediate(() => {
        try {
            const report = makeFn((ev) => send({ type: 'progress', ...ev }));
            job.lastReport = { kind, at: job.startedAt, ...report };
            send({ type: 'result', report: job.lastReport });
        } catch (e) {
            job.error = String(e?.message || e);
            send({ type: 'error', error: job.error });
        } finally {
            job.running = false; job.finishedAt = new Date().toISOString();
            send({ type: 'done', finishedAt: job.finishedAt });
            try { res.end(); } catch { /* ignore */ }
        }
    });
}

function scheduleAuto(cfg) {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    const ms = autoIntervalMs(cfg);
    if (ms > 0 && cfg.enabled) {
        autoTimer = setInterval(() => {
            if (job.running) return;
            const c = loadConfig();
            lastAutoRunAt = new Date().toISOString();
            try { runJob('auto-clean', () => clean(c, { dryRun: c.autoCleanDryRun !== false })); } catch { /* 忙 */ }
        }, ms);
        if (autoTimer.unref) autoTimer.unref();
    }
}

export async function init(router) {
    router.use(express.json({ limit: '1mb' }));
    scheduleAuto(loadConfig());

    router.get('/status', (_req, res) => {
        const cfg = loadConfig();
        res.json({
            ok: true,
            info,
            running: job.running,
            kind: job.kind,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
            error: job.error,
            lastReport: job.lastReport,
            auto: { mode: cfg.mode, text: autoIntervalText(cfg), intervalMs: autoIntervalMs(cfg), lastRunAt: lastAutoRunAt },
            config: cfg,
            rules: RULE_LABELS,
            trash: safe(() => listTrash(cfg)),
        });
    });

    router.get('/config', (_req, res) => res.json({ ok: true, config: loadConfig() }));

    router.post('/config', (req, res) => {
        try {
            const cfg = saveConfig(req.body || {});
            scheduleAuto(cfg);
            res.json({ ok: true, config: cfg });
        } catch (e) { res.status(400).json({ ok: false, error: String(e?.message || e) }); }
    });

    router.post('/scan', (_req, res) => {
        try {
            const cfg = loadConfig();
            runJob('scan', () => scan(cfg));
            res.json({ ok: true, started: true });
        } catch (e) { res.status(409).json({ ok: false, error: String(e?.message || e) }); }
    });

    // 扫描 + 流式进度（前端弹窗进度条用）
    router.post('/scan/stream', (_req, res) => {
        const cfg = loadConfig();
        streamJob(res, 'scan', (onProgress) => scan(cfg, onProgress));
    });

    router.post('/clean', (req, res) => {
        try {
            const cfg = loadConfig();
            const rules = Array.isArray(req.body?.rules) ? req.body.rules : null;
            const rels = Array.isArray(req.body?.rels) ? req.body.rels.map(String) : null;
            const permanent = req.body?.permanent === true;
            const dryRun = req.body?.dryRun !== false;
            if (permanent && !dryRunOk(req.body)) { res.status(400).json({ ok: false, error: DRY_RUN_REQUIRED }); return; }
            runJob(dryRun ? 'clean-dry-run' : (permanent ? 'clean-permanent' : 'clean'), () => {
                const rep = clean(cfg, { rules, rels, dryRun, permanent });
                if (dryRun) noteDryRun(req.body, rep);
                return rep;
            });
            res.json({ ok: true, started: true, dryRun, permanent, selected: rels ? rels.length : 0 });
        } catch (e) { res.status(409).json({ ok: false, error: String(e?.message || e) }); }
    });

    // 清理 + 流式进度（同上）；body 可带 { rels: [...] } 只清勾选的那些
    router.post('/clean/stream', (req, res) => {
        const cfg = loadConfig();
        const rules = Array.isArray(req.body?.rules) ? req.body.rules : null;
        const rels = Array.isArray(req.body?.rels) ? req.body.rels.map(String) : null;
        const permanent = req.body?.permanent === true;
        const dryRun = req.body?.dryRun !== false;
        if (permanent && !dryRunOk(req.body)) { res.status(400).json({ ok: false, error: DRY_RUN_REQUIRED }); return; }
        streamJob(res, dryRun ? 'clean-dry-run' : (permanent ? 'clean-permanent' : 'clean'), (onProgress) => {
            const rep = clean(cfg, { rules, rels, dryRun, permanent, onProgress });
            if (dryRun) noteDryRun(req.body, rep);
            return rep;
        });
    });

    router.get('/trash', (_req, res) => res.json({ ok: true, trash: safe(() => listTrash(loadConfig())) }));

    // ---- 检查更新 ----
    router.get('/update-check', async (_req, res) => {
        try { res.json(await buildUpdateInfo()); }
        catch (e) { res.json({ ok: false, error: String(e?.message || e) }); }
    });

    // ---- 一键更新（plugin + extension 都拉）----
    router.post('/update-apply', async (_req, res) => {
        try {
            const before = await buildUpdateInfo();
            if (before.latest && !before.hasUpdate) {
                res.json({ ok: true, upToDate: true, current: before.current, latest: before.latest, message: `已经是最新版本 v${before.current}，无需更新` });
                return;
            }
            const plugin = await updateTarget(__dirname, DIST_BRANCH.plugin);
            const extensions = [];
            for (const d of before.extensionDirs) extensions.push(await updateTarget(d, DIST_BRANCH.extension));
            const after = await buildUpdateInfo();
            const pluginChanged = !!(plugin && plugin.changed);
            res.json({
                ok: true,
                plugin, extensions,
                from: before.current, to: after.current,
                pluginChanged,
                restartNeeded: pluginChanged,          // 服务端插件要重启酒馆才生效
                refreshNeeded: true,                   // 前端扩展刷新页面即生效
                message: pluginChanged
                    ? `已更新到 v${after.current}。前端扩展刷新页面即生效；服务端插件需要重启酒馆才生效。`
                    : `已更新到 v${after.current}。刷新页面即生效。`,
            });
        } catch (e) {
            res.json({ ok: false, error: String(e?.message || e) });
        }
    });

    router.post('/restore', (req, res) => {
        try {
            const out = restoreTrash(loadConfig(), String(req.body?.batch || ''));
            res.json({ ok: true, ...out });
        } catch (e) { res.status(400).json({ ok: false, error: String(e?.message || e) }); }
    });

    router.post('/empty-trash', (req, res) => {
        try {
            const keepDays = Number(req.body?.keepDays) || 0;
            res.json({ ok: true, ...emptyTrash(loadConfig(), { keepDays }) });
        } catch (e) { res.status(400).json({ ok: false, error: String(e?.message || e) }); }
    });

    console.log('[st-data-janitor] ready · dataRoot=' + loadConfig().dataRoot + ' · ' + autoIntervalText(loadConfig()));
}

function safe(fn) { try { return fn(); } catch { return []; } }

/* ==================== 更新检查 / 一键更新 ==================== */

async function httpText(url, timeoutMs = 12000) {
    const res = await fetch(url, {
        headers: { 'User-Agent': 'st-data-janitor', 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

/** 依次尝试多个镜像（国内直连 raw.githubusercontent.com 经常超时） */
const SOURCES = [
    (b, f) => `https://raw.githubusercontent.com/${REPO_SLUG}/${b}/${f}`,
    (b, f) => `https://gh-proxy.com/https://raw.githubusercontent.com/${REPO_SLUG}/${b}/${f}`,
    (b, f) => `https://ghfast.top/https://raw.githubusercontent.com/${REPO_SLUG}/${b}/${f}`,
];
/** jsDelivr 稳但缓存最多 12h，所以放在最后、且晚 1.5s 才出手（避免抢跑到过期内容） */
const CACHE_SOURCE = (b, f) => `https://cdn.jsdelivr.net/gh/${REPO_SLUG}@${b}/${f}`;

async function fetchFile(branch, file, timeoutMs = 10000) {
    const jobs = SOURCES.map(mk => httpText(mk(branch, file), timeoutMs));
    jobs.push((async () => { await new Promise(r => setTimeout(r, 1500)); return httpText(CACHE_SOURCE(branch, file), timeoutMs); })());
    try {
        return { text: await Promise.any(jobs) };
    } catch (e) {
        throw (e && e.errors && e.errors[0]) || e;
    }
}

/* ---- git 通道：比 HTTP 镜像更新、更准（取到的就是 git pull 要拿的东西）---- */

async function gitOut(dir, ...args) {
    const r = await run('git', ['-C', dir, '-c', 'http.version=HTTP/1.1', '-c', 'http.postBuffer=524288000', ...args], { timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
    return r.stdout;
}

/** 拉一次远端（失败重试一次，GitHub 直连偶尔 TLS 中断） */
async function gitFetch(dir) {
    let err = null;
    for (let i = 0; i < 2; i++) {
        try { await gitOut(dir, 'fetch', '--quiet', 'origin'); return null; }
        catch (e) { err = e; }
    }
    return String(err?.stderr || err?.message || err).trim().slice(0, 200);
}

async function remoteFromGit() {
    const dir = __dirname;
    if (!fs.existsSync(path.join(dir, '.git'))) return null;
    const error = await gitFetch(dir);
    if (error) return { error };
    const read = async (ref, file) => { try { return await gitOut(dir, 'show', `${ref}:${file}`); } catch { return null; } };
    const pluginSrc = await read(`origin/${DIST_BRANCH.plugin}`, 'index.mjs');
    const extSrc = await read(`origin/${DIST_BRANCH.extension}`, 'manifest.json');
    const changelog = await read('origin/main', 'CHANGELOG.md');
    let extension = null;
    try { extension = JSON.parse(extSrc).version || null; } catch { /* ignore */ }
    return {
        plugin: pluginSrc ? (pluginSrc.match(/version:\s*'([^']+)'/) || [])[1] || null : null,
        extension,
        changelog,
        localCommit: (await gitOut(dir, 'rev-parse', 'HEAD')).trim(),
        remoteCommit: (await gitOut(dir, 'rev-parse', `origin/${DIST_BRANCH.plugin}`)).trim(),
    };
}

/** 从 CHANGELOG 文本里抽出某个版本的小节 */
function extractSection(txt, ver) {
    if (!txt) return '';
    const re = new RegExp(`^##\\s*\\[${String(ver).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][^\\n]*\\n(.*?)(?=^##\\s|$(?![\\s\\S]))`, 'ms');
    const m = txt.match(re);
    return m ? m[1].replace(/\n{3,}/g, '\n\n').trim() : '';
}

function parseVer(v) { return String(v || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0); }
function cmpVer(a, b) {
    const x = parseVer(a), y = parseVer(b);
    for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); }
    return 0;
}

/** 从磁盘读版本（插件自己的 index.mjs / 扩展的 manifest.json） */
function readPluginVersion(dir) {
    try { const m = fs.readFileSync(path.join(dir, 'index.mjs'), 'utf8').match(/version:\s*'([^']+)'/); return m ? m[1] : null; } catch { return null; }
}
function readExtVersion(dir) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version || null; } catch { return null; }
}

/** 找出 data 下所有装了本扩展的用户目录 */
function findExtensionDirs(dataRoot) {
    const out = [];
    if (!dataRoot || !fs.existsSync(dataRoot)) return out;
    const direct = path.join(dataRoot, 'extensions', 'st-data-janitor');
    if (fs.existsSync(direct)) out.push(direct);
    try {
        for (const name of fs.readdirSync(dataRoot)) {
            const p = path.join(dataRoot, name, 'extensions', 'st-data-janitor');
            if (fs.existsSync(p)) out.push(p);
        }
    } catch { /* ignore */ }
    return out;
}

/** 远端最新版本（读 dist 分支的真实内容——这才是 git pull 会拿到的东西） */
async function remoteVersions() {
    const [plug, ext] = await Promise.allSettled([
        fetchFile(DIST_BRANCH.plugin, 'index.mjs').then(r => (r.text.match(/version:\s*'([^']+)'/) || [])[1] || null),
        fetchFile(DIST_BRANCH.extension, 'manifest.json').then(r => JSON.parse(r.text).version || null),
    ]);
    return {
        plugin: plug.status === 'fulfilled' ? plug.value : null,
        extension: ext.status === 'fulfilled' ? ext.value : null,
        errors: [plug, ext].filter(r => r.status === 'rejected').map(r => String(r.reason?.message || r.reason)),
    };
}

/** 取 CHANGELOG 里某个版本的小节（更新弹窗里显示的“更新内容”） */
async function changelogFor(ver, txt = null) {
    try {
        const text = txt || (await fetchFile('main', 'CHANGELOG.md')).text;
        return extractSection(text, ver);
    } catch { return ''; }
}

async function gitPullDir(dir, branch) {
    const head = async () => (await run('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim();
    const before = await head();
    const args = ['-C', dir, '-c', 'http.version=HTTP/1.1', '-c', 'http.postBuffer=524288000'];
    const opts = { timeout: 180000, maxBuffer: 8 * 1024 * 1024 };
    let err = null;
    for (let i = 0; i < 2; i++) {           // GitHub 直连偶尔 TLS 中断，重试一次
        try { await run('git', [...args, 'fetch', '--quiet', 'origin'], opts); err = null; break; }
        catch (e) { err = e; }
    }
    if (err) throw err;
    const tip = (await run('git', [...args, 'rev-parse', `origin/${branch}`], opts)).stdout.trim();
    await run('git', ['-C', dir, 'reset', '--hard', tip], opts);
    const after = await head();
    return { mode: 'git', before, after, changed: before !== after };
}

/** 非 git 安装（拷文件装的）→ 直接下 dist 分支的 tar 包覆盖 */
async function tarOverwriteDir(dir, branch) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stj-upd-'));
    try {
        const tgz = path.join(tmp, 'src.tgz');
        await run('curl', ['-fsSL', `${CODELOAD}/${branch}`, '-o', tgz], { timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
        await run('tar', ['-xzf', tgz, '-C', tmp], { timeout: 120000 });
        const top = fs.readdirSync(tmp).find(n => n !== 'src.tgz');
        if (!top) throw new Error('解压失败');
        fs.cpSync(path.join(tmp, top), dir, { recursive: true, force: true });
        return { mode: 'tar', changed: true };
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

async function updateTarget(dir, branch) {
    if (!fs.existsSync(dir)) return { dir, skipped: '目录不存在' };
    if (fs.existsSync(path.join(dir, '.git'))) return { dir, ...(await gitPullDir(dir, branch)) };
    return { dir, ...(await tarOverwriteDir(dir, branch)) };
}

async function buildUpdateInfo() {
    const cfg = loadConfig();
    const extDirs = findExtensionDirs(cfg.dataRoot);
    const localPlugin = readPluginVersion(__dirname) || info.version;
    const localExt = extDirs.length ? readExtVersion(extDirs[0]) : null;

    // 先试 git（最新最准），不行再退 HTTP 镜像
    const git = await remoteFromGit();
    let latestPlugin = git?.plugin || null;
    let latestExtension = git?.extension || null;
    let changelogText = git?.changelog || null;
    const errors = [];
    if (git?.error) errors.push('git: ' + git.error);
    if (!latestPlugin || !latestExtension) {
        const http = await remoteVersions();
        latestPlugin = latestPlugin || http.plugin;
        latestExtension = latestExtension || http.extension;
        errors.push(...http.errors);
    }

    const latest = [latestPlugin, latestExtension].filter(Boolean).sort((a, b) => cmpVer(b, a))[0] || null;
    const current = [localPlugin, localExt].filter(Boolean).sort((a, b) => cmpVer(b, a))[0] || localPlugin;
    const hasUpdate = !!(latest && cmpVer(latest, current) > 0);
    return {
        ok: true,
        current, latest,
        currentPlugin: localPlugin, currentExtension: localExt,
        latestPlugin, latestExtension,
        hasUpdate,
        git: git ? { mode: 'git', error: git.error || null, localCommit: git.localCommit, remoteCommit: git.remoteCommit } : { mode: 'none' },
        pluginIsGit: fs.existsSync(path.join(__dirname, '.git')),
        extensionDirs: extDirs,
        extensionIsGit: extDirs.map(d => fs.existsSync(path.join(d, '.git'))),
        notes: hasUpdate ? await changelogFor(latest, changelogText) : '',
        repoUrl: REPO_URL,
        releaseUrl: `${REPO_URL}/releases/latest`,
        errors,
        checkedAt: new Date().toISOString(),
    };
}

export function exit() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
}
