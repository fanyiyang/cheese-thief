import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLES,
  dealRoles,
  rollDie,
  effectivePoint,
  tallyVotes,
  resolveElimination,
  resolveWinner,
  randomRoomCode,
  wakersOn,
  resolvePeek,
} from '../js/game.js';

// helper: deterministic rng from a fixed sequence
const seq = (s) => {
  let i = 0;
  return () => s[i++ % s.length];
};

test('dealRoles gives exactly one thief and the rest mice', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const roles = dealRoles(ids);
  assert.equal(Object.keys(roles).length, 4);
  const vals = ids.map((id) => roles[id]);
  assert.equal(vals.filter((r) => r === ROLES.THIEF).length, 1);
  assert.equal(vals.filter((r) => r === ROLES.MOUSE).length, 3);
});

test('dealRoles assigns a role to every id', () => {
  const ids = ['p1', 'p2', 'p3', 'p4'];
  const roles = dealRoles(ids);
  for (const id of ids) {
    assert.ok(roles[id] === ROLES.THIEF || roles[id] === ROLES.MOUSE);
  }
});

test('dealRoles is deterministic for a given rng', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const s = [0.1, 0.7, 0.3, 0.9, 0.5];
  assert.deepEqual(dealRoles(ids, seq(s)), dealRoles(ids, seq(s)));
});

test('rollDie returns 1 for rng 0 and 6 for rng near 1', () => {
  assert.equal(rollDie(() => 0), 1);
  assert.equal(rollDie(() => 0.9999), 6);
});

test('rollDie always returns an integer in 1..6', () => {
  for (let i = 0; i < 200; i++) {
    const d = rollDie();
    assert.ok(Number.isInteger(d) && d >= 1 && d <= 6, `bad die: ${d}`);
  }
});

test('effectivePoint is 7 for the thief regardless of die, else the die value', () => {
  assert.equal(effectivePoint({ role: ROLES.THIEF, die: 2 }), 7);
  assert.equal(effectivePoint({ role: ROLES.MOUSE, die: 4 }), 4);
});

test('tallyVotes counts votes per target', () => {
  const votes = { a: 'b', b: 'c', c: 'b', d: 'b' };
  assert.deepEqual(tallyVotes(votes), { b: 3, c: 1 });
});

test('resolveElimination eliminates the single most-voted player', () => {
  const counts = { b: 3, c: 1 };
  const players = {
    a: { role: ROLES.MOUSE, die: 1 },
    b: { role: ROLES.MOUSE, die: 2 },
    c: { role: ROLES.THIEF, die: 5 },
    d: { role: ROLES.MOUSE, die: 3 },
  };
  assert.equal(resolveElimination(counts, players), 'b');
});

test('resolveElimination breaks a vote tie by highest effective point (thief counts as 7)', () => {
  const counts = { b: 2, c: 2 };
  const players = {
    b: { role: ROLES.MOUSE, die: 6 },
    c: { role: ROLES.THIEF, die: 1 },
  };
  // thief effective 7 > mouse 6 → thief c is flipped
  assert.equal(resolveElimination(counts, players), 'c');
});

test('resolveElimination tie among mice eliminates the higher die', () => {
  const counts = { a: 2, b: 2 };
  const players = {
    a: { role: ROLES.MOUSE, die: 3 },
    b: { role: ROLES.MOUSE, die: 5 },
  };
  assert.equal(resolveElimination(counts, players), 'b');
});

test('resolveElimination final tie (equal votes and points) breaks deterministically by id', () => {
  const counts = { b: 2, a: 2 };
  const players = {
    a: { role: ROLES.MOUSE, die: 4 },
    b: { role: ROLES.MOUSE, die: 4 },
  };
  assert.equal(resolveElimination(counts, players), 'a'); // 'a' < 'b'
});

test('resolveWinner: villagers win when the thief is eliminated', () => {
  const players = {
    a: { role: ROLES.MOUSE, die: 1 },
    c: { role: ROLES.THIEF, die: 5 },
  };
  assert.equal(resolveWinner('c', players), 'villagers');
});

test('resolveWinner: thief wins when a mouse is eliminated', () => {
  const players = {
    a: { role: ROLES.MOUSE, die: 1 },
    c: { role: ROLES.THIEF, die: 5 },
  };
  assert.equal(resolveWinner('a', players), 'thief');
});

test('randomRoomCode produces a CHS- prefixed code from the unambiguous alphabet', () => {
  assert.match(randomRoomCode(() => 0), /^CHS-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
  assert.match(randomRoomCode(), /^CHS-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
});

test('randomRoomCode is deterministic for a given rng', () => {
  assert.equal(randomRoomCode(seq([0.1, 0.4, 0.7, 0.9])), randomRoomCode(seq([0.1, 0.4, 0.7, 0.9])));
});

// ---- night phase: wake schedule ----

test('wakersOn returns all ids sharing a night, sorted (collision)', () => {
  const dice = { a: 3, b: 1, c: 3, d: 6 };
  assert.deepEqual(wakersOn(dice, 3), ['a', 'c']);
  assert.deepEqual(wakersOn(dice, 1), ['b']);
});

test('wakersOn returns [] for an empty night', () => {
  assert.deepEqual(wakersOn({ a: 3, b: 1, c: 3, d: 6 }, 2), []);
});

test('wakersOn handles a full collision (everyone on one night)', () => {
  assert.deepEqual(wakersOn({ a: 4, b: 4, c: 4, d: 4 }, 4), ['a', 'b', 'c', 'd']);
  assert.deepEqual(wakersOn({ a: 4, b: 4, c: 4, d: 4 }, 5), []);
});

test('wakersOn over nights 1..6 partitions all players exactly once', () => {
  const dice = { a: 2, b: 2, c: 5, d: 6 };
  const seen = [];
  for (let n = 1; n <= 6; n++) seen.push(...wakersOn(dice, n));
  assert.deepEqual(seen.sort(), ['a', 'b', 'c', 'd']);
  assert.equal(new Set(seen).size, seen.length); // disjoint
});

// ---- night phase: peek resolution ----

const PEEK_DICE = { m1: 3, m2: 5, t: 3, m3: 6 };
const PEEK_ROLES = { m1: ROLES.MOUSE, m2: ROLES.MOUSE, t: ROLES.THIEF, m3: ROLES.MOUSE };

test('resolvePeek: a mouse on their night peeking the thief sees the thief RAW die, not 7', () => {
  // m1 wakes on night 3, peeks the thief t (die 3) → sees 3, never 7
  assert.equal(resolvePeek(PEEK_DICE, PEEK_ROLES, 'm1', 't', 3), 3);
});

test('resolvePeek: returns null when the requester is the thief', () => {
  assert.equal(resolvePeek(PEEK_DICE, PEEK_ROLES, 't', 'm1', 3), null);
});

test('resolvePeek: returns null when it is not the requester night', () => {
  // m2 rolled 5, cannot peek on night 3
  assert.equal(resolvePeek(PEEK_DICE, PEEK_ROLES, 'm2', 'm1', 3), null);
});

test('resolvePeek: returns null for self-target, null target, and unknown target', () => {
  assert.equal(resolvePeek(PEEK_DICE, PEEK_ROLES, 'm1', 'm1', 3), null);
  assert.equal(resolvePeek(PEEK_DICE, PEEK_ROLES, 'm1', null, 3), null);
  assert.equal(resolvePeek(PEEK_DICE, PEEK_ROLES, 'm1', 'ghost', 3), null);
});

test('resolvePeek and the effective-7 tie-break are independent layers', () => {
  // peek exposes the thief raw die (3) ...
  assert.equal(resolvePeek(PEEK_DICE, PEEK_ROLES, 'm1', 't', 3), 3);
  // ... but a vote tie still flips the thief via effectivePoint=7
  const counts = { m1: 2, t: 2 };
  const players = { m1: { role: ROLES.MOUSE, die: 6 }, t: { role: ROLES.THIEF, die: 3 } };
  assert.equal(resolveElimination(counts, players), 't');
});
