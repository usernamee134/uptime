import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, WEEKLY_GOAL_HOURS } from './config.js';

// ================= утилиты =================

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDay = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const startOfWeek = (d) => { const x = startOfDay(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const fmtDate = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
const fmtTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
function fmtHMS(sec) {
  sec = Math.max(0, Math.floor(sec));
  return `${Math.floor(sec / 3600)}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}`;
}
function fmtHM(sec) {
  const m = Math.max(0, Math.round(sec / 60));
  return `${Math.floor(m / 60)} ч ${pad(m % 60)} м`;
}
function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const COLORS = ['#ef4444', '#f5b83d', '#4ade80', '#c084fc', '#38bdf8'];
const GOAL = WEEKLY_GOAL_HOURS * 3600;
const DAILY_GOAL_H = WEEKLY_GOAL_HOURS / 7;

// ================= состояние =================

const state = {
  user: null,
  profiles: [],
  sessions: [],
  reports: [],
  timers: [],          // текущие заходы (секундомер/таймер), по одному на человека
  laps: [],            // флажки
  closed: new Map(),   // userId -> Map(dayKey -> секунды) только по закрытым сессиям
  tab: 'home',
  period: 'week',
  clockOffset: 0,      // серверное время - локальное, мс
  uiMode: localStorage.getItem('uiMode') || 'stopwatch',
  timerMin: Number(localStorage.getItem('timerMin')) || 50,
  pendingLap: null,    // { at: Date, elapsed: сек } — флажок, ждущий подписи
};
let barChart = null;
let busy = false;
let controlsKey = '';

const now = () => new Date(Date.now() + state.clockOffset);

if (SUPABASE_URL.includes('YOUR-PROJECT') || SUPABASE_ANON_KEY.includes('YOUR-')) {
  $('#config-error').hidden = false;
  throw new Error('config.js не заполнен');
}

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

if (window.Chart) {
  Chart.defaults.color = '#a3908c';
  Chart.defaults.borderColor = '#2f2525';
}

// ================= подсчёт времени =================

// раскидывает интервал по дням (сессия через полночь делится)
function addSplit(map, start, end) {
  let s = new Date(start);
  while (s < end) {
    const next = startOfDay(addDays(s, 1));
    const e = next < end ? next : end;
    const k = dayKey(s);
    map.set(k, (map.get(k) || 0) + (e - s) / 1000);
    s = e;
  }
}

function rebuildClosed() {
  state.closed = new Map(state.profiles.map((p) => [p.id, new Map()]));
  for (const s of state.sessions) {
    if (!s.ended_at) continue;
    const m = state.closed.get(s.user_id);
    if (m) addSplit(m, new Date(s.started_at), new Date(s.ended_at));
  }
}

const running = (uid) => state.sessions.find((s) => s.user_id === uid && !s.ended_at);

// текущий заход человека: сколько натикало (без пауз), идёт или на паузе, когда таймер дойдёт до нуля
function blockInfo(uid) {
  const t = state.timers.find((x) => x.user_id === uid);
  const run = running(uid);
  if (!t && !run) return null;
  const blockStart = t ? new Date(t.block_started_at) : new Date(run.started_at);
  let closed = 0;
  for (const s of state.sessions) {
    if (s.user_id !== uid || !s.ended_at || new Date(s.started_at) < blockStart) continue;
    closed += (new Date(s.ended_at) - new Date(s.started_at)) / 1000;
  }
  const n = now();
  const elapsed = closed + (run ? Math.max(0, (n - new Date(run.started_at)) / 1000) : 0);
  const mode = t?.mode ?? 'stopwatch';
  const target = mode === 'timer' ? t.target_seconds : null;
  // момент окончания таймера — только если он наступает внутри текущей сессии
  const reachAt = run && target && closed < target
    ? new Date(new Date(run.started_at).getTime() + (target - closed) * 1000)
    : null;
  return { mode, target, elapsed, closed, run, paused: !run, reachAt, blockStart };
}

function blockLaps(uid, b) {
  return state.laps.filter((l) => l.user_id === uid && new Date(l.at) >= b.blockStart);
}

// секунды по дням, включая идущий секундомер
function totals(uid) {
  const m = new Map(state.closed.get(uid) || []);
  const r = running(uid);
  if (r) addSplit(m, new Date(r.started_at), now());
  return m;
}

function sumRange(m, from, days) {
  let t = 0;
  for (let i = 0; i < days; i++) t += m.get(dayKey(addDays(from, i))) || 0;
  return t;
}

const colorOf = (uid) => COLORS[Math.max(0, state.profiles.findIndex((p) => p.id === uid)) % COLORS.length];
const nameOf = (uid) => state.profiles.find((p) => p.id === uid)?.name ?? '???';
const orderedPeople = () => [...state.profiles].sort((a, b) => (b.id === state.user.id) - (a.id === state.user.id));

// ================= загрузка данных =================

async function fetchAll(table, orderCols) {
  const out = [];
  const step = 1000; // лимит Supabase на один запрос
  for (let from = 0; ; from += step) {
    let q = sb.from(table).select('*');
    for (const c of orderCols) q = q.order(c, { ascending: true });
    const { data, error } = await q.range(from, from + step - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < step) break;
  }
  return out;
}

async function loadProfiles() { state.profiles = await fetchAll('profiles', ['created_at', 'id']); rebuildClosed(); }
async function loadSessions() { state.sessions = await fetchAll('sessions', ['id']); rebuildClosed(); }
async function loadReports() { state.reports = await fetchAll('reports', ['day', 'user_id']); }
async function loadTimers() { state.timers = await fetchAll('timers', ['user_id']); }
async function loadLaps() { state.laps = await fetchAll('laps', ['id']); }

async function syncClock() {
  const t0 = Date.now();
  const { data, error } = await sb.rpc('server_now');
  const t1 = Date.now();
  if (!error && data) state.clockOffset = new Date(data).getTime() - (t0 + t1) / 2;
}

async function loadAll() {
  await Promise.all([loadProfiles(), syncClock()]);
  await Promise.all([loadSessions(), loadReports(), loadTimers(), loadLaps()]);
}

// ================= рендер: главная =================

function renderPeople() {
  const n = now();
  const today = dayKey(n);
  const ws = startOfWeek(n);
  const dayIdx = (n.getDay() + 6) % 7;   // 0 = понедельник
  const daysLeft = 7 - dayIdx;            // включая сегодня

  $('#people').innerHTML = orderedPeople().map((p) => {
    const m = totals(p.id);
    const b = blockInfo(p.id);
    const week = sumRange(m, ws, 7);
    let status = '<span class="muted">не работает</span>';
    let dot = '';
    if (b && b.paused) {
      dot = 'paused';
      status = `на паузе · <span class="mono">${fmtHMS(b.elapsed)}</span>`;
    } else if (b) {
      dot = 'on';
      status = b.target && b.elapsed < b.target
        ? `таймер · осталось <span class="mono">${fmtHMS(b.target - b.elapsed)}</span>`
        : `работает · <span class="mono">${fmtHMS(b.elapsed)}</span>`;
    }
    const lastFlag = [...state.laps].reverse()
      .find((l) => l.user_id === p.id && dayKey(new Date(l.at)) === today);
    const day = m.get(today) || 0;
    const left = Math.max(0, GOAL - week);
    const plan = (GOAL * dayIdx) / 7;     // сколько должно быть к началу сегодняшнего дня
    const diff = week - plan;
    const isMe = p.id === state.user.id;
    return `
      <div class="card person" style="--c:${colorOf(p.id)}">
        <div class="person-head">
          <span class="dot ${dot}"></span>
          <b>${esc(p.name)}</b>${isMe ? ' <span class="muted">(ты)</span>' : ''}
        </div>
        <div class="status">${status}</div>
        <div class="kv"><span>Сегодня</span><b class="mono">${fmtHM(day)}</b></div>
        <div class="kv"><span>Неделя</span><b class="mono">${fmtHM(week)} / ${WEEKLY_GOAL_HOURS} ч</b></div>
        <div class="bar"><div style="width:${Math.min(100, (week / GOAL) * 100)}%"></div></div>
        <div class="kv small">
          <span>${left > 0 ? `Осталось ${fmtHM(left)} · ~${fmtHM(left / daysLeft)}/день` : 'Цель недели выполнена ✅'}</span>
          <span class="${diff >= 0 ? 'good' : 'bad'}" title="Относительно равномерного плана ${DAILY_GOAL_H.toFixed(1)} ч/день на начало сегодняшнего дня">
            ${diff >= 0 ? '+' : '−'}${fmtHM(Math.abs(diff))} к плану
          </span>
        </div>
        ${lastFlag ? `<div class="flag">🚩 ${fmtTime(new Date(lastFlag.at))}${lastFlag.note ? ` — ${esc(lastFlag.note)}` : ''}</div>` : ''}
      </div>`;
  }).join('');
}

function renderTimer() {
  const uid = state.user.id;
  const b = blockInfo(uid);
  const n = now();
  const today = totals(uid).get(dayKey(n)) || 0;
  const mode = b ? b.mode : state.uiMode;

  // табло
  let text, sub = '', cls = '';
  if (!b) {
    text = mode === 'timer' ? fmtHMS(state.timerMin * 60) : '0:00:00';
  } else if (b.target) {
    const left = b.target - b.elapsed;
    if (left > 0) {
      text = fmtHMS(left);
      sub = `таймер ${Math.round(b.target / 60)} мин · прошло ${fmtHMS(b.elapsed)}`;
    } else {
      text = `+${fmtHMS(-left)}`;
      sub = `время вышло · всего ${fmtHMS(b.elapsed)}`;
      if (b.paused) cls = 'done';
    }
  } else {
    text = fmtHMS(b.elapsed);
  }
  if (b?.paused) {
    sub = sub ? `на паузе · ${sub}` : 'на паузе';
    if (!cls) cls = 'paused';
  }
  const el = $('#my-time');
  el.textContent = text;
  el.className = `big mono ${cls}`;
  $('#my-sub').textContent = sub;
  $('#my-today').textContent = `Сегодня всего: ${fmtHM(today)}`;
  document.title = b ? `${b.paused ? '⏸' : '▶'} ${text} · 60 ч` : '60 ч / неделю';

  // переключатель режима — только когда нет захода
  $$('#mode button').forEach((x) => {
    x.classList.toggle('active', x.dataset.mode === mode);
    x.disabled = !!b;
  });
  $('#timer-setup').hidden = !!b || mode !== 'timer';

  // кнопки — перерисовываем только при смене состояния, чтобы не дёргались
  const st = !b ? 'idle' : b.paused ? 'paused' : 'running';
  const key = `${st}|${busy}`;
  if (key !== controlsKey) {
    controlsKey = key;
    const dis = busy ? 'disabled' : '';
    $('#timer-controls').innerHTML = {
      idle: `<button class="big-btn primary" data-act="start" ${dis}>▶ Старт</button>`,
      running: `<button class="big-btn pause" data-act="pause" ${dis}>⏸ Пауза</button>
                <button class="big-btn" data-act="flag" ${dis}>🚩 Флажок</button>
                <button class="big-btn" data-act="reset" ${dis}>⏹ Сброс</button>`,
      paused: `<button class="big-btn primary" data-act="resume" ${dis}>▶ Продолжить</button>
               <button class="big-btn" data-act="reset" ${dis}>⏹ Сброс</button>`,
    }[st];
  }
  if (!b && state.pendingLap) { state.pendingLap = null; $('#lap-input').hidden = true; }
}

function renderLaps() {
  const uid = state.user.id;
  const b = blockInfo(uid);
  const list = $('#laps');
  if (!b) { list.innerHTML = ''; return; }
  const laps = blockLaps(uid, b);
  let prev = 0;
  const rows = laps.map((l, i) => {
    const split = l.elapsed_seconds - prev;
    prev = l.elapsed_seconds;
    return `
      <li>
        <b>🚩${i + 1}</b>
        <span class="mono">${fmtHMS(l.elapsed_seconds)}</span>
        <span class="mono muted">+${fmtHMS(split)}</span>
        <span class="note">${esc(l.note || '')}</span>
        <span class="mono muted">${fmtTime(new Date(l.at))}</span>
        <button class="del" data-lap="${l.id}" title="Удалить флажок">✕</button>
      </li>`;
  });
  list.innerHTML = rows.reverse().join('');
}

function renderMySessions() {
  const mine = state.sessions.filter((s) => s.user_id === state.user.id).slice(-15).reverse();
  if (!mine.length) {
    $('#my-sessions').innerHTML = '<li class="muted">Пока ни одной сессии. Жми «Старт».</li>';
    return;
  }
  $('#my-sessions').innerHTML = mine.map((s) => {
    const st = new Date(s.started_at);
    const en = s.ended_at ? new Date(s.ended_at) : null;
    const dur = ((en || now()) - st) / 1000;
    return `
      <li>
        <span class="mono">${fmtDate(st)}</span>
        <span class="mono">${fmtTime(st)} – ${en ? fmtTime(en) : '…'}</span>
        <span class="spacer"></span>
        <b class="mono">${en ? fmtHM(dur) : 'идёт'}</b>
        ${en ? `<button class="del" data-id="${s.id}" title="Удалить">✕</button>` : ''}
      </li>`;
  }).join('');
}

// ================= рендер: статистика =================

function periodRange() {
  const n = now();
  switch (state.period) {
    case 'lastweek': return [addDays(startOfWeek(n), -7), 7];
    case '30': return [addDays(startOfDay(n), -29), 30];
    case '90': return [addDays(startOfDay(n), -89), 90];
    default: return [startOfWeek(n), 7];
  }
}

function renderBar() {
  const [from, n] = periodRange();
  const days = Array.from({ length: n }, (_, i) => addDays(from, i));
  const labels = days.map((d) => (n <= 7 ? `${DAY_NAMES[(d.getDay() + 6) % 7]} ${fmtDate(d)}` : fmtDate(d)));
  const people = orderedPeople();
  const maps = new Map(people.map((p) => [p.id, totals(p.id)]));

  const datasets = people.map((p) => ({
    label: p.name,
    backgroundColor: colorOf(p.id),
    borderRadius: 3,
    data: days.map((d) => +(((maps.get(p.id).get(dayKey(d)) || 0) / 3600).toFixed(2))),
  }));
  datasets.push({
    type: 'line',
    label: `план ${DAILY_GOAL_H.toFixed(1)} ч/день`,
    data: days.map(() => +DAILY_GOAL_H.toFixed(2)),
    borderColor: '#8b93a7',
    borderDash: [6, 4],
    borderWidth: 1,
    pointRadius: 0,
  });

  $('#period-totals').innerHTML = people.map((p) =>
    `<span style="color:${colorOf(p.id)}">${esc(p.name)}: <b class="mono">${fmtHM(sumRange(maps.get(p.id), from, n))}</b></span>`
  ).join('');

  if (!window.Chart) { $('.chart-wrap').textContent = 'Chart.js не загрузился'; return; }
  if (barChart) barChart.destroy();
  barChart = new Chart($('#bar'), {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: { y: { beginAtZero: true, title: { display: true, text: 'часы' } } },
      plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(1)} ч` } } },
    },
  });
}

function heatLevel(sec) {
  const h = sec / 3600;
  if (h <= 0) return 0;
  if (h < 2) return 1;
  if (h < 4) return 2;
  if (h < 6) return 3;
  if (h < 8) return 4;
  return 5;
}
const LEVEL_ALPHA = [0, 0.25, 0.45, 0.65, 0.85, 1];

function renderHeatmaps() {
  const n = now();
  const todayKey = dayKey(n);
  const start = addDays(startOfWeek(n), -52 * 7);

  $('#heatmaps').innerHTML = orderedPeople().map((p) => {
    const m = totals(p.id);
    const color = colorOf(p.id);
    const cells = [];
    let yearTotal = 0, activeDays = 0, lastMonth = -1;

    // подписи дней слева
    ['Пн', '', 'Ср', '', 'Пт', '', ''].forEach((l, i) =>
      cells.push(`<div class="dlabel" style="grid-row:${i + 2};grid-column:1">${l}</div>`));

    for (let w = 0; w < 53; w++) {
      const weekStart = addDays(start, w * 7);
      if (weekStart.getMonth() !== lastMonth) {
        lastMonth = weekStart.getMonth();
        cells.push(`<div class="mlabel" style="grid-row:1;grid-column:${w + 2}">${MONTHS[lastMonth]}</div>`);
      }
      for (let d = 0; d < 7; d++) {
        const day = addDays(weekStart, d);
        const k = dayKey(day);
        const pos = `grid-row:${d + 2};grid-column:${w + 2}`;
        if (day > n && k !== todayKey) { cells.push(`<div class="cell future" style="${pos}"></div>`); continue; }
        const sec = m.get(k) || 0;
        yearTotal += sec;
        if (sec > 0) activeDays++;
        const lvl = heatLevel(sec);
        const bg = lvl ? `background:${hexToRgba(color, LEVEL_ALPHA[lvl])};` : '';
        cells.push(`<div class="cell" style="${pos};${bg}" title="${fmtDate(day)}.${day.getFullYear()}: ${fmtHM(sec)}"></div>`);
      }
    }

    // текущая серия дней подряд (сегодня можно ещё не начинать)
    let streak = 0;
    let d = (m.get(todayKey) || 0) > 0 ? startOfDay(n) : addDays(startOfDay(n), -1);
    while ((m.get(dayKey(d)) || 0) > 0) { streak++; d = addDays(d, -1); }

    const legend = LEVEL_ALPHA.map((a, i) =>
      `<span class="cell" style="background:${i ? hexToRgba(color, a) : 'var(--empty)'}"></span>`).join('');

    return `
      <div class="hm-block">
        <div class="hm-title">
          <b style="color:${color}">${esc(p.name)}</b>
          <span class="muted">за год: <b class="mono">${fmtHM(yearTotal)}</b></span>
          <span class="muted">активных дней: <b>${activeDays}</b></span>
          <span class="muted">серия: <b>${streak}</b> дн.</span>
        </div>
        <div class="hm">${cells.join('')}</div>
        <div class="hm-legend">0 ч ${legend} 8+ ч</div>
      </div>`;
  }).join('');
}

function renderWeeks() {
  const table = $('#weeks');
  if (!state.sessions.length) { table.innerHTML = '<tr><td class="muted">Пока пусто</td></tr>'; return; }
  const people = orderedPeople();
  const maps = people.map((p) => totals(p.id));
  const first = state.sessions.reduce((a, s) => (s.started_at < a ? s.started_at : a), state.sessions[0].started_at);
  const firstWeek = startOfWeek(new Date(first));
  const cur = startOfWeek(now());

  const rows = [];
  for (let w = cur; w >= firstWeek; w = addDays(w, -7)) {
    const isCur = w.getTime() === cur.getTime();
    const cells = maps.map((m) => {
      const s = sumRange(m, w, 7);
      const mark = isCur ? '⏳' : s >= GOAL ? '✅' : '❌';
      return `<td class="mono">${fmtHM(s)} ${mark}</td>`;
    }).join('');
    rows.push(`<tr><td>${fmtDate(w)} – ${fmtDate(addDays(w, 6))}</td>${cells}</tr>`);
  }
  table.innerHTML =
    `<tr><th>Неделя</th>${people.map((p) => `<th style="color:${colorOf(p.id)}">${esc(p.name)}</th>`).join('')}</tr>` +
    rows.join('');
}

function renderStats() { renderBar(); renderHeatmaps(); renderWeeks(); }

// ================= рендер: отчёты =================

function myReport(day) { return state.reports.find((r) => r.user_id === state.user.id && r.day === day); }

function renderReportEditor() {
  const day = $('#report-day').value;
  $('#report-text').value = myReport(day)?.text ?? '';
  $('#report-msg').textContent = '';
  renderReportHours();
}

function renderReportHours() {
  const day = $('#report-day').value;
  $('#report-hours').textContent = `Наработано за ${fmtDate(parseDay(day))}: ${fmtHM(totals(state.user.id).get(day) || 0)}`;
}

function renderFeed() {
  const days = new Set([...state.reports.map((r) => r.day), ...state.laps.map((l) => dayKey(new Date(l.at)))]);
  days.add(dayKey(now()));
  const sorted = [...days].sort().reverse();
  const people = orderedPeople();
  const maps = new Map(people.map((p) => [p.id, totals(p.id)]));

  $('#feed').innerHTML = sorted.map((day) => {
    const d = parseDay(day);
    const blocks = people.map((p) => {
      const r = state.reports.find((x) => x.user_id === p.id && x.day === day);
      return `
        <div class="rep" style="--c:${colorOf(p.id)}">
          <div class="rep-head">
            <b style="color:${colorOf(p.id)}">${esc(p.name)}</b>
            <span class="muted mono">${fmtHM(maps.get(p.id).get(day) || 0)}</span>
          </div>
          <div class="rep-text ${r ? '' : 'muted'}">${r ? esc(r.text) : '— нет отчёта'}</div>
          ${state.laps.filter((l) => l.user_id === p.id && dayKey(new Date(l.at)) === day).map((l) =>
            `<div class="flag">🚩 ${fmtTime(new Date(l.at))} · <span class="mono">${fmtHMS(l.elapsed_seconds)}</span>${l.note ? ` — ${esc(l.note)}` : ''}</div>`
          ).join('')}
        </div>`;
    }).join('');
    return `
      <div class="card feed-day">
        <h3>${DAY_NAMES[(d.getDay() + 6) % 7]}, ${fmtDate(d)}.${d.getFullYear()}</h3>
        ${blocks}
      </div>`;
  }).join('');
}

// ================= общий рендер =================

function renderAll() {
  renderTimer();
  if (state.tab === 'home') { renderPeople(); renderMySessions(); renderLaps(); }
  if (state.tab === 'stats') renderStats();
  if (state.tab === 'reports') { renderReportHours(); renderFeed(); }
}

function switchTab(tab) {
  state.tab = tab;
  $$('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab').forEach((s) => (s.hidden = s.id !== `tab-${tab}`));
  renderAll();
}

// ================= действия =================

async function rpc(fn, args) {
  if (busy) return;
  busy = true;
  renderTimer();
  const { error } = await sb.rpc(fn, args);
  if (error) alert(`Ошибка: ${error.message}`);
  try { await Promise.all([loadSessions(), loadTimers()]); } catch (e) { console.error(e); }
  busy = false;
  renderAll();
}

async function timerAction(act) {
  ensureAudio();
  const b = blockInfo(state.user.id);
  switch (act) {
    case 'start': {
      if (state.uiMode === 'timer') {
        const min = Math.round(Number($('#timer-min').value));
        if (!(min >= 1 && min <= 720)) { alert('Таймер: от 1 до 720 минут'); return; }
        setTimerMin(min);
        if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
        return rpc('start_timer', { p_mode: 'timer', p_target: min * 60 });
      }
      return rpc('start_timer', { p_mode: 'stopwatch' });
    }
    case 'resume': return rpc('start_timer');
    case 'pause': return rpc('pause_timer');
    case 'reset': {
      if (b && !confirm(`Сбросить? Наработанные ${fmtHM(b.elapsed)} сохранятся в статистике.`)) return;
      return rpc('finish_timer');
    }
    case 'flag': {
      if (!b) return;
      state.pendingLap = { at: now(), elapsed: Math.floor(b.elapsed) };
      $('#lap-at').textContent = fmtHMS(state.pendingLap.elapsed);
      $('#lap-note').value = '';
      $('#lap-input').hidden = false;
      $('#lap-note').focus();
    }
  }
}

async function saveLap() {
  const p = state.pendingLap;
  if (!p) return;
  state.pendingLap = null;
  $('#lap-input').hidden = true;
  const note = $('#lap-note').value.trim() || null;
  const { error } = await sb.from('laps').insert({
    user_id: state.user.id, at: p.at.toISOString(), elapsed_seconds: p.elapsed, note,
  });
  if (error) alert(`Ошибка: ${error.message}`);
  await loadLaps();
  renderAll();
}

function cancelLap() {
  state.pendingLap = null;
  $('#lap-input').hidden = true;
}

async function deleteLap(id) {
  if (!confirm('Удалить флажок?')) return;
  const { error } = await sb.from('laps').delete().eq('id', id);
  if (error) alert(`Ошибка: ${error.message}`);
  await loadLaps();
  renderAll();
}

function setTimerMin(min) {
  state.timerMin = min;
  localStorage.setItem('timerMin', String(min));
  $('#timer-min').value = min;
}

// ---- звук и уведомление по окончании таймера ----
let audioCtx = null;
function ensureAudio() {
  // браузер разрешает звук только после клика пользователя — создаём контекст при нажатии кнопок
  try { audioCtx ??= new AudioContext(); audioCtx.resume(); } catch { /* нет звука — не страшно */ }
}
function beep() {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  for (let i = 0; i < 3; i++) {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 880;
    o.connect(g).connect(audioCtx.destination);
    const s = t0 + i * 0.4;
    g.gain.setValueAtTime(0.0001, s);
    g.gain.exponentialRampToValueAtTime(0.4, s + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, s + 0.3);
    o.start(s);
    o.stop(s + 0.35);
  }
}
function notify(body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification('⏱ 60 ч', { body }); } catch { /* мобильные браузеры */ }
  }
}

// таймер дошёл до нуля → пауза ровно в момент окончания
let autoPausing = false;
async function checkAutoPause() {
  const b = blockInfo(state.user.id);
  if (!b?.reachAt || autoPausing || busy) return;
  const late = now() - b.reachAt;
  if (late < 0) return;
  autoPausing = true;
  const { error } = await sb.rpc('pause_timer', { p_at: b.reachAt.toISOString() });
  if (error) console.error(error);
  try { await loadSessions(); } catch (e) { console.error(e); }
  autoPausing = false;
  if (late < 90_000) { // если вкладка была закрыта давно — молча
    beep();
    notify(`Таймер ${Math.round(b.target / 60)} мин закончился`);
  }
  renderAll();
}

async function deleteSession(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  const st = new Date(s.started_at);
  if (!confirm(`Удалить сессию ${fmtDate(st)} ${fmtTime(st)} (${fmtHM((new Date(s.ended_at) - st) / 1000)})?`)) return;
  const { error } = await sb.from('sessions').delete().eq('id', id);
  if (error) alert(`Ошибка: ${error.message}`);
  await loadSessions();
  renderAll();
}

async function saveReport() {
  const day = $('#report-day').value;
  const text = $('#report-text').value.trim();
  const btn = $('#report-save');
  btn.disabled = true;
  let error;
  if (text) {
    ({ error } = await sb.from('reports').upsert(
      { user_id: state.user.id, day, text, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,day' },
    ));
  } else {
    ({ error } = await sb.from('reports').delete().eq('user_id', state.user.id).eq('day', day));
  }
  btn.disabled = false;
  $('#report-msg').textContent = error ? `Ошибка: ${error.message}` : 'Сохранено ✓';
  await loadReports();
  renderFeed();
}

// ================= realtime =================

let channel = null;
const timers = {};
function debounce(key, fn) {
  clearTimeout(timers[key]);
  timers[key] = setTimeout(fn, 300);
}

function subscribe() {
  const onChange = (key, loader) => () => debounce(key, async () => {
    try { await loader(); renderAll(); } catch (e) { console.error(e); }
  });
  channel = sb.channel('db')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, onChange('s', loadSessions))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'reports' }, onChange('r', loadReports))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, onChange('p', loadProfiles))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'timers' }, onChange('t', loadTimers))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'laps' }, onChange('l', loadLaps))
    .subscribe();
}

// ================= запуск / авторизация =================

async function startApp(user) {
  state.user = user;
  $('#auth').hidden = true;
  $('#app').hidden = false;
  $('#report-day').value = dayKey(new Date());

  try {
    await loadAll();
  } catch (e) {
    alert(`Не удалось загрузить данные: ${e.message}`);
    return;
  }
  $('#me-name').textContent = nameOf(user.id);
  renderReportEditor();
  switchTab('home');
  subscribe();

  // тик раз в секунду: только лёгкие обновления
  checkAutoPause();
  setInterval(() => {
    checkAutoPause();
    renderTimer();
    if (state.tab === 'home') renderPeople();
  }, 1000);

  // вернулся во вкладку — перезагрузить (websocket мог отвалиться)
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    try { await loadAll(); renderAll(); } catch (e) { console.error(e); }
  });
}

let signupMode = false;
function setAuthMode(signup) {
  signupMode = signup;
  $('#auth-name').hidden = !signup;
  $('#auth-name').required = signup;
  $('#auth-submit').textContent = signup ? 'Зарегистрироваться' : 'Войти';
  $('#auth-toggle').textContent = signup ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Регистрация';
  $('#auth-pass').autocomplete = signup ? 'new-password' : 'current-password';
}

$('#auth-toggle').addEventListener('click', (e) => { e.preventDefault(); setAuthMode(!signupMode); });

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#auth-email').value.trim();
  const password = $('#auth-pass').value;
  const msg = $('#auth-msg');
  msg.textContent = '…';
  if (signupMode) {
    const { data, error } = await sb.auth.signUp({
      email, password,
      options: { data: { name: $('#auth-name').value.trim() }, emailRedirectTo: location.href.split('#')[0] },
    });
    if (error) { msg.textContent = `Ошибка: ${error.message}`; return; }
    msg.textContent = data.session ? '' : 'Проверь почту и подтверди email, потом войди.';
  } else {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    msg.textContent = error ? `Ошибка: ${error.message}` : '';
  }
});

$('#logout').addEventListener('click', async () => {
  if (channel) await sb.removeChannel(channel);
  await sb.auth.signOut();
  location.reload();
});

$$('nav button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
$$('#period button').forEach((b) => b.addEventListener('click', () => {
  state.period = b.dataset.p;
  $$('#period button').forEach((x) => x.classList.toggle('active', x === b));
  renderBar();
}));
$('#timer-controls').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (btn) timerAction(btn.dataset.act);
});
$$('#mode button').forEach((b) => b.addEventListener('click', () => {
  state.uiMode = b.dataset.mode;
  localStorage.setItem('uiMode', state.uiMode);
  renderTimer();
}));
$$('#timer-setup [data-min]').forEach((b) => b.addEventListener('click', () => {
  setTimerMin(Number(b.dataset.min));
  renderTimer();
}));
$('#timer-min').value = state.timerMin;
$('#timer-min').addEventListener('input', () => {
  const v = Math.round(Number($('#timer-min').value));
  if (v >= 1 && v <= 720) { state.timerMin = v; localStorage.setItem('timerMin', String(v)); renderTimer(); }
});
$('#lap-save').addEventListener('click', saveLap);
$('#lap-cancel').addEventListener('click', cancelLap);
$('#lap-note').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveLap();
  if (e.key === 'Escape') cancelLap();
});
$('#laps').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-lap]');
  if (btn) deleteLap(Number(btn.dataset.lap));
});
$('#my-sessions').addEventListener('click', (e) => {
  const btn = e.target.closest('.del');
  if (btn) deleteSession(Number(btn.dataset.id));
});
$('#report-day').addEventListener('change', renderReportEditor);
$('#report-save').addEventListener('click', saveReport);

sb.auth.onAuthStateChange((_event, session) => {
  if (session?.user) {
    // setTimeout — чтобы не дёргать supabase изнутри колбэка (может зависнуть)
    if (!state.user) setTimeout(() => startApp(session.user), 0);
  } else if (!state.user) {
    $('#auth').hidden = false;
  }
});
