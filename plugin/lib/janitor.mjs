/**
 * ST Data Janitor — 核心逻辑（零第三方依赖，可单独运行）
 *
 * 扫描 / 清理 SillyTavern `data` 目录里的「没用数据」和「多余数据」。
 *
 * 单独跑：
 *   node lib/janitor.mjs --scan  /root/SillyTavern/data
 *   node lib/janitor.mjs --clean /root/SillyTavern/data --dry-run
 *   node lib/janitor.mjs --scan  /root/SillyTavern/data --dupes [--dup-keep 1]
 *
 * 安全设计：
 *   - 默认 **试运行**（dry-run），只报告不动手；
 *   - 真删时一律 **移入回收站** `<data>/.janitor-trash/<批次>/`（同盘 rename，秒级），
 *     并写 manifest.json，可一键还原；
 *   - 硬保护：`_storage/`、`cookie-secret.txt`、`.gitkeep`、回收站自身，永不触碰。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const TRASH_DIR = '.janitor-trash';

/** 进度回调安全包装：进度上报出错绝不能影响扫描本身。 */
function emit(onProgress, ev) {
    if (typeof onProgress !== 'function') return;
    try { onProgress(ev); } catch { /* ignore */ }
}

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
    duplicates: '重复文件去重',
};

/** 去重覆盖的集合。key = 逻辑分组（用于 scope 配置），value = data/<用户>/ 下的目录名。 */
export const DUPLICATE_GROUPS = {
    characters: ['characters'],
    worlds: ['worlds'],
    presets: ['OpenAI Settings', 'KoboldAI Settings', 'NovelAI Settings', 'TextGen Settings', 'instruct', 'context', 'sysprompt', 'reasoning'],
    themes: ['themes'],
    quickreplies: ['QuickReplies'],
};

/** 去重范围的中文名（给 UI/日志用）。 */
export const DUPLICATE_SCOPE_LABELS = {
    characters: '角色卡',
    worlds: '世界书',
    presets: '预设',
    themes: '主题',
    quickreplies: '快捷回复',
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
        // 重复文件去重（角色卡 / 世界书 / 预设 …）。默认关闭：删的是「看起来一样」的副本，请先看试运行报告。
        duplicates: {
            enabled: false,
            keepNewest: 1,        // 每组保留 N 份
            preferBase: true,     // 优先保留文件名「干净」的那份（无 (1)/副本 标记；角色卡则优先文件名=卡名），再按时间取最新
            minSizeKB: 0,         // 小于该体积的文件不判重（0 = 不限；可用来避开空模板类误伤）
            identical: true,      // 判重方式①：文件内容完全相同（sha256）
            nameCopies: true,     // 判重方式②：文件名带副本标记（(1) / 副本 / copy）
            charNames: true,      // 判重方式③：角色卡按「卡内名字」判重
            scope: ['characters', 'worlds', 'presets', 'themes', 'quickreplies'],
        },
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

// ---------------------------------------------------------------- 去重工具

/** 文件内容 sha256（十六进制）。 */
function sha256File(p) {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/**
 * 文件名里的「副本标记」：
 *   xxx (1).json / xxx(2).json / xxx（1）.json / xxx[1].json
 *   xxx - 副本.json / xxx 副本.json / xxx_拷贝1.json / xxx copy.json / xxx Copy 2.json
 * 只认这些明确的标记，**不**动「名字结尾的普通数字」——否则会把
 * 「插入体位1 / 插入体位2」这类正常区分的内容误判成重复。
 */
const COPY_MARKER_RES = [
    /\s*[\(\uff08\[\u3010]\s*\d{1,3}\s*[\)\uff09\]\u3011]\s*$/,   // (1) (2) （1） [1] 【1】
    /\s*[-_]?\s*(?:副本|拷贝|复件)\s*\d{0,3}\s*$/,                  // - 副本 / 副本2
    /\s*[-_ ]\s*copy\s*\d{0,3}\s*$/i,                              // - copy / copy2
];

function stripCopyMarker(stem) {
    let s = stem;
    for (let round = 0; round < 4; round++) {
        let changed = false;
        for (const re of COPY_MARKER_RES) {
            const m = s.match(re);
            if (m) { s = s.slice(0, m.index); changed = true; }
        }
        if (!changed) break;
    }
    return s.trim();
}

/**
 * 从角色卡 PNG 里读出「卡内名字」（v2 的 chara / v3 的 ccv3 tEXt/iTXt 块，base64 JSON）。
 * 这比按文件名判重准：同名的角色卡不管文件叫什么，都能对上。
 * 读不到（非 PNG / 不是卡）返回 null。
 */
export function pngCardName(abs) {
    let buf;
    try { buf = fs.readFileSync(abs); } catch { return null; }
    if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    let off = 8;
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('latin1', off + 4, off + 8);
        const data = buf.subarray(off + 8, off + 8 + len);
        if (type === 'tEXt' || type === 'iTXt') {
            let key = null, val = null;
            const z = data.indexOf(0);
            if (z > 0) {
                key = data.toString('latin1', 0, z);
                if (type === 'tEXt') {
                    val = data.toString('latin1', z + 1);
                } else {
                    // iTXt: <keyword>\0<compflag><compmethod><lang>\0<translated>\0<text>
                    const rest = data.subarray(z + 1);
                    const z2 = rest.indexOf(0, 2);
                    val = rest.subarray(z2 >= 0 ? z2 + 1 : 2).toString('utf8');
                }
            }
            if (val && (key === 'chara' || key === 'ccv3')) {
                try {
                    const j = JSON.parse(Buffer.from(val.trim(), 'base64').toString('utf8'));
                    const n = j?.data?.name || j?.name;
                    if (n && String(n).trim()) return String(n).trim();
                } catch { /* 不是标准卡，跳过 */ }
            }
        }
        off += 12 + len;
        if (type === 'IEND') break;
    }
    return null;
}

/** 从一组候选里挑出「要删的副本」：文件名更“干净”的优先（canonical），再按 mtime 取最新，保留 keep 份。 */
function markDuplicates(list, keep, addTarget) {
    const sorted = [...list].sort((a, b) => {
        const ca = a.canonical === false ? 1 : 0;
        const cb = b.canonical === false ? 1 : 0;
        if (ca !== cb) return ca - cb;
        return b.mtimeMs - a.mtimeMs;
    });
    for (const f of sorted.slice(Math.max(1, keep))) addTarget(f);
}

/**
 * 扫描所选集合里的重复文件。返回 { targets, meta, groups }：
 *   targets：要清掉的副本绝对路径；meta：abs → { rel, size, mtimeMs }；groups：命中明细。
 */
export function collectDuplicates(config, root, userDirs, onProgress) {
    const d = (config?.rules?.duplicates) || DEFAULT_CONFIG.rules.duplicates;
    const keep = Math.max(1, Number(d.keepNewest) || 1);
    const minBytes = Math.max(0, Number(d.minSizeKB) || 0) * 1024;
    const scope = Array.isArray(d.scope) && d.scope.length ? d.scope : Object.keys(DUPLICATE_GROUPS);
    const preferBase = d.preferBase !== false;

    const seen = new Set();       // 已判为副本的绝对路径（同一文件只算一次）
    const meta = new Map();       // abs -> { rel, size, mtimeMs }
    const groups = [];            // { group, dir, reason, files[], drop }

    const relOf = (abs) => path.relative(root, abs).split(path.sep).join('/');
    const addTarget = (f) => { seen.add(f.abs); meta.set(f.abs, { rel: relOf(f.abs), size: f.size, mtimeMs: f.mtimeMs }); };

    // 进度用：先把 (用户 × 集合 × 目录) 的任务清单算出来，好显示 i/N
    const plan = [];
    for (const ud of userDirs) {
        for (const [grp, dirs] of Object.entries(DUPLICATE_GROUPS)) {
            if (!scope.includes(grp)) continue;
            for (const dn of dirs) plan.push({ grp, dn });
        }
    }
    let taskIdx = 0;

    for (const ud of userDirs) {
        for (const [grp, dirs] of Object.entries(DUPLICATE_GROUPS)) {
            if (!scope.includes(grp)) continue;
            for (const dn of dirs) {
                taskIdx++;
                emit(onProgress, { phase: 'dup', group: grp, dir: dn, done: taskIdx, total: plan.length });
                const dir = path.join(ud, dn);
                let ents;
                try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
                const files = [];
                for (const e of ents) {
                    if (!e.isFile()) continue;
                    if (isProtectedName(e.name) || isConflictCopy(e.name)) continue;  // 冲突副本交给专门规则
                    const abs = path.join(dir, e.name);
                    const st = statSafe(abs);
                    if (!st || st.size < minBytes) continue;
                    files.push({ abs, name: e.name, stem: e.name.replace(/\.[^.]+$/, ''), size: st.size, mtimeMs: st.mtimeMs });
                }
                if (files.length < 2) continue;

                // ① 内容完全相同：先按体积分桶，只有同体积的才去算哈希（省一大截 IO）
                if (d.identical !== false) {
                    const bySize = new Map();
                    for (const f of files) {
                        if (!bySize.has(f.size)) bySize.set(f.size, []);
                        bySize.get(f.size).push(f);
                    }
                    const hashTotal = [...bySize.values()].filter(b => b.length >= 2).reduce((s, b) => s + b.length, 0);
                    let hashDone = 0;
                    for (const bucket of bySize.values()) {
                        if (bucket.length < 2) continue;
                        const byHash = new Map();
                        for (const f of bucket) {
                            hashDone++;
                            if (hashDone % 20 === 0 || hashDone === hashTotal) {
                                emit(onProgress, { phase: 'dup-hash', done: hashDone, total: hashTotal });
                            }
                            let h = null; try { h = sha256File(f.abs); } catch { /* 跳过读不了的文件 */ }
                            if (!h) continue;
                            if (!byHash.has(h)) byHash.set(h, []);
                            byHash.get(h).push(f);
                        }
                        for (const g of byHash.values()) {
                            if (g.length < 2) continue;
                            const before = seen.size;
                            const g2 = preferBase ? g.map(x => ({ ...x, canonical: stripCopyMarker(x.stem) === x.stem })) : g;
                            markDuplicates(g2, keep, addTarget);
                            if (seen.size > before) groups.push({ group: grp, dir: dn, reason: '内容相同', files: g.map(x => x.name), drop: g.length - keep });
                        }
                    }
                }

                // ② 同名副本（文件名带 (1)/副本/copy 之类）
                if (d.nameCopies !== false) {
                    const byKey = new Map();
                    for (const f of files) {
                        const key = stripCopyMarker(f.stem);
                        if (!byKey.has(key)) byKey.set(key, []);
                        byKey.get(key).push({ ...f, marked: key !== f.stem });
                    }
                    for (const list of byKey.values()) {
                        if (list.length < 2 || !list.some(x => x.marked)) continue;
                        const before = seen.size;
                        const list2 = preferBase ? list.map(x => ({ ...x, canonical: !x.marked })) : list;
                        markDuplicates(list2, keep, addTarget);
                        if (seen.size > before) groups.push({ group: grp, dir: dn, reason: '同名副本', files: list.map(x => x.name), drop: list.length - keep });
                    }
                }

                // ③ 角色卡按「卡内名字」判重（仅角色卡集合）
                if (grp === 'characters' && d.charNames !== false) {
                    const byName = new Map();
                    for (const f of files) {
                        if (!/\.png$/i.test(f.name)) continue;
                        const n = pngCardName(f.abs);
                        if (!n) continue;
                        if (!byName.has(n)) byName.set(n, []);
                        byName.get(n).push(f);
                    }
                    for (const [cardName, list] of byName) {
                        if (list.length < 2) continue;
                        const before = seen.size;
                        const list2 = preferBase ? list.map(x => ({ ...x, canonical: x.stem === cardName })) : list;
                        markDuplicates(list2, keep, addTarget);
                        if (seen.size > before) groups.push({ group: grp, dir: dn, reason: `角色卡同名「${cardName}」`, files: list.map(x => x.name), drop: list.length - keep });
                    }
                }
            }
        }
    }

    // 角色卡去重 → 顺带清掉它对应的缩略图（否则会变成孤儿缩略图）
    for (const abs of [...seen]) {
        if (path.basename(path.dirname(abs)) !== 'characters') continue;
        const ud = path.dirname(path.dirname(abs));
        const thumb = path.join(ud, 'thumbnails', 'avatar', path.basename(abs));
        if (!fs.existsSync(thumb)) continue;
        const st = statSafe(thumb);
        seen.add(thumb);
        meta.set(thumb, { rel: relOf(thumb), size: st ? st.size : 0, mtimeMs: st ? st.mtimeMs : 0 });
    }

    return { targets: [...seen], meta, groups };
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
export function collectTargets(config, root, onProgress) {
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
    let scanned = 0;
    walk(root,
        (abs, rel, ent) => {
            scanned++;
            if (scanned % 300 === 0) emit(onProgress, { phase: 'walk', scanned });
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
    emit(onProgress, { phase: 'rule', id: 'treeScan', label: '遍历目录', i: 1, total: 4 });

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
        emit(onProgress, { phase: 'rule', id: 'oldBackups', label: '过量旧备份', i: 2, total: 4 });
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
        emit(onProgress, { phase: 'rule', id: 'orphanThumbs', label: '孤儿缩略图', i: 3, total: 4 });
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

    // 重复文件去重：角色卡 / 世界书 / 预设 等同内容或同名的副本
    if (rules.duplicates?.enabled) {
        emit(onProgress, { phase: 'rule', id: 'duplicates', label: '重复文件去重', i: 4, total: 4 });
        const { targets, meta } = collectDuplicates(cfg, root, userDirs, onProgress);
        // 已经会被别的规则收拾的文件不再重复计入，避免清理时重复搬运
        const handled = new Set();
        for (const id of Object.keys(RULE_LABELS)) {
            if (id === 'duplicates') continue;
            for (const it of out[id] || []) handled.add(it.abs);
        }
        for (const abs of targets) {
            if (handled.has(abs)) continue;
            const m = meta.get(abs) || { rel: path.relative(root, abs).split(path.sep).join('/'), size: 0, mtimeMs: 0 };
            out.duplicates.push({ abs, rel: m.rel, size: m.size, mtimeMs: m.mtimeMs });
        }
    }

    return out;
}

// ---------------------------------------------------------------- 扫描 / 清理

export function scan(config, onProgress, { cap = 500 } = {}) {
    const root = resolveRoot(config);
    const targets = collectTargets(config, root, onProgress);
    const report = { dataRoot: root, generatedAt: new Date().toISOString(), rules: {}, total: { count: 0, bytes: 0 } };
    for (const [id, items] of Object.entries(targets)) {
        const bytes = items.reduce((s, it) => s + (it.size || 0), 0);
        const isDir = id === 'emptyDirs';
        report.rules[id] = {
            id,
            label: RULE_LABELS[id],
            enabled: !!config?.rules?.[id]?.enabled,
            count: items.length,
            bytes,
            truncated: items.length > cap,
            items: items.slice(0, cap).map(it => describeItem(it.rel, it.size, isDir, it.mtimeMs)),
        };
        if (report.rules[id].enabled) {
            report.total.count += items.length;
            report.total.bytes += bytes;
        }
    }
    return report;
}

/** 给前端「预览」用的条目描述：拆成 名字 / 目录 / 格式，便于显示 名称·大小·格式 */
function describeItem(rel, size, isDir, mtimeMs) {
    const parts = String(rel).split('/');
    const name = parts.pop() || String(rel);
    const dir = parts.join('/');
    let type = '目录';
    if (!isDir) {
        const m = name.match(/\.([^./]+)$/);
        type = m ? m[1].toLowerCase() : '无扩展名';
    }
    return { rel, name, dir, type, size: size || 0, mtimeMs: mtimeMs || 0 };
}

export function clean(config, { rules, dryRun = true, onlyEnabled = true, onProgress, rels, permanent = false } = {}) {
    const root = resolveRoot(config);
    const targets = collectTargets(config, root, onProgress);
    const wanted = Array.isArray(rels) && rels.length ? new Set(rels.map(String)) : null;
    const picked = {};
    const notFound = [];
    for (const [id, items] of Object.entries(targets)) {
        // 选中模式：只挑用户勾中的那些（且必须真是本次扫出来的目标，防越权乱删）
        const list = wanted ? items.filter(it => wanted.has(it.rel)) : items;
        if (!list.length) continue;
        if (!wanted) {
            const enabled = onlyEnabled ? !!config?.rules?.[id]?.enabled : true;
            const ok = !rules || rules.length === 0 ? enabled : rules.includes(id);
            if (!ok) continue;
        }
        picked[id] = list;
    }
    if (wanted) {
        const hit = new Set(Object.values(picked).flat().map(it => it.rel));
        for (const r of wanted) if (!hit.has(r)) notFound.push(r);
    }

    const result = { dataRoot: root, dryRun, permanent: !!permanent, batch: null, byRule: {}, moved: 0, deleted: 0, bytes: 0, failed: [], notFound: notFound.slice(0, 50), notFoundCount: notFound.length };
    for (const [id, items] of Object.entries(picked)) {
        result.byRule[id] = { label: RULE_LABELS[id], count: items.length, bytes: items.reduce((s, it) => s + (it.size || 0), 0) };
    }
    if (dryRun) return result;

    const moveTotal = Object.entries(picked).filter(([id]) => id !== 'emptyDirs').reduce((s, [, items]) => s + items.length, 0);
    let moveDone = 0;

    // ---- 彻底删除（不进回收站，不可恢复）----
    if (permanent) {
        for (const [id, items] of Object.entries(picked)) {
            for (const it of items) {
                moveDone++;
                if (moveDone % 20 === 0 || moveDone === moveTotal) emit(onProgress, { phase: 'move', done: moveDone, total: moveTotal });
                try {
                    if (id === 'emptyDirs') fs.rmdirSync(it.abs);          // 只删空目录，非空会报错
                    else fs.unlinkSync(it.abs);
                    result.deleted++; result.bytes += it.size || 0;
                } catch (e) {
                    result.failed.push({ rel: it.rel, error: String(e.message || e) });
                }
            }
        }
        purgeTrash(config, { keepDays: Number(config?.trashKeepDays) || 7 });
        return result;
    }

    const batchId = new Date().toISOString().replace(/[:.]/g, '-');
    const batchDir = path.join(trashRoot(root), batchId);
    const manifest = { batchId, createdAt: new Date().toISOString(), dataRoot: root, entries: [] };
    for (const [id, items] of Object.entries(picked)) {
        if (id === 'emptyDirs') continue;   // 空目录不搬运，直接 rmdir
        for (const it of items) {
            moveDone++;
            if (moveDone % 20 === 0 || moveDone === moveTotal) emit(onProgress, { phase: 'move', done: moveDone, total: moveTotal });
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
    cfg.rules.duplicates.enabled = args.includes('--dupes');
    if (cfg.rules.duplicates.enabled) cfg.rules.duplicates.keepNewest = Number(args[args.indexOf('--dup-keep') + 1] || 1);
    try {
        const res = mode === 'scan' ? scan(cfg) : clean(cfg, { dryRun });
        console.log(JSON.stringify(res, null, 2));
    } catch (e) {
        console.error('ERROR:', e.message);
        process.exit(1);
    }
}
