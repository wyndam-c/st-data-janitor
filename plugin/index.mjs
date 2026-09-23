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
 *   POST /clean         开始清理  body: { rules?: string[], dryRun?: boolean }
 *   POST /clean/stream  清理并流式回报进度（同上）
 *   GET  /trash         回收站批次列表
 *   POST /restore       还原批次  body: { batch }
 *   POST /empty-trash   清空回收站（body 可带 { keepDays }）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { DEFAULT_CONFIG, RULE_LABELS, scan, clean, listTrash, restoreTrash, emptyTrash, autoIntervalMs, autoIntervalText } from './lib/janitor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const info = {
    id: 'st-data-janitor',
    name: 'ST Data Janitor',
    version: '1.2.0',
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
            const dryRun = req.body?.dryRun !== false;
            runJob(dryRun ? 'clean-dry-run' : 'clean', () => clean(cfg, { rules, dryRun }));
            res.json({ ok: true, started: true, dryRun });
        } catch (e) { res.status(409).json({ ok: false, error: String(e?.message || e) }); }
    });

    // 清理 + 流式进度（同上）
    router.post('/clean/stream', (req, res) => {
        const cfg = loadConfig();
        const rules = Array.isArray(req.body?.rules) ? req.body.rules : null;
        const dryRun = req.body?.dryRun !== false;
        streamJob(res, dryRun ? 'clean-dry-run' : 'clean', (onProgress) => clean(cfg, { rules, dryRun, onProgress }));
    });

    router.get('/trash', (_req, res) => res.json({ ok: true, trash: safe(() => listTrash(loadConfig())) }));

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

export function exit() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
}
