// 릴스 운영 현황판
// 비공개 저장소(cheese-daeri)의 ops/ 상태 파일을 GitHub API로 읽고, 버튼을 누르면 "현황판 처리" 워크플로를 실행한다.
// 토큰은 이 브라우저의 localStorage에만 저장된다.
'use strict';

const API = 'https://api.github.com';
const BRANCH = 'main';
const REFRESH_MS = 60000;
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
const WORKFLOW_NAMES = { 'make-reels.yml': '릴스 만들기', 'ops.yml': '현황판 처리', 'publish.yml': '예약 발행' };

const store = {
  get(key, fallback = '') {
    try { return localStorage.getItem('reels-dash:' + key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('reels-dash:' + key, value); } catch { /* 저장 불가 환경: 이번 접속에서만 유지 */ }
  },
  remove(key) {
    try { localStorage.removeItem('reels-dash:' + key); } catch { /* 무시 */ }
  },
};

const state = {
  repo: store.get('repo', 'gohero-17/cheese-daeri'),
  token: store.get('token'),
  persona: store.get('persona', 'all'),
  view: store.get('view', 'me'),
  status: null,
  queue: { items: [] },
  log: [],
  runs: [],
  pending: {},      // id → 'approve' | 'redo' | 'unapprove' (워크플로 처리 중)
  openCaptions: new Set(),
  thumbs: new Map(),
};

const $ = (id) => document.getElementById(id);

// 붙여넣을 때 섞여 들어오는 공백·보이지 않는 문자를 지운다. 남은 글자가 토큰에 쓰이지 않는 글자면 null
function cleanToken(raw) {
  const token = (raw || '').replace(/[\s\u00A0\u200B-\u200D\u2060\uFEFF]/g, '');
  return /^[A-Za-z0-9_]+$/.test(token) ? token : null;
}

// textContent만 쓰는 작은 DOM 도우미 (저장소 내용은 모두 글자로만 넣는다)
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function fmtTime(iso, withDay = true) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hm = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' });
  if (!withDay) return hm;
  const kst = new Date(d.getTime() + (9 * 60 + d.getTimezoneOffset()) * 60000);
  return `${kst.getMonth() + 1}/${kst.getDate()}(${DAYS[kst.getDay()]}) ${hm}`;
}

function personaName(id) {
  return state.status?.personas?.[id] || id;
}

function releaseUrl(item) {
  return `https://github.com/${state.repo}/releases/tag/${encodeURIComponent(item.release_tag)}`;
}

// ---------- GitHub API ----------

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(path, { method = 'GET', body, accept = 'application/vnd.github+json' } = {}) {
  const res = await fetch(`${API}/repos/${state.repo}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${state.token}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).message || msg; } catch { /* 본문 없음 */ }
    throw new ApiError(res.status, msg);
  }
  return res;
}

async function readFile(path, fallback) {
  try {
    const res = await api(`contents/${path}?ref=${BRANCH}`, { accept: 'application/vnd.github.raw+json' });
    return await res.json();
  } catch (e) {
    if (e.status === 404) return fallback;
    throw e;
  }
}

async function thumbUrl(path) {
  if (!path) return null;
  if (state.thumbs.has(path)) return state.thumbs.get(path);
  const promise = api(`contents/${path}?ref=${BRANCH}`, { accept: 'application/vnd.github.raw+json' })
    .then((r) => r.blob())
    .then((b) => URL.createObjectURL(b))
    .catch(() => null);
  state.thumbs.set(path, promise);
  return promise;
}

async function load() {
  if (!state.token) { openSettings('GitHub 토큰을 넣어 주세요.'); return; }
  if (!cleanToken(state.token)) { openSettings('저장된 토큰에 토큰이 아닌 글자가 섞여 있습니다. 다시 붙여넣어 주세요.'); return; }
  $('updated').textContent = '불러오는 중…';
  try {
    const [status, queue, log, runs] = await Promise.all([
      readFile('ops/status.json', null),
      readFile('ops/queue.json', { items: [] }),
      readFile('ops/log.json', []),
      api('actions/runs?per_page=15').then((r) => r.json()).then((d) => d.workflow_runs || []).catch(() => []),
    ]);
    state.status = status;
    state.queue = queue;
    state.log = log;
    state.runs = runs;
    // 워크플로가 처리를 끝낸 항목은 "처리 중" 표시를 지운다
    for (const [id, action] of Object.entries(state.pending)) {
      const item = queue.items.find((i) => i.id === id);
      const settled = !item
        || (action === 'approve' && item.status !== 'review' && item.status !== 'failed')
        || (action === 'redo' && item.status === 'redo')
        || (action === 'unapprove' && item.status === 'review');
      if (settled) delete state.pending[id];
    }
    showError('');
    render();
    $('updated').textContent = status
      ? `상태 갱신 ${fmtTime(status.updated_at)} · 화면 ${fmtTime(new Date().toISOString(), false)}`
      : '아직 상태 파일이 없습니다. 첫 "릴스 만들기"가 끝나면 채워집니다.';
  } catch (e) {
    $('updated').textContent = '불러오지 못했습니다';
    if (e.status === 401 || e.status === 403) {
      openSettings('토큰이 만료됐거나 권한이 부족합니다. 새 토큰을 넣어 주세요.');
    } else if (e.status === 404) {
      showError(`저장소를 찾을 수 없습니다: ${state.repo} (이름과 토큰의 저장소 권한을 확인하세요)`);
    } else {
      showError(`불러오기 실패: ${e.message}`);
    }
  }
}

async function dispatch(action, ids) {
  for (const id of ids) state.pending[id] = action;
  render();
  try {
    await api('actions/workflows/ops.yml/dispatches', {
      method: 'POST',
      body: { ref: BRANCH, inputs: { action, ids: ids.join(' ') } },
    });
    // 워크플로가 끝날 때까지 10초마다 다시 읽는다 (최대 3분)
    let tries = 0;
    const timer = setInterval(async () => {
      tries += 1;
      await load();
      if (!ids.some((id) => state.pending[id]) || tries >= 18) clearInterval(timer);
    }, 10000);
  } catch (e) {
    for (const id of ids) delete state.pending[id];
    render();
    showError(e.status === 403
      ? '버튼을 실행할 권한이 없습니다. 토큰에 Actions: Read and write 권한이 있는지 확인하세요.'
      : `요청 실패: ${e.message}`);
  }
}

// ---------- 화면 ----------

function visible(item) {
  return state.persona === 'all' || item.persona === state.persona;
}

function renderPersonas() {
  const personas = state.status?.personas || {};
  const options = [['all', '전체'], ...Object.entries(personas)];
  $('personas').replaceChildren(...options.map(([id, label]) => h('button', {
    class: 'chip', type: 'button', 'aria-pressed': state.persona === id ? 'true' : 'false',
    on: { click: () => { state.persona = id; store.set('persona', id); render(); } },
  }, label)));
}

function renderAuto() {
  const active = state.runs.filter((r) => r.status === 'in_progress' || r.status === 'queued');
  const recentFail = state.runs.find((r) => r.conclusion === 'failure'
    && Date.now() - new Date(r.updated_at).getTime() < 24 * 3600 * 1000);
  const runName = (r) => WORKFLOW_NAMES[r.path?.split('/').pop()] || r.name;
  const runningBox = [];
  if (active.length) {
    runningBox.push(h('div', { class: 'running' },
      h('strong', {}, '지금 실행 중'),
      active.map((r) => h('a', { href: r.html_url, target: '_blank', rel: 'noopener' },
        `${runName(r)} · ${r.status === 'queued' ? '대기' : '진행 중'} · ${fmtTime(r.run_started_at || r.created_at, false)} 시작`))));
  }
  if (recentFail) {
    runningBox.push(h('div', { class: 'running' },
      h('strong', {}, '최근 실패한 실행'),
      h('a', { href: recentFail.html_url, target: '_blank', rel: 'noopener' },
        `${runName(recentFail)} · ${fmtTime(recentFail.updated_at)} · 로그 보기`)));
  }
  $('running').replaceChildren(...runningBox);

  const pipeline = state.status?.pipeline || [];
  $('pipeline').replaceChildren(...(pipeline.length ? pipeline.map((s) => {
    const label = { done: '완료', run: '진행 중', wait: '대기' }[s.state] || s.state;
    return h('li', { class: `step s-${s.state}` },
      h('div', { class: 'step-top' },
        h('span', { class: 'step-name' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), s.name),
        h('span', { class: 'state' }, label)),
      h('p', {}, s.detail),
      h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': s.pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': `${s.name} 진행률` },
        h('div', { style: null, 'data-pct': s.pct })));
  }) : [h('li', { class: 'empty' }, '아직 진행 기록이 없습니다.')]));
  // CSP가 인라인 style 속성을 막으므로 진행률 막대 너비는 스크립트로 넣는다
  for (const bar of $('pipeline').querySelectorAll('[data-pct]')) bar.style.width = `${Number(bar.dataset.pct) || 0}%`;

  const redo = state.queue.items.filter((i) => i.status === 'redo' && visible(i));
  const entries = [
    ...redo.map((i) => ({ time: i.updated_at, text: `${personaName(i.persona)} ${i.ep}화 다시 만드는 중` })),
    ...state.log.slice(0, 12),
  ];
  $('log').replaceChildren(...(entries.length ? entries.map((e) => h('li', {},
    h('time', { datetime: e.time }, fmtTime(e.time)), h('span', {}, e.text))) : [h('li', { class: 'empty' }, '아직 기록이 없습니다.')]));
}

const PLAY_SVG = '<svg width="26" height="26" viewBox="0 0 24 24" fill="#FFFFFF" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"></path></svg>';

// 미리보기: 우선 재생 아이콘 자리를 그리고, 이미지가 오면 바꿔 넣는다
function thumbEl(item) {
  const box = h('div', { class: 'thumb thumb-empty' });
  box.innerHTML = PLAY_SVG;
  thumbUrl(item.thumb).then((url) => {
    if (url) box.replaceWith(h('img', { class: 'thumb', src: url, alt: `${item.title} 미리보기`, width: 72, height: 128 }));
  });
  return box;
}

function captionEl(item) {
  const open = state.openCaptions.has(item.id);
  return [
    h('p', { class: open ? 'caption open' : 'caption' }, item.caption || '(캡션 없음)'),
    h('button', {
      class: 'link-btn', type: 'button', 'aria-expanded': open ? 'true' : 'false',
      on: { click: () => { open ? state.openCaptions.delete(item.id) : state.openCaptions.add(item.id); render(); } },
    }, open ? '캡션 접기' : '캡션 전체 보기'),
  ];
}

function renderMe() {
  const items = state.queue.items.filter(visible);
  const reviews = items.filter((i) => i.status === 'review');
  $('reviews').replaceChildren(...(reviews.length ? reviews.map((item) => {
    const pending = state.pending[item.id];
    return h('article', { class: 'card' },
      thumbEl(item),
      h('div', { class: 'card-body' },
        h('div', { class: 'meta' }, h('span', { class: 'tag' }, personaName(item.persona)), `${item.ep}화`),
        h('h4', {}, item.title || item.id),
        captionEl(item),
        pending
          ? h('p', { class: 'done-text', role: 'status' }, pending === 'approve' ? '승인 처리 중… (30초쯤 걸려요)' : '다시 만들기 요청 중…')
          : h('div', { class: 'actions' },
            h('button', { class: 'primary', type: 'button', on: { click: () => dispatch('approve', [item.id]) } }, '승인 · 빈 시간에 예약'),
            h('button', { class: 'secondary', type: 'button', on: { click: () => dispatch('redo', [item.id]) } }, '다시 만들기'),
            h('a', { class: 'secondary', href: releaseUrl(item), target: '_blank', rel: 'noopener' }, '영상 보기'))));
  }) : [h('p', { class: 'empty' }, '승인할 영상이 없습니다. 새 영상이 완성되면 여기에 나타납니다.')]));

  const todo = (state.status?.todo || []).filter((t) => t.type !== 'review');
  const alerts = todo.map((t) => {
    const item = state.queue.items.find((i) => i.id === t.id);
    if (item && !visible(item)) return null;
    const pending = state.pending[t.id];
    return h('div', { class: 'card alert' },
      h('strong', {}, t.text),
      h('p', {}, t.hint),
      item && h('div', { class: 'actions' },
        t.type === 'failed' && (pending
          ? h('span', { class: 'done-text' }, '다시 예약 중…')
          : h('button', { class: 'primary', type: 'button', on: { click: () => dispatch('approve', [t.id]) } }, '다시 예약')),
        h('a', { class: 'secondary', href: releaseUrl(item), target: '_blank', rel: 'noopener' }, '영상 보기')));
  }).filter(Boolean);
  $('alerts-wrap').hidden = !alerts.length;
  $('alerts').replaceChildren(...alerts);

  const scheduled = items.filter((i) => i.status === 'approved').sort((a, b) => (a.slot || '').localeCompare(b.slot || ''));
  $('scheduled-wrap').hidden = !scheduled.length;
  $('scheduled').replaceChildren(...scheduled.map((item) => h('article', { class: 'card' },
    thumbEl(item),
    h('div', { class: 'card-body' },
      h('div', { class: 'meta' }, h('span', { class: 'tag' }, personaName(item.persona)), `${item.ep}화`),
      h('h4', {}, item.title || item.id),
      h('p', { class: 'done-text' }, `${fmtTime(item.slot)} 자동 발행`),
      h('div', { class: 'actions' },
        state.pending[item.id]
          ? h('span', { class: 'done-text' }, '취소 처리 중…')
          : h('button', { class: 'secondary', type: 'button', on: { click: () => dispatch('unapprove', [item.id]) } }, '예약 취소'),
        h('a', { class: 'secondary', href: releaseUrl(item), target: '_blank', rel: 'noopener' }, '영상 보기'))))));

  const setup = state.status?.setup || [];
  $('setup-wrap').hidden = !setup.length;
  $('setup').replaceChildren(...setup.map((s) => h('li', { class: s.done ? 'ok' : '' },
    h('span', { class: 'check', 'aria-hidden': 'true' }),
    h('span', { class: 'setup-text' },
      h('span', { class: 'setup-title' }, s.title, s.done ? h('span', { class: 'visually-hidden' }, ' (완료)') : ''),
      h('span', { class: 'setup-hint' }, s.hint)))));
  for (const check of $('setup').querySelectorAll('li.ok .check')) {
    check.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"></path></svg>';
  }

  const count = reviews.length + alerts.length + setup.filter((s) => !s.done).length;
  $('todo-count').textContent = `${count}건 남음`;
  $('tab-count').textContent = count ? String(count) : '';
}

function renderView() {
  document.querySelector('.cols').dataset.view = state.view;
  $('tab-me').setAttribute('aria-pressed', state.view === 'me' ? 'true' : 'false');
  $('tab-auto').setAttribute('aria-pressed', state.view === 'auto' ? 'true' : 'false');
}

function render() {
  renderPersonas();
  renderAuto();
  renderMe();
  renderView();
}

function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = !msg;
}

// ---------- 설정 ----------

function openSettings(msg = '') {
  $('repo').value = state.repo;
  $('token').value = state.token;
  $('settings-msg').textContent = msg;
  if (!$('settings').open) $('settings').showModal();
}

function init() {
  $('tab-me').addEventListener('click', () => { state.view = 'me'; store.set('view', 'me'); renderView(); });
  $('tab-auto').addEventListener('click', () => { state.view = 'auto'; store.set('view', 'auto'); renderView(); });
  $('refresh').addEventListener('click', load);
  $('open-settings').addEventListener('click', () => openSettings());
  $('settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const repo = $('repo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { $('settings-msg').textContent = '저장소는 "계정/이름" 형식으로 넣어 주세요.'; return; }
    const token = cleanToken($('token').value);
    if (!token) {
      $('settings-msg').textContent = '토큰에 한글이나 "…" 같은 다른 글자가 섞여 있습니다. 칸을 비우고 github_pat_ 로 시작하는 값만 다시 붙여넣어 주세요.';
      return;
    }
    if (!/^(github_pat_|ghp_)/.test(token)) {
      $('settings-msg').textContent = '토큰은 github_pat_ 로 시작합니다. 복사한 값이 맞는지 확인해 주세요.';
      return;
    }
    state.repo = repo;
    state.token = token;
    store.set('repo', state.repo);
    store.set('token', state.token);
    state.thumbs.clear();
    $('settings').close();
    load();
  });
  $('forget').addEventListener('click', () => {
    store.remove('token');
    state.token = '';
    $('token').value = '';
    $('settings-msg').textContent = '이 기기에서 토큰을 지웠습니다.';
  });
  render();
  load();
  setInterval(() => { if (document.visibilityState === 'visible' && state.token) load(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.token) load(); });
}

init();
