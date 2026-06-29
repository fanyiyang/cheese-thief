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
const MAX_PLAYERS = 8;
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
  voteResolved: false, // host: guard so late/duplicate votes can't re-resolve
  // night state:
  currentNight: 0,
  cheeseHolder: null,
  stolen: false, // host: has the thief taken the cheese yet
  theftNight: null, // host: the night it was taken
  thiefHeld: false, // local (thief): chose to wait this night
  nightIntro: false, // showing the "cheese is here" reveal before counting starts
  nightTimers: [],
  countdownTimer: null,
  countdownVal: 0,
  myWake: null, // {night, action, coWakers:[{id,name}], cheeseTakenBy, cheeseGone}
  myPeek: null, // {target, name, die}
  nightActed: false, // chose to skip (装睡)
  peekSent: false, // tapped a head, waiting for the result
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

// day/night transition: sun↔moon morph + sky color fade (subtle, indicative)
let skyTimer = null;
function playSky(toNight) {
  const sky = $('sky');
  if (!sky) return;
  $('sky-label').textContent = toNight ? '🌙 天黑了' : '☀️ 天亮了';
  sky.className = 'sky';
  void sky.offsetWidth; // reflow so the CSS animation restarts
  sky.className = 'sky show ' + (toNight ? 'to-night' : 'to-day');
  if (skyTimer) clearTimeout(skyTimer);
  skyTimer = setTimeout(() => (sky.className = 'sky'), 1300);
}

// brief dice-roll: cycle random faces, then settle on the real roll
let diceTimer = null;
function rollDiceAnim() {
  const slot = $('dice-slot');
  if (!slot) return;
  if (diceTimer) clearInterval(diceTimer);
  slot.classList.add('dice-rolling');
  let ticks = 0;
  diceTimer = setInterval(() => {
    ticks++;
    slot.textContent = (G.myDice || [1]).map(() => DICE_FACES[1 + Math.floor(Math.random() * 6)]).join(' ');
    if (ticks >= 12) {
      clearInterval(diceTimer);
      diceTimer = null;
      slot.classList.remove('dice-rolling');
      slot.textContent = diceText(G.myDice);
    }
  }, 70);
}

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
  // peek ON → 2 dice (pick a wake night, lone peek); peek OFF → 1 die (simpler, no choice)
  const diceCount = G.peekEnabled ? 2 : 1;
  G.dice = {};
  ids.forEach((id) => (G.dice[id] = Array.from({ length: diceCount }, () => rollDie())));
  G.wakeNights = {};
  G.votes = {};
  G.voteResolved = false;
  clearNightTimers();
  stopCountdown();
  G.currentNight = 0;
  G.cheeseHolder = null;
  G.stolen = false;
  G.theftNight = null;
  G.thiefHeld = false;
  G.nightIntro = false;
  G.myWake = null;
  G.myPeek = null;
  G.nightActed = false;
  G.peekSent = false;
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
  G.wakeNights[G.myId] = nights; // record locally so my own "已选" display is correct
  if (G.isHost) recordWakeChoice(G.myId, nights);
  else {
    G.net.send({ type: 'wake-choice', nights });
    $('role-wait').textContent = '已选好，等待房主开始…';
  }
}

$('btn-to-night').onclick = () => startNight();
$('btn-to-vote').onclick = () => {
  G.votes = {};
  G.voteResolved = false;
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
  G.stolen = false;
  G.theftNight = null;
  G.myWake = null;
  setPhase('night'); // renderPhase('night') shows the "cheese is here" reveal
  // hold the reveal a moment, then cover the cheese and begin counting
  G.nightTimers = [
    setTimeout(() => {
      G.nightIntro = false;
      tickNight();
    }, 2800),
  ];
}

function tickNight() {
  clearNightTimers();
  G.nightIntro = false;
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
  const thiefLastNight = thiefId ? Math.max(...G.wakeNights[thiefId]) : null;
  const cheeseGone = G.stolen; // taken on an earlier night

  // The thief is never forced silently: it gets a button each wake night and
  // decides which night to take the cheese (see renderNight). endNight() is the
  // only auto-steal, and only as an AFK safety net on the last chance.
  G.myWake = null;
  G.thiefHeld = false;
  G.nightActed = false;
  G.peekSent = false;
  for (const id of wakers) {
    let action;
    if (id === thiefId) {
      if (G.stolen) action = 'stole-earlier'; // already taken on an earlier night
      else if (N === thiefLastNight) action = 'steal-last'; // last chance — must take it now
      else action = 'steal-choice'; // take now, or wait for the later night
    } else {
      action = wakers.length === 1 && G.peekEnabled ? 'peek' : 'recognize';
    }
    const wake = { type: 'wake', night: N, action, coWakers: wakerList, cheeseTakenBy: null, cheeseGone };
    if (id === G.myId) G.myWake = { night: N, action, coWakers: wakerList, cheeseTakenBy: null, cheeseGone };
    else G.net.sendTo(id, wake);
  }
  startCountdown();
  if (G.myWake) playWakeChime();
  renderTable();
  renderNight();
  G.nightTimers = [setTimeout(endNight, NIGHT_SECONDS * 1000)];
}

function endNight() {
  // AFK safety net: the thief must end up with the cheese. If it never clicked
  // by its last wake night, take it now so the round stays valid.
  const thiefId = Object.keys(G.roles).find((id) => G.roles[id] === ROLES.THIEF);
  if (
    thiefId &&
    !G.stolen &&
    G.wakeNights[thiefId] &&
    G.currentNight === Math.max(...G.wakeNights[thiefId])
  ) {
    thiefSteal(G.currentNight);
  }
  forceAdvance();
}

// the thief chose to steal on the current night (an earlier-than-last wake night)
function thiefSteal(N) {
  if (G.stolen) return;
  const thiefId = Object.keys(G.roles).find((id) => G.roles[id] === ROLES.THIEF);
  G.stolen = true;
  G.theftNight = N;
  G.cheeseHolder = thiefId;
  const by = { id: thiefId, name: nameOf(thiefId) };
  for (const id of wakersAt(G.wakeNights, N)) {
    if (id === G.myId) applyTheft(by);
    else G.net.sendTo(id, { type: 'theft', by });
  }
}

// a player awake this night learns the cheese was just taken
function applyTheft(by) {
  if (!G.myWake) return;
  G.myWake.cheeseTakenBy = by;
  G.myWake.cheeseGone = true;
  if (by.id === G.myId) G.myWake.action = 'steal'; // show "you took it"
  renderTable();
  renderNight();
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
  if (msg.kind === 'steal') {
    // only the thief, on one of its wake nights, before the cheese is taken
    if (
      G.roles[peerId] === ROLES.THIEF &&
      !G.stolen &&
      (G.wakeNights[peerId] || []).includes(G.currentNight)
    ) {
      thiefSteal(G.currentNight);
    }
    return;
  }
  if (msg.kind !== 'peek') return;
  if (!G.peekEnabled) return;
  const target = G.players.find((p) => p.id === msg.target);
  if (!target || msg.target === peerId) return;
  const pair = G.dice[msg.target];
  const die = pair[Math.floor(Math.random() * pair.length)]; // reveal ONE random die
  if (peerId === G.myId) {
    G.myPeek = { target: msg.target, name: target.name, die };
    renderTable();
    renderNight();
  } else {
    G.net.sendTo(peerId, { type: 'peek-result', target: msg.target, name: target.name, die });
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
      // a fresh 'role' means a new round — clear last round's per-game state
      // (the host resets the same fields in startGame; clients must too)
      G.myRole = msg.role;
      G.myDice = msg.dice;
      G.wakeSubmitted = false;
      G.wakeNights = {};
      G.myWake = null;
      G.myPeek = null;
      G.nightActed = false;
      G.peekSent = false;
      G.thiefHeld = false;
      G.currentNight = 0;
      G.nightIntro = false;
      break;
    case 'phase':
      renderPhase(msg.phase);
      break;
    case 'night-tick':
      G.currentNight = msg.night;
      G.nightIntro = false;
      G.myWake = null;
      G.nightActed = false;
      G.peekSent = false;
      G.thiefHeld = false;
      startCountdown();
      renderTable();
      renderNight();
      break;
    case 'wake':
      G.myWake = {
        night: msg.night,
        action: msg.action,
        coWakers: msg.coWakers || [],
        cheeseTakenBy: msg.cheeseTakenBy || null,
        cheeseGone: !!msg.cheeseGone,
      };
      G.nightActed = false;
      G.peekSent = false;
      G.thiefHeld = false;
      playWakeChime();
      renderTable();
      renderNight();
      break;
    case 'theft':
      applyTheft(msg.by);
      break;
    case 'peek-result':
      G.myPeek = { target: msg.target, name: msg.name, die: msg.die };
      renderTable();
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
    G.nightIntro = true;
    G.currentNight = 0;
    G.myWake = null;
    playSky(true);
    playNightBell();
    renderTable();
    renderNight();
    show('screen-night');
  } else if (phase === 'day') {
    playSky(false);
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
    lobbyMsg(`已加入 ${n} 人（需 ${MIN_PLAYERS}–${MAX_PLAYERS} 人）`);
  }
}

function roleCardHTML(role, dice) {
  const cls = role === ROLES.THIEF ? 'thief' : 'mouse';
  const emoji = role === ROLES.THIEF ? '🧀' : '🐭';
  const name = role === ROLES.THIEF ? '奶酪大盗' : '睡鼠';
  return `<div class="card ${cls}"><div class="big">${emoji}</div>
    <div class="role-name">${name}</div>
    <div class="die">你的骰子：<span id="dice-slot">🎲</span></div></div>`;
}

function renderRole() {
  $('role-card').innerHTML = roleCardHTML(G.myRole, G.myDice);
  rollDiceAnim();
  renderWakeChoice();
}

function renderWakeChoice() {
  const box = $('wake-choice');
  box.innerHTML = '';
  const nights = distinctNights(G.myDice);

  if (G.myRole === ROLES.THIEF) {
    box.innerHTML =
      nights.length === 2
        ? `<div class="choice-info">🧀 你会在 <b>第 ${nights[0]} 晚</b> 和 <b>第 ${nights[1]} 晚</b> 各睁眼一次，到时由你<b>挑其中一晚</b>拿走奶酪（拿的时候可能被同晚睁眼的人看到）。</div>`
        : `<div class="choice-info">🧀 你只会在 <b>第 ${nights[0]} 晚</b> 睁眼，那一晚拿走奶酪。</div>`;
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
  // The cheese sits under a cup. The cup lifts during the opening reveal, or when
  // YOU are awake tonight — then you see whether the cheese is still there or gone.
  const spot = $('cheese-spot');
  const under = $('cheese-under');
  const lifted = G.nightIntro || !!G.myWake;
  const present = G.nightIntro ? true : G.myWake ? !G.myWake.cheeseGone : true;
  if (spot) spot.classList.toggle('lifted', lifted);
  if (under) {
    under.classList.toggle('empty', !present);
    under.textContent = present ? '🧀' : '';
  }
  const awake = G.myWake ? new Set((G.myWake.coWakers || []).map((w) => w.id)) : new Set();
  const cheeseSeat = G.myWake && G.myWake.cheeseTakenBy ? G.myWake.cheeseTakenBy.id : null;
  // peek: when you're awake alone and may look, other heads become tappable
  const peekMode = !!(G.myWake && G.myWake.action === 'peek' && !G.myPeek && !G.nightActed && !G.peekSent);
  const peekedId = G.myPeek ? G.myPeek.target : null;
  const n = G.players.length;
  G.players.forEach((p, i) => {
    const angle = ((-90 + (i * 360) / n) * Math.PI) / 180;
    const left = 50 + 42 * Math.cos(angle);
    const top = 50 + 42 * Math.sin(angle);
    const isAwake = awake.has(p.id);
    const tookCheese = p.id === cheeseSeat;
    const canPeek = peekMode && p.id !== G.myId;
    const wasPeeked = peekedId && p.id === peekedId;
    const seat = document.createElement('div');
    seat.className =
      'seat' +
      (p.id === G.myId ? ' me' : '') +
      (isAwake ? ' awake' : '') +
      (tookCheese ? ' cheese' : '') +
      (canPeek ? ' peekable' : '') +
      (wasPeeked ? ' peeked' : '');
    seat.style.left = left + '%';
    seat.style.top = top + '%';
    let badge = tookCheese ? '<span class="cheese-badge">🧀</span>' : '';
    if (wasPeeked) badge += `<span class="peek-badge">🔍 ${DICE_FACES[G.myPeek.die]}${G.myPeek.die}</span>`;
    seat.innerHTML =
      `<div class="avatar">${isAwake ? '😳' : '😴'}${badge}</div>` +
      `<div class="seat-name">${p.name}${p.id === G.myId ? '（你）' : ''}</div>`;
    if (canPeek) seat.onclick = () => sendPeek(p.id);
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
  return `<div class="peek-card">🔍 ${peek.name} 的其中一颗骰子是 ${DICE_FACES[peek.die]} ${peek.die}</div>
    <div class="peek-hint">随机看到的一颗（对方有两颗）。记住它。</div>`;
}

function renderNight() {
  renderNightCounter();
  renderCountdown();
  const cap = $('night-caption');
  const box = $('night-action');
  box.innerHTML = '';

  if (G.nightIntro) {
    cap.textContent = '🧀 奶酪在这里…准备数夜，看谁会偷走它';
    return;
  }

  if (G.myWake) {
    const others = (G.myWake.coWakers || []).filter((w) => w.id !== G.myId).map((w) => w.name);
    let line = others.length ? `👀 你睁眼了 · 同晚醒来：${others.join('、')}` : '👀 你睁眼了 · 这一晚只有你';
    const tb = G.myWake.cheeseTakenBy;
    if (tb && tb.id !== G.myId) line += ` ｜ 🧀 你看到 ${tb.name} 拿走了奶酪！`;
    else if (G.myWake.cheeseGone && (!tb || tb.id === G.myId) && G.myRole !== ROLES.THIEF)
      line += ' ｜ 🧀 中间的奶酪已经不见了';
    cap.textContent = line;
  } else {
    cap.textContent = '大家都睡着了…';
  }

  const act = G.myWake ? G.myWake.action : null;
  if (act === 'steal') {
    box.innerHTML = `<div class="action-title">🧀 你拿走了奶酪！</div>
      <div class="peek-hint">同一晚睁眼的人会看到是你拿的。白天可以撒谎。</div>`;
  } else if (act === 'steal-choice') {
    renderStealChoice(box);
  } else if (act === 'steal-last') {
    renderStealMust(box);
  } else if (act === 'stole-earlier') {
    box.innerHTML = '<div class="action-title">🧀 奶酪已在你手上 · 这一晚你也睁着眼</div>';
  } else if (act === 'peek') {
    if (G.myPeek) box.innerHTML = peekResultHTML(G.myPeek);
    else if (G.nightActed) box.innerHTML = '<div class="action-title">你选择了不看 😴</div>';
    else if (G.peekSent) box.innerHTML = '<div class="action-title">正在偷看… 🔍</div>';
    else renderPeekPrompt(box);
  } else if (act === 'recognize') {
    box.innerHTML = '<div class="action-title">你和别人同一晚睁眼 · 记住他们 😳</div>';
  } else if (G.myPeek) {
    box.innerHTML = peekResultHTML(G.myPeek);
  }
}

function renderStealChoice(box) {
  if (G.thiefHeld) {
    box.innerHTML = '<div class="action-title">你忍住了 · 留到下一晚再偷 🧀</div>';
    return;
  }
  const later = Math.max(...distinctNights(G.myDice));
  box.innerHTML = `<div class="action-title">🧀 你睁眼了 · 现在就偷，还是留到第 ${later} 晚？</div>`;
  const a = document.createElement('button');
  a.className = 'btn primary';
  a.textContent = `现在就偷（第 ${G.myWake.night} 晚）`;
  a.onclick = () => sendSteal();
  box.appendChild(a);
  const b = document.createElement('button');
  b.className = 'btn ghost';
  b.textContent = `忍住，留到第 ${later} 晚再偷`;
  b.onclick = () => {
    G.thiefHeld = true;
    renderNight();
  };
  box.appendChild(b);
}

function renderStealMust(box) {
  box.innerHTML = '<div class="action-title">🧀 最后机会 · 拿走奶酪</div>';
  const a = document.createElement('button');
  a.className = 'btn primary';
  a.textContent = '偷走奶酪';
  a.onclick = () => sendSteal();
  box.appendChild(a);
  const hint = document.createElement('div');
  hint.className = 'peek-hint';
  hint.textContent = '这是你唯一/最后的睁眼之夜，必须在今晚拿走。';
  box.appendChild(hint);
}

function sendSteal() {
  if (G.isHost) thiefSteal(G.currentNight);
  else G.net.send({ type: 'night-action', kind: 'steal', night: G.currentNight });
}

function renderPeekPrompt(box) {
  box.innerHTML = '<div class="action-title">🔍 点桌上一个人的头像，偷看他的一颗骰子</div>';
  const skip = document.createElement('button');
  skip.className = 'btn ghost';
  skip.textContent = '装睡（不看）';
  skip.onclick = () => {
    G.nightActed = true;
    renderTable();
    renderNight();
  };
  box.appendChild(skip);
}

function sendPeek(target) {
  if (!target || G.peekSent || G.myPeek) return;
  G.peekSent = true;
  renderTable(); // drop the tappable hint right away
  if (G.isHost) recordNightAction(G.myId, { kind: 'peek', target });
  else {
    G.net.send({ type: 'night-action', kind: 'peek', target });
    renderNight();
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
  if (G.voteResolved) return; // ignore late/duplicate votes after resolution
  G.votes[voterId] = target;
  if (G.isHost) $('vote-status').textContent = `已投票 ${Object.keys(G.votes).length}/${G.players.length}`;
  if (Object.keys(G.votes).length >= G.players.length) resolveVotes();
}

function resolveVotes() {
  if (G.voteResolved) return;
  G.voteResolved = true;
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

// ---------- rules overlay (concise, adapts to player count + mode) ----------
function renderRules() {
  const n = G.players.length || 4;
  const peek = G.peekEnabled;
  const dice = peek ? 2 : 1;
  let html =
    '<h3>🧀 奶酪大盗 · 规则</h3>' +
    `<p class="r-meta">${n} 人 · ${peek ? '开偷看（每人 2 颗骰子）' : '关偷看（每人 1 颗骰子）'}</p>` +
    '<p><b>目标</b>：找出奶酪大盗。投出大盗 → 🐭 睡鼠阵营赢；投错（投出睡鼠）→ 🧀 大盗赢。</p>' +
    `<p><b>身份</b>：${n} 人 = <b>1</b> 名奶酪大盗 + <b>${n - 1}</b> 名睡鼠。每人秘密拿到身份和 ${dice} 颗骰子。</p>` +
    '<p><b>夜晚</b>：主持从「第1晚」数到「第6晚」，每晚约 10 秒。你骰子的点数 = 你睁眼的那一晚。' +
    (peek ? '两颗点数不同的睡鼠，可自己挑一晚睁眼。' : '') +
    '同一晚睁眼的人会互相看到对方睁眼。</p>' +
    '<p><b>奶酪大盗</b>：在自己睁眼的那晚拿走奶酪' +
    (peek ? '（若两晚都睁眼，自己点按钮选其中一晚拿）' : '') +
    '。拿的时候，同晚睁眼的人会看到是他拿的（关键线索）。</p>' +
    (peek
      ? '<p><b>偷看</b>：若你（睡鼠）某晚<b>独自</b>睁眼，可点桌上一个人的头像，偷看他的一颗骰子点数。</p>'
      : '') +
    '<p><b>白天</b>：开语音自由讨论、推理、诈唬（语音请自备）。</p>' +
    '<p><b>投票</b>：所有人同时投票，得票最多者出局并翻牌；<b>平票则全部出局</b>。</p>';
  if (n > 4) html += '<p class="r-note">注：本版 5–8 人暂未加入「共犯」，目前为 1 名大盗对全场。</p>';
  $('rules-card').innerHTML = html + '<button id="rules-close" class="btn primary">知道了</button>';
  $('rules-close').onclick = hideRules;
}
function showRules() {
  renderRules();
  $('rules-overlay').classList.add('show');
}
function hideRules() {
  $('rules-overlay').classList.remove('show');
}
$('rules-btn').onclick = showRules;
$('rules-overlay').onclick = (e) => {
  if (e.target.id === 'rules-overlay') hideRules();
};
