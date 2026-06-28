// Wires UI + networking + game logic into the phase state machine.
// The host's browser is authoritative: it deals roles, runs the counted nights,
// collects votes and resolves outcomes. Clients render what the host sends.
//
// PRIVACY INVARIANT (night phase): the table is STATIC. Seats must never light up,
// badge, or animate when their owner wakes, and the public cheese must never move
// during the counted nights. Per-night the host broadcasts only a bare integer
// (night-tick); who wakes is sent privately to that one actor. Breaking this
// re-introduces the wake-order leak and ruins the deduction.
import {
  ROLES,
  dealRoles,
  rollDie,
  tallyVotes,
  resolveElimination,
  resolveWinner,
  randomRoomCode,
  wakersOn,
  resolvePeek,
} from './game.js';
import { createHost, createClient } from './net.js';

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 8;
const NIGHT_MIN_MS = 4000; // every night lasts at least this long (hides timing)
const NIGHT_MAX_MS = 20000; // soft cap so a slow/AFK actor can't hang the table
const DICE_FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

const $ = (id) => document.getElementById(id);
const screens = [...document.querySelectorAll('.screen')];
const show = (id) => screens.forEach((s) => s.classList.toggle('active', s.id === id));

const G = {
  isHost: false,
  net: null,
  myId: null,
  myName: '',
  myRole: null,
  myDie: null,
  myVote: null,
  // host-authoritative state:
  players: [], // [{id, name}]
  roles: {}, // id -> role
  dice: {}, // id -> die
  votes: {}, // voterId -> targetId
  // night state:
  currentNight: 0,
  cheeseHolder: null, // host-only; result flourish (scoring never depends on it)
  nightAwait: null, // host-only Set of mouse ids still to act this night
  nightTimers: [], // host-only timer handles
  nightStartAt: 0, // host-only
  myWake: null, // {night, action} for the local player when they wake
  myPeek: null, // {name, die} once this player has peeked
  nightActed: false, // has the local player acted this night
  peekTarget: null,
};

// ---------- HOME ----------
const homeMsg = (t) => ($('home-msg').textContent = t);
const lobbyMsg = (t) => ($('lobby-msg').textContent = t);

function readName() {
  const name = $('name-input').value.trim();
  if (!name) {
    homeMsg('请先输入昵称');
    return null;
  }
  return name;
}

$('btn-create').onclick = () => {
  const name = readName();
  if (name) startHosting(name);
};

$('btn-join').onclick = () => {
  const name = readName();
  if (!name) return;
  const code = $('code-input').value.trim().toUpperCase();
  if (!code) return homeMsg('请输入房间号');
  joinRoom(code, name);
};

// ---------- HOST ----------
function startHosting(name) {
  G.isHost = true;
  G.myName = name;
  document.body.classList.add('is-host');
  homeMsg('正在创建房间…');
  spawnHost(randomRoomCode(), name, 0);
}

function spawnHost(code, name, attempt) {
  G.net = createHost({
    roomCode: code,
    onReady: (id) => {
      G.myId = id;
      G.players = [{ id, name }];
      $('room-code').textContent = id;
      renderLobby();
      show('screen-lobby');
    },
    onData: (peerId, msg) => hostHandle(peerId, msg),
    onDisconnect: (peerId) => {
      G.players = G.players.filter((p) => p.id !== peerId);
      if (G.nightAwait) G.nightAwait.delete(peerId);
      G.net.broadcast({ type: 'players', list: G.players });
      renderLobby();
      lobbyMsg('有玩家离开了');
      if (G.nightAwait) checkAdvance();
    },
    onError: (err) => {
      if (err.type === 'unavailable-id' && attempt < 5) {
        G.net.destroy();
        spawnHost(randomRoomCode(), name, attempt + 1);
      } else {
        homeMsg('创建房间失败（' + (err.type || err) + '），请重试');
      }
    },
  });
}

function hostHandle(peerId, msg) {
  if (msg.type === 'join') {
    if (G.players.length >= MAX_PLAYERS) return;
    if (!G.players.some((p) => p.id === peerId)) {
      G.players.push({ id: peerId, name: msg.name });
    }
    G.net.broadcast({ type: 'players', list: G.players });
    renderLobby();
  } else if (msg.type === 'vote') {
    recordVote(peerId, msg.target);
  } else if (msg.type === 'night-action') {
    recordNightAction(peerId, msg);
  }
}

$('btn-start').onclick = () => startGame();

function startGame() {
  const ids = G.players.map((p) => p.id);
  G.roles = dealRoles(ids);
  G.dice = {};
  ids.forEach((id) => (G.dice[id] = rollDie()));
  G.votes = {};
  // reset night state for a fresh round
  clearNightTimers();
  G.currentNight = 0;
  G.cheeseHolder = null;
  G.nightAwait = new Set();
  G.myWake = null;
  G.myPeek = null;
  G.nightActed = false;
  G.players.forEach((p) => {
    if (p.id === G.myId) {
      G.myRole = G.roles[p.id];
      G.myDie = G.dice[p.id];
    } else {
      G.net.sendTo(p.id, { type: 'role', role: G.roles[p.id], die: G.dice[p.id] });
    }
  });
  setPhase('role');
}

function setPhase(phase) {
  if (G.isHost) G.net.broadcast({ type: 'phase', phase });
  renderPhase(phase);
}

$('btn-to-night').onclick = () => startNight();
$('btn-to-vote').onclick = () => {
  G.votes = {};
  setPhase('voting');
};
$('btn-force-resolve').onclick = () => resolveVotes();
$('btn-replay').onclick = () => startGame();

// ---------- HOST: counted nights ----------
function clearNightTimers() {
  (G.nightTimers || []).forEach(clearTimeout);
  G.nightTimers = [];
}

function startNight() {
  clearNightTimers();
  G.currentNight = 0;
  G.cheeseHolder = null;
  G.nightAwait = new Set();
  G.myWake = null;
  setPhase('night'); // broadcasts phase:'night'; clients show the idle table
  tickNight();
}

function tickNight() {
  clearNightTimers();
  G.currentNight++;
  if (G.currentNight > 6) {
    dawn();
    return;
  }
  const N = G.currentNight;
  G.net.broadcast({ type: 'night-tick', night: N });
  G.nightAwait = new Set();
  G.myWake = null;
  G.nightActed = false;
  for (const id of wakersOn(G.dice, N)) {
    const action = G.roles[id] === ROLES.THIEF ? 'steal' : 'peek';
    if (action === 'steal') G.cheeseHolder = id;
    else G.nightAwait.add(id);
    if (id === G.myId) G.myWake = { night: N, action };
    else G.net.sendTo(id, { type: 'wake', night: N, action });
  }
  renderNight();
  G.nightStartAt = Date.now();
  G.nightTimers = [
    setTimeout(checkAdvance, NIGHT_MIN_MS),
    setTimeout(forceAdvance, NIGHT_MAX_MS),
  ];
}

function checkAdvance() {
  // advance once everyone awake has acted, but never before the minimum beat
  if (G.nightAwait.size === 0 && Date.now() - G.nightStartAt >= NIGHT_MIN_MS) forceAdvance();
}

function forceAdvance() {
  clearNightTimers();
  tickNight();
}

function dawn() {
  clearNightTimers();
  setPhase('day');
}

function recordNightAction(peerId, msg) {
  if (G.dice[peerId] !== G.currentNight) return; // not their night
  if (msg.kind === 'steal') return; // flavor only; cheeseHolder already set at tick
  if (msg.kind === 'peek') {
    const die = resolvePeek(G.dice, G.roles, peerId, msg.target, G.currentNight);
    if (die !== null) {
      const target = G.players.find((p) => p.id === msg.target);
      const name = target ? target.name : '?';
      if (peerId === G.myId) {
        G.myPeek = { name, die };
        renderNight();
      } else {
        G.net.sendTo(peerId, { type: 'peek-result', target: msg.target, name, die });
      }
    }
  }
  // peek (valid or not) and skip both free this mouse
  G.nightAwait.delete(peerId);
  updateHostStatus();
  checkAdvance();
}

// ---------- CLIENT ----------
function joinRoom(code, name) {
  G.isHost = false;
  G.myName = name;
  homeMsg('正在连接房间…');
  G.net = createClient({
    roomCode: code,
    onConnected: (myId) => {
      G.myId = myId;
      G.net.send({ type: 'join', name });
      $('room-code').textContent = code;
      lobbyMsg('已连接，等待房主开始…');
      show('screen-lobby');
    },
    onData: (msg) => clientHandle(msg),
    onDisconnect: () => {
      homeMsg('与房主断开连接，本局结束');
      show('screen-home');
    },
    onError: (err) => {
      homeMsg('连接失败（' + (err.type || err) + '），请检查房间号后重试');
      show('screen-home');
    },
  });
}

function clientHandle(msg) {
  switch (msg.type) {
    case 'players':
      G.players = msg.list;
      renderLobby();
      break;
    case 'role':
      G.myRole = msg.role;
      G.myDie = msg.die;
      break;
    case 'phase':
      renderPhase(msg.phase);
      break;
    case 'night-tick':
      G.currentNight = msg.night;
      G.myWake = null;
      G.nightActed = false;
      renderNight();
      break;
    case 'wake':
      G.myWake = { night: msg.night, action: msg.action };
      G.nightActed = false;
      renderNight();
      break;
    case 'peek-result':
      G.myPeek = { name: msg.name, die: msg.die };
      renderNight();
      break;
    case 'result':
      G.players = msg.reveal.map((r) => ({ id: r.id, name: r.name }));
      renderResult(msg);
      show('screen-result');
      break;
  }
}

// ---------- RENDER ----------
function renderPhase(phase) {
  if (phase === 'role') {
    renderRole();
    show('screen-role');
  } else if (phase === 'night') {
    renderTable();
    renderNight();
    show('screen-night');
  } else if (phase === 'day') {
    renderDay();
    show('screen-day');
  } else if (phase === 'voting') {
    renderVote();
    show('screen-vote');
  }
}

function renderLobby() {
  const ul = $('lobby-players');
  ul.innerHTML = '';
  G.players.forEach((p) => {
    const li = document.createElement('li');
    li.textContent = p.name + (p.id === G.myId ? '（你）' : '');
    ul.appendChild(li);
  });
  if (G.isHost) {
    const n = G.players.length;
    $('btn-start').disabled = !(n >= MIN_PLAYERS && n <= MAX_PLAYERS);
    lobbyMsg(`已加入 ${n} 人（需 ${MIN_PLAYERS}–${MAX_PLAYERS} 人）`);
  }
}

function roleCardHTML(role, die) {
  const cls = role === ROLES.THIEF ? 'thief' : 'mouse';
  const emoji = role === ROLES.THIEF ? '🧀' : '🐭';
  const name = role === ROLES.THIEF ? '奶酪大盗' : '睡鼠';
  return `<div class="card ${cls}"><div class="big">${emoji}</div>
    <div class="role-name">${name}</div>
    <div class="die">你的骰子 ${DICE_FACES[die]} ${die}（= 第 ${die} 晚醒来）</div></div>`;
}

function renderRole() {
  $('role-card').innerHTML = roleCardHTML(G.myRole, G.myDie);
}

// Build the static 4-(to-8-)seat round table. Called once on entering night.
// Seats NEVER react to who wakes — see the privacy invariant at the top of this file.
function renderTable() {
  const table = $('night-table');
  [...table.querySelectorAll('.seat')].forEach((s) => s.remove());
  const n = G.players.length;
  G.players.forEach((p, i) => {
    const angle = ((-90 + (i * 360) / n) * Math.PI) / 180;
    const left = 50 + 42 * Math.cos(angle);
    const top = 50 + 42 * Math.sin(angle);
    const seat = document.createElement('div');
    seat.className = 'seat' + (p.id === G.myId ? ' me' : '');
    seat.style.left = left + '%';
    seat.style.top = top + '%';
    seat.innerHTML = `<div class="avatar">😴</div><div class="seat-name">${p.name}${
      p.id === G.myId ? '（你）' : ''
    }</div>`;
    table.appendChild(seat);
  });
}

function renderNightCounter() {
  $('night-counter').textContent = G.currentNight
    ? `🌙 第 ${G.currentNight} 晚 / 6`
    : '🌙 天黑请闭眼…';
  const pips = $('moon-pips');
  pips.innerHTML = '';
  for (let i = 1; i <= 6; i++) {
    const d = document.createElement('div');
    d.className = 'moon-pip' + (i <= G.currentNight ? ' filled' : '');
    pips.appendChild(d);
  }
}

function peekResultHTML(peek) {
  return `<div class="peek-card">🔍 ${peek.name} 的初始点数是 ${DICE_FACES[peek.die]} ${peek.die}</div>
    <div class="peek-hint">记住它——白天他若报别的点数，就是在撒谎。</div>`;
}

function renderNight() {
  renderNightCounter();
  const cap = $('night-caption');
  const box = $('night-action');
  box.innerHTML = '';

  if (G.myWake && G.myWake.action === 'steal') {
    cap.textContent = '夜深了…';
    box.innerHTML = `<div class="action-title">🧀 趁大家熟睡，你拿走了奶酪！</div>
      <div class="peek-hint">你不能偷看（奶酪属鼠不行）。白天你也要报一个点数——可以撒谎。</div>`;
  } else if (G.myWake && G.myWake.action === 'peek') {
    cap.textContent = '轮到你了…';
    if (G.myPeek) box.innerHTML = peekResultHTML(G.myPeek);
    else if (G.nightActed) box.innerHTML = '<div class="action-title">你选择了装睡 😴</div>';
    else renderPeekPanel(box);
  } else {
    cap.textContent = '大家都睡着了…';
    if (G.myPeek) box.innerHTML = peekResultHTML(G.myPeek);
  }
  updateHostStatus();
}

function renderPeekPanel(box) {
  box.innerHTML = '<div class="action-title">🐭 偷看一名玩家的初始点数（或装睡）</div>';

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn primary';
  confirmBtn.textContent = '确认偷看';
  confirmBtn.disabled = true;

  const opts = document.createElement('div');
  opts.className = 'vote-options';
  G.players
    .filter((p) => p.id !== G.myId)
    .forEach((p) => {
      const b = document.createElement('button');
      b.className = 'vote-opt';
      b.textContent = p.name;
      b.onclick = () => {
        G.peekTarget = p.id;
        [...opts.children].forEach((c) => c.classList.toggle('selected', c === b));
        confirmBtn.disabled = false;
      };
      opts.appendChild(b);
    });
  box.appendChild(opts);

  confirmBtn.onclick = () => sendPeek(G.peekTarget);
  box.appendChild(confirmBtn);

  const skipBtn = document.createElement('button');
  skipBtn.className = 'btn ghost';
  skipBtn.textContent = '装睡（不看）';
  skipBtn.onclick = () => sendSkip();
  box.appendChild(skipBtn);
}

function sendPeek(target) {
  if (!target) return;
  G.peekTarget = null;
  if (G.isHost) recordNightAction(G.myId, { kind: 'peek', target });
  else G.net.send({ type: 'night-action', kind: 'peek', target });
  $('night-action').innerHTML = '<div class="action-title">正在偷看… 🔍</div>';
}

function sendSkip() {
  G.nightActed = true;
  if (G.isHost) recordNightAction(G.myId, { kind: 'skip' });
  else G.net.send({ type: 'night-action', kind: 'skip' });
  renderNight();
}

function updateHostStatus() {
  if (!G.isHost) return;
  const el = $('night-host-status');
  if (!el) return;
  if (G.currentNight >= 1 && G.currentNight <= 6) {
    el.textContent = `第 ${G.currentNight} 晚 · 等待行动 ${G.nightAwait ? G.nightAwait.size : 0} 人`;
  } else {
    el.textContent = '';
  }
}

function renderDay() {
  const ul = $('day-players');
  ul.innerHTML = '';
  G.players.forEach((p) => {
    const li = document.createElement('li');
    li.textContent = p.name + (p.id === G.myId ? '（你）' : '');
    ul.appendChild(li);
  });
  const peekSlot = $('day-peek');
  if (peekSlot) peekSlot.innerHTML = G.myPeek ? peekResultHTML(G.myPeek) : '';
}

function renderVote() {
  G.myVote = null;
  const box = $('vote-options');
  box.innerHTML = '';
  G.players
    .filter((p) => p.id !== G.myId)
    .forEach((p) => {
      const b = document.createElement('button');
      b.className = 'vote-opt';
      b.textContent = p.name;
      b.onclick = () => {
        G.myVote = p.id;
        [...box.children].forEach((c) => c.classList.toggle('selected', c === b));
        $('btn-confirm-vote').disabled = false;
      };
      box.appendChild(b);
    });
  $('btn-confirm-vote').disabled = true;
  $('vote-status').textContent = '';
}

$('btn-confirm-vote').onclick = () => {
  if (!G.myVote) return;
  if (G.isHost) recordVote(G.myId, G.myVote);
  else G.net.send({ type: 'vote', target: G.myVote });
  $('btn-confirm-vote').disabled = true;
  [...$('vote-options').children].forEach((c) => (c.disabled = true));
  $('vote-status').textContent = '已投票，等待其他人…';
};

function recordVote(voterId, target) {
  G.votes[voterId] = target;
  updateVoteStatus();
  if (Object.keys(G.votes).length >= G.players.length) resolveVotes();
}

function updateVoteStatus() {
  if (G.isHost) {
    $('vote-status').textContent = `已投票 ${Object.keys(G.votes).length}/${G.players.length}`;
  }
}

function resolveVotes() {
  const pmap = {};
  G.players.forEach((p) => (pmap[p.id] = { role: G.roles[p.id], die: G.dice[p.id] }));
  const counts = tallyVotes(G.votes);
  const eliminated = resolveElimination(counts, pmap);
  const winner = resolveWinner(eliminated, pmap);
  const reveal = G.players.map((p) => ({
    id: p.id,
    name: p.name,
    role: G.roles[p.id],
    die: G.dice[p.id],
  }));
  const result = { type: 'result', eliminated, winner, reveal, counts };
  G.net.broadcast(result);
  renderResult(result);
  show('screen-result');
}

function renderResult(r) {
  const elim = r.reveal.find((p) => p.id === r.eliminated);
  const winText =
    r.winner === 'villagers' ? '🐭 睡鼠阵营胜利！' : '🧀 大盗逃脱，奶酪大盗胜利！';
  const elimText = elim
    ? `${elim.name} 被投出，身份是 ${elim.role === ROLES.THIEF ? '🧀 奶酪大盗' : '🐭 睡鼠'}`
    : '无人被投出';
  $('result-banner').innerHTML =
    `<div class="winner ${r.winner}">${winText}</div><div class="elim">${elimText}</div>`;

  const t = $('reveal-table');
  t.innerHTML = '<tr><th>玩家</th><th>身份</th><th>骰子</th><th>得票</th></tr>';
  r.reveal.forEach((p) => {
    const tr = document.createElement('tr');
    if (p.id === r.eliminated) tr.className = 'eliminated';
    tr.innerHTML =
      `<td>${p.name}</td>` +
      `<td>${p.role === ROLES.THIEF ? '🧀 大盗' : '🐭 睡鼠'}</td>` +
      `<td>${DICE_FACES[p.die]} ${p.die}</td>` +
      `<td>${r.counts[p.id] || 0}</td>`;
    t.appendChild(tr);
  });
}
