// Pure game logic for 奶酪大盗 (Cheese Thief). No DOM, no network — unit-testable.
// All randomness is injectable via an `rng` returning a float in [0, 1).

export const ROLES = { MOUSE: 'mouse', THIEF: 'thief' };

// Fisher-Yates shuffle (non-mutating).
export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Deal 1 thief + (n-1) mice to the given player ids. Returns { id: role }.
export function dealRoles(ids, rng = Math.random) {
  const roles = [ROLES.THIEF, ...Array(Math.max(0, ids.length - 1)).fill(ROLES.MOUSE)];
  const shuffled = shuffle(roles, rng);
  const out = {};
  ids.forEach((id, i) => {
    out[id] = shuffled[i];
  });
  return out;
}

// Roll a six-sided die → integer 1..6.
export function rollDie(rng = Math.random) {
  return Math.floor(rng() * 6) + 1;
}

// The thief holds the cheese, so their effective point is always 7 (the max).
export function effectivePoint(player) {
  return player.role === ROLES.THIEF ? 7 : player.die;
}

// votes: { voterId: targetId } → { targetId: count }
export function tallyVotes(votes) {
  const counts = {};
  for (const target of Object.values(votes)) {
    counts[target] = (counts[target] || 0) + 1;
  }
  return counts;
}

// Who gets flipped: most votes wins; ties broken by highest effective point
// (thief = 7, so the thief always loses a vote tie); final ties broken by id order.
export function resolveElimination(counts, players) {
  const ids = Object.keys(counts);
  if (ids.length === 0) return null;

  const maxVotes = Math.max(...ids.map((id) => counts[id]));
  let candidates = ids.filter((id) => counts[id] === maxVotes);
  if (candidates.length === 1) return candidates[0];

  const maxPoint = Math.max(...candidates.map((id) => effectivePoint(players[id])));
  candidates = candidates.filter((id) => effectivePoint(players[id]) === maxPoint);
  if (candidates.length === 1) return candidates[0];

  return candidates.sort()[0];
}

// Villagers (mice) win if the eliminated player was the thief; otherwise the thief wins.
export function resolveWinner(eliminatedId, players) {
  return players[eliminatedId].role === ROLES.THIEF ? 'villagers' : 'thief';
}

// Room code used as the host's PeerJS id. Unambiguous alphabet (no 0/O/1/I/L).
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function randomRoomCode(rng = Math.random, len = 4) {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
  }
  return 'CHS-' + s;
}
