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
  roomCodeFor,
  traitorCount,
  cowakersOfThief,
} from './game.js?v=2';
import { createHost, createClient } from './net.js?v=2';

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
  phase: 'lobby', // lobby | role | night | day | voting | result (host gates joins on this)
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
  log: [], // this player's personal event log for the round
  // traitors (5-8 players):
  traitors: [], // host: traitor ids
  traitorDone: false, // host: traitor phase resolved
  traitorCandidates: null, // host: ids the thief may pick from
  traitorNeed: 0, // host: how many to pick
  myTraitorPrompt: null, // thief client: {candidates, count}
  myTraitorInfo: null, // a traitor: {knowsThief, thiefName, fellows}
  myAllies: null, // thief: names of its traitors
};

// personal log + A/V state
let loggedKeys = new Set();
let localStream = null;
let audioWanted = false; // mic toggle
let videoWanted = false; // camera toggle
let mediaReady = false; // incoming-call answerer set up
const mediaConns = {}; // peerId -> active MediaConnection (one per peer)
const remoteCells = {}; // peerId ('__me' for self) -> { wrap, v }

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
const playTick = (freq = 740) => tone(freq, 0, 90, 0.05);
const playSteal = () => { unlockAudio(); tone(660, 0, 80, 0.09); tone(440, 0.06, 120, 0.08); tone(220, 0.14, 220, 0.07); };
const playVote = () => { unlockAudio(); tone(523, 0, 90, 0.07); tone(784, 0.05, 150, 0.08); };
const playWin = () => { unlockAudio(); tone(523, 0, 160, 0.08); tone(659, 0.12, 160, 0.08); tone(784, 0.24, 320, 0.09); };
const playLose = () => { unlockAudio(); tone(440, 0, 150, 0.08); tone(415, 0.14, 170, 0.08); tone(311, 0.3, 380, 0.09); };
const nameOf = (id) => { const p = G.players.find((x) => x.id === id); return p ? p.name : '?'; };
const diceText = (dice) => (dice || []).map((d) => `${DICE_FACES[d]} ${d}`).join(' · ');

// day/night transition: sun↔moon morph + sky color fade (subtle, indicative)
let skyTimer = null;
function playSky(toNight) {
  const sky = $('sky');
  if (!sky) return;
  const lbl = $('sky-label');
  if (lbl) lbl.textContent = toNight ? '🌙 天黑了' : '☀️ 天亮了';
  sky.className = 'sky';
  void sky.offsetWidth; // reflow so the CSS animation restarts
  sky.className = 'sky show ' + (toNight ? 'to-night' : 'to-day');
  if (skyTimer) clearTimeout(skyTimer);
  // hold, then drop only 'show' so it fades out (keeps the bg during the fade)
  skyTimer = setTimeout(() => (sky.className = 'sky ' + (toNight ? 'to-night' : 'to-day')), 1900);
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
    if (ticks >= 18) {
      clearInterval(diceTimer);
      diceTimer = null;
      slot.classList.remove('dice-rolling');
      slot.textContent = diceText(G.myDice);
    }
  }, 80);
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
  try { localStorage.setItem('nick', name); } catch (e) {} // remember for next time
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
  spawnHost(roomCodeFor(name), name, 0); // same nickname → same room code across refreshes
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
      setupVoiceAnswering();
    },
    onData: (peerId, msg) => hostHandle(peerId, msg),
    onDisconnect: (peerId) => {
      const who = nameOf(peerId);
      const wasThief = G.roles[peerId] === ROLES.THIEF;
      G.players = G.players.filter((p) => p.id !== peerId);
      delete G.roles[peerId];
      delete G.dice[peerId];
      delete G.wakeNights[peerId];
      delete G.votes[peerId];
      G.net.broadcast({ type: 'players', list: G.players });
      if (G.phase === 'lobby' || G.phase === 'result') {
        renderLobby();
        lobbyMsg(`${who} 离开了房间`);
        return;
      }
      // mid-game disconnect
      if (wasThief) return abortRound('🧀 大盗掉线了，本局作废，请房主重开');
      if (G.players.length < MIN_PLAYERS) return abortRound('人数不足（少于 4 人），本局作废');
      if (G.phase === 'role') updateChooseGate();
      else if (G.phase === 'voting') {
        $('vote-status').textContent = `已投票 ${Object.keys(G.votes).length}/${G.players.length}`;
        if (!G.voteResolved && Object.keys(G.votes).length >= G.players.length) resolveVotes();
      }
    },
    onError: (err) => {
      if (err.type === 'unavailable-id') {
        G.net.destroy();
        if (attempt < 2) {
          // usually our own peer from a refresh still releasing — keep the nickname code
          setTimeout(() => spawnHost(code, name, attempt + 1), 700);
        } else if (attempt < 5) {
          // genuine clash (another online host with the same nickname) — use a random code
          spawnHost(randomRoomCode(), name, attempt + 1);
        } else {
          homeMsg('创建房间失败，请重试');
        }
      } else {
        homeMsg('创建房间失败（' + (err.type || err) + '），请重试');
      }
    },
  });
}

function hostHandle(peerId, msg) {
  if (msg.type === 'join') {
    const inPlay = ['role', 'night', 'day', 'voting'].includes(G.phase);
    if (inPlay || G.players.length >= MAX_PLAYERS) {
      G.net.sendTo(peerId, { type: 'rejected', reason: inPlay ? '游戏进行中，请等本局结束再加入' : '房间已满（最多 8 人）' });
      return;
    }
    if (!G.players.some((p) => p.id === peerId)) G.players.push({ id: peerId, name: msg.name });
    G.net.broadcast({ type: 'players', list: G.players });
    G.net.sendTo(peerId, { type: 'setting', peek: G.peekEnabled });
    renderLobby();
  } else if (msg.type === 'wake-choice') {
    recordWakeChoice(peerId, msg.nights);
  } else if (msg.type === 'night-action') {
    recordNightAction(peerId, msg);
  } else if (msg.type === 'traitor-pick') {
    recordTraitorPick(peerId, msg.ids);
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
  G.traitors = [];
  G.traitorDone = false;
  G.traitorCandidates = null;
  G.traitorNeed = 0;
  G.myTraitorPrompt = null;
  G.myTraitorInfo = null;
  G.myAllies = null;
  resetLog();
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
  updateChooseGate();
}

function updateChooseGate() {
  if (!G.isHost) return;
  const chosen = G.players.filter((p) => G.wakeNights[p.id]).length;
  const ready = G.players.length >= MIN_PLAYERS && chosen === G.players.length;
  $('btn-to-night').disabled = !ready;
  $('role-wait').textContent = ready
    ? '大家都选好了，可以进入夜晚'
    : `等待大家选择… ${chosen}/${G.players.length}`;
}

// a player critical to the round dropped (or too few left) — void the round, back to lobby
function abortRound(text) {
  clearNightTimers();
  stopCountdown();
  G.phase = 'lobby';
  G.net.broadcast({ type: 'aborted', text });
  show('screen-lobby');
  renderLobby();
  lobbyMsg(text);
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
    afterNights();
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
  playSteal();
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

const thiefIdOf = () => Object.keys(G.roles).find((id) => G.roles[id] === ROLES.THIEF);

// after night 6: 5-8 player games recruit accomplices before dawn
function afterNights() {
  clearNightTimers();
  stopCountdown();
  const n = G.players.length;
  if (n < 5 || G.traitorDone) return dawn();
  startTraitorPhase();
}

function startTraitorPhase() {
  const n = G.players.length;
  const count = traitorCount(n);
  let candidates;
  if (n === 5) {
    // 5p: the thief's co-wakers become the traitor pool
    candidates = cowakersOfThief(G.wakeNights, G.roles);
    if (candidates.length <= count) return finishTraitors(candidates); // 0 → none, 1 → auto
  } else {
    candidates = G.players.map((p) => p.id).filter((id) => G.roles[id] !== ROLES.THIEF);
  }
  G.traitorCandidates = candidates;
  G.traitorNeed = count;
  setPhase('traitor');
  const thiefId = thiefIdOf();
  const prompt = { type: 'traitor-prompt', candidates: candidates.map((id) => ({ id, name: nameOf(id) })), count };
  if (thiefId === G.myId) {
    G.myTraitorPrompt = { candidates: prompt.candidates, count };
    renderTraitor();
  } else {
    G.net.sendTo(thiefId, prompt);
  }
  // AFK safety: auto-pick if the thief never chooses
  G.nightTimers = [
    setTimeout(() => {
      if (!G.traitorDone) finishTraitors(candidates.slice(0, count));
    }, 25000),
  ];
}

function recordTraitorPick(peerId, ids) {
  if (G.traitorDone) return;
  if (peerId !== thiefIdOf()) return; // only the thief picks
  const valid = (ids || []).filter((id) => (G.traitorCandidates || []).includes(id));
  if (valid.length !== G.traitorNeed) return;
  finishTraitors(valid);
}

function finishTraitors(ids) {
  if (G.traitorDone) return;
  G.traitorDone = true;
  clearNightTimers();
  G.traitors = ids;
  const n = G.players.length;
  const knowsThief = n !== 7; // 7p: traitors know each other but not the thief
  const thiefId = thiefIdOf();
  ids.forEach((id) => {
    const fellows = ids.filter((x) => x !== id).map(nameOf);
    const info = { type: 'traitor-assigned', knowsThief, thiefName: knowsThief ? nameOf(thiefId) : null, fellows };
    if (id === G.myId) applyTraitorInfo(info);
    else G.net.sendTo(id, info);
  });
  if (ids.length) {
    const names = ids.map(nameOf);
    if (thiefId === G.myId) G.myAllies = names;
    else G.net.sendTo(thiefId, { type: 'traitor-allies', names });
  }
  dawn();
}

function applyTraitorInfo(info) {
  G.myTraitorInfo = { knowsThief: info.knowsThief, thiefName: info.thiefName, fellows: info.fellows || [] };
  let line = '🤝 你被招募为共犯';
  if (info.knowsThief && info.thiefName) line += `，大盗是 ${info.thiefName}`;
  if (info.fellows && info.fellows.length) line += `，同伙：${info.fellows.join('、')}`;
  logOnce('traitor', line);
  renderTraitor();
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
      setupVoiceAnswering();
    },
    onData: (msg) => clientHandle(msg),
    onDisconnect: () => {
      homeMsg('与房主断开连接。可重新输入房间号再次加入。');
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
      G.myVote = null;
      G.nightActed = false;
      G.peekSent = false;
      G.thiefHeld = false;
      G.currentNight = 0;
      G.nightIntro = false;
      G.myTraitorPrompt = null;
      G.myTraitorInfo = null;
      G.myAllies = null;
      resetLog();
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
    case 'traitor-prompt':
      G.myTraitorPrompt = { candidates: msg.candidates, count: msg.count };
      renderTraitor();
      break;
    case 'traitor-assigned':
      applyTraitorInfo(msg);
      break;
    case 'traitor-allies':
      G.myAllies = msg.names;
      break;
    case 'result':
      G.players = msg.reveal.map((r) => ({ id: r.id, name: r.name }));
      renderResult(msg);
      show('screen-result');
      break;
    case 'aborted':
      G.phase = 'lobby';
      stopCountdown();
      show('screen-lobby');
      lobbyMsg(msg.text || '本局作废，等待房主重开');
      break;
    case 'rejected':
      homeMsg(msg.reason || '无法加入房间');
      show('screen-home');
      break;
  }
}

// ---------- RENDER ----------
function renderPhase(phase) {
  G.phase = phase;
  applyNightMute(); // mic auto-mutes & camera auto-hides during secret phases
  updateMediaButtons();
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
  } else if (phase === 'traitor') {
    renderTraitor();
    show('screen-traitor');
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
  logOnce('role', `🎭 身份：${G.myRole === ROLES.THIEF ? '🧀 奶酪大盗' : '🐭 睡鼠'}（骰子 ${diceText(G.myDice)}）`);
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
    if (G.countdownVal >= 1 && G.countdownVal <= 3) playTick(740 + (4 - G.countdownVal) * 80);
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
  if (!el) return;
  el.textContent = G.countdownVal > 0 ? `⏳ ${G.countdownVal}` : '';
  el.classList.toggle('urgent', G.countdownVal > 0 && G.countdownVal <= 3);
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
    const n = G.myWake.night;
    const others = (G.myWake.coWakers || []).filter((w) => w.id !== G.myId).map((w) => w.name);
    let line = others.length ? `👀 你睁眼了 · 同晚醒来：${others.join('、')}` : '👀 你睁眼了 · 这一晚只有你';
    const tb = G.myWake.cheeseTakenBy;
    if (tb && tb.id !== G.myId) line += ` ｜ 🧀 你看到 ${tb.name} 拿走了奶酪！`;
    else if (G.myWake.cheeseGone && (!tb || tb.id === G.myId) && G.myRole !== ROLES.THIEF)
      line += ' ｜ 🧀 中间的奶酪已经不见了';
    cap.textContent = line;
    // personal log
    logOnce('wake' + n, `🌙 第${n}晚 你睁眼${others.length ? '，同晚：' + others.join('、') : '（只有你）'}`);
    if (tb && tb.id === G.myId) logOnce('mysteal', `🧀 第${n}晚 你拿走了奶酪`);
    else if (tb) logOnce('sawtheft', `🧀 第${n}晚 你看到 ${tb.name} 拿走了奶酪`);
  } else {
    const mine = G.wakeNights[G.myId] || [];
    const upcoming = mine.filter((n) => n > G.currentNight);
    cap.textContent = upcoming.length
      ? `😴 你在睡觉…你会在第 ${upcoming.join('、')} 晚睁眼`
      : '😴 你在睡觉…静待天亮';
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
  if (G.myPeek) logOnce('peek', `🔍 你偷看 ${G.myPeek.name}：${DICE_FACES[G.myPeek.die]} ${G.myPeek.die}`);
}

function renderStealChoice(box) {
  if (G.thiefHeld) {
    box.innerHTML = '<div class="action-title">你忍住了 · 留到下一晚再偷 🧀</div>';
    return;
  }
  const later = Math.max(...distinctNights(G.myDice));
  const others = (G.myWake.coWakers || []).filter((w) => w.id !== G.myId);
  const warn = others.length
    ? `⚠️ 今晚还有 ${others.length} 人睁着眼，现在偷会被他们看见。`
    : '✅ 今晚只有你睁眼，现在偷最安全。';
  box.innerHTML = `<div class="action-title">🧀 你睁眼了 · 现在偷还是留到第 ${later} 晚？</div><div class="peek-hint">${warn}</div>`;
  const a = document.createElement('button');
  a.className = 'btn primary tempt';
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
  a.className = 'btn primary tempt';
  a.textContent = '偷走奶酪';
  a.onclick = () => sendSteal();
  box.appendChild(a);
  const hint = document.createElement('div');
  hint.className = 'peek-hint';
  hint.textContent = '这是你唯一/最后的睁眼之夜，必须在今晚拿走。';
  box.appendChild(hint);
}

function sendSteal() {
  unlockAudio();
  tone(880, 0, 50, 0.06); // instant tactile click (the real steal sound lands after the round-trip)
  if (G.isHost) thiefSteal(G.currentNight);
  else G.net.send({ type: 'night-action', kind: 'steal', night: G.currentNight });
}

// ---------- traitor phase (5-8 players) ----------
function renderTraitor() {
  const body = $('traitor-body');
  if (!body) return;
  if (G.myRole === ROLES.THIEF && G.myTraitorPrompt && !G.myAllies) {
    renderTraitorPick(body, G.myTraitorPrompt);
  } else if (G.myTraitorInfo) {
    body.innerHTML = traitorInfoHTML();
  } else if (G.myRole === ROLES.THIEF && G.myAllies) {
    body.innerHTML = `<div class="action-title">🤝 你的共犯：${G.myAllies.join('、')}</div>`;
  } else {
    body.innerHTML = '<div class="action-title">🌙 奶酪大盗正在挑选共犯…</div>';
  }
}

function renderTraitorPick(body, prompt) {
  body.innerHTML = `<div class="action-title">🤝 大盗，挑选 ${prompt.count} 名共犯（与你共享胜利）</div>`;
  const picks = new Set();
  const opts = document.createElement('div');
  opts.className = 'vote-options';
  const confirm = document.createElement('button');
  confirm.className = 'btn primary';
  confirm.textContent = '确认';
  confirm.disabled = true;
  prompt.candidates.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'vote-opt';
    b.textContent = c.name;
    b.onclick = () => {
      if (picks.has(c.id)) {
        picks.delete(c.id);
        b.classList.remove('selected');
      } else {
        if (picks.size >= prompt.count) return;
        picks.add(c.id);
        b.classList.add('selected');
      }
      confirm.disabled = picks.size !== prompt.count;
    };
    opts.appendChild(b);
  });
  body.appendChild(opts);
  confirm.onclick = () => {
    confirm.disabled = true;
    sendTraitorPick([...picks]);
    body.querySelector('.action-title').textContent = '🤝 已选好，天就要亮了…';
  };
  body.appendChild(confirm);
}

function sendTraitorPick(ids) {
  if (G.isHost) recordTraitorPick(G.myId, ids);
  else G.net.send({ type: 'traitor-pick', ids });
}

function traitorInfoHTML() {
  const info = G.myTraitorInfo;
  let s = '<div class="action-title">🤝 你被招募为共犯！与奶酪大盗共享胜利</div>';
  if (info.knowsThief && info.thiefName) s += `<div class="peek-hint">大盗是：${info.thiefName}</div>`;
  if (info.fellows && info.fellows.length) s += `<div class="peek-hint">其他共犯：${info.fellows.join('、')}</div>`;
  if (!info.knowsThief) s += '<div class="peek-hint">你不知道大盗是谁，护好彼此。</div>';
  return s;
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
  if (note) {
    let h = '';
    if (G.myTraitorInfo) {
      const ti = G.myTraitorInfo;
      h += `<div class="peek-card" style="margin-bottom:8px">🤝 你是共犯${
        ti.knowsThief && ti.thiefName ? '，大盗：' + ti.thiefName : ''
      }${ti.fellows && ti.fellows.length ? '，同伙：' + ti.fellows.join('、') : ''}</div>`;
    }
    if (G.myAllies && G.myAllies.length)
      h += `<div class="peek-card" style="margin-bottom:8px">🤝 你的共犯：${G.myAllies.join('、')}</div>`;
    if (G.myPeek) h += '<div class="peek-hint" style="margin:0 0 6px">🔍 你的私密线索：</div>' + peekResultHTML(G.myPeek);
    note.innerHTML = h;
  }
  const dh = $('day-hint');
  if (dh) dh.textContent = G.isHost ? '开语音讨论，聊完后点下方「开始投票」。' : '开语音讨论，等房主点「开始投票」。';
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
  playVote();
  if (G.isHost) recordVote(G.myId, G.myVote);
  else G.net.send({ type: 'vote', target: G.myVote });
  $('btn-confirm-vote').disabled = true;
  [...$('vote-options').children].forEach((c) => (c.disabled = true));
  if (!G.isHost) $('vote-status').textContent = '你已投票，等待其他人…';
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
  const reveal = G.players.map((p) => ({
    id: p.id,
    name: p.name,
    role: G.roles[p.id],
    dice: G.dice[p.id],
    traitor: G.traitors.includes(p.id),
  }));
  const result = { type: 'result', eliminated, winner, reveal, counts };
  G.net.broadcast(result);
  renderResult(result);
  show('screen-result');
}

function renderResult(r) {
  G.phase = 'result';
  (r.winner === 'sleepyheads' ? playWin : playLose)();
  const roleLabel = (p) => (p.role === ROLES.THIEF ? '🧀 大盗' : p.traitor ? '🤝 背叛者' : '🐭 睡鼠');
  const hasTraitors = r.reveal.some((p) => p.traitor);
  const winText =
    r.winner === 'sleepyheads' ? '🐭 睡鼠阵营胜利！' : hasTraitors ? '🧀 大盗阵营胜利！' : '🧀 奶酪大盗胜利！';
  const elimNames = r.eliminated.map((id) => {
    const p = r.reveal.find((x) => x.id === id);
    return p ? `${p.name}（${roleLabel(p)}）` : '?';
  });
  const elimText = elimNames.length ? `出局：${elimNames.join('、')}` : '无人出局';
  logOnce('result', `🏁 ${winText} ｜ ${elimText}`);
  $('result-banner').innerHTML = `<div class="winner ${r.winner}">${winText}</div><div class="elim">${elimText}</div>`;

  const t = $('reveal-table');
  t.innerHTML = '<tr><th>玩家</th><th>身份</th><th>骰子</th><th>得票</th></tr>';
  r.reveal.forEach((p, i) => {
    const tr = document.createElement('tr');
    if (r.eliminated.includes(p.id)) tr.className = 'eliminated';
    tr.style.animationDelay = (i + 1) * 0.1 + 's'; // stagger the identity reveal
    tr.innerHTML =
      `<td>${p.name}</td>` +
      `<td>${roleLabel(p)}</td>` +
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
  if (n > 4) {
    const tc = traitorCount(n);
    html +=
      `<p><b>共犯</b>：${n} 人局有 <b>${tc}</b> 名共犯（与大盗共享胜利）。` +
      (n === 5 ? '和大盗同晚睁眼的人会成为共犯。' : '数完第6晚后，大盗再睁眼挑选共犯。') +
      (n === 7 ? '（两名共犯彼此相认，但不知道大盗是谁）' : '') +
      '</p>' +
      '<p class="r-note">投出共犯也算大盗阵营获胜——要找的是大盗本人。</p>';
  }
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

// copy a join link (prefills the room code for whoever opens it)
$('btn-copy-code').onclick = () => {
  const code = $('room-code').textContent;
  if (!code) return;
  const url = location.origin + location.pathname + '?room=' + encodeURIComponent(code);
  const done = () => {
    const b = $('btn-copy-code');
    b.textContent = '已复制 ✓ 发给朋友';
    setTimeout(() => (b.textContent = '📋 复制房间号链接'), 1800);
  };
  if (navigator.clipboard) navigator.clipboard.writeText(url).then(done).catch(done);
  else done();
};

// deep link: /?room=CHS-XXXX prefills the join field
const _roomParam = new URLSearchParams(location.search).get('room');
if (_roomParam) $('code-input').value = _roomParam.toUpperCase();

// remember the last nickname across refreshes
try {
  const _nick = localStorage.getItem('nick');
  if (_nick) $('name-input').value = _nick;
} catch (e) {}

// ---------- personal log (collapsible side panel) ----------
function logOnce(key, text) {
  if (loggedKeys.has(key)) return;
  loggedKeys.add(key);
  G.log.push(text);
  renderLog();
}
function resetLog() {
  G.log = [];
  loggedKeys = new Set();
  renderLog();
}
function renderLog() {
  const list = $('log-list');
  if (!list) return;
  list.innerHTML = G.log.length
    ? G.log.map((t) => `<div class="log-entry">${t}</div>`).join('')
    : '<div class="log-empty">本局还没有和你相关的记录</div>';
  list.scrollTop = list.scrollHeight;
}
$('log-toggle').onclick = () => $('log-panel').classList.toggle('open');
$('log-close').onclick = () => $('log-panel').classList.remove('open');

// ---------- A/V: PeerJS mesh audio + optional video (opt-in; video shows by day only) ----------
$('mic-btn').onclick = () => { audioWanted = !audioWanted; refreshMedia(); };
$('cam-btn').onclick = () => {
  videoWanted = !videoWanted;
  if (videoWanted) audioWanted = true; // opening the camera turns the mic on too
  refreshMedia();
};

const videoPhaseOk = () => !['role', 'night', 'traitor'].includes(G.phase); // hide video in secret phases

// kept name (called on connect): set up answering incoming calls so we receive others
function setupVoiceAnswering() {
  if (mediaReady || !G.net || !G.net.peer) return;
  mediaReady = true;
  G.net.peer.on('call', (call) => {
    call.answer(localStream || undefined);
    attachCall(call.peer, call);
  });
}

function attachCall(id, call) {
  if (mediaConns[id] && mediaConns[id] !== call) {
    try { mediaConns[id].close(); } catch (e) {}
  }
  mediaConns[id] = call;
  call.on('stream', (s) => renderRemote(id, s));
  call.on('close', () => {
    if (mediaConns[id] === call) {
      delete mediaConns[id];
      removeRemote(id);
    }
  });
}

function callPeer(id) {
  if (!G.net || !G.net.peer || !localStream) return;
  try {
    const call = G.net.peer.call(id, localStream);
    if (call) attachCall(id, call);
  } catch (e) {
    /* ignore */
  }
}

async function refreshMedia() {
  setupVoiceAnswering();
  if (!audioWanted && !videoWanted) {
    stopVidMonitor();
    Object.values(mediaConns).forEach((c) => { try { c.close(); } catch (e) {} });
    if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
    updateLocalTile();
    updateMediaButtons();
    updateMediaGrid();
    return;
  }
  if (videoWanted) vidTier = pickInitialTier(); // start at a resolution matched to the network
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: audioWanted,
      video: videoWanted ? tierVideoConstraints(vidTier) : false,
    });
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    localStream = stream;
  } catch (e) {
    audioWanted = false;
    videoWanted = false; // permission denied / no device — stay off
    updateMediaButtons();
    return;
  }
  applyNightMute(); // set track.enabled per current phase
  G.players.forEach((p) => { if (p.id !== G.myId) callPeer(p.id); });
  if (videoWanted) {
    applyTier(vidTier); // cap sender bitrate to the tier
    startVidMonitor(); // then auto-adjust by measured packet loss
  } else {
    stopVidMonitor();
  }
  updateLocalTile();
  updateMediaButtons();
  updateMediaGrid();
}

function renderRemote(id, stream) {
  let cell = remoteCells[id];
  if (!cell) {
    const v = document.createElement('video');
    v.autoplay = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    const wrap = document.createElement('div');
    wrap.className = 'vid-cell';
    const label = document.createElement('span');
    label.className = 'vid-name';
    label.textContent = nameOf(id);
    wrap.appendChild(v);
    wrap.appendChild(label);
    $('video-grid').appendChild(wrap);
    cell = remoteCells[id] = { wrap, v };
  }
  cell.v.srcObject = stream;
  cell.v.play().catch(() => {});
  updateMediaGrid();
}

function removeRemote(id) {
  const cell = remoteCells[id];
  if (cell) {
    cell.wrap.remove();
    delete remoteCells[id];
  }
  updateMediaGrid();
}

function updateLocalTile() {
  const grid = $('video-grid');
  if (!grid) return;
  const haveVideo = localStream && localStream.getVideoTracks().length > 0;
  let cell = remoteCells['__me'];
  if (haveVideo) {
    if (!cell) {
      const v = document.createElement('video');
      v.autoplay = true;
      v.muted = true; // avoid hearing yourself
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.style.transform = 'scaleX(-1)'; // mirror self-view
      const wrap = document.createElement('div');
      wrap.className = 'vid-cell me';
      const label = document.createElement('span');
      label.className = 'vid-name';
      label.textContent = '你';
      wrap.appendChild(v);
      wrap.appendChild(label);
      grid.insertBefore(wrap, grid.firstChild);
      cell = remoteCells['__me'] = { wrap, v };
    }
    cell.v.srcObject = localStream;
    cell.v.play().catch(() => {});
  } else if (cell) {
    cell.wrap.remove();
    delete remoteCells['__me'];
  }
}

// applies per-phase audio mute + video hide (kept name for the renderPhase call site)
function applyNightMute() {
  if (localStream) {
    localStream.getAudioTracks().forEach((t) => (t.enabled = G.phase !== 'night'));
    localStream.getVideoTracks().forEach((t) => (t.enabled = videoPhaseOk()));
  }
  updateMediaGrid();
}

function updateMediaGrid() {
  const grid = $('video-grid');
  const wrap = $('video-wrap');
  if (!grid || !wrap) return;
  const showVideo = videoPhaseOk();
  let anyVisible = false;
  [...grid.children].forEach((cell) => {
    const v = cell.querySelector('video');
    const hasVid = v && v.srcObject && v.srcObject.getVideoTracks().length > 0;
    const vis = showVideo && hasVid;
    cell.style.display = vis ? '' : 'none';
    if (vis) anyVisible = true;
  });
  wrap.style.display = anyVisible ? 'flex' : 'none';
}

// ---------- adaptive video resolution (by network) ----------
const VID_TIERS = [
  { w: 160, h: 120, fr: 15, br: 120000 },
  { w: 240, h: 180, fr: 20, br: 300000 },
  { w: 320, h: 240, fr: 24, br: 600000 },
  { w: 480, h: 360, fr: 24, br: 1100000 },
];
let vidTier = 2;
let vidMon = null;
let healthyStreak = 0;

function pickInitialTier() {
  try {
    const c = navigator.connection;
    if (c && c.effectiveType) {
      if (c.effectiveType === '4g') return c.downlink && c.downlink >= 5 ? 3 : 2;
      if (c.effectiveType === '3g') return 1;
      return 0; // 2g / slow-2g
    }
  } catch (e) {}
  return 2;
}
const tierVideoConstraints = (i) => {
  const t = VID_TIERS[i];
  return { width: { ideal: t.w }, height: { ideal: t.h }, frameRate: { ideal: t.fr } };
};
async function applyTier(i) {
  vidTier = Math.max(0, Math.min(VID_TIERS.length - 1, i));
  const t = VID_TIERS[vidTier];
  try {
    const vt = localStream && localStream.getVideoTracks()[0];
    if (vt) await vt.applyConstraints(tierVideoConstraints(vidTier));
  } catch (e) {}
  Object.values(mediaConns).forEach((conn) => {
    try {
      const pc = conn.peerConnection;
      if (!pc) return;
      pc.getSenders().forEach((s) => {
        if (s.track && s.track.kind === 'video') {
          const p = s.getParameters();
          if (!p.encodings || !p.encodings.length) p.encodings = [{}];
          p.encodings[0].maxBitrate = t.br;
          s.setParameters(p).catch(() => {});
        }
      });
    } catch (e) {}
  });
}
function startVidMonitor() {
  stopVidMonitor();
  healthyStreak = 0;
  vidMon = setInterval(monitorVid, 4000);
}
function stopVidMonitor() {
  if (vidMon) {
    clearInterval(vidMon);
    vidMon = null;
  }
}
async function monitorVid() {
  if (!localStream || localStream.getVideoTracks().length === 0) return;
  let lossSum = 0;
  let lossN = 0;
  for (const conn of Object.values(mediaConns)) {
    try {
      const pc = conn.peerConnection;
      if (!pc) continue;
      const stats = await pc.getStats();
      stats.forEach((r) => {
        if (r.type === 'remote-inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video') && typeof r.fractionLost === 'number') {
          lossSum += r.fractionLost;
          lossN++;
        }
      });
    } catch (e) {}
  }
  if (!lossN) return;
  const loss = lossSum / lossN;
  if (loss > 0.04 && vidTier > 0) {
    applyTier(vidTier - 1); // network struggling → drop resolution
    healthyStreak = 0;
  } else if (loss < 0.02) {
    if (++healthyStreak >= 3 && vidTier < VID_TIERS.length - 1) {
      applyTier(vidTier + 1); // sustained healthy → raise
      healthyStreak = 0;
    }
  } else {
    healthyStreak = 0;
  }
}

function updateMediaButtons() {
  const m = $('mic-btn');
  if (m) {
    const nightMuted = audioWanted && G.phase === 'night';
    m.className = 'mic-btn' + (audioWanted ? ' on' : '') + (nightMuted ? ' night' : '');
    m.textContent = !audioWanted ? '🎙️' : nightMuted ? '🌙' : '🎤';
    m.title = !audioWanted ? '点开麦克风语音' : nightMuted ? '夜晚已自动静音' : '语音开启中（点关闭）';
  }
  const c = $('cam-btn');
  if (c) {
    const camHidden = videoWanted && !videoPhaseOk();
    c.className = 'cam-btn' + (videoWanted ? ' on' : '') + (camHidden ? ' night' : '');
    c.textContent = !videoWanted ? '📷' : camHidden ? '🌙' : '🎥';
    c.title = !videoWanted ? '点开摄像头（白天显示画面）' : camHidden ? '此阶段画面自动隐藏' : '摄像头开启中（点关闭）';
  }
}

renderLog(); // show the empty-state placeholder at load

// video tile size — user-adjustable via −/＋ buttons, persisted across sessions
(function initVidSize() {
  let v = 120;
  try {
    const s = localStorage.getItem('vidSize');
    if (s) v = +s;
  } catch (e) {}
  const setSize = (nv) => {
    v = Math.max(90, Math.min(280, nv));
    document.documentElement.style.setProperty('--vid-size', v + 'px');
    try { localStorage.setItem('vidSize', v); } catch (e) {}
  };
  setSize(v);
  const sm = $('vid-smaller');
  const bg = $('vid-bigger');
  if (sm) sm.onclick = () => setSize(v - 30);
  if (bg) bg.onclick = () => setSize(v + 30);
})();
