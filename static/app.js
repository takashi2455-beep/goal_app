'use strict';

// Auto-detect API prefix for standalone (/api/...) vs portal (/goal/api/...)
const API_BASE = window.location.pathname.startsWith('/goal') ? '/goal' : '';

// ── State ────────────────────────────────────────────────────────────────────
let currentTab   = 'bucket';
let currentDate  = new Date();
let currentMonth = new Date();
let currentWeek  = new Date();
let editId   = null;
let editKind = null;

const LIFE_LEVEL_LABELS = ['', '人生の大きな目標', '達成に必要なこと', '今年やること'];

const expandedIds   = new Set();
const subitemsMap   = new Map();   // subitem id → raw data
const bucketItemMap = new Map();   // bucket  id → raw data
const taskMap       = new Map();   // task    id → raw data
const lifeGoalsMap  = new Map();   // life goal id → raw data

let subitemBucketId  = null;
let subitemEditId    = null;
let subitemParentId  = null;
let pendingTimeKind  = null;
let pendingTimeId    = null;
let lifeGoalEditId   = null;
let lifeGoalParentId = null;
let lifeGoalLevel    = 1;

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  updateLabels();
  api('/api/catchup', { method: 'POST', body: JSON.stringify({ today: fmtDate(new Date()) }) })
    .then(() => loadBucket());
  document.addEventListener('click', e => {
    if (!e.target.closest('#export-btn') && !e.target.closest('#export-menu'))
      document.getElementById('export-menu').classList.add('hidden');
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeAddModal(); closeEditModal(); closeSubitemModal(); closeTimeModal(); closeLifeModal(); }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (!document.getElementById('add-overlay').classList.contains('hidden'))     saveAdd();
      if (!document.getElementById('edit-overlay').classList.contains('hidden'))    saveEdit();
      if (!document.getElementById('subitem-overlay').classList.contains('hidden')) saveSubitem();
      if (!document.getElementById('time-overlay').classList.contains('hidden'))    saveTimeSpent();
      if (!document.getElementById('life-overlay').classList.contains('hidden'))    saveLifeGoal();
    }
  });
});

// ── Tab ──────────────────────────────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tab}`));
  if (tab === 'life')    loadLife();
  if (tab === 'bucket')  loadBucket();
  if (tab === 'monthly') loadMonthly();
  if (tab === 'weekly')  loadWeekly();
  if (tab === 'daily')   loadDaily();
}

// ── Date helpers ─────────────────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(d)  { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function fmtMonth(d) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}`; }
function fmtWeek(d) {
  const dt = new Date(d); dt.setHours(0,0,0,0);
  const dow = dt.getDay() || 7;
  dt.setDate(dt.getDate() + 4 - dow);
  const y1 = new Date(dt.getFullYear(), 0, 1);
  const wk = Math.ceil(((dt - y1) / 86400000 + 1) / 7);
  return `${dt.getFullYear()}-W${pad(wk)}`;
}
function weekRange(d) {
  const dt = new Date(d), dow = dt.getDay() || 7;
  const mon = new Date(dt); mon.setDate(dt.getDate() - dow + 1);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  return `${mon.getMonth()+1}/${mon.getDate()}〜${sun.getMonth()+1}/${sun.getDate()}`;
}
function monthJP(ym) {
  if (!ym) return null;
  const [y, m] = ym.split('-');
  return `${y}年${parseInt(m)}月`;
}

const MONTH_JP = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
const DAY_JP   = ['日','月','火','水','木','金','土'];

function updateLabels() {
  document.getElementById('monthly-label').textContent =
    `${currentMonth.getFullYear()}年 ${MONTH_JP[currentMonth.getMonth()]}`;
  document.getElementById('weekly-label').textContent =
    `${weekRange(currentWeek)}（${fmtWeek(currentWeek)}）`;
  const d = currentDate;
  document.getElementById('daily-label').textContent =
    `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}（${DAY_JP[d.getDay()]}）`;
}

// ── Navigation ───────────────────────────────────────────────────────────────
function changeMonth(delta) {
  currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + delta, 1);
  updateLabels(); loadMonthly();
}
function changeWeek(delta) {
  currentWeek = new Date(currentWeek); currentWeek.setDate(currentWeek.getDate() + delta * 7);
  updateLabels(); loadWeekly();
}
function changeDay(delta) {
  currentDate = new Date(currentDate); currentDate.setDate(currentDate.getDate() + delta);
  updateLabels(); loadDaily();
}

// ── API ──────────────────────────────────────────────────────────────────────
async function api(url, opts = {}) {
  const res = await fetch(API_BASE + url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Load ─────────────────────────────────────────────────────────────────────
async function loadBucket() {
  renderBucket(await api('/api/bucket-with-subitems'));
}
async function loadMonthly() {
  const data = await api(`/api/monthly-combined?month=${fmtMonth(currentMonth)}`);
  renderTab('monthly-list', '📋 月次タスク', data);
}
async function loadWeekly() {
  const data = await api(`/api/weekly-combined?week=${fmtWeek(currentWeek)}`);
  renderTab('weekly-list', '📋 週次タスク', data);
}
async function loadDaily() {
  const data = await api(`/api/daily-combined?date=${fmtDate(currentDate)}`);
  updateProgress(data.tasks || []);
  renderTab('daily-list', null, data);
}
function reloadAll() { loadBucket(); loadMonthly(); loadWeekly(); loadDaily(); }

// ── Helpers ──────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function emptyState(icon, msg) {
  return `<div class="empty"><div class="empty-icon">${icon}</div><p>${msg}</p></div>`;
}
function updateProgress(tasks) {
  const area = document.getElementById('daily-progress');
  if (!tasks.length) { area.classList.add('hidden'); return; }
  const done = tasks.filter(t => t.completed).length;
  const pct  = Math.round(done / tasks.length * 100);
  document.getElementById('progress-bar').style.width = pct + '%';
  document.getElementById('progress-text').textContent = `${done} / ${tasks.length} 完了 (${pct}%)`;
  area.classList.remove('hidden');
}

// ── Categories ───────────────────────────────────────────────────────────────
const CATEGORIES = [
  { key: 'must',          icon: '🔥' },
  { key: '読みたい本',     icon: '📚' },
  { key: '読みたい教科書', icon: '📖' },
  { key: '趣味',          icon: '🎯' },
  { key: '投資',          icon: '📈' },
];
function catIcon(key) { return (CATEGORIES.find(c => c.key === key) || {}).icon || '⭐'; }

// ── Normalize: raw API data → unified item shape ──────────────────────────────
function normalizeTask(t) {
  taskMap.set(t.id, t);
  return {
    _kind: 'task', id: t.id, title: t.title,
    done:      !!t.completed,
    dl_month:  monthJP(t.target_month),
    dl_week:   t.target_week  || null,
    dl_date:   t.target_date  || null,
    rolled:    !!t.rolled_over_from,
    time_spent:   t.time_spent   || null,
    completed_at: t.completed_at || null,
  };
}

function normalizeBucket(b) {
  bucketItemMap.set(b.id, b);
  (b.subitems || []).forEach(s => subitemsMap.set(s.id, s));
  const y = b.deadline_year, m = b.deadline_month;
  return {
    _kind: 'bucket', id: b.id, title: b.title,
    done:   b.status === 1,
    status: b.status ?? 0,
    dl_month: (y && m) ? `${y}年${m}月` : null,
    dl_week:  b.deadline_week  || null,
    dl_date:  b.deadline_date  || null,
    subitems:     b.subitems     || [],
    time_spent:   b.time_spent   || null,
    completed_at: b.completed_at || null,
  };
}

function normalizeSubitem(s) {
  subitemsMap.set(s.id, s);
  const y = s.deadline_year, m = s.deadline_month;
  return {
    _kind: 'subitem', id: s.id, title: s.title,
    done:    !!s.completed,
    dl_month: (y && m) ? `${y}年${m}月` : null,
    dl_week:  s.deadline_week || null,
    dl_date:  s.deadline_date || null,
    bucket_id:       s.bucket_id,
    parent_id:       s.parent_id ?? null,
    bucket_title:    s.bucket_title    || '',
    bucket_category: s.bucket_category || '',
    time_spent:  s.time_spent  || null,
  };
}

// ── Deadline badges (shared) ─────────────────────────────────────────────────
function dlBadges(item) {
  const m = item.dl_month ? `<span class="sub-month-label">${item.dl_month}</span>` : '';
  const w = item.dl_week  ? `<span class="sub-week-label">${item.dl_week}</span>`   : '';
  const d = item.dl_date  ? `<span class="sub-date-label">${item.dl_date}</span>`   : '';
  return (m || w || d) ? `<div class="task-deadline-badges">${m}${w}${d}</div>` : '';
}

// ── Unified item row (月/週/日 tabs) ─────────────────────────────────────────
function itemRow(item) {
  const isDone   = item.done;
  const chkClass = item._kind === 'bucket' ? 'chk chk-sq' : 'chk';

  const rollBadge  = item.rolled ? '<span class="badge badge-roll">繰越</span>' : '';
  const parentLine = item._kind === 'subitem' && item.bucket_title
    ? `<div class="task-sub">${catIcon(item.bucket_category)} ${esc(item.bucket_title)}</div>` : '';
  const doneLine  = isDone && item.completed_at
    ? `<div class="task-sub">✓ 完了: ${item.completed_at.slice(0,10)}</div>` : '';
  const timeLine  = isDone
    ? item.time_spent
      ? `<div class="time-badge" onclick="event.stopPropagation();showTimeForItem('${item._kind}',${item.id})">⏱ ${esc(item.time_spent)}</div>`
      : `<div class="time-badge empty" onclick="event.stopPropagation();showTimeForItem('${item._kind}',${item.id})">⏱ 時間を記録</div>`
    : '';

  const addParent = item._kind === 'subitem' ? item.bucket_id : item.id;
  const addChild  = item._kind === 'subitem' ? item.id : 'null';
  const addBtn = item._kind !== 'task'
    ? `<button class="add-sub-inline" onclick="showAddSubitem(${addParent},${addChild})" title="子項目を追加">＋</button>` : '';
  const dupBtn  = `<button class="dup-btn" onclick="event.stopPropagation();dupItem('${item._kind}',${item.id})" title="複製">⧉</button>`;
  const editArrow = `<span class="edit-arrow" onclick="editItem('${item._kind}',${item.id})">›</span>`;

  return `
  <div class="task-item${isDone ? ' done' : ''}${item.rolled ? ' rolled' : ''}">
    <div class="${chkClass}${isDone ? ' on' : ''}" onclick="toggleItem('${item._kind}',${item.id})"></div>
    <div class="task-body" onclick="editItem('${item._kind}',${item.id})">
      <div class="task-title-text${isDone ? ' done' : ''}">${esc(item.title)}${rollBadge}</div>
      ${parentLine}${dlBadges(item)}${doneLine}${timeLine}
    </div>
    ${addBtn}${dupBtn}${editArrow}
  </div>`;
}

// ── Tab render (月/週/日) ─────────────────────────────────────────────────────
function renderTab(listId, taskLabel, data) {
  const el          = document.getElementById(listId);
  const tasks       = data.tasks        || [];
  const bucketItems = data.bucket_items || [];
  const subitems    = data.subitems     || [];
  const rootIds     = data.root_subitem_ids || [];
  let html = '', hasContent = false;

  if (tasks.length) {
    hasContent = true;
    if (taskLabel) html += `<div class="section-label">${taskLabel}</div>`;
    const norm   = tasks.map(normalizeTask);
    const active = norm.filter(i => !i.done);
    const done   = norm.filter(i =>  i.done);
    active.forEach(i => { html += itemRow(i); });
    if (done.length) {
      html += `<div class="section-label" style="margin-top:8px">完了済み (${done.length})</div>`;
      done.forEach(i => { html += itemRow(i); });
    }
  }

  if (bucketItems.length) {
    hasContent = true;
    html += `<div class="section-label" style="margin-top:${tasks.length ? '14px' : '0'}">⭐ やりたいこと</div>`;
    const bActive = bucketItems.filter(b => b.status !== 1);
    const bDone   = bucketItems.filter(b => b.status === 1);
    bActive.forEach(b => { html += tabBucketItemHtml(b); });
    if (bDone.length) {
      html += `<div class="section-label" style="margin-top:8px">完了済み (${bDone.length})</div>`;
      bDone.forEach(b => { html += tabBucketItemHtml(b); });
    }
  }

  if (rootIds.length) {
    hasContent = true;
    html += `<div class="section-label" style="margin-top:14px">⭐ やりたいこと（サブ項目）</div>`;
    html += renderTabSubitems(subitems, rootIds);
  }

  el.innerHTML = hasContent ? html : emptyState('📋', 'タスクがありません');
}

function tabBucketItemHtml(raw) {
  const item     = normalizeBucket(raw);
  const subsHtml = renderSubitemNodes(raw.subitems || [], raw.id, null);
  return `<div>${itemRow(item)}<div class="subitems-panel">${subsHtml}</div></div>`;
}

function renderTabSubitems(allSubs, rootIds) {
  const rootSet = new Set(rootIds);
  const roots   = allSubs.filter(s => rootSet.has(s.id))
    .sort((a,b) => a.completed - b.completed || new Date(a.created_at) - new Date(b.created_at));
  const renderNodes = (nodes) => {
    let html = '';
    nodes.forEach(s => {
      html += itemRow(normalizeSubitem(s));
      const children = allSubs.filter(c => (c.parent_id ?? null) === s.id)
        .sort((a,b) => a.completed - b.completed || new Date(a.created_at) - new Date(b.created_at));
      if (children.length) html += `<div style="margin-left:18px">${renderNodes(children)}</div>`;
    });
    return html;
  };
  const active = roots.filter(s => !s.completed);
  const done   = roots.filter(s =>  s.completed);
  let html = renderNodes(active);
  if (done.length) {
    html += `<div class="section-label" style="margin-top:8px">完了済み (${done.length})</div>`;
    html += renderNodes(done);
  }
  return html;
}

// ── Bucket tab render (やりたいこと) ─────────────────────────────────────────
function renderBucket(items) {
  bucketItemMap.clear();
  items.forEach(i => bucketItemMap.set(i.id, i));
  const el      = document.getElementById('bucket-list');
  const active  = items.filter(i => (i.status ?? 0) === 0);
  const done    = items.filter(i => (i.status ?? 0) === 1);
  const dropped = items.filter(i => (i.status ?? 0) === 2);
  let html = '';

  CATEGORIES.forEach(({ key, icon }) => {
    const catItems = active.filter(i => (i.category || 'must') === key)
      .sort((a,b) => {
        const da = a.deadline_year ? a.deadline_year*100+(a.deadline_month||13) : Infinity;
        const db = b.deadline_year ? b.deadline_year*100+(b.deadline_month||13) : Infinity;
        return da !== db ? da - db : a.title.localeCompare(b.title, 'ja');
      });
    const badge = catItems.length ? `<span class="cat-count">${catItems.length}</span>` : '';
    html += `<div class="cat-header"><span class="cat-icon">${icon}</span>${key}${badge}</div>`;
    catItems.length
      ? catItems.forEach(i => { html += bucketItemHtml(i); })
      : (html += `<div class="cat-empty">＋ 右下のボタンで追加</div>`);
  });

  if (done.length) {
    html += `<div class="section-label" style="margin-top:14px">✓ 終了済み (${done.length})</div>`;
    done.forEach(i => { html += bucketItemHtml(i); });
  }
  if (dropped.length) {
    html += `<div class="section-label" style="margin-top:8px">— やらないと決めた (${dropped.length})</div>`;
    dropped.forEach(i => { html += bucketItemHtml(i); });
  }
  el.innerHTML = html;
}

function deadlineText(item) {
  if (!item.deadline_year) return '';
  const y = item.deadline_year, m = item.deadline_month;
  const text  = m ? `${y}年${m}月` : `${y}年`;
  const limit = m ? new Date(y, m-1, 1) : new Date(y, 11, 31);
  const near  = (limit - new Date()) < 1000*60*60*24*92;
  return `<div class="deadline-badge${near ? ' near' : ''}">⏰ 期限: ${text}</div>`;
}

function bucketItemHtml(item) {
  const status     = item.status ?? 0;
  const isDone     = status === 1;
  const isDropped  = status === 2;
  const isInactive = isDone || isDropped;
  const subs       = item.subitems || [];
  const isExpanded = expandedIds.has(item.id);
  subs.forEach(s => subitemsMap.set(s.id, s));

  const panel = `<div id="subs-${item.id}" class="subitems-panel${isExpanded ? '' : ' hidden'}">
    ${renderSubitemNodes(subs, item.id, null)}
    <button class="add-sub-btn" onclick="showAddSubitem(${item.id},null)">＋ サブ項目を追加</button>
  </div>`;

  const doneChk = `<div class="chk chk-sq${isDone ? ' on' : ''}" title="終了済み"
    onclick="setStatus(${item.id},${isDone ? 0 : 1})"></div>`;
  const dropChk = `<div class="chk chk-drop${isDropped ? ' dropped' : ''}" title="やらないと決めた"
    onclick="setStatus(${item.id},${isDropped ? 0 : 2})"></div>`;
  const doneLine = isDone && item.completed_at
    ? `<div class="task-sub">✓ 完了: ${item.completed_at.slice(0,10)}</div>` : '';
  const timeLine = isDone
    ? item.time_spent
      ? `<div class="time-badge" onclick="event.stopPropagation();showTimeForItem('bucket',${item.id})">⏱ ${esc(item.time_spent)}</div>`
      : `<div class="time-badge empty" onclick="event.stopPropagation();showTimeForItem('bucket',${item.id})">⏱ 時間を記録</div>`
    : '';
  const subBadge = subs.length ? `<span class="sub-badge">${subs.length}</span>` : '';

  return `
  <div>
    <div class="task-item${isInactive ? ' done' : ''}">
      ${doneChk}
      <div class="task-body" onclick="openEditBucket(${item.id})">
        <div class="task-title-text${isInactive ? ' done' : ''}">${esc(item.title)}</div>
        ${deadlineText(item)}
        ${item.description ? `<div class="task-sub">${esc(item.description)}</div>` : ''}
        ${doneLine}${timeLine}
      </div>
      ${subBadge}
      <button class="expand-btn" onclick="toggleExpand(${item.id})">${isExpanded ? '▼' : '▶'}</button>
      ${dropChk}
      <button class="dup-btn" onclick="event.stopPropagation();dupItem('bucket',${item.id})" title="複製">⧉</button>
      <span class="edit-arrow" onclick="openEditBucket(${item.id})">›</span>
    </div>
    ${panel}
  </div>`;
}

function renderSubitemNodes(subs, bucketId, parentId) {
  let html = '';
  subs.filter(s => (s.parent_id ?? null) === parentId).forEach(s => {
    html += subitemRowHtml(s, bucketId);
    html += renderSubitemNodes(subs, bucketId, s.id);
  });
  return html;
}

function subitemRowHtml(s, bucketId) {
  subitemsMap.set(s.id, s);
  const y = s.deadline_year, m = s.deadline_month;
  const mLabel = (y && m) ? `<span class="sub-month-label">${y}年${m}月</span>`
    : y ? `<span class="sub-month-label">${y}年</span>` : '';
  const wLabel = s.deadline_week ? `<span class="sub-week-label">${s.deadline_week}</span>` : '';
  const dLabel = s.deadline_date ? `<span class="sub-date-label">${s.deadline_date}</span>` : '';
  const tLabel = s.completed
    ? s.time_spent
      ? `<span class="sub-time-label" onclick="event.stopPropagation();showTimeForItem('subitem',${s.id})">⏱ ${esc(s.time_spent)}</span>`
      : `<span class="sub-time-label empty" onclick="event.stopPropagation();showTimeForItem('subitem',${s.id})">⏱ 時間を記録</span>`
    : '';
  const bid = bucketId ?? s.bucket_id;
  return `
  <div class="subitem-row${s.completed ? ' done' : ''}">
    <div class="sub-line"></div>
    <div class="chk${s.completed ? ' on' : ''}" onclick="toggleItem('subitem',${s.id})"></div>
    <div class="subitem-body">
      <span class="subitem-title${s.completed ? ' done' : ''}">${esc(s.title)}</span>
      ${mLabel}${wLabel}${dLabel}${tLabel}
    </div>
    <button class="add-sub-inline" onclick="showAddSubitem(${bid},${s.id})" title="子項目を追加">＋</button>
    <button class="dup-btn" onclick="event.stopPropagation();dupItem('subitem',${s.id})" title="複製">⧉</button>
    <span class="edit-arrow" onclick="editItem('subitem',${s.id})">›</span>
  </div>`;
}

// ── Toggle ───────────────────────────────────────────────────────────────────
async function toggleItem(kind, id) {
  if (kind === 'task') {
    const u = await api(`/api/tasks/${id}/toggle`, { method: 'PATCH' });
    if (u) taskMap.set(id, u);
    if (u?.completed) showTimeForItem('task', id); else reloadAll();
  } else if (kind === 'bucket') {
    const raw = await api(`/api/bucket/${id}`);
    const newStatus = (raw.status ?? 0) === 1 ? 0 : 1;
    await api(`/api/bucket/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: newStatus }) });
    if (newStatus === 1) showTimeForItem('bucket', id); else reloadAll();
  } else if (kind === 'subitem') {
    const u = await api(`/api/subitems/${id}/toggle`, { method: 'PATCH' });
    if (u) subitemsMap.set(id, { ...(subitemsMap.get(id)||{}), ...u });
    if (u?.completed) showTimeForItem('subitem', id); else reloadAll();
  }
}

async function setStatus(id, status) {
  await api(`/api/bucket/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
  if (status === 1) showTimeForItem('bucket', id); else reloadAll();
}

// ── Edit / Dup routing ───────────────────────────────────────────────────────
function editItem(kind, id) {
  if (kind === 'task')    openEditTask(id);
  if (kind === 'bucket')  openEditBucket(id);
  if (kind === 'subitem') editSubitem(id);
}

async function dupItem(kind, id) {
  if (kind === 'task')    await api(`/api/tasks/${id}/duplicate`,    { method: 'POST' });
  if (kind === 'bucket')  await api(`/api/bucket/${id}/duplicate`,   { method: 'POST' });
  if (kind === 'subitem') await api(`/api/subitems/${id}/duplicate`, { method: 'POST' });
  reloadAll();
}

// ── Expand ───────────────────────────────────────────────────────────────────
function toggleExpand(id) {
  expandedIds.has(id) ? expandedIds.delete(id) : expandedIds.add(id);
  const panel = document.getElementById(`subs-${id}`);
  if (panel) panel.classList.toggle('hidden', !expandedIds.has(id));
  document.querySelectorAll('.expand-btn').forEach(btn => {
    if (btn.getAttribute('onclick') === `toggleExpand(${id})`)
      btn.textContent = expandedIds.has(id) ? '▼' : '▶';
  });
}

// ── Time modal ───────────────────────────────────────────────────────────────
function sumSubitemTime(subitems) {
  let total = 0, valid = false;
  for (const s of subitems) {
    if (!s.time_spent) continue;
    const v = String(s.time_spent).trim();
    let m = null;
    if (/^\d+$/.test(v))            m = parseInt(v);
    else if (/^(\d+)分$/.test(v))   m = parseInt(v);
    else if (/^(\d+)時間$/.test(v)) m = parseInt(v)*60;
    else { const hm = v.match(/^(\d+)時間(\d+)分$/); if (hm) m = parseInt(hm[1])*60+parseInt(hm[2]); }
    if (m !== null) { total += m; valid = true; }
  }
  return valid ? total + '分' : '';
}

function showTimeForItem(kind, id) {
  pendingTimeKind = kind;
  pendingTimeId   = id;
  let title = '', val = '';
  if (kind === 'task')    { const t = taskMap.get(id);       title = t?.title||''; val = t?.time_spent||''; }
  if (kind === 'subitem') { const s = subitemsMap.get(id);   title = s?.title||''; val = s?.time_spent||''; }
  if (kind === 'bucket')  {
    const b = bucketItemMap.get(id);
    title = b?.title||''; val = b?.time_spent||'';
    if (!val && b?.subitems?.length) val = sumSubitemTime(b.subitems);
  }
  document.getElementById('time-modal-item-name').textContent = title;
  document.getElementById('time-inp').value = val;
  document.getElementById('time-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('time-inp').focus(), 80);
}

function closeTimeModal() {
  document.getElementById('time-overlay').classList.add('hidden');
  pendingTimeKind = pendingTimeId = null;
  reloadAll();
}

async function saveTimeSpent() {
  let val = document.getElementById('time-inp').value.trim();
  if (val && /^\d+(\.\d+)?$/.test(val)) val = val + '分';
  const endpoints = { task: 'tasks', bucket: 'bucket', subitem: 'subitems' };
  if (pendingTimeKind && pendingTimeId != null)
    await api(`/api/${endpoints[pendingTimeKind]}/${pendingTimeId}/time-spent`,
              { method: 'PATCH', body: JSON.stringify({ time_spent: val }) });
  closeTimeModal();
}

// ── Add modal ────────────────────────────────────────────────────────────────
function setBucketFieldsVisible(prefix, visible) {
  ['desc','cat'].forEach(f => {
    document.getElementById(`${prefix}-${f}`).style.display = visible ? '' : 'none';
  });
  const overlayId = prefix === 'inp' ? 'add-overlay' : 'edit-overlay';
  document.querySelectorAll(`#${overlayId} .deadline-row`).forEach(el => {
    el.style.display = visible ? '' : 'none';
  });
}

function showAddModal() {
  if (currentTab === 'life') { openLifeModal(1, null); return; }
  const isBucket = currentTab === 'bucket';
  document.getElementById('add-title').textContent =
    isBucket ? 'やりたいこと追加' :
    currentTab === 'monthly' ? '月次タスク追加' :
    currentTab === 'weekly'  ? '週次タスク追加' : '日次タスク追加';
  document.getElementById('inp-title').value = '';
  document.getElementById('inp-desc').value  = '';
  document.getElementById('inp-cat').value   = 'must';
  document.getElementById('inp-year').value  = '2026';
  document.getElementById('inp-month').value = '';
  document.getElementById('inp-week').innerHTML = '<option value="">週（任意）</option>';
  document.getElementById('inp-date').value  = '';
  setBucketFieldsVisible('inp', isBucket);
  document.getElementById('add-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('inp-title').focus(), 80);
}

function closeAddModal() { document.getElementById('add-overlay').classList.add('hidden'); }

async function saveAdd() {
  const title = document.getElementById('inp-title').value.trim();
  if (!title) { document.getElementById('inp-title').focus(); return; }

  if (currentTab === 'bucket') {
    const year  = document.getElementById('inp-year').value.trim();
    const month = document.getElementById('inp-month').value;
    await api('/api/bucket', { method: 'POST', body: JSON.stringify({
      title,
      description:    document.getElementById('inp-desc').value.trim(),
      category:       document.getElementById('inp-cat').value,
      deadline_year:  year  ? parseInt(year)  : null,
      deadline_month: month ? parseInt(month) : null,
      deadline_week:  document.getElementById('inp-week').value || null,
      deadline_date:  document.getElementById('inp-date').value || null,
    })});
    closeAddModal(); reloadAll();
    return;
  }

  const body = { title, task_type: currentTab };
  if (currentTab === 'monthly') {
    body.target_month = fmtMonth(currentMonth);
  } else if (currentTab === 'weekly') {
    body.target_week  = fmtWeek(currentWeek);
    body.target_month = fmtMonth(currentWeek);
  } else if (currentTab === 'daily') {
    body.target_date  = fmtDate(currentDate);
    body.target_week  = fmtWeek(currentDate);
    body.target_month = fmtMonth(currentDate);
  }
  await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
  closeAddModal(); reloadAll();
}

// ── Edit modal ───────────────────────────────────────────────────────────────
async function openEditBucket(id) {
  const item = await api(`/api/bucket/${id}`);
  editId = id; editKind = 'bucket';
  document.getElementById('edit-title').value = item.title;
  document.getElementById('edit-desc').value  = item.description || '';
  document.getElementById('edit-cat').value   = item.category    || 'must';
  document.getElementById('edit-year').value  = item.deadline_year  || '2026';
  document.getElementById('edit-month').value = item.deadline_month || '';
  document.getElementById('edit-date').value  = item.deadline_date  || '';
  populateWeekDropdown(item.deadline_year||'2026', item.deadline_month||'', item.deadline_week||'', 'edit-week');
  setBucketFieldsVisible('edit', true);
  document.getElementById('edit-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('edit-title').focus(), 80);
}

function openEditTask(id) {
  const task = taskMap.get(id);
  if (!task) return;
  editId = id; editKind = 'task';
  document.getElementById('edit-title').value = task.title;
  setBucketFieldsVisible('edit', false);
  document.getElementById('edit-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('edit-title').focus(), 80);
}

function closeEditModal() {
  document.getElementById('edit-overlay').classList.add('hidden');
  editId = editKind = null;
}

async function saveEdit() {
  const title = document.getElementById('edit-title').value.trim();
  if (!title) { document.getElementById('edit-title').focus(); return; }
  if (editKind === 'bucket') {
    const year  = document.getElementById('edit-year').value.trim();
    const month = document.getElementById('edit-month').value;
    await api(`/api/bucket/${editId}`, { method: 'PUT', body: JSON.stringify({
      title,
      description:    document.getElementById('edit-desc').value.trim(),
      category:       document.getElementById('edit-cat').value,
      deadline_year:  year  ? parseInt(year)  : null,
      deadline_month: month ? parseInt(month) : null,
      deadline_week:  document.getElementById('edit-week').value || null,
      deadline_date:  document.getElementById('edit-date').value || null,
    })});
  } else {
    await api(`/api/tasks/${editId}`, { method: 'PUT', body: JSON.stringify({ title }) });
  }
  closeEditModal(); reloadAll();
}

async function confirmDelete() {
  if (!confirm('このアイテムを削除しますか？')) return;
  if (editKind === 'bucket') await api(`/api/bucket/${editId}`, { method: 'DELETE' });
  else                        await api(`/api/tasks/${editId}`,  { method: 'DELETE' });
  closeEditModal(); reloadAll();
}

// ── Subitem modal ────────────────────────────────────────────────────────────
function getWeeksInMonth(year, month) {
  const firstDay = new Date(year, month-1, 1);
  const lastDay  = new Date(year, month, 0);
  let cur = new Date(firstDay);
  const dow = cur.getDay() || 7;
  if (dow > 1) cur.setDate(cur.getDate() - dow + 1);
  const weeks = [];
  while (cur <= lastDay) {
    const weekKey = fmtWeek(cur);
    const wEnd = new Date(cur); wEnd.setDate(wEnd.getDate() + 6);
    const dS = cur < firstDay ? firstDay : new Date(cur);
    const dE = wEnd > lastDay ? lastDay  : wEnd;
    weeks.push({ week: weekKey, label: `${weekKey}（${dS.getMonth()+1}/${dS.getDate()}〜${dE.getMonth()+1}/${dE.getDate()}）` });
    cur.setDate(cur.getDate() + 7);
  }
  return weeks;
}

function populateWeekDropdown(year, month, selectedWeek, selectId = 'sub-inp-week') {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  sel.innerHTML = '<option value="">週（任意）</option>';
  if (!year || !month) return;
  getWeeksInMonth(parseInt(year), parseInt(month)).forEach(({ week, label }) => {
    const opt = document.createElement('option');
    opt.value = week; opt.textContent = label;
    if (week === selectedWeek) opt.selected = true;
    sel.appendChild(opt);
  });
}

function onSubYearMonthChange() {
  populateWeekDropdown(
    document.getElementById('sub-inp-year').value,
    document.getElementById('sub-inp-month').value,
    '', 'sub-inp-week'
  );
}
function onBucketYearMonthChange(prefix) {
  populateWeekDropdown(
    document.getElementById(`${prefix}-year`).value,
    document.getElementById(`${prefix}-month`).value,
    '', `${prefix}-week`
  );
}

function showAddSubitem(bucketId, parentSubId) {
  const item      = bucketItemMap.get(bucketId);
  const parentSub = parentSubId ? subitemsMap.get(parentSubId) : null;
  subitemBucketId = bucketId;
  subitemEditId   = null;
  subitemParentId = parentSubId ?? null;
  const refYear  = parentSub?.deadline_year  || item?.deadline_year  || '2026';
  const refMonth = parentSub?.deadline_month || item?.deadline_month || '';
  document.getElementById('subitem-title').textContent = parentSubId ? 'サブ項目追加（子）' : 'サブ項目追加';
  document.getElementById('sub-delete-btn').classList.add('hidden');
  document.getElementById('sub-inp-title').value = '';
  document.getElementById('sub-inp-year').value  = refYear;
  document.getElementById('sub-inp-month').value = refMonth;
  document.getElementById('sub-inp-date').value  = '';
  populateWeekDropdown(refYear, refMonth, '');
  document.getElementById('subitem-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('sub-inp-title').focus(), 80);
}

function editSubitem(id) {
  const s = subitemsMap.get(id);
  if (!s) return;
  subitemBucketId = null;
  subitemEditId   = s.id;
  document.getElementById('subitem-title').textContent = 'サブ項目編集';
  document.getElementById('sub-delete-btn').classList.remove('hidden');
  document.getElementById('sub-inp-title').value = s.title || '';
  document.getElementById('sub-inp-year').value  = s.deadline_year  || '2026';
  document.getElementById('sub-inp-month').value = s.deadline_month || '';
  document.getElementById('sub-inp-date').value  = s.deadline_date  || '';
  populateWeekDropdown(s.deadline_year, s.deadline_month, s.deadline_week || '');
  document.getElementById('subitem-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('sub-inp-title').focus(), 80);
}

function closeSubitemModal() {
  document.getElementById('subitem-overlay').classList.add('hidden');
  subitemBucketId = subitemEditId = subitemParentId = null;
}

async function saveSubitem() {
  const title = document.getElementById('sub-inp-title').value.trim();
  if (!title) { document.getElementById('sub-inp-title').focus(); return; }
  const year  = document.getElementById('sub-inp-year').value.trim();
  const month = document.getElementById('sub-inp-month').value;
  const week  = document.getElementById('sub-inp-week').value;
  const ddate = document.getElementById('sub-inp-date').value;
  const body  = {
    title,
    deadline_year:  year  ? parseInt(year)  : null,
    deadline_month: month ? parseInt(month) : null,
    deadline_week:  week  || null,
    deadline_date:  ddate || null,
    parent_id:      subitemParentId ?? null,
  };
  if (subitemEditId != null)
    await api(`/api/subitems/${subitemEditId}`, { method: 'PUT', body: JSON.stringify(body) });
  else
    await api(`/api/bucket/${subitemBucketId}/subitems`, { method: 'POST', body: JSON.stringify(body) });
  closeSubitemModal(); reloadAll();
}

async function confirmDeleteSubitem() {
  if (!confirm('このサブ項目を削除しますか？')) return;
  await api(`/api/subitems/${subitemEditId}`, { method: 'DELETE' });
  closeSubitemModal(); reloadAll();
}

// ── Life Goals ───────────────────────────────────────────────────────────────
async function loadLife() {
  const goals = await api('/api/life-goals');
  lifeGoalsMap.clear();
  goals.forEach(g => lifeGoalsMap.set(g.id, g));
  renderLife(goals);
}

function renderLife(goals) {
  const el = document.getElementById('life-list');
  if (!goals || goals.length === 0) {
    el.innerHTML = emptyState('🌟', '人生の目標をまだ登録していません');
    return;
  }
  const map = new Map();
  const roots = [];
  goals.forEach(g => map.set(g.id, { ...g, children: [] }));
  goals.forEach(g => {
    if (g.parent_id && map.has(g.parent_id))
      map.get(g.parent_id).children.push(map.get(g.id));
    else
      roots.push(map.get(g.id));
  });

  const ADD_LABELS = ['', '必要なことを追加', '今年やることを追加', ''];

  function renderNode(node) {
    const doneClass = node.completed ? ' life-done' : '';
    const checkSvg = node.completed
      ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`
      : '';
    let childrenHtml = node.children.length
      ? `<div class="life-children">${node.children.map(renderNode).join('')}</div>`
      : '';
    const addChildBtn = node.level < 3
      ? `<button class="life-add-child" onclick="event.stopPropagation();openLifeModal(${node.level+1},${node.id})">＋ ${ADD_LABELS[node.level]}</button>`
      : '';
    return `
      <div class="life-goal-l${node.level}${doneClass}">
        <div class="life-goal-row">
          <button class="life-chk" onclick="event.stopPropagation();toggleLifeGoal(${node.id})">${checkSvg}</button>
          <span class="life-title">${esc(node.title)}</span>
          <button class="life-edit-btn" onclick="event.stopPropagation();openLifeEditModal(${node.id})">…</button>
        </div>
        ${node.description ? `<p class="life-desc">${esc(node.description)}</p>` : ''}
        ${childrenHtml}
        ${addChildBtn}
      </div>`;
  }

  el.innerHTML = roots.map(renderNode).join('');
}

function openLifeModal(level, parentId) {
  lifeGoalLevel    = level;
  lifeGoalParentId = parentId ?? null;
  lifeGoalEditId   = null;
  document.getElementById('life-modal-title').textContent = `${LIFE_LEVEL_LABELS[level]}を追加`;
  document.getElementById('life-inp-title').value = '';
  document.getElementById('life-inp-desc').value  = '';
  document.getElementById('life-delete-btn').classList.add('hidden');
  document.getElementById('life-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('life-inp-title').focus(), 50);
}

function openLifeEditModal(id) {
  const goal = lifeGoalsMap.get(id);
  if (!goal) return;
  lifeGoalEditId   = id;
  lifeGoalLevel    = goal.level;
  lifeGoalParentId = goal.parent_id;
  document.getElementById('life-modal-title').textContent = `${LIFE_LEVEL_LABELS[goal.level]}を編集`;
  document.getElementById('life-inp-title').value = goal.title;
  document.getElementById('life-inp-desc').value  = goal.description || '';
  document.getElementById('life-delete-btn').classList.remove('hidden');
  document.getElementById('life-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('life-inp-title').focus(), 50);
}

function closeLifeModal() {
  document.getElementById('life-overlay').classList.add('hidden');
  lifeGoalEditId = lifeGoalParentId = null;
}

async function saveLifeGoal() {
  const title = document.getElementById('life-inp-title').value.trim();
  if (!title) { document.getElementById('life-inp-title').focus(); return; }
  const desc = document.getElementById('life-inp-desc').value.trim();
  if (lifeGoalEditId != null) {
    await api(`/api/life-goals/${lifeGoalEditId}`, { method: 'PUT', body: JSON.stringify({ title, description: desc }) });
  } else {
    await api('/api/life-goals', { method: 'POST', body: JSON.stringify({ title, description: desc, level: lifeGoalLevel, parent_id: lifeGoalParentId }) });
  }
  closeLifeModal();
  loadLife();
}

async function toggleLifeGoal(id) {
  await api(`/api/life-goals/${id}/toggle`, { method: 'PATCH' });
  loadLife();
}

async function confirmDeleteLifeGoal() {
  if (!confirm('この項目とその子項目をすべて削除しますか？')) return;
  await api(`/api/life-goals/${lifeGoalEditId}`, { method: 'DELETE' });
  closeLifeModal();
  loadLife();
}

// ── Export ───────────────────────────────────────────────────────────────────
function toggleExportMenu() { document.getElementById('export-menu').classList.toggle('hidden'); }
function exportFile(type) {
  window.location.href = `${API_BASE}/api/export/${type}`;
  document.getElementById('export-menu').classList.add('hidden');
}
