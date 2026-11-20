// localStorage persistence. Falls back to memory when storage is blocked,
// so the app still works for the session.
import { DEFAULT_SETTINGS } from './srs.js';

export const KEYS = Object.freeze({
  settings: 'geo:settings',
  progress: 'geo:progress',
  scheme: 'geo:scheme',
});

export const TOPICS = Object.freeze(['countries', 'water', 'islands', 'land']);

const memory = new Map();

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return memory.get(key);
  }
}

function write(key, value) {
  memory.set(key, value);
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const emptyProgress = () => ({
  v: 1,
  cards: {},                                    // card id -> packed card
  daily: { day: -1, new: 0, rev: 0, done: 0, extra: 0 },
  log: {},                                      // day number -> answers given
});

const num = (v, min, max, fallback) =>
  Number.isFinite(+v) ? Math.min(max, Math.max(min, +v)) : fallback;

export function sanitizeSettings(s = {}) {
  const d = DEFAULT_SETTINGS;
  const topics = Array.isArray(s.topics) ? TOPICS.filter((t) => s.topics.includes(t)) : [];
  return {
    newPerDay: Math.round(num(s.newPerDay, 0, 100, d.newPerDay)),
    maxReviews: Math.round(num(s.maxReviews, 10, 500, d.maxReviews)),
    order: ['mixed', 'known', 'random'].includes(s.order) ? s.order : d.order,
    pace: num(s.pace, 0.5, 2, d.pace),
    topics: topics.length ? topics : [...d.topics],
  };
}

/** @param {Set<string>|null} ids  known card ids, or null to keep any id */
export function sanitizeProgress(p, ids) {
  const out = emptyProgress();
  if (!p || typeof p !== 'object') return out;
  for (const [id, a] of Object.entries(p.cards ?? {})) {
    if (ids && !ids.has(id)) continue;
    if (!Array.isArray(a) || a.length !== 5 || !a.every(Number.isFinite)) continue;
    out.cards[id] = a;
  }
  for (const [day, count] of Object.entries(p.log ?? {})) {
    if (Number.isFinite(+day) && Number.isFinite(count)) out.log[day] = count;
  }
  if (p.daily && Number.isFinite(p.daily.day)) out.daily = { ...out.daily, ...p.daily };
  return out;
}

export const loadSettings = () => sanitizeSettings(read(KEYS.settings));
export const saveSettings = (s) => write(KEYS.settings, s);
// Unknown ids are kept in storage (a later deck may bring them back), just not used.
export const loadProgress = () => sanitizeProgress(read(KEYS.progress), null);
export const saveProgress = (p) => write(KEYS.progress, p);

/** Ask the browser not to evict our data under storage pressure. */
export function requestPersistence() {
  navigator.storage?.persist?.().catch(() => {});
}
