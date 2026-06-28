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

// The distinct nights a pair of dice could wake on (sorted). A matching pair
// collapses to one night; a differing pair gives two.
export function distinctNights(pair) {
  return [...new Set(pair)].sort((a, b) => a - b);
}

// schedule: { id: [nights...] } → ids scheduled to wake on night n, sorted.
export function wakersAt(schedule, n) {
  return Object.keys(schedule)
    .filter((id) => schedule[id].includes(n))
    .sort();
}

// votes: { voterId: targetId } → { targetId: count }
export function tallyVotes(votes) {
  const counts = {};
  for (const target of Object.values(votes)) {
    counts[target] = (counts[target] || 0) + 1;
  }
  return counts;
}

// Everyone tied for the most votes is eliminated (official rule: ties all die).
export function resolveEliminations(counts) {
  const ids = Object.keys(counts);
  if (!ids.length) return [];
  const max = Math.max(...ids.map((id) => counts[id]));
  return ids.filter((id) => counts[id] === max).sort();
}

// Sleepyheads win iff the thief is among the eliminated; otherwise the thief
// (and any traitor) wins. Decided purely by votes — no dice scoring.
export function resolveWinner(eliminatedIds, roles) {
  const thiefCaught = eliminatedIds.some((id) => roles[id] === ROLES.THIEF);
  return thiefCaught ? 'sleepyheads' : 'thief';
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
