// Wires UI + networking + game logic into the phase state machine.
// The host's browser is authoritative: it deals roles + 2 dice, runs the counted
// nights, collects votes and resolves outcomes. Clients render what the host sends.
//
// NIGHT PRIVACY: who wakes on night N is sent privately (via `wake`) only to the
// players awake that night, so co-wakers recognize each other. Asleep players get
// only the bare `night-tick` (an integer) and see a static all-sleeping table.
import {
  ROLES,
  dealRoles,
  rollDie,
  tallyVotes,
  distinctNights,
  wakersAt,
  resolveEliminations,
  resolveWinner,
  randomRoomCode,
} from './game.js';
import { createHost, createClient } from './net.js';

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 4;
const NIGHT_SECONDS = 10;
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
  myDice: null, // [a, b]
  myVote: null,
  peekEnabled: true, // toggle set by host in the lobby
  // host-authoritative state:
  players: [], // [{id, name}]
  roles: {}, // id -> role
  dice: {}, // id -> [a, b]
  wakeNights: {}, // id -> [nights]  (built from each player's choice)
  wakeSubmitted: false, // local: have I submitted my wake choice
  votes: {}, // voterId -> targetId
  // night state:
  currentNight: 0,
  cheeseHolder: null,
  nightTimers: [],
  countdownTimer: null,
  countdownVal: 0,
  myWake: null, // {night, action, coWakers:[{id,name}], cheeseTakenBy:{id,name}|null}
  myPeek: null, // {name, dice:[a,b]}
  nightActed: false,
  peekTarget: null,
};

// ---------- audio (generated, unlocked on first user gesture) ----------
let audioCtx = null;
function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) {
    /* audio optional */
  }
}
function tone(freq, startOffset, durMs, gain) {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime + startOffset;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  osc.connect(g);
  g.connect(audioCtx.destination);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
  osc.start(t0);
  osc.stop(t0 + durMs / 1000 + 0.02);
}
const playNightBell = () => { unlockAudio(); tone(392, 0, 500, 0.08); tone(294, 0.12, 600, 0.07); };
const playWakeChime = () => { unlockAudio(); tone(659, 0, 250, 0.09); tone(880, 0.13, 350, 0.08); };
const playTick = () => tone(740, 0, 90, 0.05);
const nameOf = (id) => { const p = G.players.find((x) => x.id === id); return p ? p.name : '?'; };
const diceText = (dice) => (dice || []).map((d) => `${DICE_FACES[d]} ${d}`).join(' · ');

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
  unlockAudio();
  const name = readName();
  if (name) startHosting(name);
};

$('btn-join').onclick = () => {
  unlockAudio();
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
      renderPeekState();
      renderLobby();
      show('screen-lobby');
    },
    onData: (peerId, msg) => hostHandle(peerId, msg),
    onDisconnect: (peerId) => {
      G.players = G.players.filter((p) => p.id !== peerId);
      G.net.broadcast({ type: 'players', list: G.players });
      renderLobby();
      lobbyMsg('有玩家离开了');
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
    if (!G.players.some((p) => p.id === peerId)) G.players.push({ id: peerId, name: msg.name });
    G.net.broadcast({ type: 'players', list: G.players });
    G.net.sendTo(peerId, { type: 'setting', peek: G.peekEnabled });
    renderLobby();
  } else if (msg.type === 'wake-choice') {
    recordWakeChoice(peerId, msg.nights);
  } else if (msg.type === 'night-action') {
    recordNightAction(peerId, msg);
  } else if (msg.type === 'vote') {
    recordVote(peerId, msg.target);
  }
}

$('btn-peek-toggle').onclick = () => {
  G.peekEnabled = !G.peekEnabled;
  renderPeekState();
  G.net.broadcast({ type: 'setting', peek: G.peekEnabled });
};

$('btn-start').onclick = () => startGame();

function startGame() {
  const ids = G.players.map((p) => p.id);
  G.roles = dealRoles(ids);
  G.dice = {};
  ids.forEach((id) => (G.dice[id] = [rollDie(), rollDie()]));
  G.wakeNights = {};
  G.votes = {};
  clearNightTimers();
  stopCountdown();
  G.currentNight = 0;
  G.cheeseHolder = null;
  G.myWake = null;
  G.myPeek = null;
  G.nightActed = false;
  G.wakeSubmitted = false;
  G.players.forEach((p) => {
    if (p.id === G.myId) {
      G.myRole = G.roles[p.id];
      G.myDice = G.dice[p.id];
    } else {
      G.net.sendTo(p.id, { type: 'role', role: G.roles[p.id], dice: G.dice[p.id] });
    }
  });
  setPhase('role');
}

function setPhase(phase) {
  if (G.isHost) G.net.broadcast({ type: 'phase', phase });
  renderPhase(phase);
}

// host learns each player's chosen wake schedule before the night can begin
function recordWakeChoice(id, nights) {
  G.wakeNights[id] = nights;
  if (G.isHost) {
    const ready = G.players.every((p) => G.wakeNights[p.id]);
    $('btn-to-night').disabled = !ready;
    $('role-wait').textContent = ready
      ? '大家都选好了，可以进入夜晚'
      : `等待大家选择… ${Object.keys(G.wakeNights).length}/${G.players.length}`;
  }
}

function submitWakeChoice(nights) {
  if (G.wakeSubmitted) return;
  G.wakeSubmitted = true;
  if (G.isHost) recordWakeChoice(G.myId, nights);
  else {
    G.net.send({ type: 'wake-choice', nights });
    $('role-wait').textContent = '已选好，等待房主开始…';
  }
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
  G.myWake = null;
  setPhase('night');
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
  const wakers = wakersAt(G.wakeNights, N);
  const wakerList = wakers.map((id) => ({ id, name: nameOf(id) }));
  const thiefId = wakers.find((id) => G.roles[id] === ROLES.THIEF) || null;
  const cheeseTakenBy = thiefId ? { id: thiefId, name: nameOf(thiefId) } : null;
  if (thiefId) G.cheeseHolder = thiefId;
  G.myWake = null;
  G.nightActed = false;
  for (const id of wakers) {
    let action;
    if (G.roles[id] === ROLES.THIEF) action = 'steal';
    else action = wakers.length === 1 && G.peekEnabled ? 'peek' : 'recognize';
    const wake = { type: 'wake', night: N, action, coWakers: wakerList, cheeseTakenBy };
    if (id === G.myId) G.myWake = { night: N, action, coWakers: wakerList, cheeseTakenBy };
    else G.net.sendTo(id, wake);
  }
  startCountdown();
  if (G.myWake) playWakeChime();
  renderTable();
  renderNight();
  G.nightTimers = [setTimeout(forceAdvance, NIGHT_SECONDS * 1000)];
}

function forceAdvance() {
  clearNightTimers();
  tickNight();
}

function dawn() {
  clearNightTimers();
  stopCountdown();
  setPhase('day');
}

function recordNightAction(peerId, msg) {
  if (msg.kind !== 'peek') return; // recognize/skip need no host response
  if (!G.peekEnabled) return;
  const target = G.players.find((p) => p.id === msg.target);
  if (!target || msg.target === peerId) return;
  const payload = { type: 'peek-result', target: msg.target, name: target.name, dice: G.dice[msg.target] };
  if (peerId === G.myId) {
    G.myPeek = { name: target.name, dice: G.dice[msg.target] };
    renderNight();
  } else {
    G.net.sendTo(peerId, payload);
  }
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
    case 'setting':
      G.peekEnabled = msg.peek;
      renderPeekState();
      break;
    case 'role':
      G.myRole = msg.role;
      G.myDice = msg.dice;
      break;
    case 'phase':
      renderPhase(msg.phase);
      break;
    case 'night-tick':
      G.currentNight = msg.night;
      G.myWake = null;
      G.nightActed = false;
      startCountdown();
      renderTable();
      renderNight();
      break;
    case 'wake':
      G.myWake = { night: msg.night, action: msg.action, coWakers: msg.coWakers || [], cheeseTakenBy: msg.cheeseTakenBy || null };
      G.nightActed = false;
      playWakeChime();
      renderTable();
      renderNight();
      break;
    case 'peek-result':
      G.myPeek = { name: msg.name, dice: msg.dice };
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

function renderPeekState() {
  const t = G.peekEnabled
    ? '偷看规则：开 · 独自睁眼时可偷看一名玩家的点数'
    : '偷看规则：关 · 官方 4 人玩法，无偷看';
  const s = $('peek-state');
  if (s) s.textContent = t;
  const btn = $('btn-peek-toggle');
  if (btn) btn.textContent = G.peekEnabled ? '开' : '关';
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
    lobbyMsg(`已加入 ${n} 人（需 ${MIN_PLAYERS} 人）`);
  }
}

function roleCardHTML(role, dice) {
  const cls = role === ROLES.THIEF ? 'thief' : 'mouse';
  const emoji = role === ROLES.THIEF ? '🧀' : '🐭';
  const name = role === ROLES.THIEF ? '奶酪大盗' : '睡鼠';
  return `<div class="card ${cls}"><div class="big">${emoji}</div>
    <div class="role-name">${name}</div>
    <div class="die">你的两颗骰子：${diceText(dice)}</div></div>`;
}

function renderRole() {
  $('role-card').innerHTML = roleCardHTML(G.myRole, G.myDice);
  renderWakeChoice();
}

function renderWakeChoice() {
  const box = $('wake-choice');
  box.innerHTML = '';
  const nights = distinctNights(G.myDice);

  if (G.myRole === ROLES.THIEF) {
    box.innerHTML =
      nights.length === 2
        ? `<div class="choice-info">🧀 你会在 <b>第 ${nights[0]} 晚</b> 和 <b>第 ${nights[1]} 晚</b> 各睁眼一次，每次都要拿走奶酪（可能被同晚的人看到）。</div>`
        : `<div class="choice-info">🧀 你会在 <b>第 ${nights[0]} 晚</b> 睁眼，拿走奶酪。</div>`;
    submitWakeChoice(nights);
    return;
  }

  // sleepyhead
  if (nights.length === 1) {
    box.innerHTML = `<div class="choice-info">🐭 你会在 <b>第 ${nights[0]} 晚</b> 睁眼。</div>`;
    submitWakeChoice([nights[0]]);
    return;
  }
  if (G.wakeSubmitted) {
    box.innerHTML = `<div class="choice-info">已选：第 ${G.wakeNights[G.myId] ? G.wakeNights[G.myId][0] : '?'} 晚 睁眼</div>`;
    return;
  }
  box.innerHTML = '<div class="choice-info">🐭 选择你要睁眼的那一晚：</div>';
  const row = document.createElement('div');
  row.className = 'vote-options';
  nights.forEach((nt) => {
    const b = document.createElement('button');
    b.className = 'vote-opt';
    b.textContent = `第 ${nt} 晚`;
    b.onclick = () => {
      submitWakeChoice([nt]);
      renderWakeChoice();
    };
    row.appendChild(b);
  });
  box.appendChild(row);
}

// Static seats; eyes-open + cheese-taken shown only to a fellow waker.
function renderTable() {
  const table = $('night-table');
  [...table.querySelectorAll('.seat')].forEach((s) => s.remove());
  const awake = G.myWake ? new Set((G.myWake.coWakers || []).map((w) => w.id)) : new Set();
  const cheeseSeat = G.myWake && G.myWake.cheeseTakenBy ? G.myWake.cheeseTakenBy.id : null;
  const n = G.players.length;
  G.players.forEach((p, i) => {
    const angle = ((-90 + (i * 360) / n) * Math.PI) / 180;
    const left = 50 + 42 * Math.cos(angle);
    const top = 50 + 42 * Math.sin(angle);
    const isAwake = awake.has(p.id);
    const tookCheese = p.id === cheeseSeat;
    const seat = document.createElement('div');
    seat.className = 'seat' + (p.id === G.myId ? ' me' : '') + (isAwake ? ' awake' : '') + (tookCheese ? ' cheese' : '');
    seat.style.left = left + '%';
    seat.style.top = top + '%';
    seat.innerHTML =
      `<div class="avatar">${isAwake ? '🐭' : '😴'}${tookCheese ? '<span class="cheese-badge">🧀</span>' : ''}</div>` +
      `<div class="seat-name">${p.name}${p.id === G.myId ? '（你）' : ''}</div>`;
    table.appendChild(seat);
  });
}

function startCountdown() {
  stopCountdown();
  G.countdownVal = NIGHT_SECONDS;
  playNightBell();
  renderCountdown();
  G.countdownTimer = setInterval(() => {
    G.countdownVal--;
    if (G.countdownVal >= 1 && G.countdownVal <= 3) playTick();
    renderCountdown();
    if (G.countdownVal <= 0) stopCountdown();
  }, 1000);
}
function stopCountdown() {
  if (G.countdownTimer) {
    clearInterval(G.countdownTimer);
    G.countdownTimer = null;
  }
}
function renderCountdown() {
  const el = $('night-timer');
  if (el) el.textContent = G.countdownVal > 0 ? `⏳ ${G.countdownVal}` : '';
}

function renderNightCounter() {
  $('night-counter').textContent = G.currentNight ? `🌙 第 ${G.currentNight} 晚 / 6` : '🌙 天黑请闭眼…';
  const pips = $('moon-pips');
  pips.innerHTML = '';
  for (let i = 1; i <= 6; i++) {
    const d = document.createElement('div');
    d.className = 'moon-pip' + (i <= G.currentNight ? ' filled' : '');
    pips.appendChild(d);
  }
}

function peekResultHTML(peek) {
  return `<div class="peek-card">🔍 ${peek.name} 的骰子是 ${diceText(peek.dice)}</div>
    <div class="peek-hint">记住它——白天他若报别的点数，就是在撒谎。</div>`;
}

function renderNight() {
  renderNightCounter();
  renderCountdown();
  const cap = $('night-caption');
  const box = $('night-action');
  box.innerHTML = '';

  if (G.myWake) {
    const others = (G.myWake.coWakers || []).filter((w) => w.id !== G.myId).map((w) => w.name);
    let line = others.length ? `👀 你睁眼了 · 同晚醒来：${others.join('、')}` : '👀 你睁眼了 · 这一晚只有你';
    const tb = G.myWake.cheeseTakenBy;
    if (tb && tb.id !== G.myId) line += ` ｜ 🧀 你看到 ${tb.name} 拿走了奶酪！`;
    cap.textContent = line;
  } else {
    cap.textContent = '大家都睡着了…';
  }

  if (G.myWake && G.myWake.action === 'steal') {
    box.innerHTML = `<div class="action-title">🧀 趁夜色，你拿走了奶酪！</div>
      <div class="peek-hint">同一晚睁眼的人会看到是你拿的。白天可以撒谎。</div>`;
  } else if (G.myWake && G.myWake.action === 'peek') {
    if (G.myPeek) box.innerHTML = peekResultHTML(G.myPeek);
    else if (G.nightActed) box.innerHTML = '<div class="action-title">你选择了不看 😴</div>';
    else renderPeekPanel(box);
  } else if (G.myWake && G.myWake.action === 'recognize') {
    box.innerHTML = '<div class="action-title">你和别人同一晚睁眼 · 记住他们的脸 🐭</div>';
  } else if (G.myPeek) {
    box.innerHTML = peekResultHTML(G.myPeek);
  }
}

function renderPeekPanel(box) {
  box.innerHTML = '<div class="action-title">🐭 你独自睁眼 · 可偷看一名玩家的点数（或不看）</div>';
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
  skipBtn.textContent = '不看';
  skipBtn.onclick = () => {
    G.nightActed = true;
    renderNight();
  };
  box.appendChild(skipBtn);
}

function sendPeek(target) {
  if (!target) return;
  G.peekTarget = null;
  if (G.isHost) recordNightAction(G.myId, { kind: 'peek', target });
  else G.net.send({ type: 'night-action', kind: 'peek', target });
  $('night-action').innerHTML = '<div class="action-title">正在偷看… 🔍</div>';
}

function renderDay() {
  const ul = $('day-players');
  ul.innerHTML = '';
  G.players.forEach((p) => {
    const li = document.createElement('li');
    li.textContent = p.name + (p.id === G.myId ? '（你）' : '');
    ul.appendChild(li);
  });
  const note = $('day-note');
  if (note) note.innerHTML = G.myPeek ? peekResultHTML(G.myPeek) : '';
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
  if (G.isHost) $('vote-status').textContent = `已投票 ${Object.keys(G.votes).length}/${G.players.length}`;
  if (Object.keys(G.votes).length >= G.players.length) resolveVotes();
}

function resolveVotes() {
  const counts = tallyVotes(G.votes);
  const eliminated = resolveEliminations(counts);
  const winner = resolveWinner(eliminated, G.roles);
  const reveal = G.players.map((p) => ({ id: p.id, name: p.name, role: G.roles[p.id], dice: G.dice[p.id] }));
  const result = { type: 'result', eliminated, winner, reveal, counts };
  G.net.broadcast(result);
  renderResult(result);
  show('screen-result');
}

function renderResult(r) {
  const winText = r.winner === 'sleepyheads' ? '🐭 睡鼠阵营胜利！' : '🧀 奶酪大盗胜利！';
  const elimNames = r.eliminated.map((id) => {
    const p = r.reveal.find((x) => x.id === id);
    return p ? `${p.name}（${p.role === ROLES.THIEF ? '🧀 大盗' : '🐭 睡鼠'}）` : '?';
  });
  const elimText = elimNames.length ? `出局：${elimNames.join('、')}` : '无人出局';
  $('result-banner').innerHTML = `<div class="winner ${r.winner}">${winText}</div><div class="elim">${elimText}</div>`;

  const t = $('reveal-table');
  t.innerHTML = '<tr><th>玩家</th><th>身份</th><th>骰子</th><th>得票</th></tr>';
  r.reveal.forEach((p) => {
    const tr = document.createElement('tr');
    if (r.eliminated.includes(p.id)) tr.className = 'eliminated';
    tr.innerHTML =
      `<td>${p.name}</td>` +
      `<td>${p.role === ROLES.THIEF ? '🧀 大盗' : '🐭 睡鼠'}</td>` +
      `<td>${diceText(p.dice)}</td>` +
      `<td>${r.counts[p.id] || 0}</td>`;
    t.appendChild(tr);
  });
}
