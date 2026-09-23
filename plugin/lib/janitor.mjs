/**
 * ST Data Janitor — 核心逻辑（零第三方依赖，可单独运行）
 *
 * 扫描 / 清理 SillyTavern `data` 目录里的「没用数据」和「多余数据」。
 *
 * 单独跑：
 *   node lib/janitor.mjs --scan  /root/SillyTavern/data
 *   node lib/janitor.mjs --clean /root/SillyTavern/data --dry-run
 *
 * 安全设计：
 *   - 默认 **试运行**（dry-run），只报告不动手；
 *   - 真删时一律 **移入回收站** `<data>/.janitor-trash/<批次>/`（同盘 rename，秒级），
 *     并写 manifest.json，可一键还原；
 *   - 硬保护：`_storage/`、`cookie-secret.txt`、`.gitkeep`、回收站自身，永不触碰。
 */

import fs from 'node:fs';
import path from 'node:path';

export const TRASH_DIR = '.janitor-trash';

/** 回收站放在 data 的**同级**目录（不能放 data 里，否则会被云同步带走） */
export function trashRoot(dataRoot) {
    return path.join(path.dirname(path.resolve(dataRoot)), TRASH_DIR);
}

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', TRASH_DIR]);
const HARD_PROTECT_NAMES = new Set(['cookie-secret.txt', '.gitkeep']);
const HARD_PROTECT_DIRS = new Set(['_storage']);

export const RULE_LABELS = {
    conflictCopies: '同步冲突副本',
    unisonTemp: '同步临时残留',
    junkFiles: '系统垃圾文件',
    emptyDirs: '空目录',
    oldBackups: '过量旧备份',
    orphanThumbs: '孤儿缩略图',
    zeroByteFiles: '空文件',
};

export const DEFAULT_CONFIG = {
    enabled: true,
    dataRoot: '',              // 空 = 交给插件自动探测
    mode: 'manual',            // manual | auto —— 手动 / 自动
    intervalValue: 1,          // 自动清理间隔数值
    intervalUnit: 'hours',     // minutes | hours | days
    autoCleanDryRun: true,     // 自动模式下默认只报告、不真删
    trashKeepDays: 7,          // 回收站保留天数，超期可清空
    rules: {
        // 同一次同步冲突会生成多份，保留最新的 N 份（0 = 全清）
        conflictCopies: { enabled: true, rule: 'conflictCopies', keepNewest: 0 },
        unisonTemp: { enabled: true },
        junkFiles: { enabled: true },
        emptyDirs: { enabled: false },
        oldBackups: { enabled: false, keepNewest: 10 },
        orphanThumbs: { enabled: false },
        zeroByteFiles: { enabled: false, minAgeHours: 24 },
    },
};

// ---------------------------------------------------------------- 工具

function isProtectedName(name) {
    return HARD_PROTECT_NAMES.has(name);
}

function isProtectedDir(rel) {
    return rel.split('/').some(p => HARD_PROTECT_DIRS.has(p));
}

/** 递归遍历 data 根，回调 (absPath, relPath, dirent, depth)。 */
function walk(root, onFile, onDir) {
    const stack = [['', 0]];
    while (stack.length) {
        const [rel, depth] = stack.pop();
        const abs = rel ? path.join(root, rel) : root;
        let entries;
        try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
        for (const ent of entries) {
            const childRel = rel ? `${rel}/${ent.name}` : ent.name;
            if (ent.isDirectory()) {
                if (SKIP_DIR_NAMES.has(ent.name)) continue;
                if (isProtectedDir(childRel)) continue;
                if (onDir) onDir(path.join(root, childRel), childRel, ent, depth + 1);
                stack.push([childRel, depth + 1]);
            } else if (ent.isFile()) {
                if (isProtectedName(ent.name)) continue;
                onFile(path.join(root, childRel), childRel, ent, depth + 1);
            }
        }
    }
}

function statSafe(p) {
    try { return fs.statSync(p, { throwIfNoEntry: false }); } catch { return null; }
}

// ---------------------------------------------------------------- 规则

function isConflictCopy(name) {
    return /\(conflict\s*(?:#\d+)?_on_\d{4}-\d{2}-\d{2}\)/i.test(name);
}

function isUnisonTemp(name) {
    return /^\.unison\./i.test(name) || /\.unison\.tmp$/i.test(name);
}

function isJunkFile(name) {
    if (name === '.DS_Store' || name === 'Thumbs.db' || name === 'desktop.ini' || name === 'ehthumbs.db') return true;
    if (name.startsWith('.#')) return true;
    if (name.length > 2 && name.startsWith('#') && name.endsWith('#')) return true;
    if (name.endsWith('~')) return true;
    return /\.(swp|swo|tmp|crdownload|part|orig|rej)$/i.test(name);
}

/** 收集每个规则命中的目标。返回 { [ruleId]: items[] }，item = {abs, rel, size} */
export function collectTargets(config, root) {
    const cfg = config || DEFAULT_CONFIG;
    const rules = cfg.rules || {};
    const out = {};
    for (const id of Object.keys(RULE_LABELS)) out[id] = [];
    const now = Date.now();

    const userDirs = [];
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
        if (ent.isDirectory() && !SKIP_DIR_NAMES.has(ent.name)) userDirs.push(path.join(root, ent.name));
    }

    const push = (id, abs, rel) => {
        const st = statSafe(abs);
        const size = st && st.isFile() ? st.size : 0;   // 目录不计体积
        out[id].push({ abs, rel, size, mtimeMs: st ? st.mtimeMs : 0 });
    };

    // 全树规则
    walk(root,
        (abs, rel, ent) => {
            if (rules.conflictCopies?.enabled && isConflictCopy(ent.name)) push('conflictCopies', abs, rel);
            else if (rules.unisonTemp?.enabled && isUnisonTemp(ent.name)) push('unisonTemp', abs, rel);
            else if (rules.junkFiles?.enabled && isJunkFile(ent.name)) push('junkFiles', abs, rel);
            else if (rules.zeroByteFiles?.enabled) {
                const st = statSafe(abs);
                if (st && st.size === 0 && (now - st.mtimeMs) > (rules.zeroByteFiles.minAgeHours ?? 24) * 3600e3) {
                    push('zeroByteFiles', abs, rel);
                }
            }
        },
        (abs, rel, ent) => {
            if (rules.emptyDirs?.enabled) {
                try { if (fs.readdirSync(abs).length === 0) push('emptyDirs', abs, rel); } catch { /* ignore */ }
            }
        },
    );

    // 冲突副本保留 N 份：按文件名分组（去掉冲突标记），保留 mtime 最新
    if (rules.conflictCopies?.enabled) {
        const keep = Number(rules.conflictCopies.keepNewest) || 0;
        if (keep > 0) {
            const groups = new Map();
            for (const it of out.conflictCopies) {
                const key = it.abs.replace(/\s*\(conflict\s*(?:#\d+)?_on_\d{4}-\d{2}-\d{2}\)/gi, '');
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(it);
            }
            const keepSet = new Set();
            for (const list of groups.values()) {
                list.sort((a, b) => b.mtimeMs - a.mtimeMs);
                for (const it of list.slice(0, keep)) keepSet.add(it.abs);
            }
            out.conflictCopies = out.conflictCopies.filter(it => !keepSet.has(it.abs));
        }
    }

    // 每个用户的 backups/：**按聊天分组**，每组只保留最新 N 个
    if (rules.oldBackups?.enabled) {
        const keep = Number(rules.oldBackups.keepNewest) || 0;
        for (const ud of userDirs) {
            const bdir = path.join(ud, 'backups');
            let ents;
            try { ents = fs.readdirSync(bdir, { withFileTypes: true }); } catch { continue; }
            const groups = new Map();
            for (const e of ents) {
                const abs = path.join(bdir, e.name);
                const st = statSafe(abs);
                // 备份名形如 chat___1_ab12cd_20260924-015434.jsonl —— 去掉尾部时间戳做分组键
                const key = e.name.replace(/_\d{8}-\d{6}(?=\.[^.]+$|$)/, '');
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push({ abs, name: e.name, size: st && st.isFile() ? st.size : 0, mtimeMs: st ? st.mtimeMs : 0 });
            }
            for (const list of groups.values()) {
                list.sort((a, b) => b.mtimeMs - a.mtimeMs);
                for (const it of list.slice(keep)) {
                    push('oldBackups', it.abs, path.relative(root, it.abs).split(path.sep).join('/'));
                }
            }
        }
    }

    // 孤儿缩略图：thumbnails/ 下没有对应 characters/ 文件的
    if (rules.orphanThumbs?.enabled) {
        for (const ud of userDirs) {
            const tdir = path.join(ud, 'thumbnails');
            const cdir = path.join(ud, 'characters');
            let tents;
            try { tents = fs.readdirSync(tdir); } catch { continue; }
            let cset;
            try { cset = new Set(fs.readdirSync(cdir)); } catch { cset = new Set(); }
            for (const name of tents) {
                if (cset.has(name)) continue;
                // 角色头像以 <卡名>.png / .jpg 存；缩略图同名
                const stem = name.replace(/\.[^.]+$/, '');
                const hit = [...cset].some(c => c.replace(/\.[^.]+$/, '') === stem);
                if (!hit) push('orphanThumbs', path.join(tdir, name), path.relative(root, path.join(tdir, name)).split(path.sep).join('/'));
            }
        }
    }

    return out;
}

// ---------------------------------------------------------------- 扫描 / 清理

export function scan(config) {
    const root = resolveRoot(config);
    const targets = collectTargets(config, root);
    const cap = 200;
    const report = { dataRoot: root, generatedAt: new Date().toISOString(), rules: {}, total: { count: 0, bytes: 0 } };
    for (const [id, items] of Object.entries(targets)) {
        const bytes = items.reduce((s, it) => s + (it.size || 0), 0);
        report.rules[id] = {
            id,
            label: RULE_LABELS[id],
            enabled: !!config?.rules?.[id]?.enabled,
            count: items.length,
            bytes,
            truncated: items.length > cap,
            items: items.slice(0, cap).map(it => ({ rel: it.rel, size: it.size })),
        };
        if (report.rules[id].enabled) {
            report.total.count += items.length;
            report.total.bytes += bytes;
        }
    }
    return report;
}

export function clean(config, { rules, dryRun = true, onlyEnabled = true } = {}) {
    const root = resolveRoot(config);
    const targets = collectTargets(config, root);
    const picked = {};
    for (const [id, items] of Object.entries(targets)) {
        const enabled = onlyEnabled ? !!config?.rules?.[id]?.enabled : true;
        const wanted = !rules || rules.length === 0 ? enabled : rules.includes(id);
        if (wanted) picked[id] = items;
    }

    const result = { dataRoot: root, dryRun, batch: null, byRule: {}, moved: 0, bytes: 0, failed: [] };
    for (const [id, items] of Object.entries(picked)) {
        result.byRule[id] = { label: RULE_LABELS[id], count: items.length, bytes: items.reduce((s, it) => s + (it.size || 0), 0) };
    }
    if (dryRun) return result;

    const batchId = new Date().toISOString().replace(/[:.]/g, '-');
    const batchDir = path.join(trashRoot(root), batchId);
    const manifest = { batchId, createdAt: new Date().toISOString(), dataRoot: root, entries: [] };

    for (const [id, items] of Object.entries(picked)) {
        if (id === 'emptyDirs') continue;   // 空目录不搬运，直接 rmdir
        for (const it of items) {
            const dest = path.join(batchDir, 'files', it.rel);
            try {
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.renameSync(it.abs, dest);
                manifest.entries.push({ rule: id, rel: it.rel, size: it.size || 0, type: 'file' });
                result.moved++;
                result.bytes += it.size || 0;
            } catch (e) {
                result.failed.push({ rel: it.rel, error: String(e.message || e) });
            }
        }
    }

    // 空目录单独处理（直接删，无内容可还原）
    if (picked.emptyDirs?.length) {
        const sorted = [...picked.emptyDirs].sort((a, b) => b.rel.length - a.rel.length);
        for (const it of sorted) {
            try { fs.rmdirSync(it.abs); manifest.entries.push({ rule: 'emptyDirs', rel: it.rel, type: 'dir' }); result.moved++; }
            catch (e) { result.failed.push({ rel: it.rel, error: String(e.message || e) }); }
        }
    }

    if (manifest.entries.length) {
        fs.mkdirSync(batchDir, { recursive: true });
        fs.writeFileSync(path.join(batchDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
        result.batch = batchId;
    }
    purgeTrash(config, { keepDays: Number(config?.trashKeepDays) || 7 });
    return result;
}

export function listTrash(config) {
    const root = resolveRoot(config);
    const tdir = trashRoot(root);
    let ents;
    try { ents = fs.readdirSync(tdir, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const e of ents) {
        if (!e.isDirectory()) continue;
        const mp = path.join(tdir, e.name, 'manifest.json');
        let size = 0, count = 0;
        const m = statSafe(mp);
        if (m) { try { const j = JSON.parse(fs.readFileSync(mp, 'utf8')); count = j.entries?.length || 0; size = (j.entries || []).reduce((s, x) => s + (x.size || 0), 0); } catch { /* ignore */ } }
        out.push({ batch: e.name, count, size, createdAt: m ? m.mtime.toISOString() : null });
    }
    return out.sort((a, b) => (b.batch > a.batch ? 1 : -1));
}

export function restoreTrash(config, batch) {
    const root = resolveRoot(config);
    const batchDir = path.join(trashRoot(root), batch);
    const mp = path.join(batchDir, 'manifest.json');
    if (!fs.existsSync(mp)) throw new Error(`批次不存在: ${batch}`);
    const manifest = JSON.parse(fs.readFileSync(mp, 'utf8'));
    let restored = 0;
    const failed = [];
    for (const ent of manifest.entries || []) {
        if (ent.type === 'dir') continue;
        const src = path.join(batchDir, 'files', ent.rel);
        const dst = path.join(root, ent.rel);
        try {
            if (fs.existsSync(dst)) { failed.push({ rel: ent.rel, error: '目标已存在，跳过' }); continue; }
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.renameSync(src, dst);
            restored++;
        } catch (e) { failed.push({ rel: ent.rel, error: String(e.message || e) }); }
    }
    return { batch, restored, failed };
}

export function emptyTrash(config, { keepDays = 0 } = {}) {
    const root = resolveRoot(config);
    const tdir = trashRoot(root);
    let freed = 0, removed = 0;
    for (const b of listTrash(config)) {
        const ageDays = (Date.now() - new Date(b.createdAt || 0).getTime()) / 86400e3;
        if (keepDays > 0 && ageDays < keepDays) continue;
        try { fs.rmSync(path.join(tdir, b.batch), { recursive: true, force: true }); freed += b.size; removed++; } catch { /* ignore */ }
    }
    return { removed, freed };
}

function purgeTrash(config, { keepDays }) {
    if (!(keepDays > 0)) return { removed: 0, freed: 0 };
    try { return emptyTrash(config, { keepDays }); } catch { return { removed: 0, freed: 0 }; }
}

export function resolveRoot(config) {
    const root = config?.dataRoot;
    if (!root) throw new Error('未配置 dataRoot');
    const abs = path.resolve(root);
    if (!fs.existsSync(abs)) throw new Error(`dataRoot 不存在: ${abs}`);
    return abs;
}

// ---------------------------------------------------------------- 自动间隔

/** 自动模式下的间隔毫秒数；手动模式返回 0。 */
export function autoIntervalMs(cfg) {
    if (!cfg || cfg.mode !== 'auto') return 0;
    const v = Math.max(1, Number(cfg.intervalValue) || 1);
    const mult = cfg.intervalUnit === 'minutes' ? 60_000
        : cfg.intervalUnit === 'days' ? 86_400_000
            : 3_600_000;                    // 默认按小时
    return v * mult;
}

/** 人话描述间隔，给 UI/日志用。 */
export function autoIntervalText(cfg) {
    if (!cfg || cfg.mode !== 'auto') return '手动';
    const v = Math.max(1, Number(cfg.intervalValue) || 1);
    const unit = cfg.intervalUnit === 'minutes' ? '分钟' : cfg.intervalUnit === 'days' ? '天' : '小时';
    return `每 ${v} ${unit}`;
}

// ---------------------------------------------------------------- CLI

const invokedDirectly = (() => {
    try { return process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href; } catch { return false; }
})();

if (invokedDirectly) {
    const args = process.argv.slice(2);
    const mode = args.includes('--clean') ? 'clean' : 'scan';
    const root = args.find(a => !a.startsWith('--') && a !== mode) || '/root/SillyTavern/data';
    const dryRun = !args.includes('--apply');
    const cfg = { ...DEFAULT_CONFIG, dataRoot: root, rules: JSON.parse(JSON.stringify(DEFAULT_CONFIG.rules)) };
    // CLI 默认把「安全规则」全开，便于看效果
    cfg.rules.conflictCopies.enabled = true;
    cfg.rules.unisonTemp.enabled = true;
    cfg.rules.junkFiles.enabled = true;
    cfg.rules.emptyDirs.enabled = args.includes('--empty-dirs');
    cfg.rules.oldBackups.enabled = args.includes('--old-backups');
    if (cfg.rules.oldBackups.enabled) cfg.rules.oldBackups.keepNewest = Number(args[args.indexOf('--keep') + 1] || 30);
    try {
        const res = mode === 'scan' ? scan(cfg) : clean(cfg, { dryRun });
        console.log(JSON.stringify(res, null, 2));
    } catch (e) {
        console.error('ERROR:', e.message);
        process.exit(1);
    }
}
