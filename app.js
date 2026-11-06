'use strict';
/* Squeek Jump — hamster runner.
   Plain JS, no build step. All art is drawn on canvas.
   Data: same-origin /api/* (Vercel + Upstash) with a local-board fallback,
   plus the public Squeekchain wheel status API for the Wheel Boost. */

/* ================= helpers ================= */
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);

const USERNAME_RE = /^[A-Za-z0-9_]{2,16}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ROOM_CODE_RE = /^[A-Z0-9]{6}$/;
const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // matches api/rooms.js

function shortAddr(a) {
  if (!a || a.length < 12) return a || '';
  return a.slice(0, 6) + '…' + a.slice(-4);
}
function csvCell(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* ============ storage (throw-safe, in-memory fallback) ============ */
const memStore = new Map();
function lsGet(key, fallback) {
  try {
    const v = window.localStorage.getItem(key);
    if (v !== null) return v;
  } catch (e) { /* storage can throw in some webviews — fall through */ }
  return memStore.has(key) ? memStore.get(key) : fallback;
}
function lsSet(key, value) {
  memStore.set(key, value);
  try { window.localStorage.setItem(key, value); } catch (e) { /* in-memory copy already kept */ }
}
function lsGetJSON(key, fallback) {
  const raw = lsGet(key, null);
  if (raw === null) return fallback;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}
function lsSetJSON(key, value) { lsSet(key, JSON.stringify(value)); }

/* ============ identity & personal bests ============ */
const identity = { username: lsGet('sqj_username', ''), address: lsGet('sqj_address', '') };
let muted = lsGet('sqj_mute', '0') === '1';

function personalBests() { return lsGetJSON('sqj_bests', {}); }
function getBest(scope) { return personalBests()[scope] || 0; }
function setBest(scope, v) { const b = personalBests(); b[scope] = v; lsSetJSON('sqj_bests', b); }

/* ============ tiny WebAudio blips (created only after a user gesture) ============ */
let audioCtx = null;
function ensureAudio() {
  if (muted) return null;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  } catch (e) { return null; }
}
function blip(freqA, freqB, dur, type) {
  if (muted) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  try {
    const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freqA, t);
    if (freqB) o.frequency.exponentialRampToValueAtTime(Math.max(freqB, 1), t + dur);
    g.gain.setValueAtTime(0.055, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(ctx.destination);
    o.start(t); o.stop(t + dur + 0.03);
  } catch (e) { /* audio is decoration only */ }
}
const sfx = {
  jump() { blip(320, 660, 0.12, 'square'); },
  point() { blip(880, 1320, 0.08, 'sine'); },
  over() { blip(420, 90, 0.35, 'sawtooth'); }
};

/* ============ local fallback data (mirrors the API semantics) ============ */
function localData() { return lsGetJSON('sqj_local', { boards: {}, rooms: {} }); }
function saveLocalData(d) { lsSetJSON('sqj_local', d); }

function localGetBoard(room) {
  const d = localData();
  const b = d.boards[room || 'global'] || {};
  return Object.keys(b)
    .map((addr) => ({ username: b[addr].u, address: addr, score: b[addr].s }))
    .sort((x, y) => y.score - x.score)
    .slice(0, 100);
}
function localSubmit(username, address, score, room) {
  const d = localData();
  const key = room || 'global';
  const b = d.boards[key] || (d.boards[key] = {});
  const addr = String(address).toLowerCase();
  const cur = b[addr];
  const improved = !cur || score > cur.s;
  if (improved) b[addr] = { u: username, s: score };
  saveLocalData(d);
  const entries = localGetBoard(room);
  const idx = entries.findIndex((e) => e.address === addr);
  return { rank: idx === -1 ? null : idx, improved, best: b[addr] ? b[addr].s : score };
}
function localCreateRoom(name, username, address) {
  const d = localData();
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
  } while (d.rooms[code]);
  d.rooms[code] = { name, by: { u: username || '', a: (address || '').toLowerCase() }, t: Date.now() };
  saveLocalData(d);
  return { code, name };
}
function localGetRoom(code) {
  const d = localData();
  const r = d.rooms[code];
  if (!r) return null;
  return { code, name: r.name, players: Object.keys(d.boards[code] || {}).length };
}

/* ============ API layer (falls back to local on 501/503/network failure) ============ */
async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON body */ }
  return { status: res.status, json };
}
function isFallbackStatus(status) { return status === 501 || status === 503; }

const api = {
  async getBoard(room) {
    const qs = '?limit=100' + (room ? '&room=' + encodeURIComponent(room) : '');
    let r = null;
    try { r = await fetchJSON('/api/leaderboard' + qs); } catch (e) { r = null; }
    if (r && r.status === 200 && r.json && r.json.ok) return r.json.entries || [];
    if (r && !isFallbackStatus(r.status) && room && !localGetRoom(room)) {
      throw new Error('room_not_found');
    }
    return localGetBoard(room);
  },
  async submitScore(username, address, score, room) {
    const body = { username, address, score };
    if (room) body.room = room;
    let r = null;
    try {
      r = await fetchJSON('/api/leaderboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (e) { r = null; }
    if (r && r.status === 200 && r.json && r.json.ok) {
      return { rank: (typeof r.json.rank === 'number' ? r.json.rank : null), improved: !!r.json.improved, best: r.json.best };
    }
    return localSubmit(username, address, score, room);
  },
  async createRoom(name, username, address) {
    const body = { name };
    if (username) body.username = username;
    if (address) body.address = address;
    let r = null;
    try {
      r = await fetchJSON('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (e) { r = null; }
    if (r && r.status === 200 && r.json && r.json.ok && r.json.room) {
      return { code: r.json.room.code, name: r.json.room.name, local: false };
    }
    const lr = localCreateRoom(name, username, address);
    return { code: lr.code, name: lr.name, local: true };
  },
  async getRoom(code) {
    let r = null;
    try { r = await fetchJSON('/api/rooms?code=' + encodeURIComponent(code)); } catch (e) { r = null; }
    if (r && r.status === 200 && r.json && r.json.ok && r.json.room) {
      return { code: r.json.room.code, name: r.json.room.name, players: r.json.room.players || 0, local: false };
    }
    const lr = localGetRoom(code);
    if (lr) return { code: lr.code, name: lr.name, players: lr.players, local: true };
    return null;
  }
};

/* ============ Wheel Boost (live Squeekchain wheel) ============
   Running state comes ONLY from rpmMilli / cumulativeWorkUnits —
   never from measurement.coreStatus (it reads IDLE while spinning). */
const wheel = { rpm: 0, boost: 1, online: false, cum: null, working: false };

function updateWheelChip() {
  const chip = $('wheelChip');
  if (!chip) return;
  if (!wheel.online) {
    chip.textContent = 'Wheel: sensor offline · Boost ×1.00';
    chip.classList.remove('live');
  } else if (wheel.rpm > 0.5) {
    chip.textContent = 'Wheel: ' + wheel.rpm.toFixed(0) + ' RPM · Boost ×' + wheel.boost.toFixed(2);
    chip.classList.add('live');
  } else {
    chip.textContent = 'Wheel: idle (napping) · Boost ×1.00';
    chip.classList.remove('live');
  }
}

async function pollWheel() {
  try {
    const res = await fetch('https://api.squeekchain.com/v1/status');
    if (!res.ok) throw new Error('http ' + res.status);
    const j = await res.json();
    const m = (j && j.measurement) ? j.measurement : {};
    const rpm = (typeof m.rpmMilli === 'number' ? m.rpmMilli : 0) / 1000;
    let cum = null;
    if (typeof m.cumulativeWorkUnits === 'number') cum = m.cumulativeWorkUnits;
    else if (typeof m.cumulativeWorkUnits === 'string') cum = Number(m.cumulativeWorkUnits);
    wheel.working = cum !== null && wheel.cum !== null && cum > wheel.cum;
    if (cum !== null) wheel.cum = cum;
    wheel.rpm = rpm;
    wheel.boost = 1 + Math.min(rpm, 120) / 120;
    wheel.online = true;
  } catch (e) {
    wheel.online = false;
    wheel.rpm = 0;
    wheel.boost = 1;
    wheel.working = false;
  }
  updateWheelChip();
}

/* ============ leaderboard component (top 100, slides of 20) ============ */
function createBoard(refs) {
  const state = { entries: [], slide: 0, room: null };
  const PER_SLIDE = 20;
  const slideCount = () => Math.max(1, Math.ceil(state.entries.length / PER_SLIDE));

  function render() {
    const track = refs.track;
    track.innerHTML = '';
    const myAddr = (identity.address || '').toLowerCase();
    if (!state.entries.length) {
      const s = document.createElement('div');
      s.className = 'board-slide';
      const row = document.createElement('div');
      row.className = 'entry empty-row';
      row.textContent = 'No scores yet — be the first to post one!';
      s.appendChild(row);
      track.appendChild(s);
    } else {
      for (let i = 0; i < slideCount(); i++) {
        const s = document.createElement('div');
        s.className = 'board-slide';
        state.entries.slice(i * PER_SLIDE, (i + 1) * PER_SLIDE).forEach((e, j) => {
          const row = document.createElement('div');
          row.className = 'entry' + (myAddr && e.address && e.address.toLowerCase() === myAddr ? ' mine' : '');
          const rank = document.createElement('span');
          rank.className = 'rank';
          rank.textContent = '#' + (i * PER_SLIDE + j + 1);
          const un = document.createElement('span');
          un.className = 'uname';
          un.textContent = e.username || '—';
          const ua = document.createElement('span');
          ua.className = 'uaddr';
          ua.textContent = shortAddr(e.address || '');
          const sc = document.createElement('span');
          sc.className = 'uscore';
          sc.textContent = e.score + ' pts';
          row.appendChild(rank); row.appendChild(un); row.appendChild(ua); row.appendChild(sc);
          s.appendChild(row);
        });
        track.appendChild(s);
      }
    }
    state.slide = clamp(state.slide, 0, slideCount() - 1);
    track.style.transform = 'translateX(' + (-state.slide * 100) + '%)';
    refs.dots.innerHTML = '';
    for (let i = 0; i < slideCount(); i++) {
      const d = document.createElement('button');
      d.type = 'button';
      d.className = 'dot' + (i === state.slide ? ' active' : '');
      d.setAttribute('aria-label', 'Slide ' + (i + 1));
      ((idx) => d.addEventListener('click', () => go(idx)))(i);
      refs.dots.appendChild(d);
    }
    refs.prev.disabled = state.slide <= 0;
    refs.next.disabled = state.slide >= slideCount() - 1;
  }
  function go(i) { state.slide = clamp(i, 0, slideCount() - 1); render(); }

  async function load(room) {
    state.room = room || null;
    try { state.entries = await api.getBoard(state.room); }
    catch (e) { state.entries = []; }
    render();
  }

  function download() {
    const rows = [['rank', 'username', 'address', 'score']];
    state.entries.forEach((e, i) => rows.push([i + 1, e.username || '', e.address || '', e.score]));
    const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = state.room ? 'squeekjump-room-' + state.room + '.csv' : 'squeekjump-leaderboard.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 120);
  }

  let touchX = null;
  refs.viewport.addEventListener('touchstart', (ev) => { touchX = ev.changedTouches[0].clientX; }, { passive: true });
  refs.viewport.addEventListener('touchend', (ev) => {
    if (touchX === null) return;
    const dx = ev.changedTouches[0].clientX - touchX;
    if (dx < -40) go(state.slide + 1);
    else if (dx > 40) go(state.slide - 1);
    touchX = null;
  }, { passive: true });
  refs.prev.addEventListener('click', () => go(state.slide - 1));
  refs.next.addEventListener('click', () => go(state.slide + 1));
  refs.download.addEventListener('click', download);

  return { load, render };
}

let globalBoard = null;
let roomBoard = null;

/* ============ views ============ */
function showView(name) {
  ['entry', 'room', 'game'].forEach((k) => {
    $('view-' + k).classList.toggle('hidden', k !== name);
  });
  window.scrollTo(0, 0);
}

/* ============ entry form ============ */
function validateIdentity(showErrors) {
  const u = $('usernameInput').value.trim();
  const a = $('addressInput').value.trim();
  let ok = true;
  if (!USERNAME_RE.test(u)) {
    if (showErrors) {
      $('usernameError').textContent = 'Username needs 2–16 characters: letters, numbers and underscore only.';
      $('usernameInput').classList.add('invalid');
    }
    ok = false;
  } else {
    $('usernameError').textContent = '';
    $('usernameInput').classList.remove('invalid');
  }
  if (!ADDRESS_RE.test(a)) {
    if (showErrors) {
      $('addressError').textContent = 'Enter a valid wallet address: 0x followed by 40 hex characters.';
      $('addressInput').classList.add('invalid');
    }
    ok = false;
  } else {
    $('addressError').textContent = '';
    $('addressInput').classList.remove('invalid');
  }
  if (ok) {
    identity.username = u;
    identity.address = a;
    lsSet('sqj_username', u);
    lsSet('sqj_address', a);
  }
  return ok;
}
function identityReady() {
  return USERNAME_RE.test(identity.username) && ADDRESS_RE.test(identity.address);
}

/* ============ rooms ============ */
let currentRoom = null;

function updateRoomPlayerLine() {
  const el = $('roomPlayerLine');
  if (identityReady()) {
    el.textContent = 'Playing as ' + identity.username + ' · ' + shortAddr(identity.address);
  } else {
    el.textContent = 'No player set yet — fill in your username + wallet address on the main screen before playing.';
  }
}

async function enterRoom(code) {
  const info = await api.getRoom(code);
  if (!info) return null;
  currentRoom = info;
  $('roomName').textContent = info.name;
  $('roomCodeBig').textContent = info.code;
  $('roomPlayers').textContent = info.players;
  $('roomPlayError').textContent = '';
  updateRoomPlayerLine();
  showView('room');
  roomBoard.load(info.code);
  return info;
}

async function refreshRoomMeta() {
  if (!currentRoom) return;
  const info = await api.getRoom(currentRoom.code);
  if (info) {
    currentRoom = info;
    $('roomPlayers').textContent = info.players;
  }
}

function copyText(text, noteEl) {
  const done = () => { if (noteEl) noteEl.textContent = 'Copied!'; };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    done();
  } catch (e) { /* clipboard unavailable — the code is on screen to copy by hand */ }
}

/* ============ game engine ============ */
const BASE_SPEED = 435;          // units per second at run start
const MAX_SPEED = 870;           // ~2x cap
const RAMP_PER_SEC = 9.7;        // reaches the cap in ~45 s
const GRAV0 = 4371;              // gravity at physK = 1
const JUMP0 = 1355;              // full-hold jump velocity at physK = 1 (apex ~210, airtime ~0.62 s)
const RELEASE_CAP = 0.5;         // early release caps upward velocity to this fraction
const HAM_W = 46, HAM_H = 34;
const GROUND_H = 54;

const canvas = $('gameCanvas');
const ctx = canvas.getContext('2d');
let W = 960, H = 360;
function groundY() { return H - GROUND_H; }
function hamX() { return Math.round(clamp(W * 0.16, 64, 150)); }

function fitCanvas() {
  const wrap = $('gameWrap');
  const w = wrap.clientWidth || 960;
  const h = Math.round(clamp(w * 0.42, 240, 400));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = w; H = h;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

const game = {
  running: false, over: false, submitted: false,
  t: 0, ramp: BASE_SPEED, speed: BASE_SPEED,
  dist: 0, scroll: 0, runPhase: 0, wheelAngle: 0,
  score: 0, cleared: 0, obstacles: [], nextGap: 600,
  lastFamily: null, room: null, returnTo: 'entry',
  ham: { y: 0, vy: 0, grounded: true },
  lastTs: 0
};

function physK() { return Math.sqrt(game.speed / BASE_SPEED); }
function tempo() { return game.ramp / BASE_SPEED; }

/* ---------- obstacle picking ---------- */
function weightedPick(pool) {
  let total = 0;
  pool.forEach((p) => { total += p[1]; });
  let r = Math.random() * total;
  for (const p of pool) { r -= p[1]; if (r <= 0) return p[0]; }
  return pool[pool.length - 1][0];
}

function pickFamily() {
  const tp = tempo();
  const pool = [['seed', 3], ['bottle', 3], ['box', 3], ['cat', 2], ['ball', 2]];
  if (tp >= 1.2) pool.push(['row', 3]);
  if (tp >= 1.45) {
    // stack share grows ~18% -> ~34% of spawns as tempo rises to the cap
    const share = 0.18 + ((Math.min(tp, 2) - 1.45) / 0.55) * 0.16;
    let total = 0;
    pool.forEach((p) => { total += p[1]; });
    pool.push(['stack', (share / (1 - share)) * total]);
  }
  let pick = weightedPick(pool);
  let guard = 0;
  while (pick === game.lastFamily && Math.random() < 0.8 && guard < 3) {
    pick = weightedPick(pool);
    guard++;
  }
  game.lastFamily = pick;
  return pick;
}

function spawnObstacle() {
  const fam = pickFamily();
  let o;
  if (fam === 'seed') o = { type: 'seed', w: 58, h: 30, insetTop: 8 };
  else if (fam === 'bottle') o = { type: 'bottle', w: 26, h: 80, insetTop: 6 };
  else if (fam === 'box') o = { type: 'box', w: 50, h: 50, insetTop: 4 };
  else if (fam === 'cat') o = { type: 'cat', w: 64, h: 30, insetTop: 7 };
  else if (fam === 'ball') o = { type: 'ball', w: 44, h: 44, insetTop: 5, rot: 0 };
  else if (fam === 'row') {
    const count = Math.random() < 0.5 ? 2 : 3;
    if (Math.random() < 0.5) o = { type: 'boxRow', count, w: count * 50 + (count - 1) * 4, h: 50, insetTop: 4 };
    else o = { type: 'bottleRow', count, w: count * 26 + (count - 1) * 3, h: 80, insetTop: 6 };
  } else { // stack
    const r = Math.random();
    if (r < 0.34) o = { type: 'box2', w: 50, h: 100, insetTop: 4 };
    else if (r < 0.67) o = { type: 'bottle3', w: 26, h: 198, insetTop: 8 };
    else o = { type: 'cat3', w: 64, h: 82, insetTop: 8 };
  }
  o.x = W + 40;
  o.passed = false;
  o.insetX = 4;
  game.obstacles.push(o);
  let gap = rand(400, 660) + game.speed * 0.35;
  if (fam === 'stack') gap *= 1.35;
  else if (fam === 'row') gap *= (o.count === 3 ? 1.25 : 1.12);
  game.nextGap = o.w + gap;
}

/* ---------- run lifecycle ---------- */
function startGame(room) {
  ensureAudio();
  game.room = room || null;
  game.returnTo = room ? 'room' : 'entry';
  game.score = 0; game.cleared = 0;
  game.t = 0; game.ramp = BASE_SPEED; game.speed = BASE_SPEED;
  game.obstacles = []; game.nextGap = rand(520, 720);
  game.lastFamily = null;
  game.over = false; game.submitted = false;
  game.ham.y = 0; game.ham.vy = 0; game.ham.grounded = true;
  showView('game');
  fitCanvas();
  $('gameOver').classList.add('hidden');
  $('tapHint').style.display = '';
  game.running = true;
  game.lastTs = 0;
  updateHUD(true);
  requestAnimationFrame(loop);
}

function stopToView() {
  game.running = false;
  showView(game.returnTo);
  globalBoard.load(null);
  if (game.room) { roomBoard.load(game.room); refreshRoomMeta(); }
}

function gameOver() {
  game.over = true;
  sfx.over();
  const scope = game.room || 'global';
  const prevBest = getBest(scope);
  const isNewBest = game.score > prevBest;
  if (isNewBest) setBest(scope, game.score);
  $('goTitle').textContent = game.room ? 'Run over — room ' + game.room : 'Run over!';
  $('goScore').textContent = game.score;
  $('goCleared').textContent = 'Obstacles cleared: ' + game.cleared;
  $('goBest').textContent = 'Best: ' + Math.max(prevBest, game.score);
  const note = $('goNote');
  if (game.score === 0) {
    note.textContent = 'No obstacles cleared — that first jump is the hardest!';
    note.className = 'go-note miss';
  } else if (isNewBest) {
    note.textContent = '🎉 New best!';
    note.className = 'go-note';
  } else {
    note.textContent = "Didn't beat your best of " + prevBest + ' — run it back!';
    note.className = 'go-note miss';
  }
  $('goRank').textContent = 'Saving your score…';
  $('gameOver').classList.remove('hidden');
  submitRun(scope);
}

async function submitRun(scope) {
  if (game.submitted) return;
  game.submitted = true;
  const boardName = game.room ? 'room leaderboard' : 'global leaderboard';
  try {
    const res = await api.submitScore(identity.username, identity.address, game.score, game.room);
    if (typeof res.best === 'number' && res.best > getBest(scope)) setBest(scope, res.best);
    if (res.improved) {
      $('goRank').textContent = (res.rank !== null && res.rank !== undefined)
        ? 'Rank #' + (res.rank + 1) + ' on the ' + boardName + '!'
        : 'New entry on the ' + boardName + '!';
    } else {
      $('goRank').textContent = 'Your best of ' + res.best + ' stays on the ' + boardName + '.';
    }
  } catch (e) {
    $('goRank').textContent = 'Score saved on this device.';
  }
  globalBoard.load(null);
  if (game.room) { roomBoard.load(game.room); refreshRoomMeta(); }
  updateHUD(true);
}

/* ---------- input ---------- */
function jumpPress(ev) {
  if (ev) ev.preventDefault();
  ensureAudio();
  if (!game.running || game.over) return;
  const ham = game.ham;
  if (ham.grounded) {
    ham.grounded = false;
    ham.vy = JUMP0 * physK();
    sfx.jump();
    $('tapHint').style.display = 'none';
  }
}
function jumpRelease() {
  const ham = game.ham;
  if (!ham.grounded && ham.vy > 0) {
    const cap = JUMP0 * physK() * RELEASE_CAP;
    if (ham.vy > cap) ham.vy = cap;
  }
}

/* ---------- simulation ---------- */
function step(dt) {
  if (game.over) return;
  game.t += dt;
  game.ramp = Math.min(MAX_SPEED, BASE_SPEED + RAMP_PER_SEC * game.t);
  game.speed = game.ramp * wheel.boost;
  const K = physK();
  const dx = game.speed * dt;
  game.dist += dx;
  game.scroll += dx;
  game.runPhase += dx * 0.055;
  game.wheelAngle += (wheel.rpm * Math.PI * 2 / 60) * dt;

  const ham = game.ham;
  if (!ham.grounded) {
    // jump velocity (set in jumpPress) and gravity both scale by physK,
    // so airtime stays ~constant while the jump apex grows with speed.
    ham.vy -= GRAV0 * K * (ham.vy < 0 ? 1.15 : 1) * dt;
    ham.y += ham.vy * dt;
    if (ham.y <= 0) { ham.y = 0; ham.vy = 0; ham.grounded = true; }
  }

  game.nextGap -= dx;
  if (game.nextGap <= 0) spawnObstacle();

  const hx = hamX();
  const hLeft = hx + 5, hRight = hx + HAM_W - 5;
  const hBottom = groundY() - ham.y;
  const hTop = hBottom - (HAM_H - 6);

  for (const o of game.obstacles) {
    o.x -= dx;
    if (o.type === 'ball') o.rot += dx / 22;
  }
  game.obstacles = game.obstacles.filter((o) => o.x + o.w > -60);

  for (const o of game.obstacles) {
    if (!o.passed && o.x + o.w < hLeft) {
      o.passed = true;
      game.score++;
      game.cleared++;
      sfx.point();
    }
    const oLeft = o.x + o.insetX, oRight = o.x + o.w - o.insetX;
    const oTop = groundY() - o.h + o.insetTop;
    if (hRight > oLeft && hLeft < oRight && hBottom > oTop && hTop < groundY()) {
      gameOver();
      break;
    }
  }
  updateHUD(false);
}

function loop(ts) {
  if (!game.running) return;
  const dt = Math.min(0.05, game.lastTs ? (ts - game.lastTs) / 1000 : 0.016);
  game.lastTs = ts;
  step(dt);
  draw();
  requestAnimationFrame(loop);
}

/* ---------- HUD ---------- */
const hudCache = {};
function setHud(id, v, force) {
  if (force || hudCache[id] !== v) { hudCache[id] = v; $(id).textContent = v; }
}
function updateHUD(force) {
  setHud('hudScore', String(game.score), force);
  setHud('hudBest', String(Math.max(getBest(game.room || 'global'), game.score)), force);
  setHud('hudTempo', 'Tempo ×' + tempo().toFixed(1), force);
  setHud('hudBoost', wheel.online ? 'Boost ×' + wheel.boost.toFixed(2) : 'Boost ×1.00 (offline)', force);
}

/* ============ drawing ============ */
function rr(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function draw() {
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#fdeeda');
  grad.addColorStop(1, '#f6dcb2');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  drawBars();
  drawHabitatMid();
  drawWheel();
  drawGround();
  for (const o of game.obstacles) drawObstacle(o);
  drawHamster();
}

function drawBars() {
  const spacing = 92;
  const off = -((game.scroll * 0.35) % spacing);
  ctx.strokeStyle = 'rgba(130,150,160,0.45)';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  for (let x = off; x < W + spacing; x += spacing) {
    ctx.beginPath();
    ctx.moveTo(x, 12);
    ctx.lineTo(x, groundY());
    ctx.stroke();
  }
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(0, 26); ctx.lineTo(W, 26); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, groundY() - 14); ctx.lineTo(W, groundY() - 14); ctx.stroke();
}

function drawHabitatMid() {
  const seg = 780;
  const off = -((game.scroll * 0.55) % seg);
  for (let base = off - seg; base < W + seg; base += seg) {
    drawHouse(base + 110, groundY());
    drawTube(base + 470, groundY() - 128);
  }
}

function drawHouse(x, gy) {
  ctx.fillStyle = '#b07a45';
  ctx.fillRect(x, gy - 84, 124, 84);
  ctx.strokeStyle = '#8a5a2e';
  ctx.lineWidth = 3;
  ctx.strokeRect(x, gy - 84, 124, 84);
  ctx.fillStyle = '#8a5a2e';
  ctx.beginPath();
  ctx.moveTo(x - 10, gy - 84);
  ctx.lineTo(x + 62, gy - 122);
  ctx.lineTo(x + 134, gy - 84);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#7a4a22';
  ctx.beginPath();
  ctx.arc(x + 62, gy - 26, 17, Math.PI, 0);
  ctx.lineTo(x + 79, gy);
  ctx.lineTo(x + 45, gy);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ffe9a8';
  ctx.beginPath();
  ctx.arc(x + 26, gy - 54, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#8a5a2e';
  ctx.stroke();
}

function drawTube(x, y) {
  ctx.fillStyle = 'rgba(110,170,215,0.35)';
  rr(x, y, 220, 42, 21);
  ctx.fill();
  ctx.strokeStyle = 'rgba(70,120,165,0.6)';
  ctx.lineWidth = 3;
  rr(x, y, 220, 42, 21);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(70,120,165,0.45)';
  ctx.lineWidth = 4;
  for (let i = 1; i < 5; i++) {
    ctx.beginPath();
    ctx.moveTo(x + i * 44, y + 3);
    ctx.lineTo(x + i * 44, y + 39);
    ctx.stroke();
  }
}

function drawWheel() {
  const cx = W * 0.76, cy = groundY() - 116, R = 78;
  ctx.strokeStyle = 'rgba(122,74,34,0.75)';
  ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(cx - 44, groundY()); ctx.lineTo(cx, cy + 20); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx + 44, groundY()); ctx.lineTo(cx, cy + 20); ctx.stroke();
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(game.wheelAngle);
  ctx.strokeStyle = '#d96f32';
  ctx.lineWidth = 10;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#e8935a';
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(0, 0, R - 14, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 6;
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI * 2) / 3;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * -R + 0, Math.sin(a) * -R);
    ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R);
    ctx.stroke();
  }
  ctx.fillStyle = '#b95f16';
  ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawGround() {
  const gy = groundY();
  ctx.fillStyle = '#e7ba82';
  ctx.fillRect(0, gy, W, GROUND_H);
  ctx.strokeStyle = '#c98d4e';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(0, gy + 1); ctx.lineTo(W, gy + 1); ctx.stroke();
  ctx.fillStyle = 'rgba(160,105,50,0.5)';
  const spacing = 46;
  const off = -(game.scroll % spacing);
  for (let x = off; x < W + spacing; x += spacing) {
    ctx.beginPath();
    ctx.ellipse(x, gy + 22 + ((x * 7) % 13), 7, 2.4, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawHamster() {
  const hx = hamX(), gy = groundY();
  const ham = game.ham;
  // ground shadow (shrinks/fades as he rises)
  const shScale = 1 - Math.min(ham.y / 320, 0.55);
  ctx.fillStyle = 'rgba(120,72,20,' + (0.28 * shScale) + ')';
  ctx.beginPath();
  ctx.ellipse(hx + HAM_W / 2, gy + 10, 26 * shScale, 6 * shScale, 0, 0, Math.PI * 2);
  ctx.fill();

  const bob = ham.grounded ? Math.sin(game.runPhase) * 2 : 0;
  const cx = hx + HAM_W / 2;
  const cy = gy - ham.y - HAM_H / 2 + bob;
  ctx.save();
  ctx.translate(cx, cy);
  if (!ham.grounded) ctx.rotate(-0.08);
  // tail
  ctx.fillStyle = '#f9c784';
  ctx.beginPath(); ctx.arc(-23, 5, 5, 0, Math.PI * 2); ctx.fill();
  // body
  ctx.fillStyle = '#f7b267';
  ctx.strokeStyle = '#d98a3d';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(0, 3, 24, 15, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  // belly
  ctx.fillStyle = '#fdeeda';
  ctx.beginPath(); ctx.ellipse(3, 8, 14, 8, 0, 0, Math.PI * 2); ctx.fill();
  // head
  ctx.fillStyle = '#f9c784';
  ctx.beginPath(); ctx.arc(15, -5, 12.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  // ear
  ctx.fillStyle = '#f7b267';
  ctx.beginPath(); ctx.arc(8, -15, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#f6a6b2';
  ctx.beginPath(); ctx.arc(8, -15, 2.6, 0, Math.PI * 2); ctx.fill();
  // cheek + eye + nose
  ctx.fillStyle = 'rgba(246,140,140,0.55)';
  ctx.beginPath(); ctx.ellipse(21, 0, 4.5, 3, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#3a2a1a';
  ctx.beginPath(); ctx.arc(19, -7, 2.2, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(27, -2, 1.7, 0, Math.PI * 2); ctx.fill();
  // feet
  ctx.fillStyle = '#e08e45';
  if (ham.grounded) {
    const s = Math.sin(game.runPhase);
    ctx.beginPath(); ctx.ellipse(-9, 16 + s * 2.5, 6, 3.4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(10, 16 - s * 2.5, 6, 3.4, 0, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.beginPath(); ctx.ellipse(-8, 15, 6, 3.4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(9, 15, 6, 3.4, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

/* ---------- obstacles ---------- */
function drawObstacle(o) {
  const gy = groundY();
  switch (o.type) {
    case 'seed': drawSeedPile(o.x, gy); break;
    case 'bottle': drawBottleUnit(o.x + o.w / 2, gy, 80); break;
    case 'bottle3': for (let i = 0; i < 3; i++) drawBottleUnit(o.x + o.w / 2, gy - i * 66, 66); break;
    case 'bottleRow': for (let i = 0; i < o.count; i++) drawBottleUnit(o.x + i * 29 + 13, gy, 80); break;
    case 'box': drawBoxAt(o.x, gy, 50, 50); break;
    case 'box2': drawBoxAt(o.x, gy, 50, 50); drawBoxAt(o.x + 2, gy - 50, 50, 50); break;
    case 'boxRow': for (let i = 0; i < o.count; i++) drawBoxAt(o.x + i * 54, gy, 50, 50); break;
    case 'cat': drawCat(o.x, gy, 0); break;
    case 'cat3':
      drawCat(o.x, gy, 0);
      drawCat(o.x + 3, gy - 26, -0.06);
      drawCat(o.x - 2, gy - 52, 0.05);
      break;
    case 'ball': drawBall(o.x + o.w / 2, gy - o.h / 2, o.h / 2, o.rot || 0); break;
  }
}

function drawSeedPile(x, gy) {
  const cx = x + 29;
  // warm orange glow halo
  const glow = ctx.createRadialGradient(cx, gy - 8, 4, cx, gy - 8, 72);
  glow.addColorStop(0, 'rgba(255,150,50,0.5)');
  glow.addColorStop(1, 'rgba(255,150,50,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(cx - 74, gy - 80, 148, 84);
  // ground ring
  ctx.strokeStyle = 'rgba(224,123,42,0.85)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(cx, gy - 2, 37, 7, 0, 0, Math.PI * 2);
  ctx.stroke();
  // charcoal shells with cream stripes + amber rims
  const shells = [
    { dx: -16, dy: -6, r: -0.5 }, { dx: 0, dy: -5, r: 0.2 }, { dx: 16, dy: -6, r: 0.6 },
    { dx: -8, dy: -14, r: 0.9 }, { dx: 9, dy: -14, r: -0.8 },
    { dx: 0, dy: -22, r: 0.1 }
  ];
  for (const s of shells) {
    ctx.save();
    ctx.translate(cx + s.dx, gy + s.dy);
    ctx.rotate(s.r);
    ctx.fillStyle = '#211710';
    ctx.strokeStyle = '#f5a83d';
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.ellipse(0, 0, 13, 8, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#ffedb5';
    ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(-8, 0); ctx.quadraticCurveTo(0, 3, 8, 0); ctx.stroke();
    ctx.restore();
  }
}

function drawBottleUnit(cx, baseY, h) {
  // body
  ctx.fillStyle = '#bfe6f5';
  ctx.strokeStyle = '#5b9bbf';
  ctx.lineWidth = 2;
  rr(cx - 13, baseY - (h - 14), 26, h - 14, 7);
  ctx.fill(); ctx.stroke();
  // water
  ctx.fillStyle = 'rgba(80,160,220,0.5)';
  rr(cx - 10, baseY - (h - 14) * 0.55, 20, (h - 14) * 0.55 - 5, 5);
  ctx.fill();
  // neck + cap
  ctx.fillStyle = '#bfe6f5';
  rr(cx - 6, baseY - h + 4, 12, 12, 3);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#e2574c';
  rr(cx - 7, baseY - h, 14, 7, 2);
  ctx.fill();
  // highlight
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(cx - 7, baseY - (h - 20));
  ctx.lineTo(cx - 7, baseY - 14);
  ctx.stroke();
}

function drawBoxAt(x, baseY, w, h) {
  ctx.fillStyle = '#cf9455';
  ctx.strokeStyle = '#a06a34';
  ctx.lineWidth = 2;
  ctx.fillRect(x, baseY - h, w, h);
  ctx.strokeRect(x, baseY - h, w, h);
  // tape band + seams
  ctx.fillStyle = 'rgba(240,220,180,0.85)';
  ctx.fillRect(x + w / 2 - 4, baseY - h, 8, h);
  ctx.strokeStyle = 'rgba(160,106,52,0.7)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, baseY - h); ctx.lineTo(x + w / 2, baseY - h + 9); ctx.lineTo(x + w, baseY - h);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + 3, baseY - 4); ctx.lineTo(x + w - 3, baseY - 4);
  ctx.stroke();
}

function drawCat(x, baseY, rot) {
  ctx.save();
  ctx.translate(x + 32, baseY);
  ctx.rotate(rot || 0);
  ctx.translate(-32, 0);
  // tail
  ctx.strokeStyle = '#8f887e';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x + 4, baseY - 6);
  ctx.quadraticCurveTo(x - 4, baseY - 16, x + 6, baseY - 20);
  ctx.stroke();
  // body
  ctx.fillStyle = '#b3aca1';
  ctx.strokeStyle = '#8f887e';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(x + 30, baseY - 13, 29, 13, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  // stripes
  ctx.strokeStyle = 'rgba(120,112,100,0.8)';
  ctx.lineWidth = 3;
  [18, 28, 38].forEach((dx) => {
    ctx.beginPath();
    ctx.moveTo(x + dx, baseY - 24);
    ctx.lineTo(x + dx + 2, baseY - 16);
    ctx.stroke();
  });
  // head
  ctx.fillStyle = '#b3aca1';
  ctx.beginPath(); ctx.arc(x + 52, baseY - 12, 11, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  // ears
  ctx.fillStyle = '#b3aca1';
  ctx.beginPath();
  ctx.moveTo(x + 45, baseY - 20); ctx.lineTo(x + 47, baseY - 28); ctx.lineTo(x + 52, baseY - 21);
  ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x + 54, baseY - 21); ctx.lineTo(x + 59, baseY - 28); ctx.lineTo(x + 61, baseY - 20);
  ctx.closePath(); ctx.fill();
  // closed eye
  ctx.strokeStyle = '#5d564d';
  ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.arc(x + 55, baseY - 12, 3.4, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  // floating z's
  ctx.fillStyle = 'rgba(93,86,77,0.75)';
  ctx.font = 'bold 11px sans-serif';
  ctx.fillText('z', x + 60, baseY - 30);
  ctx.font = 'bold 8px sans-serif';
  ctx.fillText('z', x + 66, baseY - 38);
  ctx.restore();
}

function drawBall(cx, cy, r, rot) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = '#7ec8e3';
  ctx.strokeStyle = '#4a90b8';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.rotate(rot);
  ctx.strokeStyle = '#4a90b8';
  ctx.lineWidth = 3.5;
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI * 2) / 3;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * -r, Math.sin(a) * -r);
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    ctx.stroke();
  }
  ctx.fillStyle = '#e2574c';
  ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

/* ============ wiring & init ============ */
function updateMuteBtn() { $('muteBtn').textContent = muted ? '🔇' : '🔊'; }

function init() {
  globalBoard = createBoard({
    viewport: $('gBoardViewport'), track: $('gBoardTrack'),
    prev: $('gBoardPrev'), next: $('gBoardNext'), dots: $('gBoardDots'), download: $('gBoardDownload')
  });
  roomBoard = createBoard({
    viewport: $('rBoardViewport'), track: $('rBoardTrack'),
    prev: $('rBoardPrev'), next: $('rBoardNext'), dots: $('rBoardDots'), download: $('rBoardDownload')
  });

  $('usernameInput').value = identity.username;
  $('addressInput').value = identity.address;
  updateMuteBtn();

  $('muteBtn').addEventListener('click', () => {
    muted = !muted;
    lsSet('sqj_mute', muted ? '1' : '0');
    updateMuteBtn();
    if (!muted) ensureAudio();
  });

  ['usernameInput', 'addressInput'].forEach((id) => {
    $(id).addEventListener('input', () => {
      $(id).classList.remove('invalid');
      if (id === 'usernameInput') lsSet('sqj_username', $(id).value.trim());
      else lsSet('sqj_address', $(id).value.trim());
    });
  });

  $('startBtn').addEventListener('click', () => {
    ensureAudio();
    if (validateIdentity(true)) startGame(null);
  });

  /* rooms */
  $('createRoomBtn').addEventListener('click', async () => {
    ensureAudio();
    const name = $('roomNameInput').value.trim().replace(/\s+/g, ' ').slice(0, 30);
    if (name.length < 2) {
      $('createRoomError').textContent = 'Room name needs 2–30 characters.';
      return;
    }
    $('createRoomError').textContent = '';
    $('createRoomBtn').disabled = true;
    const room = await api.createRoom(name, $('usernameInput').value.trim(), $('addressInput').value.trim());
    $('createRoomBtn').disabled = false;
    $('createdRoomCode').textContent = room.code;
    $('copyNote').textContent = '';
    $('createdRoomBox').classList.remove('hidden');
    $('createdRoomBox').dataset.code = room.code;
  });
  $('copyCodeBtn').addEventListener('click', () => {
    copyText($('createdRoomBox').dataset.code || '', $('copyNote'));
  });
  $('copyLinkBtn').addEventListener('click', () => {
    const code = $('createdRoomBox').dataset.code || '';
    copyText(window.location.origin + window.location.pathname + '?room=' + code, $('copyNote'));
  });
  $('createdEnterBtn').addEventListener('click', async () => {
    const code = $('createdRoomBox').dataset.code || '';
    if (code) await enterRoom(code);
  });
  $('joinRoomBtn').addEventListener('click', async () => {
    ensureAudio();
    const code = $('joinCodeInput').value.trim().toUpperCase();
    if (!ROOM_CODE_RE.test(code)) {
      $('joinRoomError').textContent = 'Room codes are 6 letters/digits — check the code and try again.';
      return;
    }
    $('joinRoomError').textContent = '';
    const info = await enterRoom(code);
    if (!info) $('joinRoomError').textContent = 'Room not found — check the code and try again.';
  });
  $('leaveRoomBtn').addEventListener('click', () => {
    currentRoom = null;
    showView('entry');
    globalBoard.load(null);
  });
  $('playRoomBtn').addEventListener('click', () => {
    ensureAudio();
    if (!currentRoom) return;
    if (!validateIdentity(true) || !identityReady()) {
      $('roomPlayError').textContent = 'Your username / wallet address needs fixing first: leave the room, complete the form on the main screen, then rejoin with code ' + currentRoom.code + '.';
      return;
    }
    $('roomPlayError').textContent = '';
    startGame(currentRoom.code);
  });

  /* game controls */
  canvas.addEventListener('pointerdown', jumpPress);
  window.addEventListener('pointerup', jumpRelease);
  window.addEventListener('pointercancel', jumpRelease);
  window.addEventListener('keydown', (ev) => {
    if ($('view-game').classList.contains('hidden')) return;
    if (ev.code === 'Space' || ev.code === 'ArrowUp' || ev.code === 'KeyW') {
      ev.preventDefault();
      if (!ev.repeat) jumpPress(ev);
    }
  });
  window.addEventListener('keyup', (ev) => {
    if (ev.code === 'Space' || ev.code === 'ArrowUp' || ev.code === 'KeyW') jumpRelease();
  });
  $('quitBtn').addEventListener('click', () => { game.running = false; stopToView(); });
  $('againBtn').addEventListener('click', () => startGame(game.room));
  $('backBtn').addEventListener('click', () => { game.running = false; stopToView(); });
  window.addEventListener('resize', () => {
    if (!$('view-game').classList.contains('hidden')) {
      fitCanvas();
      if (!game.running) draw();
    }
  });

  globalBoard.load(null);
  pollWheel();
  setInterval(pollWheel, 8000);

  /* auto-join from ?room=CODE invite links */
  const params = new URLSearchParams(window.location.search);
  const roomParam = (params.get('room') || '').toUpperCase();
  if (ROOM_CODE_RE.test(roomParam)) {
    $('joinCodeInput').value = roomParam;
    enterRoom(roomParam).then((info) => {
      if (!info) $('joinRoomError').textContent = 'Room "' + roomParam + '" from that link was not found.';
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
