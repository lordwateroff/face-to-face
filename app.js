// Face to Face UI. Uses parseList, makeGroups and meetCounts from core.js.
// ?e=<id> with the organizer key in localStorage → organizer; without the key → guest lookup page.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const plural = (n, one, few, many) => {
  const a = n % 10, b = n % 100;
  return `${n.toLocaleString('ru-RU')} ${a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many}`;
};
const mmss = ms => {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return `${String(s / 60 | 0).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const pad3 = i => String(i).padStart(3, '0');
const randomId = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => (b % 36).toString(36)).join('');

const q = new URLSearchParams(location.search);
const id = /^[a-z0-9]{6,32}$/.test(q.get('e') || '') ? q.get('e') : null;
const hashKey = new URLSearchParams(location.hash.slice(1)).get('k');
if (id && hashKey) { store.set(`f2f:key:${id}`, hashKey); history.replaceState(null, '', `?e=${id}`); }
const key = id && store.get(`f2f:key:${id}`);

let S = null, view = 'people', cloud = false, saveTimer;

async function api(method, body) {
  try {
    const r = await fetch(`/api/event?id=${id}${key && method === 'GET' ? `&t=${Date.now()}` : ''}`, {
      method, body, headers: key ? { 'x-key': key, 'content-type': 'application/json' } : {},
    });
    cloud = r.ok;
    return r.ok ? await r.json() : null;
  } catch { cloud = false; return null; }
}

// ---------- state helpers ----------
const cur = () => S.rounds[S.rounds.length - 1];
const activeIds = () => S.participants.filter(p => p.active).map(p => p.id);
const byId = () => new Map(S.participants.map(p => [p.id, p]));
const timeLeft = t => t.status === 'running' ? t.endsAt - Date.now() : t.left;
const shownState = t => t.status === 'running' && timeLeft(t) <= 0 ? 'done' : t.status;
const STATE_TEXT = { idle: 'Готов к старту', running: 'Идёт', paused: 'Пауза', done: 'Раунд завершён' };

function summary(n) {
  const trio = n % 2, pairs = (n - 3 * trio) / 2;
  const parts = [pairs && plural(pairs, 'пара', 'пары', 'пар'), trio && '1 тройка'].filter(Boolean);
  return `${plural(n, 'участник', 'участника', 'участников')}: ${parts.join(' и ')}`;
}

function blocker() {
  const n = activeIds().length;
  if (!S.participants.length) return 'Добавьте участников';
  if (!n) return 'Все участники отмечены как «Не пришёл»';
  if (n < 2) return 'Недостаточно участников для раунда';
  return '';
}

function save() {
  S.updatedAt = Date.now();
  store.set(`f2f:ev:${id}`, S);
  store.set('f2f:last', { id, name: S.name });
  $('#sync').textContent = 'Сохраняю…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    $('#sync').textContent = await api('PUT', JSON.stringify(S)) ? 'Сохранено' : 'Сохранено только на этом устройстве';
  }, 600);
}
function commit() { save(); render(); }

function newRound(replace) {
  if (blocker()) return;
  if (replace) S.rounds.pop();
  S.rounds.push({ groups: makeGroups(activeIds(), meetCounts(S.rounds)).groups, at: Date.now() });
  S.timer = { status: 'idle', left: S.duration * 1000 };
  view = 'round';
  commit();
}

function timerAction(a) {
  const now = Date.now(), t = S.timer;
  if (a === 'start') S.timer = { status: 'running', endsAt: now + t.left };
  if (a === 'pause') S.timer = { status: 'paused', left: Math.max(0, t.endsAt - now) };
  if (a === 'end') S.timer = { status: 'done', left: 0 };
  commit();
}

function beep() {
  try {
    const ctx = new AudioContext(), o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.3, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.5);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 1.5);
  } catch {}
}

function tick() {
  if (!S) return;
  if (key && S.timer.status === 'running' && timeLeft(S.timer) <= 0) {
    if (Date.now() - S.timer.endsAt < 5000) beep();
    S.timer = { status: 'done', left: 0 };
    commit();
  }
  const st = shownState(S.timer);
  for (const el of document.querySelectorAll('.timer')) { el.textContent = mmss(timeLeft(S.timer)); el.dataset.state = st; }
  for (const el of document.querySelectorAll('.chip')) { el.textContent = STATE_TEXT[st]; el.dataset.state = st; }
}

// ---------- organizer views ----------
function render() {
  $('#org').hidden = false;
  $('#evName').value = S.name;
  for (const v of ['people', 'round', 'history', 'finish']) $(`#v-${v}`).hidden = v !== view;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false');
  ({ people: renderPeople, round: renderRound, history: renderHistory, finish: renderFinish })[view]();
  tick();
}

function renderPeople() {
  const f = $('#filter').value.trim().toLowerCase();
  const seen = new Set(S.rounds.flatMap(r => r.groups.flat()));
  const list = S.participants
    .filter(p => !f || String(p.num).startsWith(f) || `${p.name} ${p.group}`.toLowerCase().includes(f))
    .sort((a, b) => a.num - b.num || a.id - b.id);
  $('#plist').innerHTML = list.map(p => `
    <li class="${p.active ? '' : 'off'}">
      <span class="num">№${p.num}</span>
      <span class="who">${esc(p.name) || '<span class="hint">без имени</span>'}<small>${esc(p.group)}</small></span>
      <span class="pid" title="Внутренний ID">ID ${p.id}</span>
      <button class="toggle" data-toggle="${p.id}" aria-pressed="${p.active}">${p.active ? 'Участвует' : 'Не пришёл'}</button>
      ${seen.has(p.id) ? '<span></span>' : `<button class="icon" data-del="${p.id}" aria-label="Удалить №${p.num}" title="Удалить">×</button>`}
    </li>`).join('') || `<li style="display: block" class="hint">${S.participants.length ? 'Никого не нашли' : 'Список пуст. Вставьте номера слева.'}</li>`;
  const n = activeIds().length;
  $('#counts').textContent = S.participants.length ? `${plural(S.participants.length, 'человек', 'человека', 'человек')}, участвуют ${n}` : '';
  $('#clearBtn').hidden = !S.participants.length || S.rounds.length > 0;
  const b = blocker();
  $('#distrib').textContent = b || summary(n);
  $('#distrib').classList.toggle('hint', !!b);
  $('#duration').value = S.duration / 60;
  $('#formBtn').disabled = !S.rounds.length && !!b;
  $('#formBtn').textContent = S.rounds.length ? 'Перейти к раунду' : 'Сформировать пары';
}

function renderRound() {
  const r = cur();
  $('#roundEmpty').hidden = !!r;
  $('#roundMain').hidden = !r;
  if (!r) {
    $('#roundEmptyMsg').textContent = blocker() || 'Раундов ещё не было. Всё готово для первого.';
    $('#formBtn2').disabled = !!blocker();
    return;
  }
  const st = S.timer.status, people = byId();
  $('#roundNo').textContent = `Раунд ${S.rounds.length}`;
  $('#roundStats').textContent = summary(r.groups.flat().length);
  $('#tStart').hidden = st !== 'idle';
  $('#tResume').hidden = st !== 'paused';
  $('#tPause').hidden = st !== 'running';
  $('#tEnd').hidden = st !== 'running' && st !== 'paused';
  $('#tNext').hidden = st === 'done';
  $('#doneBar').hidden = st !== 'done';

  const inRound = new Set(r.groups.flat()), active = new Set(activeIds());
  const gone = [...inRound].filter(x => !active.has(x)).length, added = [...active].filter(x => !inRound.has(x)).length;
  $('#driftBar').hidden = !gone && !added;
  $('#driftMsg').textContent = `Состав изменился: ${[gone && `выбыли ${gone}`, added && `добавлены ${added}`].filter(Boolean).join(', ')}. Пересоберите группы, чтобы никто не остался без пары.`;
  $('#regroupBtn2').disabled = !!blocker();

  const find = $('#findNum').value.trim();
  $('#groups').innerHTML = r.groups.map((g, i) => {
    const hit = find && g.some(pid => String(people.get(pid)?.num) === find);
    const nums = g.map(pid => {
      const p = people.get(pid);
      const tip = p ? [p.name, p.group, `ID ${p.id}`].filter(Boolean).join(', ') : 'удалён';
      return `<span class="${p?.active ? '' : 'off'}" title="${esc(tip)}"><small>№</small>${p ? p.num : '?'}</span>`;
    }).join('<i>+</i>');
    return `<li class="group${g.length > 2 ? ' trio' : ''}${hit ? ' hit' : ''}">
      <span class="gno">${pad3(i + 1)}${g.length > 2 ? '<em>тройка</em>' : ''}</span><span class="nums">${nums}</span></li>`;
  }).join('');
}

function renderHistory() {
  const met = meetCounts(S.rounds), people = byId();
  let repeats = 0;
  for (const c of met.values()) repeats += c - 1;
  $('#histStats').textContent = S.rounds.length
    ? `${plural(S.rounds.length, 'раунд', 'раунда', 'раундов')}, ${plural(met.size, 'знакомство', 'знакомства', 'знакомств')}, повторных встреч: ${repeats}`
    : 'Раундов ещё не было.';
  $('#histList').innerHTML = S.rounds.map((r, i) => `
    <details class="hist-round" ${i === S.rounds.length - 1 ? 'open' : ''}>
      <summary>Раунд ${i + 1}<span>${summary(r.groups.flat().length)}</span></summary>
      <ol class="hist">${r.groups.map((g, j) => `<li><span>${pad3(j + 1)}</span>${g.map(pid => `№${people.get(pid)?.num ?? '?'}`).join(' + ')}</li>`).join('')}</ol>
    </details>`).reverse().join('');
}

function renderFinish() {
  const met = meetCounts(S.rounds);
  const everyone = new Set(S.rounds.flatMap(r => r.groups.flat())).size;
  $('#finSum').textContent = S.rounds.length
    ? `${plural(S.rounds.length, 'раунд', 'раунда', 'раундов')}, ${plural(everyone, 'участник', 'участника', 'участников')} и ${plural(met.size, 'новое знакомство', 'новых знакомства', 'новых знакомств')}.`
    : 'Мероприятие завершено без раундов.';
}

async function organizer() {
  S = store.get(`f2f:ev:${id}`);
  if (S) { view = S.finished ? 'finish' : S.rounds.length ? 'round' : 'people'; render(); }
  const remote = await api('GET');
  if (remote && (!S || remote.updatedAt > S.updatedAt)) {
    S = remote;
    store.set(`f2f:ev:${id}`, S);
    view = S.finished ? 'finish' : S.rounds.length ? 'round' : 'people';
    render();
  }
  if (!S) { alert('Мероприятие не найдено ни на этом устройстве, ни в облаке.'); location.href = './'; return; }
  if (!remote || remote.updatedAt < S.updatedAt) save(); // new event or offline edits → push to the cloud
  else $('#sync').textContent = 'Сохранено';
  setInterval(tick, 250);
}

function importRows(rows, bad) {
  for (const r of rows) S.participants.push({ id: S.nextId++, ...r, active: true });
  const msg = $('#importMsg');
  msg.className = bad.length ? 'warn' : 'hint';
  msg.textContent = `Добавлено ${rows.length}.` + (bad.length
    ? ` Пропущено строк без номера: ${bad.length} (${bad.slice(0, 3).join('; ')}${bad.length > 3 ? '…' : ''}).`
    : '');
  commit();
}

function bindOrganizer() {
  document.querySelector('.tabs').onclick = e => {
    const v = e.target.dataset?.view;
    if (v) { view = v; render(); }
  };
  $('#evName').oninput = e => { S.name = e.target.value.trim() || 'Face to Face'; save(); };
  $('#importBtn').onclick = () => {
    const { rows, bad } = parseList($('#importText').value);
    if (!rows.length && !bad.length) { $('#importMsg').className = 'err'; $('#importMsg').textContent = 'Поле пустое. Вставьте хотя бы один номер.'; return; }
    importRows(rows, bad);
    $('#importText').value = '';
  };
  $('#genBtn').onclick = () => {
    const n = Math.min(1000, Math.max(1, +$('#genN').value | 0));
    if (S.participants.length && !confirm(`В списке уже ${S.participants.length}. Добавить ещё номера от 1 до ${n}?`)) return;
    importRows(Array.from({ length: n }, (_, i) => ({ num: i + 1, name: '', group: '' })), []);
  };
  $('#clearBtn').onclick = () => { if (confirm('Удалить всех участников из списка?')) { S.participants = []; commit(); } };
  $('#filter').oninput = renderPeople;
  $('#plist').onclick = e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.toggle) { const p = S.participants.find(p => p.id === +t.dataset.toggle); p.active = !p.active; }
    if (t.dataset.del) S.participants = S.participants.filter(p => p.id !== +t.dataset.del);
    commit();
  };
  $('#duration').onchange = e => {
    S.duration = Math.min(60, Math.max(1, +e.target.value || 5)) * 60;
    if (S.timer.status === 'idle') S.timer.left = S.duration * 1000;
    commit();
  };
  $('#formBtn').onclick = () => { if (S.rounds.length) { view = 'round'; render(); } else newRound(); };
  $('#formBtn2').onclick = () => newRound();
  $('#tStart').onclick = $('#tResume').onclick = () => timerAction('start');
  $('#tPause').onclick = () => timerAction('pause');
  $('#tEnd').onclick = () => timerAction('end');
  $('#tNext').onclick = $('#tNext2').onclick = () => newRound();
  $('#regroupBtn').onclick = $('#regroupBtn2').onclick = () => {
    if (S.timer.status !== 'idle' && !confirm('Раунд уже идёт. Собрать группы заново и сбросить таймер?')) return;
    newRound(true);
  };
  $('#findNum').oninput = () => { renderRound(); document.querySelector('.group.hit')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); };
  $('#fsBtn').onclick = () => document.fullscreenElement ? document.exitFullscreen() : $('#v-round').requestFullscreen?.();
  $('#finishBtn').onclick = () => { if (confirm('Завершить мероприятие?')) { S.finished = true; if (S.timer.status === 'running') S.timer = { status: 'done', left: 0 }; view = 'finish'; commit(); } };
  $('#unfinishBtn').onclick = () => { S.finished = false; view = S.rounds.length ? 'round' : 'people'; commit(); };
  $('#shareBtn').onclick = () => {
    const base = location.origin + location.pathname;
    $('#guestLink').value = `${base}?e=${id}`;
    $('#orgLink').value = `${base}?e=${id}#k=${key}`;
    $('#shareWarn').hidden = cloud;
    $('#share').showModal();
  };
  for (const inp of ['#guestLink', '#orgLink']) $(inp).onclick = e => { e.target.select(); navigator.clipboard?.writeText(e.target.value).catch(() => {}); };
}

// ---------- guest ----------
function renderGuest() {
  const r = cur(), people = byId(), mine = $('#myNum').value.trim();
  $('#gName').textContent = S.name;
  $('#gRound').textContent = S.finished ? 'Мероприятие завершено' : r ? `Раунд ${S.rounds.length}` : 'Раунды скоро начнутся';
  $('#gChip').hidden = $('#gTimer').hidden = !r || S.finished;
  const out = $('#gResult');
  if (!r || S.finished) { out.innerHTML = ''; return; }
  if (!/^\d+$/.test(mine)) { out.innerHTML = '<p class="hint">Введите номер, который вам выдали, и здесь появится ваша группа.</p>'; return; }
  const found = r.groups.map((g, i) => ({ g, i })).filter(({ g }) => g.some(pid => people.get(pid)?.num === +mine));
  out.innerHTML = found.map(({ g, i }) => `
    <div class="result">
      <span class="hint">Группа ${pad3(i + 1)}${g.length > 2 ? ', вас трое' : ''}</span>
      <span class="nums">${g.map(pid => people.get(pid)?.num).sort((a, b) => (a === +mine) - (b === +mine))
        .map(n => n === +mine ? `<span class="me"><small>№</small>${n}</span>` : `<span><small>№</small>${n}</span>`).join('<i>+</i>')}</span>
    </div>`).join('') || `<p class="err">Номера ${esc(mine)} нет в этом раунде. Подойдите к организатору.</p>`;
}

async function guest() {
  $('#guest').hidden = false;
  $('#myNum').value = store.get(`f2f:num:${id}`) ?? '';
  $('#myNum').oninput = e => { store.set(`f2f:num:${id}`, e.target.value.trim()); if (S) renderGuest(); };
  const load = async () => {
    const s = await api('GET');
    if (s) { S = s; renderGuest(); tick(); }
    else if (!S) $('#gName').textContent = 'Мероприятие не найдено. Проверьте ссылку у организатора.';
  };
  await load();
  setInterval(() => document.hidden || load(), 10000);
  setInterval(tick, 250);
}

// ---------- boot ----------
function home() {
  $('#home').hidden = false;
  const last = store.get('f2f:last');
  if (last && store.get(`f2f:key:${last.id}`)) {
    $('#contBtn').hidden = false;
    $('#contBtn').href = `?e=${last.id}`;
    $('#contBtn').textContent = `Продолжить «${last.name}»`;
  }
  $('#newBtn').onclick = () => {
    const newId = randomId(10), newKey = randomId(32);
    store.set(`f2f:key:${newId}`, newKey);
    store.set(`f2f:ev:${newId}`, {
      v: 1, name: `Face to Face ${new Date().toLocaleDateString('ru-RU')}`, nextId: 1, participants: [], rounds: [],
      duration: 300, timer: { status: 'idle', left: 300000 }, finished: false, updatedAt: 0,
    });
    location.search = `?e=${newId}`;
  };
}

if (!id) home();
else if (key) { bindOrganizer(); organizer(); }
else guest();
