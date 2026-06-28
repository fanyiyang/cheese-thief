// Wires UI + networking + game logic into the phase state machine.
// The host's browser is authoritative: it deals roles, collects votes and
// resolves outcomes. Clients render what the host sends and report actions.
import {
  ROLES,
  dealRoles,
  rollDie,
  tallyVotes,
  resolveElimination,
  resolveWinner,
  randomRoomCode,
} from './game.js';
import { createHost, createClient } from './net.js';

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 8;
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
    if (!G.players.some((p) => p.id === peerId)) {
      G.players.push({ id: peerId, name: msg.name });
    }
    G.net.broadcast({ type: 'players', list: G.players });
    renderLobby();
  } else if (msg.type === 'vote') {
    recordVote(peerId, msg.target);
  }
}

$('btn-start').onclick = () => startGame();

function startGame() {
  const ids = G.players.map((p) => p.id);
  G.roles = dealRoles(ids);
  G.dice = {};
  ids.forEach((id) => (G.dice[id] = rollDie()));
  G.votes = {};
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

$('btn-to-night').onclick = () => setPhase('night');
$('btn-to-day').onclick = () => setPhase('day');
$('btn-to-vote').onclick = () => {
  G.votes = {};
  setPhase('voting');
};
$('btn-force-resolve').onclick = () => resolveVotes();
$('btn-replay').onclick = () => startGame();

function recordVote(voterId, target) {
  G.votes[voterId] = target;
  updateVoteStatus();
  if (Object.keys(G.votes).length >= G.players.length) resolveVotes();
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
    <div class="die">你的骰子 ${DICE_FACES[die]} ${die}</div></div>`;
}

function renderRole() {
  $('role-card').innerHTML = roleCardHTML(G.myRole, G.myDie);
}

function renderNight() {
  $('night-text').innerHTML =
    G.myRole === ROLES.THIEF
      ? '🌙 夜深了…<br>趁大家熟睡，你悄悄拿走了桌上的奶酪 🧀'
      : '🌙 天黑了，你睡着了…<br>小心有人偷奶酪！';
}

function renderDay() {
  const ul = $('day-players');
  ul.innerHTML = '';
  G.players.forEach((p) => {
    const li = document.createElement('li');
    li.textContent = p.name + (p.id === G.myId ? '（你）' : '');
    ul.appendChild(li);
  });
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

function updateVoteStatus() {
  if (G.isHost) {
    $('vote-status').textContent = `已投票 ${Object.keys(G.votes).length}/${G.players.length}`;
  }
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
