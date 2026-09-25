// Face to Face: pure logic, no DOM. A classic script (works from file://); tests load it via vm.

function pairKey(a, b) { return a < b ? a * 1e6 + b : b * 1e6 + a; }

// How many times each pair of participant ids has already been in one group.
function meetCounts(rounds) {
  const met = new Map();
  for (const r of rounds) for (const g of r.groups)
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      const k = pairKey(g[i], g[j]);
      met.set(k, (met.get(k) || 0) + 1);
    }
  return met;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.random() * (i + 1) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Pairs for everyone; an odd count adds one triple. Picks the least-met partner, restarts to cut repeats.
// ponytail: random greedy + restarts, not optimal matching; swap in min-cost matching if repeats show up
// while a repeat-free round still exists (small groups, many rounds).
function makeGroups(ids, met = new Map()) {
  if (ids.length < 2) return { groups: [], repeats: 0 };
  const cost = (a, b) => met.get(pairKey(a, b)) || 0;
  const tries = Math.max(20, Math.min(2000, 4e6 / ids.length ** 2 | 0));
  let best = null;
  for (let t = 0; t < tries && best?.repeats !== 0; t++) {
    const pool = shuffle(ids.slice()), groups = [];
    let repeats = 0;
    while (pool.length > 1) {
      const a = pool.pop();
      let bi = pool.length - 1, bc = Infinity;
      for (let i = pool.length - 1; i >= 0 && bc > 0; i--) {
        const c = cost(a, pool[i]);
        if (c < bc) { bc = c; bi = i; }
      }
      groups.push([a, pool[bi]]);
      pool[bi] = pool[pool.length - 1];
      pool.pop();
      repeats += bc;
    }
    if (pool.length) { // odd: the last one joins the pair they know least
      const x = pool[0];
      let gi = 0, gc = Infinity;
      for (let i = 0; i < groups.length && gc > 0; i++) {
        const c = cost(x, groups[i][0]) + cost(x, groups[i][1]);
        if (c < gc) { gc = c; gi = i; }
      }
      groups[gi].push(x);
      repeats += gc;
    }
    if (!best || repeats < best.repeats) best = { groups, repeats };
  }
  return best;
}

// Lines like "15, Аружан, ПО2302", "15 Аружан" or "15 16 17" → participants; the rest goes to `bad`.
function parseList(text) {
  const rows = [], bad = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[\d\s,;]+$/.test(line)) {
      for (const n of line.split(/[\s,;]+/)) if (n) rows.push({ num: +n, name: '', group: '' });
      continue;
    }
    const cells = /[,;\t]/.test(line) ? line.split(/[,;\t]/) : line.split(/\s+(.*)/);
    const [num, name = '', group = ''] = cells.map(s => s.trim().replace(/^"|"$/g, ''));
    if (/^\d{1,6}$/.test(num)) rows.push({ num: +num, name, group });
    else bad.push(line);
  }
  return { rows, bad };
}
