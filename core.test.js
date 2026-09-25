import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('./core.js', import.meta.url), 'utf8'));
const range = n => Array.from({ length: n }, (_, i) => i + 1);

function check(ids, groups) {
  assert.deepEqual(groups.flat().sort((a, b) => a - b), ids, 'everyone exactly once');
  const trios = groups.filter(g => g.length === 3).length;
  assert.equal(trios, ids.length % 2);
  assert.ok(groups.every(g => g.length === 2 || g.length === 3));
}

test('sizes from the PRD', () => {
  assert.deepEqual(makeGroups([]).groups, []);
  assert.deepEqual(makeGroups([1]).groups, []);
  for (const n of [2, 3, 4, 5, 399, 400, 401]) check(range(n), makeGroups(range(n)).groups);
  assert.equal(makeGroups(range(399)).groups.length, 199); // 198 pairs + 1 triple
});

test('400 people, 12 rounds, no repeats, fast', () => {
  const ids = range(400), rounds = [];
  for (let r = 0; r < 12; r++) {
    const t = performance.now();
    const { groups, repeats } = makeGroups(ids, meetCounts(rounds));
    assert.ok(performance.now() - t < 1000);
    check(ids, groups);
    assert.equal(repeats, 0, `round ${r + 1}`);
    rounds.push({ groups });
  }
});

test('small odd group: 11 people, 4 rounds, no repeats', () => {
  const ids = range(11), rounds = [];
  for (let r = 0; r < 4; r++) {
    const { groups, repeats } = makeGroups(ids, meetCounts(rounds));
    check(ids, groups);
    assert.equal(repeats, 0);
    rounds.push({ groups });
  }
});

test('repeats allowed when unavoidable', () => {
  const rounds = [{ groups: [[1, 2, 3]] }];
  const { groups, repeats } = makeGroups([1, 2, 3], meetCounts(rounds));
  check([1, 2, 3], groups);
  assert.equal(repeats, 3);
});

test('parseList', () => {
  const { rows, bad } = parseList('﻿15, Аружан, ПО2302\n\n16; Дамир\n17 18  19\n20 Айгерим Сапарова\n"21","Ерлан"\nномер,имя\n  \n');
  assert.deepEqual(rows.map(r => r.num), [15, 16, 17, 18, 19, 20, 21]);
  assert.deepEqual(rows[0], { num: 15, name: 'Аружан', group: 'ПО2302' });
  assert.equal(rows[5].name, 'Айгерим Сапарова');
  assert.equal(rows[6].name, 'Ерлан');
  assert.deepEqual(bad, ['номер,имя']);
});

test('api: create, guard, strip names for guests', async () => {
  const db = new Map();
  process.env.KV_REST_API_URL = 'https://redis.test';
  process.env.KV_REST_API_TOKEN = 't';
  globalThis.fetch = async (url, { body }) => {
    const [cmd, k, v] = JSON.parse(body);
    if (cmd === 'SET') db.set(k, v);
    return Response.json({ result: cmd === 'GET' ? db.get(k) ?? null : 'OK' });
  };
  const { GET, PUT } = await import('./api/event.js');
  const url = 'https://x/api/event?id=abc123def0';
  const key = 'k'.repeat(32);
  const state = { name: 'E', participants: [{ id: 1, num: 15, name: 'Аружан', group: 'ПО', active: true }], rounds: [] };
  const put = (k, s = state) => PUT(new Request(url, { method: 'PUT', headers: { 'x-key': k }, body: JSON.stringify(s) }));

  assert.equal((await put(key)).status, 200);
  assert.equal((await put('x'.repeat(32))).status, 403);
  assert.equal((await put('short')).status, 401);
  assert.equal((await PUT(new Request(url, { method: 'PUT', headers: { 'x-key': key }, body: '{}' }))).status, 400);

  const guest = await GET(new Request(url));
  assert.deepEqual((await guest.json()).participants, [{ id: 1, num: 15, active: true }]);
  assert.match(guest.headers.get('cache-control'), /s-maxage/);
  const org = await GET(new Request(url, { headers: { 'x-key': key } }));
  assert.equal((await org.json()).participants[0].name, 'Аружан');
  assert.equal(org.headers.get('cache-control'), 'no-store');
  assert.equal((await GET(new Request('https://x/api/event?id=../etc'))).status, 400);
  assert.equal((await GET(new Request('https://x/api/event?id=nothere00'))).status, 404);
});
