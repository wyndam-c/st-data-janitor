/**
 * 数据清洁工 (Data Janitor) — SillyTavern 前端扩展
 * UI 壳：扫描 / 清理 / 回收站全靠服务端插件 /api/plugins/st-data-janitor
 */
(function () {
    'use strict';

    const MODULE = 'st-data-janitor';
    const API = `/api/plugins/${MODULE}`;
    let pollTimer = null;

    const RULES = [
        { id: 'conflictCopies', label: '同步冲突副本', hint: '“xxx (conflict_on_日期)”这类同步残留' },
        { id: 'unisonTemp', label: '同步临时残留', hint: '.unison.*.unison.tmp' },
        { id: 'junkFiles', label: '系统垃圾文件', hint: '.DS_Store / Thumbs.db / *~ / *.swp 等' },
        { id: 'emptyDirs', label: '空目录', hint: '没有任何内容的目录' },
        { id: 'oldBackups', label: '过量旧备份', keep: true, hint: '每个聊天的 backups/ 只留最新 N 份' },
        { id: 'orphanThumbs', label: '孤儿缩略图', hint: 'thumbnails/ 里没有对应角色卡的' },
        { id: 'zeroByteFiles', label: '空文件', age: true, hint: '0 字节且已存在 N 小时以上' },
        { id: 'duplicates', label: '重复文件去重', dup: true, hint: '角色卡 / 世界书 / 预设 等同内容或同名的副本' },
    ];

    const DUP_SCOPES = [
        { id: 'characters', label: '角色卡' },
        { id: 'worlds', label: '世界书' },
        { id: 'presets', label: '预设' },
        { id: 'themes', label: '主题' },
        { id: 'quickreplies', label: '快捷回复' },
    ];

    const getCtx = () => SillyTavern.getContext();
    const $el = (id) => document.getElementById(id);

    async function api(p, { method = 'GET', body } = {}) {
        const headers = getCtx().getRequestHeaders();
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetch(`${API}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { raw: text }; }
        if (!res.ok) {
            const err = new Error(data.error || `${res.status}: ${text.slice(0, 200)}`);
            err.status = res.status;
            throw err;
        }
        return data;
    }

    const fmtBytes = (n) => {
        n = Number(n) || 0;
        if (n < 1024) return `${n} B`;
        if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
        if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
        return `${(n / 1073741824).toFixed(2)} GB`;
    };

    function setStatus(text, cls) {
        const el = $el('stj_status');
        if (el) { el.textContent = text; el.className = 'stj-status ' + (cls || ''); }
    }

    function renderReport(rep) {
        const box = $el('stj_report');
        if (!box) return;
        if (!rep) { box.innerHTML = '<div class="stj-dim">还没扫描过，点「扫描」看看有啥可清的。</div>'; return; }
        const rows = Object.entries(rep.rules || {}).map(([id, r]) => {
            const mark = r.enabled ? '' : ' <span class="stj-dim">(未启用)</span>';
            return `<tr><td>${r.label}${mark}</td><td class="stj-num">${r.count}</td><td class="stj-num">${fmtBytes(r.bytes)}</td></tr>`;
        }).join('');
        const head = rep.kind === 'scan'
            ? `扫描于 ${new Date(rep.at || Date.now()).toLocaleString()}`
            : `清理（${rep.dryRun ? '试运行' : '已执行'}）于 ${new Date(rep.at || Date.now()).toLocaleString()}`
                + (rep.batch ? ` · 批次 <code>${rep.batch}</code>` : '');
        const tot = rep.total || { count: 0, bytes: 0 };
        const tail = rep.moved !== undefined
            ? `<div class="stj-dim">移动 ${rep.moved} 项 / ${fmtBytes(rep.bytes)}${rep.failed?.length ? ` · 失败 ${rep.failed.length}` : ''}</div>`
            : `<div class="stj-dim">合计可清：${tot.count} 项 / ${fmtBytes(tot.bytes)}</div>`;
        box.innerHTML = `<div class="stj-head">${head}</div>`
            + `<table class="stj-table"><thead><tr><th>规则</th><th>数量</th><th>体积</th></tr></thead><tbody>${rows}</tbody></table>${tail}`;
    }

    // ------------------------------------------------ 扫描预览 / 勾选清理
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmtType = (t) => (t === '目录' ? '目录' : t === '无扩展名' ? '(无扩展名)' : '.' + t);

    let previewKey = null;
    let previewRules = {};           // ruleId -> items[]
    const previewSel = new Set();    // 勾选的 rel
    let previewSize = new Map();     // rel -> size
    const PREVIEW_MAX_ROWS = 1000;

    function updateSelCount() {
        let n = 0, bytes = 0;
        for (const rel of previewSel) { n++; bytes += previewSize.get(rel) || 0; }
        const el = $el('stj_pv_sel');
        if (el) el.textContent = `已选 ${n} 项 / ${fmtBytes(bytes)}`;
    }

    function applyChecks(scope) {
        if (!scope) return;
        scope.querySelectorAll('.stj-pv-cb').forEach(cb => {
            const on = previewSel.has(cb.dataset.rel);
            cb.checked = on;
            const row = cb.closest('.stj-pv-row');
            if (row) row.classList.toggle('on', on);
        });
    }

    /** 扫描结果的逐文件预览（名字 / 目录 / 格式 / 大小 + 勾选） */
    function renderPreview(rep) {
        const box = $el('stj_preview');
        if (!box) return;
        const key = rep ? `${rep.kind || 'scan'}@${rep.generatedAt || rep.at || ''}` : null;
        if (key === previewKey) return;          // 轮询时不动，保住勾选
        previewKey = key;
        previewSel.clear(); previewSize = new Map(); previewRules = {};
        if (!rep || (rep.kind && rep.kind !== 'scan')) { box.innerHTML = ''; return; }
        const groups = Object.entries(rep.rules || {}).filter(([, r]) => (r.items || []).length);
        if (!groups.length) { box.innerHTML = '<div class="stj-dim">这次扫描没扫出可清理的文件 🎉</div>'; return; }

        let html = '<div class="stj-pv-bar"><span class="stj-pv-title">扫描结果预览 · 勾选后只清选中的</span>'
            + '<span class="menu_button menu_button_small" data-pv="all">全选</span>'
            + '<span class="menu_button menu_button_small" data-pv="none">清空选择</span></div>';
        for (const [id, r] of groups) {
            previewRules[id] = r.items;
            for (const it of r.items) previewSize.set(it.rel, it.size || 0);
            const rows = r.items.slice(0, PREVIEW_MAX_ROWS).map(it => `
              <label class="stj-pv-row" title="${esc(it.rel)}">
                <input type="checkbox" class="stj-pv-cb" data-rel="${esc(it.rel)}">
                <span class="stj-pv-name">${esc(it.name)}</span>
                <span class="stj-pv-dir">${esc(it.dir || '/')}</span>
                <span class="stj-pv-type">${esc(fmtType(it.type))}</span>
                <span class="stj-pv-size">${fmtBytes(it.size)}</span>
              </label>`).join('');
            html += `<div class="stj-pv-group" data-rule="${esc(id)}">
              <div class="stj-pv-head">
                <span><b>${esc(r.label)}</b></span>
                <span class="stj-pv-count">${r.count} 项 · ${fmtBytes(r.bytes)}${r.truncated ? ' · 列表已截断' : ''}</span>
                <span class="stj-pv-actions">
                  <span class="menu_button menu_button_small" data-pv-rule="${esc(id)}" data-pv-act="all">全选</span>
                  <span class="menu_button menu_button_small" data-pv-rule="${esc(id)}" data-pv-act="none">清空</span>
                </span>
              </div>
              <div class="stj-pv-list">${rows}</div>
            </div>`;
        }
        html += '<div class="stj-pv-foot">'
            + '<span class="stj-pv-sel" id="stj_pv_sel">已选 0 项 / 0 B</span>'
            + '<span class="menu_button menu_button_small" data-pv="drysel">试运行选中</span>'
            + '<span class="menu_button menu_button_small stj-danger" data-pv="gosel">清理选中项</span>'
            + '</div>';
        box.innerHTML = html;
        updateSelCount();
    }

    function bindPreview() {
        const box = $el('stj_preview');
        if (!box || box.dataset.bound) return;
        box.dataset.bound = '1';
        box.addEventListener('change', (e) => {
            const cb = e.target.closest && e.target.closest('.stj-pv-cb');
            if (!cb) return;
            if (cb.checked) previewSel.add(cb.dataset.rel); else previewSel.delete(cb.dataset.rel);
            const row = cb.closest('.stj-pv-row');
            if (row) row.classList.toggle('on', cb.checked);
            updateSelCount();
        });
        box.addEventListener('click', (e) => {
            const btn = e.target.closest && e.target.closest('[data-pv],[data-pv-rule]');
            if (!btn || btn.tagName === 'INPUT') return;
            const ruleAct = btn.dataset.pvAct, ruleId = btn.dataset.pvRule;
            if (ruleAct && ruleId) {
                for (const it of previewRules[ruleId] || []) { if (ruleAct === 'all') previewSel.add(it.rel); else previewSel.delete(it.rel); }
                applyChecks(btn.closest('.stj-pv-group'));
            } else {
                const a = btn.dataset.pv;
                if (a === 'all') { for (const list of Object.values(previewRules)) for (const it of list) previewSel.add(it.rel); applyChecks(box); }
                else if (a === 'none') { previewSel.clear(); applyChecks(box); }
                else if (a === 'drysel') { cleanSelected(true); }
                else if (a === 'gosel') { cleanSelected(false); }
            }
            updateSelCount();
        });
    }

    async function cleanSelected(dry) {
        const rels = [...previewSel];
        if (!rels.length) { try { toastr.warning('先勾选要清理的文件'); } catch { /* ignore */ } return; }
        if (!dry) { await startClean({ rels }); return; }   // 真删 → 先问回收站还是彻底删除
        const size = rels.reduce((s, r) => s + (previewSize.get(r) || 0), 0);
        if (!confirm(`试运行：检查选中的 ${rels.length} 项（${fmtBytes(size)}）？`)) return;
        await streamJob('/clean/stream', { dryRun: true, rels }, '正在试运行（选中项）…', 'clean');
    }

    let lastScan = null;

    // ---- 清理方式询问（回收站 / 彻底删除）----
    let delResolve = null, delArmTimer = null;

    function askCleanMode(summary) {
        const m = $el('stj_del_modal');
        if (!m) return Promise.resolve('trash');
        $el('stj_del_sub').innerHTML = summary;
        if (delArmTimer) { clearTimeout(delArmTimer); delArmTimer = null; }
        m.style.display = 'flex';
        return new Promise((resolve) => { delResolve = resolve; });
    }

    // ---- 彻底删除的最终确认（前面已强制试运行过）----
    let permResolve = null;

    function askPermanentConfirm(info) {
        const m = $el('stj_perm_modal');
        if (!m) return Promise.resolve(false);
        $el('stj_perm_sub').innerHTML = `共 <b>${info.count} 项</b> / <b>${fmtBytes(info.bytes)}</b> —— 不进回收站、<b>不可恢复</b>`;
        $el('stj_perm_list').textContent = (info.lines || []).join('\n');
        m.style.display = 'flex';
        return new Promise((resolve) => { permResolve = resolve; });
    }

    function closePermanentConfirm(ok) {
        const m = $el('stj_perm_modal');
        if (m) m.style.display = 'none';
        const r = permResolve; permResolve = null;
        if (r) r(!!ok);
    }

    function closeCleanMode(pick) {
        const m = $el('stj_del_modal');
        if (m) m.style.display = 'none';
        if (delArmTimer) { clearTimeout(delArmTimer); delArmTimer = null; }
        const r = delResolve; delResolve = null;
        if (r) r(pick);
    }

    /** 真正开始清理：先问一句「放回收站 / 彻底删除」 */
    async function startClean({ rels = null } = {}) {
        let summary;
        if (rels && rels.length) {
            const size = rels.reduce((s, r) => s + (previewSize.get(r) || 0), 0);
            summary = `即将清理<b>勾选的 ${rels.length} 项</b> · 共 ${fmtBytes(size)}`;
        } else {
            const rep = lastScan && lastScan.kind === 'scan' ? lastScan : null;
            const en = rep ? Object.values(rep.rules || {}).filter(r => r.enabled) : [];
            const c = en.reduce((a, r) => a + (r.count || 0), 0);
            const b = en.reduce((a, r) => a + (r.bytes || 0), 0);
            summary = c
                ? `即将按<b>已启用的规则</b>清理 · 约 ${c} 项 / ${fmtBytes(b)}`
                : '即将按<b>已启用的规则</b>清理（建议先点「扫描」看看会动什么）';
        }
        const pick = await askCleanMode(summary + '<br><span class="stj-dim">放回收站：随时可还原 · 彻底删除：会先自动试运行一次，再让你确认</span>');
        if (!pick) return;
        const scope = rels && rels.length ? { rels } : {};
        if (pick !== 'permanent') {
            await streamJob('/clean/stream', { ...scope, dryRun: false }, '正在清理（进回收站）…', 'clean');
            return;
        }

        // —— 彻底删除：强制先跑一次试运行，把“会删什么”摆出来，再二次确认 ——
        const rep = await streamJob('/clean/stream', { ...scope, dryRun: true }, '彻底删除前，先试运行…', 'clean');
        if (!rep) return;
        const by = Object.values(rep.byRule || {});
        const count = by.reduce((a, r) => a + (r.count || 0), 0);
        const bytes = by.reduce((a, r) => a + (r.bytes || 0), 0);
        if (!count) { try { toastr.info('试运行结果：这次没有可清理的项'); } catch { /* ignore */ } return; }
        const ok = await askPermanentConfirm({ count, bytes, lines: by.filter(r => r.count).map(r => `${r.label}  ${r.count} 项 · ${fmtBytes(r.bytes)}`) });
        if (!ok) return;
        await streamJob('/clean/stream', { ...scope, dryRun: false, permanent: true }, '正在彻底删除…', 'clean');
    }

    function renderTrash(trash) {
        const box = $el('stj_trash');
        if (!box) return;
        if (!trash || !trash.length) { box.innerHTML = '<div class="stj-dim">回收站是空的。</div>'; return; }
        box.innerHTML = trash.map(t =>
            `<div class="stj-trash-row"><span><code>${t.batch}</code> · ${t.count} 项 / ${fmtBytes(t.size)}</span>`
            + `<span><span class="menu_button menu_button_small stj-restore" data-batch="${t.batch}">还原</span></span></div>`
        ).join('');
        box.querySelectorAll('.stj-restore').forEach(btn => btn.addEventListener('click', async () => {
            const batch = btn.dataset.batch;
            if (!confirm(`还原批次 ${batch} 里的文件？`)) return;
            await act('还原', async () => {
                const r = await api('/restore', { method: 'POST', body: { batch } });
                toastr.success(`已还原 ${r.restored} 项${r.failed?.length ? `，${r.failed.length} 项跳过` : ''}`);
            });
        }));
    }

    function fillConfig(c) {
        if (!c) return;
        $el('stj_root').value = c.dataRoot || '';
        const auto = c.mode === 'auto';
        $el('stj_mode_auto').checked = auto;
        $el('stj_mode_manual').checked = !auto;
        $el('stj_ival').value = c.intervalValue ?? 1;
        $el('stj_iunit').value = c.intervalUnit || 'hours';
        $el('stj_autodry').checked = c.autoCleanDryRun !== false;
        toggleAutoBox();
        for (const r of RULES) {
            const cb = $el('stj_r_' + r.id);
            if (cb) cb.checked = !!c.rules?.[r.id]?.enabled;
            if (r.keep) { const k = $el('stj_keep_' + r.id); if (k) k.value = c.rules?.[r.id]?.keepNewest ?? 10; }
            if (r.age) { const a = $el('stj_age_' + r.id); if (a) a.value = c.rules?.[r.id]?.minAgeHours ?? 24; }
            if (r.dup) {
                const d = c.rules?.duplicates || {};
                $el('stj_dup_keep').value = d.keepNewest ?? 1;
                $el('stj_dup_prefer').checked = d.preferBase !== false;
                $el('stj_dup_min').value = d.minSizeKB ?? 0;
                $el('stj_dup_identical').checked = d.identical !== false;
                $el('stj_dup_nameCopies').checked = d.nameCopies !== false;
                $el('stj_dup_charNames').checked = d.charNames !== false;
                const sc = Array.isArray(d.scope) && d.scope.length ? d.scope : DUP_SCOPES.map(s => s.id);
                for (const s of DUP_SCOPES) { const cb = $el('stj_ds_' + s.id); if (cb) cb.checked = sc.includes(s.id); }
            }
        }
    }

    function collectConfig() {
        const rules = {};
        for (const r of RULES) {
            const entry = { enabled: !!$el('stj_r_' + r.id)?.checked };
            if (r.keep) entry.keepNewest = Number($el('stj_keep_' + r.id)?.value) || 0;
            if (r.age) entry.minAgeHours = Number($el('stj_age_' + r.id)?.value) || 24;
            if (r.dup) {
                entry.keepNewest = Math.max(1, Number($el('stj_dup_keep')?.value) || 1);
                entry.preferBase = !!$el('stj_dup_prefer')?.checked;
                entry.minSizeKB = Number($el('stj_dup_min')?.value) || 0;
                entry.identical = !!$el('stj_dup_identical')?.checked;
                entry.nameCopies = !!$el('stj_dup_nameCopies')?.checked;
                entry.charNames = !!$el('stj_dup_charNames')?.checked;
                entry.scope = DUP_SCOPES.filter(s => $el('stj_ds_' + s.id)?.checked).map(s => s.id);
            }
            rules[r.id] = entry;
        }
        return {
            dataRoot: $el('stj_root').value.trim(),
            mode: $el('stj_mode_auto').checked ? 'auto' : 'manual',
            intervalValue: Number($el('stj_ival').value) || 1,
            intervalUnit: $el('stj_iunit').value,
            autoCleanDryRun: $el('stj_autodry').checked,
            rules,
        };
    }

    function toggleAutoBox() {
        const auto = !!$el('stj_mode_auto')?.checked;
        const box = $el('stj_auto_box');
        if (box) box.style.opacity = auto ? '1' : '.5';
    }

    // ---- 服务端插件没装时的引导卡 ----
    const REPO_URL = 'https://github.com/wyndam-c/st-data-janitor';
    const RAW_BASE = 'https://raw.githubusercontent.com/wyndam-c/st-data-janitor/main';
    let serverEnv = null;   // 服务端上报的运行环境（/status 的 env）

    // 判断「酒馆是不是跑在手机上」：服务端上报优先（/status.env），拿不到（比如插件还没装）就按浏览器 UA 猜
    function termuxGuess() {
        if (serverEnv) return !!serverEnv.termux;
        const ua = `${navigator?.userAgent || ''} ${navigator?.platform || ''}`;
        return /android|termux/i.test(ua);
    }

    function installCmd() {
        const ua = `${navigator?.userAgent || ''} ${navigator?.platform || ''}`;
        // 酒馆跑在手机(Termux)上 → 给手机版安装器（浏览器 UA 可能是电脑的，所以服务端信息优先）
        if (termuxGuess()) {
            return `pkg install -y curl && curl -fsSL ${RAW_BASE}/install-termux.sh | bash`;
        }
        if (/win/i.test(ua)) {
            return `powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr -UseB ${RAW_BASE}/install.ps1 -OutFile $env:TEMP\\stj-install.ps1; & $env:TEMP\\stj-install.ps1"`;
        }
        return `curl -fsSL ${RAW_BASE}/install.sh | bash`;
    }

    async function copyText(t) {
        try { await navigator.clipboard.writeText(t); return true; } catch { /* 退化 */ }
        try {
            const ta = document.createElement('textarea');
            ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
        } catch { return false; }
    }

    function showSetup(kind, detail) {
        const box = $el('stj_setup');
        if (!box) return;
        if (!kind) { box.style.display = 'none'; return; }
        $el('stj_setup_title').textContent = kind === 'missing' ? '还差一步：装「服务端插件」' : '连不上服务端插件';
        $el('stj_setup_msg').innerHTML = kind === 'missing'
            ? '这个扩展只是<b>前端面板</b>；真正干活的<b>服务端插件</b>还没在酒馆的 <code>plugins/</code> 里。<br>酒馆本身<b>没有「安装服务端插件」的界面</b>，用下面这行命令（自动找路径、装好、备份旧版）最省事：'
                + (termuxGuess() ? '<br>📱 <b>看起来酒馆是跑在手机（Termux）上的</b>，下面是手机版命令，在 Termux 里贴即可。' : '')
            : `错误：<code>${String(detail || '').slice(0, 200)}</code>`;
        const steps = $el('stj_setup_steps');
        if (steps) steps.style.display = kind === 'missing' ? '' : 'none';
        $el('stj_setup_cmd').textContent = installCmd();
        box.style.display = 'block';
    }

    async function refresh() {
        try {
            const s = await api('/status');
            serverEnv = s.env || null;
            lastScan = s.lastReport || null;
            if (s.running) setStatus(`⏳ 正在${s.kind === 'scan' ? '扫描' : '清理'}…`, 'stj-busy');
            else if (s.error) setStatus(`⚠️ 上次任务出错：${s.error}`, 'stj-bad');
            else setStatus('就绪 · ' + (s.auto?.mode === 'auto' ? `自动：${s.auto.text}` : '手动'), '');
            renderReport(s.lastReport);
            renderPreview(s.lastReport);
            renderTrash(s.trash);
            showSetup(null);
            return s;
        } catch (e) {
            const missing = e.status === 404;
            setStatus(missing ? '⚠️ 还没装服务端插件（看下面的安装指引）' : `⚠️ 连不上服务端插件：${e.message}`, 'stj-bad');
            showSetup(missing ? 'missing' : 'error', e.message);
            return null;
        }
    }

    function startPoll() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(() => {
            if (!$el('stj_status')) { clearInterval(pollTimer); pollTimer = null; return; }
            refresh();
        }, 3000);
    }

    async function act(label, fn) {
        try {
            setStatus(`⏳ ${label}…`, 'stj-busy');
            await fn();
            await refresh();
        } catch (e) {
            setStatus(`⚠️ ${label}失败：${e.message}`, 'stj-bad');
        }
    }

    // ---------------------------------------------------------- 进度弹窗
    const MODAL_HTML = `
<div class="stj-modal" id="stj_modal">
  <div class="stj-modal-box">
    <div class="stj-modal-title"><span class="stj-spin" id="stj_spin"></span><span id="stj_modal_title">正在处理…</span></div>
    <div class="stj-bar"><div class="stj-bar-fill" id="stj_bar"></div></div>
    <div class="stj-modal-line"><span id="stj_modal_phase">准备中…</span><span id="stj_modal_pct">0%</span></div>
    <div class="stj-modal-meta"><span id="stj_elapsed">已用 0.0 秒</span><span class="stj-dim">跑完会自动消失</span></div>
    <div class="stj-modal-actions"><div class="menu_button menu_button_small" id="stj_modal_close">关闭</div></div>
  </div>
</div>
<div class="stj-modal" id="stj_upd_modal">
  <div class="stj-modal-box">
    <div class="stj-modal-title"><span class="stj-upd-dot"></span><span id="stj_upd_title">发现新版本</span></div>
    <div class="stj-upd-sub" id="stj_upd_sub"></div>
    <pre class="stj-notes" id="stj_upd_notes"></pre>
    <div class="stj-modal-meta"><span id="stj_upd_time"></span><span class="stj-dim">更新会从发布分支拉取最新代码</span></div>
    <div class="stj-modal-actions">
      <div class="menu_button menu_button_small" id="stj_upd_cancel">取消</div>
      <div class="menu_button menu_button_small stj-primary" id="stj_upd_go">立即更新</div>
    </div>
  </div>
</div>
<div class="stj-modal" id="stj_del_modal">
  <div class="stj-modal-box">
    <div class="stj-modal-title"><span class="stj-upd-dot"></span><span id="stj_del_title">清理方式</span></div>
    <div class="stj-upd-sub" id="stj_del_sub"></div>
    <div class="stj-modal-meta"><span>💡 放回收站：可随时还原 · 彻底删除：不可恢复</span></div>
    <div class="stj-modal-actions">
      <div class="menu_button menu_button_small" id="stj_del_cancel">取消</div>
      <div class="menu_button menu_button_small stj-primary" id="stj_del_trash">移入回收站</div>
      <div class="menu_button menu_button_small stj-danger" id="stj_del_perm">彻底删除</div>
    </div>
  </div>
</div>
<div class="stj-modal" id="stj_perm_modal">
  <div class="stj-modal-box">
    <div class="stj-modal-title"><span class="stj-upd-dot"></span><span>⚠️ 确认彻底删除</span></div>
    <div class="stj-upd-sub" id="stj_perm_sub"></div>
    <pre class="stj-notes" id="stj_perm_list"></pre>
    <div class="stj-modal-meta"><span>已先跑过试运行；此操作不进回收站，删除后无法恢复</span></div>
    <div class="stj-modal-actions">
      <div class="menu_button menu_button_small" id="stj_perm_cancel">取消</div>
      <div class="menu_button menu_button_small stj-danger" id="stj_perm_ok">确认彻底删除</div>
    </div>
  </div>
</div>`;

    /** 弹窗必须挂在 body 上：挂在扩展面板里会被面板的定位/裁剪影响，导致又小又不显眼。 */
    function ensureModal() {
        if (document.getElementById('stj_modal')) return;
        document.body.insertAdjacentHTML('beforeend', MODAL_HTML);
        const c = document.getElementById('stj_modal_close');
        if (c) c.addEventListener('click', () => closeProgress());
        const dc = document.getElementById('stj_del_cancel');
        if (dc) dc.addEventListener('click', () => closeCleanMode(null));
        const pc = document.getElementById('stj_perm_cancel');
        if (pc) pc.addEventListener('click', () => closePermanentConfirm(false));
        const po = document.getElementById('stj_perm_ok');
        if (po) po.addEventListener('click', () => closePermanentConfirm(true));
        const dt = document.getElementById('stj_del_trash');
        if (dt) dt.addEventListener('click', () => closeCleanMode('trash'));
        const dp = document.getElementById('stj_del_perm');
        if (dp) dp.addEventListener('click', () => closeCleanMode('permanent'));
    }

    let barPct = 0, progressStart = 0, progressTimer = null;
    const RULE_LABEL = Object.fromEntries(RULES.map(r => [r.id, r.label]));
    const SCOPE_LABEL = Object.fromEntries(DUP_SCOPES.map(s => [s.id, s.label]));

    function openProgress(title) {
        const m = $el('stj_modal'); if (!m) return;
        barPct = 0;
        $el('stj_modal_title').textContent = title;
        $el('stj_modal_phase').textContent = '准备中…';
        $el('stj_modal_pct').textContent = '0%';
        $el('stj_bar').style.width = '0%';
        $el('stj_modal_close').style.display = 'none';
        const sp = $el('stj_spin'); if (sp) sp.style.display = '';
        progressStart = Date.now();
        const el = $el('stj_elapsed'); if (el) el.textContent = '已用 0.0 秒';
        if (progressTimer) clearInterval(progressTimer);
        progressTimer = setInterval(() => {
            const t = $el('stj_elapsed');
            if (t) t.textContent = `已用 ${((Date.now() - progressStart) / 1000).toFixed(1)} 秒`;
        }, 100);
        m.style.display = 'flex';
    }

    function setProgress(pct, phaseText) {
        pct = Math.max(0, Math.min(100, Number(pct) || 0));
        if (pct < barPct) pct = barPct;   // 只前进，不后退
        barPct = pct;
        const bar = $el('stj_bar'); if (bar) bar.style.width = pct + '%';
        const p = $el('stj_modal_pct'); if (p) p.textContent = Math.round(pct) + '%';
        if (phaseText) { const ph = $el('stj_modal_phase'); if (ph) ph.textContent = phaseText; }
    }

    function closeProgress(delay) {
        const hide = () => {
            const m = $el('stj_modal'); if (m) m.style.display = 'none';
            if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
        };
        if (delay) setTimeout(hide, delay); else hide();
    }

    /** 把服务端进度事件映射成 0-100 的整体百分比（扫描/清理两套刻度）。 */
    function pctFor(kind, ev) {
        const frac = (d, t) => (t > 0 ? Math.max(0, Math.min(1, d / t)) : 0);
        const isClean = kind !== 'scan';
        switch (ev.phase) {
            case 'walk': return isClean ? 6 : 10;
            case 'rule': return (isClean ? 12 : 20) + (isClean ? 18 : 25) * frac(ev.i, ev.total);
            case 'dup': case 'dup-hash': return (isClean ? 30 : 45) + (isClean ? 30 : 50) * frac(ev.done, ev.total);
            case 'move': return 60 + 38 * frac(ev.done, ev.total);
            default: return null;
        }
    }

    function phaseTextFor(ev) {
        switch (ev.phase) {
            case 'walk': return `遍历目录… 已看 ${ev.scanned || 0} 个文件`;
            case 'rule': return `检查规则：${ev.label || RULE_LABEL[ev.id] || ev.id}（${ev.i}/${ev.total}）`;
            case 'dup': return `去重：${SCOPE_LABEL[ev.group] || ev.group} · ${ev.dir}（${ev.done}/${ev.total}）`;
            case 'dup-hash': return `比对文件内容… ${ev.done}/${ev.total}`;
            case 'move': return `移入回收站… ${ev.done}/${ev.total}`;
            default: return null;
        }
    }

    /** 跑一个带进度的任务：POST → 读 NDJSON 流 → 更新弹窗进度条。 */
    async function streamJob(path, body, title, kind) {
        openProgress(title);
        setStatus('⏳ ' + title, 'stj-busy');
        let report = null, serverErr = null;
        const handle = (ev) => {
            if (ev.type === 'progress') {
                const p = pctFor(kind, ev);
                setProgress(p == null ? barPct : p, phaseTextFor(ev) || undefined);
            } else if (ev.type === 'result') {
                report = ev.report; setProgress(100, '完成');
            } else if (ev.type === 'error') {
                serverErr = ev.error;
            }
        };
        try {
            const headers = getCtx().getRequestHeaders();
            headers['Content-Type'] = 'application/json';
            const res = await fetch(`${API}${path}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
            if (!res.ok) {
                const t = await res.text();
                let msg = t; try { msg = JSON.parse(t).error || t; } catch { /* keep */ }
                throw new Error(String(msg).slice(0, 200));
            }
            if (res.body && typeof res.body.getReader === 'function') {
                const reader = res.body.getReader();
                const dec = new TextDecoder();
                let buf = '';
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buf += dec.decode(value, { stream: true });
                    let i;
                    while ((i = buf.indexOf('\n')) >= 0) {
                        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
                        if (!line) continue;
                        try { handle(JSON.parse(line)); } catch { /* 忽略半行 */ }
                    }
                }
                if (buf.trim()) { try { handle(JSON.parse(buf.trim())); } catch { /* ignore */ } }
            } else {
                const t = await res.text();   // 退化：服务端不支持流式
                for (const line of t.split('\n')) { if (line.trim()) { try { handle(JSON.parse(line)); } catch { /* ignore */ } } }
            }
        } catch (e) {
            serverErr = e.message;
        }
        if (serverErr) {
            $el('stj_modal_title').textContent = '任务失败';
            setProgress(barPct, '出错：' + serverErr);
            $el('stj_modal_close').style.display = '';
            const sp = $el('stj_spin'); if (sp) sp.style.display = 'none';
            if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
            setStatus('⚠️ 任务失败：' + serverErr, 'stj-bad');
            try { toastr.error('任务失败：' + serverErr); } catch { /* ignore */ }
        } else {
            closeProgress(600);
            try {
                if (report) {
                    const byRule = report.rules || report.byRule || {};
                    const list = Array.isArray(byRule) ? byRule : Object.values(byRule);
                    const sum = list.reduce((a, r) => ({ count: a.count + (r.count || 0), bytes: a.bytes + (r.bytes || 0) }), { count: 0, bytes: 0 });
                    const msg = kind === 'scan'
                        ? `扫描完成：可清 ${report.total?.count ?? sum.count} 项 / ${fmtBytes(report.total?.bytes ?? sum.bytes)}`
                        : report.dryRun
                            ? `试运行完成：会处理 ${sum.count} 项 / ${fmtBytes(sum.bytes)}（什么都没动）`
                            : `清理完成：${report.permanent ? `彻底删除 ${report.deleted ?? 0} 项` : `移入回收站 ${report.moved ?? 0} 项`} / ${fmtBytes(report.bytes ?? 0)}${report.failed?.length ? ` · 失败 ${report.failed.length}` : ''}${report.notFoundCount ? ` · 跳过 ${report.notFoundCount}` : ''}`;
                    toastr.success(msg);
                }
            } catch { /* ignore */ }
            renderPreview(report);   // 扫描完直接把列表画出来
            if (report && kind !== 'scan' && ((report.moved || 0) + (report.deleted || 0)) > 0) {
                try { await api('/scan', { method: 'POST' }); } catch { /* ignore */ }   // 真删除后自动重扫，列表自己刷新
            }
            await refresh();
        }
        return report;
    }

    // ---------------------------------------------------------- 检查更新
    function setVersionLabel(cur, latest, hasUpdate) {
        const v = $el('stj_ver'); if (v) v.textContent = 'v' + (cur || '?');
        const h = $el('stj_updhint');
        if (h) h.innerHTML = hasUpdate ? `· 有新版本 <b>v${latest}</b>` : (cur ? '· 已是最新' : '');
    }

    async function checkUpdate(manual = true) {
        const btn = $el('stj_updchk');
        const oldLabel = btn ? btn.textContent : '检查更新';
        if (btn) { btn.textContent = '检查中…'; }
        try {
            const r = await api('/update-check');
            if (!r.ok) throw new Error(r.error || '检查失败');
            setVersionLabel(r.current, r.latest, r.hasUpdate);
            if (r.hasUpdate) openUpdateModal(r);
            else if (manual) toastr.success(`已经是最新版本 v${r.current}，无需更新`);
            return r;
        } catch (e) {
            const m = '检查更新失败：' + e.message;
            if (manual) toastr.error(m); else setStatus('⚠️ ' + m, 'stj-bad');
            return null;
        } finally {
            if (btn) btn.textContent = oldLabel || '检查更新';
        }
    }

    function openUpdateModal(r) {
        const m = $el('stj_upd_modal'); if (!m) return;
        $el('stj_upd_title').textContent = `发现新版本 v${r.latest}`;
        $el('stj_upd_sub').innerHTML = `当前版本 <b>v${r.current}</b> → 可更新到 <b>v${r.latest}</b>`;
        $el('stj_upd_notes').textContent = r.notes ? r.notes : '（本次更新没有写说明）';
        $el('stj_upd_time').textContent = '检查于 ' + new Date(r.checkedAt || Date.now()).toLocaleTimeString();
        const go = $el('stj_upd_go'), cancel = $el('stj_upd_cancel');
        if (go) { go.textContent = '立即更新'; go.dataset.busy = ''; }
        if (cancel) cancel.style.display = '';
        m.style.display = 'flex';
    }
    function closeUpdateModal() { const m = $el('stj_upd_modal'); if (m) m.style.display = 'none'; }

    async function applyUpdate() {
        const go = $el('stj_upd_go'), cancel = $el('stj_upd_cancel');
        if (!go || go.dataset.busy) return;
        go.textContent = '更新中…'; go.dataset.busy = '1';
        if (cancel) cancel.style.display = 'none';
        try {
            const r = await api('/update-apply', { method: 'POST', body: {} });
            if (!r.ok) throw new Error(r.error || '更新失败');
            closeUpdateModal();
            toastr.success(r.message || `已更新到 v${r.to}`);
            setVersionLabel(r.to, r.to, false);
            if (r.restartNeeded) {
                setStatus(`✅ 已更新到 v${r.to} · 服务端插件需重启酒馆才生效`, '');
                try { toastr.warning('服务端插件要重启酒馆才生效；前端扩展刷新页面即可。', '更新完成', { timeOut: 15000 }); } catch { /* ignore */ }
            } else {
                setStatus(`✅ 已更新到 v${r.to} · 刷新页面即生效`, '');
            }
            await refresh();
        } catch (e) {
            if (go) { go.textContent = '立即更新'; go.dataset.busy = ''; }
            if (cancel) cancel.style.display = '';
            toastr.error('更新失败：' + e.message);
        }
    }

    function buildHtml() {
        const ruleRows = RULES.map(r => `
      <div class="stj-rule">
        <label class="stj-rule-main">
          <input type="checkbox" id="stj_r_${r.id}">
          <span><b>${r.label}</b><em>${r.hint}</em></span>
        </label>
        ${r.keep ? `<label class="stj-rule-num">保留<input type="number" id="stj_keep_${r.id}" min="0" value="10">份</label>` : ''}
        ${r.age ? `<label class="stj-rule-num">存续<input type="number" id="stj_age_${r.id}" min="0" value="24">小时</label>` : ''}
        ${r.dup ? `<div class="stj-dup">
          <div class="stj-dup-line">
            <label class="stj-rule-num">保留<input type="number" id="stj_dup_keep" min="1" value="1">份</label>
            <label class="stj-check"><input type="checkbox" id="stj_dup_prefer" checked> 优先留“干净”文件名</label>
            <label class="stj-rule-num">小于<input type="number" id="stj_dup_min" min="0" value="0">KB 不判重</label>
          </div>
          <div class="stj-dup-line">判重方式：
            <label class="stj-check"><input type="checkbox" id="stj_dup_identical" checked> 内容相同</label>
            <label class="stj-check"><input type="checkbox" id="stj_dup_nameCopies" checked> 同名副本</label>
            <label class="stj-check"><input type="checkbox" id="stj_dup_charNames" checked> 角色卡同名</label>
          </div>
          <div class="stj-dup-line">范围：
            ${DUP_SCOPES.map(s => `<label class="stj-check"><input type="checkbox" id="stj_ds_${s.id}" checked> ${s.label}</label>`).join('')}
          </div>
        </div>` : ''}
      </div>`).join('');

        return `
<div class="inline-drawer">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b>数据清洁工 (Data Janitor)</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content">
    <div class="stj-status" id="stj_status">加载中…</div>
    <div class="stj-setup" id="stj_setup" style="display:none">
      <div class="stj-setup-title" id="stj_setup_title"></div>
      <div class="stj-setup-msg" id="stj_setup_msg"></div>
      <div id="stj_setup_steps">
        <pre class="stj-setup-cmd" id="stj_setup_cmd"></pre>
        <div class="stj-setup-btns">
          <span class="menu_button menu_button_small stj-primary" id="stj_setup_copy">复制安装命令</span>
          <span class="menu_button menu_button_small" id="stj_setup_retry">装好了，重新检测</span>
        </div>
        <div class="stj-setup-note">
          · 国内下载慢？把链接前面加个镜像前缀 <code>https://gh-proxy.com/</code> 再跑。<br>
          · 不想用命令：下 <code>install.cmd</code>（Windows）或 <code>install.sh</code> 双击/执行也行，脚本会自己找酒馆路径。<br>
          · 装完<b>重启一次酒馆</b>，回来点「重新检测」；<b>本扩展</b>还能直接在酒馆里装：<br>
          　扩展 → 安装扩展 → URL 填 <code>${REPO_URL}</code>，分支填 <code>ext-dist</code>。
        </div>
      </div>
    </div>
    <div class="stj-hint">清理时可选 <b>放回收站</b>（可还原）或 <b>彻底删除</b>；默认只「试运行」不真删。</div>
    <div class="stj-row"><label>版本</label>
      <span class="stj-ver" id="stj_ver">v?</span>
      <span class="menu_button menu_button_small" id="stj_updchk">检查更新</span>
      <span class="stj-dim" id="stj_updhint"></span>
    </div>
    <div class="stj-rules">${ruleRows}</div>
    <div class="stj-row"><label>清理模式</label>
      <label class="stj-check"><input type="radio" name="stj_mode" id="stj_mode_manual" value="manual"> 手动</label>
      <label class="stj-check"><input type="radio" name="stj_mode" id="stj_mode_auto" value="auto"> 自动</label>
      <span class="stj-dim">（自动 = 到点自己跑）</span>
    </div>
    <div class="stj-row" id="stj_auto_box">
      <label>自动间隔</label>
      <span class="stj-inline">
        <input type="number" id="stj_ival" min="1" value="1">
        <select id="stj_iunit">
          <option value="minutes">分钟</option>
          <option value="hours" selected>小时</option>
          <option value="days">天</option>
        </select>
      </span>
      <label class="stj-check"><input type="checkbox" id="stj_autodry" checked> 自动只报告不真删</label>
    </div>
    <div class="stj-row"><label>data 根</label><input type="text" id="stj_root" placeholder="留空自动探测"></div>
    <div class="stj-btns">
      <div class="menu_button" id="stj_save">保存配置</div>
      <div class="menu_button" id="stj_scan">扫描</div>
      <div class="menu_button" id="stj_dry">试运行清理</div>
      <div class="menu_button stj-danger" id="stj_go">立即清理</div>
      <div class="menu_button" id="stj_empt">清空回收站</div>
    </div>
    <div class="stj-report" id="stj_report"></div>
    <div class="stj-preview" id="stj_preview"></div>
    <div class="stj-sub">回收站</div>
    <div class="stj-trash" id="stj_trash"></div>
  </div>
</div>`;
    }

    async function init() {
        if ($el('stj_status') || !document.getElementById('extensions_settings')) return;
        ensureModal();
        $('#extensions_settings').append(buildHtml());
        bindPreview();

        $el('stj_save').addEventListener('click', () => act('保存配置', async () => {
            await api('/config', { method: 'POST', body: collectConfig() });
            toastr.success('配置已保存');
        }));
        $el('stj_mode_manual').addEventListener('change', toggleAutoBox);
        $el('stj_mode_auto').addEventListener('change', toggleAutoBox);
        $el('stj_scan').addEventListener('click', () => streamJob('/scan/stream', {}, '正在扫描…', 'scan'));
        $el('stj_dry').addEventListener('click', () => streamJob('/clean/stream', { dryRun: true }, '正在试运行…', 'clean'));
        $el('stj_go').addEventListener('click', () => startClean({}));   // 先问「回收站 / 彻底删除」
        $el('stj_empt').addEventListener('click', () => {
            if (!confirm('彻底清空回收站？此操作不可撤销。')) return;
            act('清空回收站', async () => {
                const r = await api('/empty-trash', { method: 'POST', body: { keepDays: 0 } });
                toastr.success(`已清空 ${r.removed} 个批次，释放 ${fmtBytes(r.freed)}`);
            });
        });

        $el('stj_updchk').addEventListener('click', () => checkUpdate(true));
        $el('stj_setup_copy').addEventListener('click', async () => {
            const ok = await copyText(installCmd());
            try { ok ? toastr.success('安装命令已复制，粘到酒馆那台机器的终端里跑') : toastr.warning('复制失败，手动选中命令复制吧'); } catch { /* ignore */ }
        });
        $el('stj_setup_retry').addEventListener('click', async () => {
            const s = await refresh();
            try { s ? toastr.success('服务端插件在啦 🎉') : toastr.warning('还没检测到，装完记得重启酒馆'); } catch { /* ignore */ }
        });
        $el('stj_upd_cancel').addEventListener('click', () => closeUpdateModal());
        $el('stj_upd_go').addEventListener('click', () => applyUpdate());

        const s = await refresh();
        if (s && s.config) fillConfig(s.config);
        setVersionLabel(s?.info?.version, null, false);
        checkUpdate(false);      // 载入面板时静默查一下，有新版就直接弹窗
        startPoll();
    }

    jQuery(async () => { await init(); });
})();
