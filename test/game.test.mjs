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
