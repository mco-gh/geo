import { schedule, bucket, pack, unpack, dayNumber, dateOfDay, newCardOrder, AGAIN } from './srs.js';
import {
  KEYS, TOPICS, emptyProgress, loadProgress, saveProgress, loadSettings, saveSettings,
  sanitizeProgress, sanitizeSettings, requestPersistence,
} from './store.js';
import { loadMap, drawMap } from './map.js';

const $ = (id) => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const nf = new Intl.NumberFormat('en');

const TOPIC_NAMES = {
  countries: 'Countries and capitals',
  water: 'Oceans, seas and lakes',
  islands: 'Islands',
  land: 'Mountains, deserts and regions',
};
const KIND_NAMES = {
  country: 'Country', ocean: 'Ocean', sea: 'Sea', gulf: 'Gulf', bay: 'Bay', strait: 'Strait',
  channel: 'Channel', estuary: 'Estuary', lake: 'Lake', island: 'Island', islands: 'Island group',
  continent: 'Continent', mountains: 'Mountain range', desert: 'Desert', peninsula: 'Peninsula',
  region: 'Region', plain: 'Plain', plateau: 'Plateau', basin: 'Basin', reef: 'Reef', canyon: 'Canyon',
  valley: 'Valley', isthmus: 'Isthmus', wetland: 'Wetland', delta: 'Delta',
};
const kindName = (card) => KIND_NAMES[card.kind] ?? 'Place';
const question = (card) => (card.kind === 'islands' ? 'Name these islands' : `Name this ${kindName(card).toLowerCase()}`);

// ───────── State ─────────
let deck = [];             // cards, best known first (data/deck.json)
let byId = new Map();      // card id -> deck index
let settings = loadSettings();
let progress = emptyProgress();
let today = dayNumber();
let queue = [];            // [{ id: deck index, kind: 'new' | 'learning' | 'review' }]
let flipped = false;
let undoState = null;

const cardState = (i) => progress.cards[deck[i].id];
const active = (i) => settings.topics.includes(deck[i].topic);

// ───────── Boot ─────────
async function init() {
  wireEvents();
  try {
    const res = await fetch('./data/deck.json');
    if (!res.ok) throw new Error(`deck.json: ${res.status}`);
    [deck] = await Promise.all([res.json(), loadMap('./data/map.json', './data/shapes.json')]);
  } catch (err) {
    console.error(err);
    $('load-error').hidden = false;
    return;
  }
  byId = new Map(deck.map((c, i) => [c.id, i]));
  progress = loadProgress();
  $('about-count').textContent = nf.format(deck.length);
  fillSettingsForm();
  startSession();
  route();
  registerServiceWorker();
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW registration failed', err));
  }
}

// ───────── Session / queue ─────────
function ensureToday() {
  today = dayNumber();
  if (progress.daily.day !== today) {
    progress.daily = { day: today, new: 0, rev: 0, done: 0, extra: 0 };
  }
}

function startSession() {
  ensureToday();
  undoState = null;
  const { daily } = progress;
  const learning = [];
  const due = [];
  for (const [id, c] of Object.entries(progress.cards)) {
    const i = byId.get(id);
    if (i === undefined || !active(i)) continue;
    if (c[0] === 0) learning.push(i);
    else if (c[2] <= today) due.push(i);
  }
  due.sort((a, b) => cardState(a)[2] - cardState(b)[2] || a - b);
  due.length = Math.min(due.length, Math.max(0, settings.maxReviews - daily.rev));

  const fresh = pickNew(Math.max(0, settings.newPerDay + daily.extra - daily.new));

  // Spread new cards evenly among the reviews so a session doesn't front-load them.
  const mixed = due.map((id) => ({ id, kind: 'review' }));
  const gap = (mixed.length + fresh.length) / (fresh.length || 1);
  fresh.forEach((id, k) => mixed.splice(Math.min(mixed.length, Math.round(k * gap)), 0, { id, kind: 'new' }));

  queue = [...learning.map((id) => ({ id, kind: 'learning' })), ...mixed];
  renderStudy();
}

const orderCache = {};

/** The next `count` unseen cards, from the topics being studied, in the chosen order. */
function pickNew(count) {
  if (count <= 0) return [];
  const order = (orderCache[settings.order] ??= newCardOrder(settings.order, deck.map((c) => c.tier)));
  const picked = [];
  for (const i of order) {
    if (cardState(i) || !active(i)) continue;
    picked.push(i);
    if (picked.length === count) break;
  }
  return picked;
}

const unseenCount = () => deck.reduce((n, c, i) => n + (active(i) && !progress.cards[c.id] ? 1 : 0), 0);

function answer(rating) {
  const item = queue[0];
  if (!item || !flipped) return;
  ensureToday();
  const key = deck[item.id].id;
  const prev = progress.cards[key];
  undoState = {
    key,
    prev: prev ? [...prev] : null,
    daily: { ...progress.daily },
    logged: progress.log[today] ?? 0,
    queue: queue.map((q) => ({ ...q })),
  };

  const next = schedule(unpack(prev), rating, today, settings.pace);
  progress.cards[key] = pack(next);
  if (!prev) progress.daily.new += 1;
  else if (prev[0] > 0) progress.daily.rev += 1;
  progress.log[today] = (progress.log[today] ?? 0) + 1;

  queue.shift();
  if (next.i === 0) {
    // Forgotten: show it again a few cards later in this same session.
    queue.splice(Math.min(queue.length, 4), 0, { id: item.id, kind: 'learning' });
  } else {
    progress.daily.done += 1;
  }
  persist();
  if (rating !== AGAIN) requestPersistence();
  renderStudy();
}

function undo() {
  if (!undoState) return;
  const u = undoState;
  if (u.prev) progress.cards[u.key] = u.prev;
  else delete progress.cards[u.key];
  progress.daily = u.daily;
  if (u.logged) progress.log[today] = u.logged;
  else delete progress.log[today];
  queue = u.queue;
  undoState = null;
  persist();
  renderStudy();
}

function persist() {
  if (!saveProgress(progress)) toast('Could not save — browser storage is unavailable.');
}

// ───────── Study view ─────────
function fillAnswer(card, prefix) {
  $(`${prefix}kind`).textContent = kindName(card);
  $(`${prefix}name`).textContent = card.name;
  $(`${prefix}capital`).hidden = !card.cap;
  $(`${prefix}capital-name`).textContent = card.cap ?? '';
  $(`${prefix}note`).textContent = card.note ?? '';
}

function renderStudy() {
  const item = queue[0];
  $('undo').hidden = !undoState;
  $('session').hidden = !item;
  $('done').hidden = !!item;
  if (!item) return renderDone();

  const count = (kind) => queue.filter((q) => q.kind === kind).length;
  $('count-new').textContent = count('new');
  $('count-learning').textContent = count('learning');
  $('count-review').textContent = count('review');
  const bar = $('session-bar');
  bar.max = progress.daily.done + queue.length;
  bar.value = progress.daily.done;

  const card = deck[item.id];
  const el = $('card');

  // Reset to the front without animating (which would flash the next answer).
  el.classList.add('instant');
  setFlipped(false);
  drawMap($('map-front'), card);
  drawMap($('map-back'), card, { capital: true });
  $('question').textContent = question(card);
  fillAnswer(card, '');
  $('name').classList.toggle('long', card.name.length > 18);
  $('badge-new').hidden = item.kind !== 'new';
  void el.offsetWidth;
  el.classList.remove('instant');
  if (!reducedMotion.matches) {
    el.animate(
      [{ opacity: 0, transform: 'translateY(14px) scale(0.98)' }, { opacity: 1, transform: 'none' }],
      { duration: 240, easing: 'ease-out' },
    );
  }

  const current = unpack(cardState(item.id));
  for (const btn of document.querySelectorAll('.rate')) {
    const next = schedule(current, +btn.dataset.rating, today, settings.pace);
    btn.querySelector('small').textContent = fmtInterval(next.i);
  }
}

function fmtInterval(days) {
  const f = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
  if (days <= 0) return 'today';
  if (days < 30) return `${days} d`;
  if (days < 365) return `${f.format(days / 30)} mo`;
  return `${f.format(days / 365)} y`;
}

function setFlipped(value) {
  flipped = value;
  // Don't leave focus on a rating button that is about to be hidden, or the next
  // Space press would be swallowed by it instead of revealing the next card.
  if (!value && $('ratings').contains(document.activeElement)) document.activeElement.blur();
  $('card').classList.toggle('flipped', value);
  $('face-front').inert = value;
  $('face-back').inert = !value;
  $('show').hidden = value;
  $('ratings').hidden = !value;
}

function reveal() {
  if (!queue[0] || flipped) return;
  setFlipped(true);
  $('ratings').querySelector('.rate-3').focus({ preventScroll: true });
}

function renderDone() {
  const tomorrow = Object.entries(progress.cards)
    .filter(([id, c]) => byId.has(id) && active(byId.get(id)) && c[0] > 0 && c[2] <= today + 1).length;
  const unseen = unseenCount();
  $('done-today').textContent = progress.daily.done;
  $('done-streak').textContent = streak();
  $('done-tomorrow').textContent = tomorrow + Math.min(settings.newPerDay, unseen);
  const extra = Math.min(unseen, Math.max(5, settings.newPerDay));
  $('more').hidden = unseen === 0;
  $('more').textContent = `Learn ${extra} more new place${extra === 1 ? '' : 's'}`;
  $('more').dataset.extra = extra;
  $('done-sub').textContent = unseen === 0
    ? 'You have seen every place in the topics you’re studying! Add a topic in Settings for more.'
    : 'Nice work. Come back tomorrow to keep your memory fresh.';
}

function streak() {
  let day = progress.log[today] ? today : today - 1;
  let n = 0;
  while (progress.log[day]) { n += 1; day -= 1; }
  return n;
}

// ───────── List view ─────────
const PAGE = 100;
let listMatches = [];
let listShown = 0;
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function renderList() {
  const q = fold($('search').value.trim());
  const filter = $('filter').value;
  const topic = $('topic-filter').value;
  listMatches = [];
  for (let i = 0; i < deck.length; i++) {
    const c = deck[i];
    if (topic !== 'all' && c.topic !== topic) continue;
    if (filter !== 'all' && bucket(unpack(cardState(i))) !== filter) continue;
    if (q && !fold(`${c.name} ${c.cap ?? ''} ${kindName(c)}`).includes(q)) continue;
    listMatches.push(i);
  }
  // Alphabetical reads better than "best known" when browsing.
  listMatches.sort((a, b) => deck[a].name.localeCompare(deck[b].name, 'en'));
  listShown = 0;
  $('place-list').replaceChildren();
  $('list-count').textContent = listMatches.length
    ? `${nf.format(listMatches.length)} place${listMatches.length === 1 ? '' : 's'}`
    : 'No places match.';
  appendList();
}

function appendList() {
  const frag = document.createDocumentFragment();
  for (const i of listMatches.slice(listShown, listShown + PAGE)) {
    const c = deck[i];
    const b = bucket(unpack(cardState(i)));
    const li = el('li');
    const btn = el('button', 'row-btn');
    btn.type = 'button';
    btn.dataset.i = i;
    const head = el('span', 'head');
    head.append(el('span', 'n', c.name), el('span', 'k', kindName(c)));
    const status = el('span', 'status');
    status.append(el('span', `dot b-${b}`), el('span', 'label', BUCKETS[b]));
    head.append(status);
    btn.append(head);
    if (c.cap) btn.append(el('span', 'cap', `Capital: ${c.cap}`));
    li.append(btn);
    frag.append(li);
  }
  listShown += PAGE;
  $('place-list').append(frag);
}

const BUCKETS = { new: 'Not seen', learning: 'Learning', young: 'Young', mature: 'Mastered' };

function openPreview(i) {
  const c = deck[i];
  drawMap($('map-preview'), c, { capital: true });
  fillAnswer(c, 'preview-');
  const s = unpack(cardState(i));
  const b = bucket(s);
  let status = BUCKETS[b];
  if (s && s.i > 0) {
    const days = s.d - today;
    status += days <= 0 ? ' · due today' : ` · next review in ${fmtInterval(days)}`;
  }
  if (!active(i)) status += ' · topic paused';
  $('preview-status').textContent = status;
  $('preview').showModal();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ───────── Progress view ─────────
function renderProgress() {
  const counts = { new: 0, learning: 0, young: 0, mature: 0 };
  const perTopic = Object.fromEntries(TOPICS.map((t) => [t, { total: 0, learned: 0 }]));
  const forecast = new Array(14).fill(0);
  deck.forEach((card, i) => {
    const c = unpack(cardState(i));
    const b = bucket(c);
    counts[b] += 1;
    perTopic[card.topic].total += 1;
    if (b === 'young' || b === 'mature') perTopic[card.topic].learned += 1;
    if (c && active(i)) {
      const offset = Math.max(0, c.d - today);
      if (offset < 14) forecast[offset] += 1;
    }
  });
  const reviews = Object.values(progress.log).reduce((a, b) => a + b, 0);
  $('st-streak').textContent = nf.format(streak());
  $('st-learned').textContent = nf.format(counts.young + counts.mature);
  $('st-mature').textContent = nf.format(counts.mature);
  $('st-reviews').textContent = nf.format(reviews);

  const order = ['mature', 'young', 'learning', 'new'];
  $('mastery-bar').replaceChildren(...order.filter((b) => counts[b]).map((b) => {
    const seg = el('span', `b-${b}`);
    seg.style.flexGrow = counts[b];
    return seg;
  }));
  $('mastery-legend').replaceChildren(...order.map((b) => {
    const li = el('li');
    li.append(el('span', `dot b-${b}`), BUCKETS[b], el('b', '', nf.format(counts[b])));
    return li;
  }));

  $('topic-bars').replaceChildren(...TOPICS.map((t) => {
    const { total, learned } = perTopic[t];
    const li = el('li');
    const label = el('span', 'label', TOPIC_NAMES[t]);
    if (!settings.topics.includes(t)) label.append(el('span', 'paused', 'paused'));
    const meter = el('span', 'meter');
    const fill = el('span');
    fill.style.inlineSize = `${(learned / Math.max(1, total)) * 100}%`;
    meter.append(fill);
    li.append(label, el('b', '', `${nf.format(learned)} / ${nf.format(total)}`), meter);
    return li;
  }));

  const peak = Math.max(1, ...forecast);
  const dayFmt = new Intl.DateTimeFormat('en', { weekday: 'narrow' });
  const fullFmt = new Intl.DateTimeFormat('en', { weekday: 'long', day: 'numeric', month: 'long' });
  $('forecast').replaceChildren(...forecast.map((n, k) => {
    const date = dateOfDay(today + k);
    const li = el('li');
    li.setAttribute('aria-label', `${fullFmt.format(date)}: ${n}`);
    const col = el('span', 'col');
    col.style.setProperty('--v', n / peak);
    const num = el('span', 'n', n || '');
    const day = el('span', 'day', dayFmt.format(date));
    num.ariaHidden = day.ariaHidden = 'true';
    li.append(num, col, day);
    return li;
  }));
}

// ───────── Routing ─────────
const VIEWS = ['study', 'list', 'progress'];

function route() {
  const name = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'study';
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
  for (const a of document.querySelectorAll('.tabs a')) {
    if (a.dataset.tab === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (!deck.length) return;
  if (name === 'list') renderList();
  if (name === 'progress') renderProgress();
  if (name === 'study' && dayNumber() !== today) startSession();
}

function refreshAll() {
  startSession();
  route();
}

// ───────── Theme ─────────
const schemeMeta = document.querySelector('meta[name="color-scheme"]');
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

function setScheme(value) {
  schemeMeta.content = value;
  try {
    // Saved even when it's System: with nothing saved, the app starts in Light.
    localStorage.setItem(KEYS.scheme, JSON.stringify(value));
  } catch { /* theme still applies for this visit */ }
  syncSchemeControl();
}

function syncSchemeControl() {
  const value = ['light', 'dark'].includes(schemeMeta.content) ? schemeMeta.content : 'light dark';
  for (const input of document.querySelectorAll('input[name="scheme"]')) input.checked = input.value === value;
}

function updateSchemeLabel() {
  $('scheme-system').textContent = `System (currently ${darkQuery.matches ? 'dark' : 'light'})`;
}

// ───────── Settings ─────────
function fillSettingsForm() {
  if (!$('topic-checks').children.length) {
    const counts = Object.fromEntries(TOPICS.map((t) => [t, deck.filter((c) => c.topic === t).length]));
    $('topic-checks').replaceChildren(...TOPICS.map((t) => {
      const label = el('label', 'check');
      const input = el('input');
      input.type = 'checkbox';
      input.name = 'topic';
      input.value = t;
      label.append(input, el('span', '', TOPIC_NAMES[t]), el('small', '', counts[t] ? nf.format(counts[t]) : ''));
      return label;
    }));
    $('topic-filter').append(...TOPICS.map((t) => {
      const o = el('option', '', TOPIC_NAMES[t]);
      o.value = t;
      return o;
    }));
  }
  for (const input of document.querySelectorAll('input[name="topic"]')) input.checked = settings.topics.includes(input.value);
  $('newPerDay').value = settings.newPerDay;
  $('maxReviews').value = settings.maxReviews;
  for (const input of document.querySelectorAll('input[name="order"]')) input.checked = input.value === settings.order;
  $('pace').value = String(settings.pace);
  syncSchemeControl();
  updateSchemeLabel();
}

function updateSettings(patch) {
  settings = sanitizeSettings({ ...settings, ...patch });
  if (!saveSettings(settings)) toast('Could not save — browser storage is unavailable.');
}

function exportBackup() {
  const blob = new Blob(
    [JSON.stringify({ app: 'geo', v: 1, exportedAt: new Date().toISOString(), settings, progress })],
    { type: 'application/json' },
  );
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = `geo-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Backup downloaded.');
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data?.app !== 'geo' || typeof data.progress?.cards !== 'object') throw new Error('shape');
    progress = sanitizeProgress(data.progress, null);
    persist();
    if (data.settings) {
      updateSettings(data.settings);
      fillSettingsForm();
    }
    refreshAll();
    toast('Backup restored.');
  } catch {
    toast('That file is not a valid backup.');
  }
}

let toastTimer;
function toast(message, ms = 2600) {
  const node = $('toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), ms);
}

// ───────── Events ─────────
function wireEvents() {
  addEventListener('hashchange', route);

  // Study
  $('card').addEventListener('click', (e) => { if (!e.target.closest('button')) reveal(); });
  $('show').addEventListener('click', reveal);
  $('ratings').addEventListener('click', (e) => {
    const btn = e.target.closest('.rate');
    if (btn) answer(+btn.dataset.rating);
  });
  $('undo').addEventListener('click', undo);
  $('more').addEventListener('click', () => {
    progress.daily.extra += +$('more').dataset.extra;
    persist();
    startSession();
  });

  addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if ($('view-study').hidden || document.querySelector('dialog[open]')) return;
    if (e.target.closest('input, select, textarea')) return;
    const control = e.target.closest('button, a');
    const onButton = control && (control.checkVisibility?.() ?? true);
    if ((e.key === ' ' || e.key === 'Enter') && !flipped && !onButton) { e.preventDefault(); reveal(); }
    else if (flipped && e.key >= '1' && e.key <= '4') { e.preventDefault(); answer(+e.key); }
    else if (e.key.toLowerCase() === 'z' && undoState) undo();
  });

  // List
  let searchTimer;
  $('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderList, 120); });
  $('filter').addEventListener('change', renderList);
  $('topic-filter').addEventListener('change', renderList);
  $('place-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.row-btn');
    if (btn) openPreview(+btn.dataset.i);
  });
  new IntersectionObserver((entries) => {
    if (entries.some((en) => en.isIntersecting) && listShown < listMatches.length) appendList();
  }, { rootMargin: '600px' }).observe($('list-sentinel'));

  // Settings
  $('topic-checks').addEventListener('change', (e) => {
    const chosen = [...document.querySelectorAll('input[name="topic"]:checked')].map((i) => i.value);
    if (!chosen.length) {
      e.target.checked = true;
      toast('Keep at least one topic.');
      return;
    }
    updateSettings({ topics: chosen });
    if (deck.length) refreshAll();
  });
  $('scheme').addEventListener('change', (e) => setScheme(e.target.value));
  darkQuery.addEventListener('change', updateSchemeLabel);
  $('order').addEventListener('change', (e) => {
    updateSettings({ order: e.target.value });
    if (deck.length) refreshAll();
  });
  for (const id of ['newPerDay', 'maxReviews', 'pace']) {
    $(id).addEventListener('change', (e) => {
      updateSettings({ [id]: e.target.value });
      e.target.value = String(settings[id]);
      if (deck.length) refreshAll();
    });
  }
  $('export').addEventListener('click', exportBackup);
  $('import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) importBackup(file);
    e.target.value = '';
  });
  $('reset').addEventListener('close', (e) => {
    const confirmed = e.target.returnValue === 'reset';
    e.target.returnValue = '';
    if (!confirmed) return;
    progress = emptyProgress();
    persist();
    refreshAll();
    toast('Progress erased.');
  });

  // Stay in sync with other tabs, and roll over to a new day while left open.
  addEventListener('storage', (e) => {
    if (e.key === KEYS.scheme) {
      try { schemeMeta.content = JSON.parse(e.newValue) ?? 'light'; } catch { schemeMeta.content = 'light'; }
      syncSchemeControl();
    }
    if (e.key === KEYS.progress && deck.length) { progress = loadProgress(); refreshAll(); }
    if (e.key === KEYS.settings && deck.length) { settings = loadSettings(); fillSettingsForm(); refreshAll(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && deck.length && dayNumber() !== today) refreshAll();
  });

  syncSchemeControl();
  updateSchemeLabel();
  wireDialogFallbacks();
  wireInstall();
}

// Invoker commands and closedby are progressive enhancements; cover browsers without them.
function wireDialogFallbacks() {
  if (!('commandForElement' in HTMLButtonElement.prototype)) {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('button[commandfor]');
      const target = btn && document.getElementById(btn.getAttribute('commandfor'));
      if (!(target instanceof HTMLDialogElement)) return;
      if (btn.getAttribute('command') === 'show-modal') target.showModal();
      else if (btn.getAttribute('command') === 'close') target.close();
    });
  }
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    const outside = (e, dialog) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
      let pressedOutside = false;
      dialog.addEventListener('pointerdown', (e) => { pressedOutside = e.target === dialog && outside(e, dialog); });
      dialog.addEventListener('pointerup', (e) => { if (pressedOutside && e.target === dialog && outside(e, dialog)) dialog.close(); });
    }
  }
}

function wireInstall() {
  const button = $('install');
  const supportsWebInstall = typeof Navigator.prototype.install === 'function';
  let deferredPrompt;
  if (matchMedia('(display-mode: standalone)').matches) return;
  if (supportsWebInstall) button.hidden = false;

  addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    if (!supportsWebInstall) button.hidden = false;
  });
  addEventListener('appinstalled', () => { button.hidden = true; });

  button.addEventListener('click', async () => {
    if (button.getAttribute('aria-disabled') === 'true') return;
    button.setAttribute('aria-disabled', 'true');
    try {
      if (supportsWebInstall) {
        await navigator.install();
        toast('App installed.');
        button.hidden = true;
      } else if (deferredPrompt) {
        const promptEvent = deferredPrompt;
        deferredPrompt = undefined;
        await promptEvent.prompt();
        const { outcome } = await promptEvent.userChoice;
        toast(outcome === 'accepted' ? 'App installed.' : 'Installation was cancelled.');
        if (!deferredPrompt) button.hidden = true;
      }
    } catch (error) {
      if (error.name === 'AbortError') toast('Installation was cancelled.');
      else console.error(error);
    } finally {
      button.removeAttribute('aria-disabled');
    }
  });
}

init();
