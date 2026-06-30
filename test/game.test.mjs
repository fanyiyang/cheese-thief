import { test } from 'node:test';
import assert from 'node:assert/strict';
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
} from '../js/game.js';

// deterministic rng from a fixed sequence
const seq = (s) => {
  let i = 0;
  return () => s[i++ % s.length];
};

// ---- roles ----

test('dealRoles gives exactly one thief and the rest mice', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const roles = dealRoles(ids);
  assert.equal(Object.keys(roles).length, 4);
  const vals = ids.map((id) => roles[id]);
  assert.equal(vals.filter((r) => r === ROLES.THIEF).length, 1);
  assert.equal(vals.filter((r) => r === ROLES.MOUSE).length, 3);
});

test('dealRoles is deterministic for a given rng', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const s = [0.1, 0.7, 0.3, 0.9, 0.5];
  assert.deepEqual(dealRoles(ids, seq(s)), dealRoles(ids, seq(s)));
});

// ---- dice ----

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

// ---- wake schedule (2 dice) ----

test('distinctNights collapses a matching pair and sorts a differing pair', () => {
  assert.deepEqual(distinctNights([3, 5]), [3, 5]);
  assert.deepEqual(distinctNights([5, 2]), [2, 5]);
  assert.deepEqual(distinctNights([4, 4]), [4]);
});

test('wakersAt returns the players scheduled to wake on a given night, sorted', () => {
  const schedule = { a: [3], b: [3, 5], c: [1], d: [6] };
  assert.deepEqual(wakersAt(schedule, 3), ['a', 'b']);
  assert.deepEqual(wakersAt(schedule, 5), ['b']);
  assert.deepEqual(wakersAt(schedule, 2), []);
});

// ---- votes & resolution ----

test('tallyVotes counts votes per target', () => {
  assert.deepEqual(tallyVotes({ a: 'b', b: 'c', c: 'b', d: 'b' }), { b: 3, c: 1 });
});

test('resolveEliminations returns the single most-voted player', () => {
  assert.deepEqual(resolveEliminations({ b: 3, c: 1 }), ['b']);
});

test('resolveEliminations returns ALL tied players on a tie', () => {
  assert.deepEqual(resolveEliminations({ a: 2, b: 2, c: 1 }), ['a', 'b']);
});

test('resolveEliminations returns [] when there are no votes', () => {
  assert.deepEqual(resolveEliminations({}), []);
});

test('resolveWinner: sleepyheads win when the thief is among the eliminated', () => {
  const roles = { a: ROLES.MOUSE, b: ROLES.MOUSE, c: ROLES.THIEF };
  assert.equal(resolveWinner(['c'], roles), 'sleepyheads');
});

test('resolveWinner: thief wins when only sleepyheads are eliminated', () => {
  const roles = { a: ROLES.MOUSE, b: ROLES.MOUSE, c: ROLES.THIEF };
  assert.equal(resolveWinner(['a'], roles), 'thief');
});

test('resolveWinner: a tie that includes the thief still lets sleepyheads win', () => {
  const roles = { a: ROLES.MOUSE, b: ROLES.THIEF };
  assert.equal(resolveWinner(['a', 'b'], roles), 'sleepyheads');
});

// ---- room code ----

test('randomRoomCode produces a CHS- prefixed code from the unambiguous alphabet', () => {
  assert.match(randomRoomCode(() => 0), /^CHS-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
  assert.match(randomRoomCode(), /^CHS-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
});

test('randomRoomCode is deterministic for a given rng', () => {
  assert.equal(randomRoomCode(seq([0.1, 0.4, 0.7, 0.9])), randomRoomCode(seq([0.1, 0.4, 0.7, 0.9])));
});

test('roomCodeFor maps a nickname to a stable CHS- code', () => {
  assert.match(roomCodeFor('房主'), /^CHS-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
  assert.equal(roomCodeFor('房主'), roomCodeFor('房主')); // same name → same code
  assert.equal(roomCodeFor(' 房主 '), roomCodeFor('房主')); // trimmed
  assert.notEqual(roomCodeFor('Alice'), roomCodeFor('Bob')); // different names usually differ
});

// ---- traitors (5-8 players) ----

test('traitorCount: none at 4, one at 5-6, two at 7-8', () => {
  assert.equal(traitorCount(4), 0);
  assert.equal(traitorCount(5), 1);
  assert.equal(traitorCount(6), 1);
  assert.equal(traitorCount(7), 2);
  assert.equal(traitorCount(8), 2);
});

test('cowakersOfThief: non-thief players who shared a night with the thief', () => {
  const roles = { t: ROLES.THIEF, a: ROLES.MOUSE, b: ROLES.MOUSE, c: ROLES.MOUSE };
  const wakeNights = { t: [3, 5], a: [3], b: [2], c: [5] };
  assert.deepEqual(cowakersOfThief(wakeNights, roles), ['a', 'c']); // a shares 3, c shares 5; b (2) does not
});

test('cowakersOfThief: empty when nobody shares the thief night', () => {
  const roles = { t: ROLES.THIEF, a: ROLES.MOUSE, b: ROLES.MOUSE };
  assert.deepEqual(cowakersOfThief({ t: [4], a: [1], b: [6] }, roles), []);
});
