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
        if (!res.ok) throw new Error(data.error || `${res.status}: ${text.slice(0, 200)}`);
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
        }
    }

    function collectConfig() {
        const rules = {};
        for (const r of RULES) {
            const entry = { enabled: !!$el('stj_r_' + r.id)?.checked };
            if (r.keep) entry.keepNewest = Number($el('stj_keep_' + r.id)?.value) || 0;
            if (r.age) entry.minAgeHours = Number($el('stj_age_' + r.id)?.value) || 24;
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

    async function refresh() {
        try {
            const s = await api('/status');
            if (s.running) setStatus(`⏳ 正在${s.kind === 'scan' ? '扫描' : '清理'}…`, 'stj-busy');
            else if (s.error) setStatus(`⚠️ 上次任务出错：${s.error}`, 'stj-bad');
            else setStatus('就绪 · ' + (s.auto?.mode === 'auto' ? `自动：${s.auto.text}` : '手动'), '');
            renderReport(s.lastReport);
            renderTrash(s.trash);
            return s;
        } catch (e) {
            setStatus(`⚠️ 连不上服务端插件：${e.message}`, 'stj-bad');
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

    function buildHtml() {
        const ruleRows = RULES.map(r => `
      <div class="stj-rule">
        <label class="stj-rule-main">
          <input type="checkbox" id="stj_r_${r.id}">
          <span><b>${r.label}</b><em>${r.hint}</em></span>
        </label>
        ${r.keep ? `<label class="stj-rule-num">保留<input type="number" id="stj_keep_${r.id}" min="0" value="10">份</label>` : ''}
        ${r.age ? `<label class="stj-rule-num">存续<input type="number" id="stj_age_${r.id}" min="0" value="24">小时</label>` : ''}
      </div>`).join('');

        return `
<div class="inline-drawer">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b>数据清洁工 (Data Janitor)</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content">
    <div class="stj-status" id="stj_status">加载中…</div>
    <div class="stj-hint">删东西前 <b>先入回收站</b>，可随时还原；默认只「试运行」不真删。</div>
    <div class="stj-rules">${ruleRows}</div>
    <div class="stj-row"><label>清理模式</label>
      <label class="stj-check"><input type="radio" name="stj_mode" id="stj_mode_manual" value="manual"> 手动</label>
      <label class="stj-check"><input type="radio" name="stj_mode" id="stj_mode_auto" value="auto"> 自动</label>
      <span class="stj-dim">（自动 = 到点自己跑）</span>
    </div>
    <div class="stj-row" id="stj_auto_box">
      <label>自动间隔</label>
      <input type="number" id="stj_ival" min="1" value="1" style="max-width:90px">
      <select id="stj_iunit">
        <option value="minutes">分钟</option>
        <option value="hours" selected>小时</option>
        <option value="days">天</option>
      </select>
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
    <div class="stj-sub">回收站</div>
    <div class="stj-trash" id="stj_trash"></div>
  </div>
</div>`;
    }

    async function init() {
        if ($el('stj_status') || !document.getElementById('extensions_settings')) return;
        $('#extensions_settings').append(buildHtml());

        $el('stj_save').addEventListener('click', () => act('保存配置', async () => {
            await api('/config', { method: 'POST', body: collectConfig() });
            toastr.success('配置已保存');
        }));
        $el('stj_mode_manual').addEventListener('change', toggleAutoBox);
        $el('stj_mode_auto').addEventListener('change', toggleAutoBox);
        $el('stj_scan').addEventListener('click', () => act('扫描', () => api('/scan', { method: 'POST', body: {} })));
        $el('stj_dry').addEventListener('click', () => act('试运行', () => api('/clean', { method: 'POST', body: { dryRun: true } })));
        $el('stj_go').addEventListener('click', () => {
            if (!confirm('确定清理？文件会先移入回收站（可还原），不是永久删除。')) return;
            act('清理', () => api('/clean', { method: 'POST', body: { dryRun: false } }));
        });
        $el('stj_empt').addEventListener('click', () => {
            if (!confirm('彻底清空回收站？此操作不可撤销。')) return;
            act('清空回收站', async () => {
                const r = await api('/empty-trash', { method: 'POST', body: { keepDays: 0 } });
                toastr.success(`已清空 ${r.removed} 个批次，释放 ${fmtBytes(r.freed)}`);
            });
        });

        const s = await refresh();
        if (s && s.config) fillConfig(s.config);
        startPoll();
    }

    jQuery(async () => { await init(); });
})();
