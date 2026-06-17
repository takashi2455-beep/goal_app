'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let currentTab   = 'bucket';
let currentDate  = new Date();
let currentMonth = new Date();
let currentWeek  = new Date();

let editId   = null;
let editKind = null;

const expandedIds   = new Set();   // expanded bucket item IDs
const subitemsMap   = new Map();   // subitem id  → subitem data
const bucketItemMap = new Map();   // bucket id   → bucket item data
const taskMap       = new Map();   // task id     → task data

let subitemBucketId   = null;
let subitemEditId     = null;
let subitemParentId   = null;
let pendingTimeItemId = null;  // bucket item
let pendingTimeSubitemId = null;  // subitem
let pendingTimeTaskId    = null;  // task

// ── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  updateLabels();
  loadBucket();

  document.addEventListener('click', e => {
    if (!e.target.closest('#export-btn') && !e.target.closest('#export-menu')) {
      document.getElementById('export-menu').classList.add('hidden');
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeAddModal(); closeEditModal(); closeSubitemModal(); closeTimeModal();
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (!document.getElementById('add-overlay').classList.contains('hidden'))     saveAdd();
      if (!document.getElementById('edit-overlay').classList.contains('hidden'))    saveEdit();
      if (!document.getElementById('subitem-overlay').classList.contains('hidden')) saveSubitem();
      if (!document.getElementById('time-overlay').classList.contains('hidden'))    saveTimeSpent();
    }
  });
});

// ── Tab ────────────────────────────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tab}`));
  if (tab === 'bucket')  loadBucket();
  if (tab === 'monthly') loadMonthly();
  if (tab === 'weekly')  loadWeekly();
  if (tab === 'daily')   loadDaily();
}

// ── Date helpers ───────────────────────────────────────────────────────────
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
function pad(n) { return String(n).padStart(2,'0'); }

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

// ── Navigation ─────────────────────────────────────────────────────────────
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

// ── API ────────────────────────────────────────────────────────────────────
async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Load ───────────────────────────────────────────────────────────────────
async function loadBucket() {
  const items = await api('/api/bucket-with-subitems');
  renderBucket(items);
}

async function loadMonthly() {
  const data = await api(`/api/monthly-combined?month=${fmtMonth(currentMonth)}`);
  renderMonthly(data.tasks, data.bucket_items, data.subitems || []);
}

async function loadWeekly() {
  const data = await api(`/api/weekly-combined?week=${fmtWeek(currentWeek)}`);
  renderWeekly(data.tasks, data.subitems);
}

async function loadDaily() {
  const data = await api(`/api/daily-combined?date=${fmtDate(currentDate)}`);
  renderDaily(data.tasks, data.subitems);
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

// ── Render helpers ─────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function emptyState(icon, msg) {
  return `<div class="empty"><div class="empty-icon">${icon}</div><p>${msg}</p></div>`;
}

// ── Bucket List render ─────────────────────────────────────────────────────
const CATEGORIES = [
  { key: 'must',          icon: '🔥' },
  { key: '読みたい本',     icon: '📚' },
  { key: '読みたい教科書', icon: '📖' },
  { key: '趣味',          icon: '🎯' },
  { key: '投資',          icon: '📈' },
];

function renderBucket(items) {
  bucketItemMap.clear();
  items.forEach(i => bucketItemMap.set(i.id, i));

  const el      = document.getElementById('bucket-list');
  const active  = items.filter(i => (i.status ?? 0) === 0);
  const done    = items.filter(i => (i.status ?? 0) === 1);
  const dropped = items.filter(i => (i.status ?? 0) === 2);
  let html = '';

  CATEGORIES.forEach(({ key, icon }) => {
    const catItems = active.filter(i => (i.category || 'must') === key);
    catItems.sort((a, b) => {
      const da = a.deadline_year ? a.deadline_year * 100 + (a.deadline_month || 13) : Infinity;
      const db = b.deadline_year ? b.deadline_year * 100 + (b.deadline_month || 13) : Infinity;
      if (da !== db) return da - db;
      return a.title.localeCompare(b.title, 'ja');
    });
    const badge = catItems.length ? `<span class="cat-count">${catItems.length}</span>` : '';
    html += `<div class="cat-header"><span class="cat-icon">${icon}</span>${key}${badge}</div>`;
    if (catItems.length) {
      catItems.forEach(i => { html += bucketItemHtml(i); });
    } else {
      html += `<div class="cat-empty">＋ 右下のボタンで追加</div>`;
    }
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
  const limit = m ? new Date(y, m - 1, 1) : new Date(y, 11, 31);
  const near  = (limit - new Date()) < 1000 * 60 * 60 * 24 * 92;
  return `<div class="deadline-badge${near ? ' near' : ''}">⏰ 期限: ${text}</div>`;
}

function bucketItemHtml(item) {
  const status     = item.status ?? 0;
  const isDone     = status === 1;
  const isDropped  = status === 2;
  const isInactive = isDone || isDropped;

  const subs       = item.subitems || [];
  const isExpanded = expandedIds.has(item.id);
  const subBadge   = subs.length ? `<span class="sub-badge">${subs.length}</span>` : '';

  subs.forEach(s => subitemsMap.set(s.id, s));

  let panel = `<div id="subs-${item.id}" class="subitems-panel${isExpanded ? '' : ' hidden'}">`;
  panel += renderSubitemNodes(subs, item.id, null);
  panel += `<button class="add-sub-btn" onclick="showAddSubitem(${item.id}, null)">＋ サブ項目を追加</button>`;
  panel += `</div>`;

  // 終了済みチェック (✓)
  const doneChk = `<div class="chk chk-sq${isDone ? ' on' : ''}" title="終了済み"
    onclick="setStatus(${item.id}, ${isDone ? 0 : 1})"></div>`;

  // やらないと決めたチェック (✕)
  const dropChk = `<div class="chk chk-drop${isDropped ? ' dropped' : ''}" title="やらないと決めた"
    onclick="setStatus(${item.id}, ${isDropped ? 0 : 2})"></div>`;

  const completedDateHtml = isDone && item.completed_at
    ? `<div class="task-sub">✓ 完了: ${item.completed_at.slice(0, 10)}</div>`
    : '';
  const timeHtml = isDone
    ? item.time_spent
      ? `<div class="time-badge" onclick="event.stopPropagation();showTimeModal(${item.id})">⏱ ${esc(item.time_spent)}</div>`
      : `<div class="time-badge empty" onclick="event.stopPropagation();showTimeModal(${item.id})">⏱ 時間を記録</div>`
    : '';

  return `
  <div>
    <div class="task-item${isInactive ? ' done' : ''}">
      ${doneChk}
      <div class="task-body" onclick="openEditBucket(${item.id})">
        <div class="task-title-text${isInactive ? ' done' : ''}">${esc(item.title)}</div>
        ${deadlineText(item)}
        ${item.description ? `<div class="task-sub">${esc(item.description)}</div>` : ''}
        ${completedDateHtml}
        ${timeHtml}
      </div>
      ${subBadge}
      <button class="expand-btn" onclick="toggleExpand(${item.id})">${isExpanded ? '▼' : '▶'}</button>
      ${dropChk}
      <span class="edit-arrow" onclick="openEditBucket(${item.id})">›</span>
    </div>
    ${panel}
  </div>`;
}

function renderSubitemNodes(subitems, bucketId, parentId) {
  const nodes = subitems.filter(s => (s.parent_id ?? null) === parentId);
  let html = '';
  nodes.forEach(s => {
    html += subitemRowHtml(s, bucketId);
    const childHtml = renderSubitemNodes(subitems, bucketId, s.id);
    if (childHtml) {
      html += `<div style="margin-left:18px">${childHtml}</div>`;
    }
  });
  return html;
}

function subitemRowHtml(s, bucketId) {
  subitemsMap.set(s.id, s);
  const monthLabel = s.deadline_year && s.deadline_month
    ? `<span class="sub-month-label">${s.deadline_year}年${s.deadline_month}月</span>`
    : s.deadline_year
    ? `<span class="sub-month-label">${s.deadline_year}年</span>` : '';
  const weekLabel = s.deadline_week
    ? `<span class="sub-week-label">${s.deadline_week}</span>` : '';
  const dateLabel = s.deadline_date
    ? `<span class="sub-date-label">${s.deadline_date}</span>` : '';
  const timeLabel = s.completed
    ? s.time_spent
      ? `<span class="sub-time-label" onclick="event.stopPropagation();showSubitemTimeModal(${s.id})">⏱ ${esc(s.time_spent)}</span>`
      : `<span class="sub-time-label empty" onclick="event.stopPropagation();showSubitemTimeModal(${s.id})">⏱ 時間を記録</span>`
    : '';
  const bid = bucketId ?? s.bucket_id;
  return `
  <div class="subitem-row${s.completed ? ' done' : ''}">
    <div class="sub-line"></div>
    <div class="chk${s.completed ? ' on' : ''}" onclick="toggleSubitem(${s.id})"></div>
    <div class="subitem-body">
      <span class="subitem-title${s.completed ? ' done' : ''}">${esc(s.title)}</span>
      ${monthLabel}${weekLabel}${dateLabel}${timeLabel}
    </div>
    <button class="add-sub-inline" onclick="showAddSubitem(${bid}, ${s.id})" title="サブ項目を追加">＋</button>
    <span class="edit-arrow" onclick="editSubitem(${s.id})">›</span>
  </div>`;
}

// ── Monthly render ─────────────────────────────────────────────────────────
function renderMonthly(tasks, bucketItems, subitems) {
  const el = document.getElementById('monthly-list');
  let html = '';
  let hasContent = false;

  if (tasks.length) {
    hasContent = true;
    html += `<div class="section-label">📋 月次タスク</div>`;
    const active = tasks.filter(t => !t.completed);
    const done   = tasks.filter(t =>  t.completed);
    active.forEach(t => { html += taskItemHtml(t); });
    if (done.length) {
      html += `<div class="section-label" style="margin-top:8px">完了済み (${done.length})</div>`;
      done.forEach(t => { html += taskItemHtml(t); });
    }
  }

  if (bucketItems.length) {
    hasContent = true;
    html += `<div class="section-label" style="margin-top:${tasks.length ? '14px' : '0'}">⭐ やりたいこと</div>`;
    bucketItems.forEach(item => { html += monthlyBucketItemHtml(item); });
  }

  if (subitems.length) {
    hasContent = true;
    html += `<div class="section-label" style="margin-top:14px">⭐ やりたいこと（サブ項目）</div>`;
    const active = subitems.filter(s => !s.completed);
    const done   = subitems.filter(s =>  s.completed);
    active.forEach(s => { html += monthlySubitemHtml(s); });
    if (done.length) {
      html += `<div class="section-label" style="margin-top:8px">完了済み (${done.length})</div>`;
      done.forEach(s => { html += monthlySubitemHtml(s); });
    }
  }

  if (!hasContent) html = emptyState('📋', 'タスクがありません');
  el.innerHTML = html;
}

function monthlySubitemHtml(s) {
  subitemsMap.set(s.id, s);
  const catIcon = (CATEGORIES.find(c => c.key === s.bucket_category) || {}).icon || '⭐';
  const dateLabel = s.deadline_date
    ? `<span class="sub-date-label">${s.deadline_date}</span>` : '';
  return `
  <div class="task-item${s.completed ? ' done' : ''}">
    <div class="chk${s.completed ? ' on' : ''}" onclick="toggleSubitemMonthly(${s.id})"></div>
    <div class="task-body">
      <div class="task-title-text${s.completed ? ' done' : ''}">${esc(s.title)}${dateLabel}</div>
      <div class="task-sub">${catIcon} ${esc(s.bucket_title)}</div>
    </div>
    <span class="edit-arrow" onclick="editSubitem(${s.id})">›</span>
  </div>`;
}

function monthlyBucketItemHtml(item) {
  const subs = item.subitems || [];
  subs.forEach(s => subitemsMap.set(s.id, s));

  let subsHtml = subs.map(s => {
    const wl = s.deadline_week ? `<span class="sub-week-label">${s.deadline_week}</span>` : '';
    return `
    <div class="subitem-row${s.completed ? ' done' : ''}">
      <div class="sub-line"></div>
      <div class="chk${s.completed ? ' on' : ''}" onclick="toggleSubitemMonthly(${s.id})"></div>
      <div class="subitem-body">
        <span class="subitem-title${s.completed ? ' done' : ''}">${esc(s.title)}</span>
        ${wl}
      </div>
    </div>`;
  }).join('');

  return `
  <div>
    <div class="task-item${item.completed ? ' done' : ''}">
      <div class="chk chk-sq${item.completed ? ' on' : ''}" onclick="toggleBucketMonthly(${item.id})"></div>
      <div class="task-body">
        <div class="task-title-text${item.completed ? ' done' : ''}">${esc(item.title)}</div>
      </div>
    </div>
    ${subsHtml}
  </div>`;
}

// ── Weekly render ──────────────────────────────────────────────────────────
function renderWeekly(tasks, subitems) {
  const el = document.getElementById('weekly-list');
  let html = '';

  if (tasks.length) {
    html += `<div class="section-label">📋 週次タスク</div>`;
    const active = tasks.filter(t => !t.completed);
    const done   = tasks.filter(t =>  t.completed);
    active.forEach(t => { html += taskItemHtml(t); });
    if (done.length) {
      html += `<div class="section-label" style="margin-top:8px">完了済み (${done.length})</div>`;
      done.forEach(t => { html += taskItemHtml(t); });
    }
  }

  if (subitems.length) {
    html += `<div class="section-label" style="margin-top:${tasks.length ? '14px' : '0'}">⭐ やりたいこと（サブ項目）</div>`;
    const active = subitems.filter(s => !s.completed);
    const done   = subitems.filter(s =>  s.completed);
    active.forEach(s => { html += weeklySubitemHtml(s); });
    if (done.length) {
      html += `<div class="section-label" style="margin-top:8px">完了済み (${done.length})</div>`;
      done.forEach(s => { html += weeklySubitemHtml(s); });
    }
  }

  if (!tasks.length && !subitems.length) {
    html = emptyState('📋', 'タスクがありません');
  }
  el.innerHTML = html;
}

function weeklySubitemHtml(s) {
  subitemsMap.set(s.id, s);
  const catIcon = (CATEGORIES.find(c => c.key === s.bucket_category) || {}).icon || '⭐';
  const dateLabel = s.deadline_date
    ? `<span class="sub-date-label">${s.deadline_date}</span>` : '';
  return `
  <div class="task-item${s.completed ? ' done' : ''}">
    <div class="chk${s.completed ? ' on' : ''}" onclick="toggleSubitemWeekly(${s.id})"></div>
    <div class="task-body">
      <div class="task-title-text${s.completed ? ' done' : ''}">${esc(s.title)}${dateLabel}</div>
      <div class="task-sub">${catIcon} ${esc(s.bucket_title)}</div>
    </div>
    <span class="edit-arrow" onclick="editSubitem(${s.id})">›</span>
  </div>`;
}

// ── Daily render ───────────────────────────────────────────────────────────
function renderDaily(tasks, subitems) {
  updateProgress(tasks);
  const el = document.getElementById('daily-list');
  let html = '';

  if (tasks.length) {
    const active = tasks.filter(t => !t.completed);
    const done   = tasks.filter(t =>  t.completed);
    active.forEach(t => { html += taskItemHtml(t); });
    if (done.length) {
      html += `<div class="section-label" style="margin-top:12px">完了済み (${done.length})</div>`;
      done.forEach(t => { html += taskItemHtml(t); });
    }
  }

  if (subitems.length) {
    html += `<div class="section-label" style="margin-top:${tasks.length ? '14px' : '0'}">⭐ やりたいこと（サブ項目）</div>`;
    const active = subitems.filter(s => !s.completed);
    const done   = subitems.filter(s =>  s.completed);
    active.forEach(s => { html += dailySubitemHtml(s); });
    if (done.length) {
      html += `<div class="section-label" style="margin-top:8px">完了済み (${done.length})</div>`;
      done.forEach(s => { html += dailySubitemHtml(s); });
    }
  }

  if (!tasks.length && !subitems.length) {
    html = emptyState('📋', 'タスクがありません');
  }
  el.innerHTML = html;
}

function dailySubitemHtml(s) {
  subitemsMap.set(s.id, s);
  const catIcon = (CATEGORIES.find(c => c.key === s.bucket_category) || {}).icon || '⭐';
  return `
  <div class="task-item${s.completed ? ' done' : ''}">
    <div class="chk${s.completed ? ' on' : ''}" onclick="toggleSubitemDaily(${s.id})"></div>
    <div class="task-body">
      <div class="task-title-text${s.completed ? ' done' : ''}">${esc(s.title)}</div>
      <div class="task-sub">${catIcon} ${esc(s.bucket_title)}</div>
    </div>
    <span class="edit-arrow" onclick="editSubitem(${s.id})">›</span>
  </div>`;
}

async function toggleSubitemDaily(id) {
  const u = await _toggleSubitem(id);
  if (u && u.completed) showSubitemTimeModal(id); else { loadBucket(); loadDaily(); }
}

// ── Task list render ───────────────────────────────────────────────────────
function renderTasks(listId, tasks) {
  const el = document.getElementById(listId);
  if (!tasks.length) { el.innerHTML = emptyState('📋', 'タスクがありません'); return; }
  const active = tasks.filter(t => !t.completed);
  const done   = tasks.filter(t =>  t.completed);
  let html = '';
  active.forEach(t => { html += taskItemHtml(t); });
  if (done.length) {
    html += `<div class="section-label" style="margin-top:12px">完了済み (${done.length})</div>`;
    done.forEach(t => { html += taskItemHtml(t); });
  }
  el.innerHTML = html;
}

function taskItemHtml(t) {
  taskMap.set(t.id, t);
  const roll = t.rolled_over_from ? '<span class="badge badge-roll">繰越</span>' : '';
  const completedDateHtml = t.completed && t.completed_at
    ? `<div class="task-sub">✓ 完了: ${t.completed_at.slice(0, 10)}</div>` : '';
  const timeHtml = t.completed
    ? t.time_spent
      ? `<div class="time-badge" onclick="event.stopPropagation();showTaskTimeModal(${t.id})">⏱ ${esc(t.time_spent)}</div>`
      : `<div class="time-badge empty" onclick="event.stopPropagation();showTaskTimeModal(${t.id})">⏱ 時間を記録</div>`
    : '';
  return `
  <div class="task-item${t.completed ? ' done' : ''}${t.rolled_over_from ? ' rolled' : ''}">
    <div class="chk${t.completed ? ' on' : ''}" onclick="toggleTask(${t.id})"></div>
    <div class="task-body" onclick="openEditTask(${t.id})">
      <div class="task-title-text${t.completed ? ' done' : ''}">${esc(t.title)}${roll}</div>
      ${completedDateHtml}
      ${timeHtml}
    </div>
    <span class="edit-arrow" onclick="openEditTask(${t.id})">›</span>
  </div>`;
}

// ── Expand / Collapse ──────────────────────────────────────────────────────
function toggleExpand(id) {
  if (expandedIds.has(id)) expandedIds.delete(id);
  else expandedIds.add(id);
  const panel = document.getElementById(`subs-${id}`);
  if (panel) panel.classList.toggle('hidden', !expandedIds.has(id));
  // update arrow text
  document.querySelectorAll('.expand-btn').forEach(btn => {
    if (btn.getAttribute('onclick') === `toggleExpand(${id})`) {
      btn.textContent = expandedIds.has(id) ? '▼' : '▶';
    }
  });
}

// ── Toggle ─────────────────────────────────────────────────────────────────
async function setStatus(id, status) {
  await api(`/api/bucket/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
  if (status === 1) {
    showTimeModal(id);
  } else {
    loadBucket();
    if (currentTab === 'monthly') loadMonthly();
    if (currentTab === 'weekly')  loadWeekly();
  }
}

// サブ項目の time_spent を分単位で合計する
function sumSubitemTime(subitems) {
  let total = 0, valid = false;
  for (const s of subitems) {
    if (!s.time_spent) continue;
    const v = String(s.time_spent).trim();
    let m = null;
    if (/^\d+$/.test(v))            m = parseInt(v);
    else if (/^(\d+)分$/.test(v))   m = parseInt(v);
    else if (/^(\d+)時間$/.test(v)) m = parseInt(v) * 60;
    else { const hm = v.match(/^(\d+)時間(\d+)分$/); if (hm) m = parseInt(hm[1]) * 60 + parseInt(hm[2]); }
    if (m !== null) { total += m; valid = true; }
  }
  return valid ? total + '分' : '';
}

function showTimeModal(id) {
  pendingTimeItemId    = id;
  pendingTimeSubitemId = null;
  const item = bucketItemMap.get(id);
  document.getElementById('time-modal-item-name').textContent = item ? item.title : '';
  let def = (item && item.time_spent) ? item.time_spent : '';
  if (!def && item && item.subitems && item.subitems.length) {
    def = sumSubitemTime(item.subitems);
  }
  document.getElementById('time-inp').value = def;
  document.getElementById('time-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('time-inp').focus(), 80);
}

function showSubitemTimeModal(id) {
  pendingTimeItemId    = null;
  pendingTimeSubitemId = id;
  pendingTimeTaskId    = null;
  const s = subitemsMap.get(id);
  document.getElementById('time-modal-item-name').textContent = s ? s.title : '';
  document.getElementById('time-inp').value = (s && s.time_spent) ? s.time_spent : '';
  document.getElementById('time-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('time-inp').focus(), 80);
}

function showTaskTimeModal(id) {
  pendingTimeItemId    = null;
  pendingTimeSubitemId = null;
  pendingTimeTaskId    = id;
  const t = taskMap.get(id);
  document.getElementById('time-modal-item-name').textContent = t ? t.title : '';
  document.getElementById('time-inp').value = (t && t.time_spent) ? t.time_spent : '';
  document.getElementById('time-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('time-inp').focus(), 80);
}

function closeTimeModal() {
  document.getElementById('time-overlay').classList.add('hidden');
  pendingTimeItemId    = null;
  pendingTimeSubitemId = null;
  pendingTimeTaskId    = null;
  loadBucket();
  if (currentTab === 'monthly') loadMonthly();
  if (currentTab === 'weekly')  loadWeekly();
  if (currentTab === 'daily')   loadDaily();
}

async function saveTimeSpent() {
  let val = document.getElementById('time-inp').value.trim();
  if (val && /^\d+(\.\d+)?$/.test(val)) val = val + '分';
  if (pendingTimeSubitemId != null) {
    await api(`/api/subitems/${pendingTimeSubitemId}/time-spent`, {
      method: 'PATCH', body: JSON.stringify({ time_spent: val })
    });
  } else if (pendingTimeTaskId != null) {
    await api(`/api/tasks/${pendingTimeTaskId}/time-spent`, {
      method: 'PATCH', body: JSON.stringify({ time_spent: val })
    });
  } else if (pendingTimeItemId != null) {
    await api(`/api/bucket/${pendingTimeItemId}/time-spent`, {
      method: 'PATCH', body: JSON.stringify({ time_spent: val })
    });
  }
  closeTimeModal();
}
async function toggleBucketMonthly(id) {
  const item = await api(`/api/bucket/${id}`);
  const newStatus = (item.status ?? 0) === 1 ? 0 : 1;
  await api(`/api/bucket/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: newStatus }) });
  loadBucket(); loadMonthly();
}
async function toggleTask(id) {
  const updated = await api(`/api/tasks/${id}/toggle`, { method: 'PATCH' });
  if (updated) taskMap.set(id, updated);
  if (updated && updated.completed) {
    showTaskTimeModal(id);
  } else {
    reloadCurrentTab();
  }
}
async function _toggleSubitem(id) {
  const updated = await api(`/api/subitems/${id}/toggle`, { method: 'PATCH' });
  if (updated) subitemsMap.set(id, { ...(subitemsMap.get(id) || {}), ...updated });
  return updated;
}
async function toggleSubitem(id) {
  const u = await _toggleSubitem(id);
  if (u && u.completed) showSubitemTimeModal(id); else loadBucket();
}
async function toggleSubitemMonthly(id) {
  const u = await _toggleSubitem(id);
  if (u && u.completed) showSubitemTimeModal(id); else { loadBucket(); loadMonthly(); }
}
async function toggleSubitemWeekly(id) {
  const u = await _toggleSubitem(id);
  if (u && u.completed) showSubitemTimeModal(id); else { loadBucket(); loadWeekly(); }
}

function reloadCurrentTab() {
  if (currentTab === 'daily')   loadDaily();
  if (currentTab === 'weekly')  loadWeekly();
  if (currentTab === 'monthly') loadMonthly();
}

// ── Add modal ──────────────────────────────────────────────────────────────
function setBucketFieldsVisible(prefix, visible) {
  ['desc', 'cat'].forEach(f => {
    document.getElementById(`${prefix}-${f}`).style.display = visible ? '' : 'none';
  });
  const overlayId = prefix === 'inp' ? 'add-overlay' : 'edit-overlay';
  document.querySelector(`#${overlayId} .deadline-row`).style.display = visible ? '' : 'none';
}

function showAddModal() {
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
  setBucketFieldsVisible('inp', isBucket);

  document.getElementById('add-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('inp-title').focus(), 80);
}

function closeAddModal() {
  document.getElementById('add-overlay').classList.add('hidden');
}

async function saveAdd() {
  const title = document.getElementById('inp-title').value.trim();
  if (!title) { document.getElementById('inp-title').focus(); return; }

  if (currentTab === 'bucket') {
    const year  = document.getElementById('inp-year').value.trim();
    const month = document.getElementById('inp-month').value;
    await api('/api/bucket', {
      method: 'POST',
      body: JSON.stringify({
        title,
        description:    document.getElementById('inp-desc').value.trim(),
        category:       document.getElementById('inp-cat').value,
        deadline_year:  year  ? parseInt(year)  : null,
        deadline_month: month ? parseInt(month) : null,
      })
    });
    closeAddModal(); loadBucket();
    return;
  }

  const body = { title, task_type: currentTab };
  if (currentTab === 'monthly') body.target_month = fmtMonth(currentMonth);
  if (currentTab === 'weekly')  body.target_week  = fmtWeek(currentWeek);
  if (currentTab === 'daily')   body.target_date  = fmtDate(currentDate);
  await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
  closeAddModal(); reloadCurrentTab();
}

// ── Edit modal ─────────────────────────────────────────────────────────────
async function openEditBucket(id) {
  const item = await api(`/api/bucket/${id}`);
  editId   = id;
  editKind = 'bucket';
  document.getElementById('edit-title').value = item.title;
  document.getElementById('edit-desc').value  = item.description || '';
  document.getElementById('edit-cat').value   = item.category    || 'must';
  document.getElementById('edit-year').value  = item.deadline_year  || '2026';
  document.getElementById('edit-month').value = item.deadline_month || '';
  setBucketFieldsVisible('edit', true);
  document.getElementById('edit-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('edit-title').focus(), 80);
}

async function openEditTask(id) {
  let tasks;
  if (currentTab === 'daily')   tasks = await api(`/api/tasks?type=daily&date=${fmtDate(currentDate)}`);
  if (currentTab === 'weekly')  tasks = await api(`/api/tasks?type=weekly&week=${fmtWeek(currentWeek)}`);
  if (currentTab === 'monthly') tasks = await api(`/api/tasks?type=monthly&month=${fmtMonth(currentMonth)}`);
  const task = (tasks || []).find(t => t.id === id);
  if (!task) return;
  editId   = id;
  editKind = 'task';
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
    await api(`/api/bucket/${editId}`, {
      method: 'PUT',
      body: JSON.stringify({
        title,
        description:    document.getElementById('edit-desc').value.trim(),
        category:       document.getElementById('edit-cat').value,
        deadline_year:  year  ? parseInt(year)  : null,
        deadline_month: month ? parseInt(month) : null,
      })
    });
    closeEditModal(); loadBucket();
    if (currentTab === 'monthly') loadMonthly();
  } else {
    await api(`/api/tasks/${editId}`, { method: 'PUT', body: JSON.stringify({ title }) });
    closeEditModal(); reloadCurrentTab();
  }
}

async function confirmDelete() {
  if (!confirm('このアイテムを削除しますか？')) return;
  if (editKind === 'bucket') {
    await api(`/api/bucket/${editId}`, { method: 'DELETE' });
    closeEditModal(); loadBucket();
    if (currentTab === 'monthly') loadMonthly();
  } else {
    await api(`/api/tasks/${editId}`, { method: 'DELETE' });
    closeEditModal(); reloadCurrentTab();
  }
}

// ── Subitem modal ──────────────────────────────────────────────────────────
function getWeeksInMonth(year, month) {
  const firstDay = new Date(year, month - 1, 1);
  const lastDay  = new Date(year, month, 0);
  let cur = new Date(firstDay);
  const dow = cur.getDay() || 7;
  if (dow > 1) cur.setDate(cur.getDate() - dow + 1);
  const weeks = [];
  while (cur <= lastDay) {
    const weekKey = fmtWeek(cur);
    const wEnd    = new Date(cur); wEnd.setDate(wEnd.getDate() + 6);
    const dStart  = cur < firstDay ? firstDay : new Date(cur);
    const dEnd    = wEnd > lastDay ? lastDay  : wEnd;
    weeks.push({
      week:  weekKey,
      label: `${weekKey}（${dStart.getMonth()+1}/${dStart.getDate()}〜${dEnd.getMonth()+1}/${dEnd.getDate()}）`
    });
    cur.setDate(cur.getDate() + 7);
  }
  return weeks;
}

function populateWeekDropdown(year, month, selectedWeek) {
  const sel = document.getElementById('sub-inp-week');
  sel.innerHTML = '<option value="">週（任意）</option>';
  if (!year || !month) return;
  getWeeksInMonth(parseInt(year), parseInt(month)).forEach(({ week, label }) => {
    const opt = document.createElement('option');
    opt.value = week;
    opt.textContent = label;
    if (week === selectedWeek) opt.selected = true;
    sel.appendChild(opt);
  });
}

function onSubYearMonthChange() {
  const y = document.getElementById('sub-inp-year').value;
  const m = document.getElementById('sub-inp-month').value;
  populateWeekDropdown(y, m, '');
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

  if (subitemEditId != null) {
    await api(`/api/subitems/${subitemEditId}`, { method: 'PUT', body: JSON.stringify(body) });
  } else {
    await api(`/api/bucket/${subitemBucketId}/subitems`, { method: 'POST', body: JSON.stringify(body) });
  }
  closeSubitemModal();
  loadBucket();
  if (currentTab === 'monthly') loadMonthly();
  if (currentTab === 'weekly')  loadWeekly();
}

async function confirmDeleteSubitem() {
  if (!confirm('このサブ項目を削除しますか？')) return;
  await api(`/api/subitems/${subitemEditId}`, { method: 'DELETE' });
  closeSubitemModal();
  loadBucket();
  if (currentTab === 'monthly') loadMonthly();
  if (currentTab === 'weekly')  loadWeekly();
}

// ── Export ─────────────────────────────────────────────────────────────────
function toggleExportMenu() {
  document.getElementById('export-menu').classList.toggle('hidden');
}

function exportFile(type) {
  window.location.href = `/api/export/${type}`;
  document.getElementById('export-menu').classList.add('hidden');
}
