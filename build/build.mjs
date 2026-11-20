// Builds data/deck.json, data/map.json and data/shapes.json from build/deck.mjs and Natural Earth.
//
//   cd build && npm install
//   node build/build.mjs <folder with the Natural Earth GeoJSON files>
//
// The folder needs these files from github.com/nvkelso/natural-earth-vector/tree/master/geojson:
//   ne_50m_admin_0_countries, ne_50m_land, ne_50m_lakes, ne_10m_geography_marine_polys,
//   ne_10m_geography_regions_polys, ne_10m_populated_places_simple  (all .geojson)
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { geoArea, geoCentroid, geoCircle, geoContains, geoDistance } from 'd3-geo';
import { COUNTRIES, WATER, ISLANDS, LAND } from './deck.mjs';

const require = createRequire(import.meta.url);
const mapshaper = require('mapshaper');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NE = process.argv[2];
if (!NE) { console.error('usage: node build/build.mjs <natural-earth-geojson-folder>'); process.exit(1); }

const load = (name) => JSON.parse(readFileSync(join(NE, `${name}.geojson`), 'utf8')).features;
const countries = load('ne_50m_admin_0_countries');
const lakes = load('ne_50m_lakes');
const marine = load('ne_10m_geography_marine_polys');
const regions = load('ne_10m_geography_regions_polys');
const places = load('ne_10m_populated_places_simple');

const errors = [];
const polysOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);
// d3-geo wants clockwise outer rings (spherical winding); flip any ring set that
// would otherwise cover most of the globe.
const rewind = (rings) => (geoArea({ type: 'Polygon', coordinates: rings }) > 2 * Math.PI ? rings.map((r) => [...r].reverse()) : rings);
const merge = (features) => ({ type: 'MultiPolygon', coordinates: features.flatMap((f) => polysOf(f.geometry)).map(rewind) });

function find(source) {
  // Hand-drawn shapes, for water Natural Earth only has as a label point. They're
  // drawn under the land, so a rough outline is clipped to the real coast.
  if (source.startsWith('x:')) {
    const ring = source.slice(2).split(';').map((pt) => pt.split(',').map(Number));
    return [{ geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } }];
  }
  if (source.startsWith('o:')) {
    const [lon, lat, radius] = source.slice(2).split(',').map(Number);
    return [{ geometry: geoCircle().center([lon, lat]).radius(radius).precision(2)() }];
  }
  const [layer, names] = [source[0], source.slice(2).split('+')];
  const pick = {
    c: (n) => countries.filter((f) => f.properties.ADM0_A3 === n),
    m: (n) => marine.filter((f) => f.properties.name === n),
    r: (n) => regions.filter((f) => f.properties.NAME === n),
    l: (n) => lakes.filter((f) => f.properties.name === n),
  }[layer];
  return names.flatMap((n) => {
    const found = pick(n);
    if (!found.length) errors.push(`not found: ${source} (${n})`);
    return found;
  });
}

function capitalAt(iso, name) {
  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const matches = places.filter((p) => [p.properties.name, p.properties.nameascii, p.properties.namealt].some((n) => n && norm(n) === norm(name)));
  const best = matches.find((p) => p.properties.adm0_a3 === iso || p.properties.sov_a3 === iso)
    ?? (matches.length === 1 ? matches[0] : null);
  if (!best) { errors.push(`capital not found: ${iso} ${name} (${matches.length} by name)`); return null; }
  return [best.properties.longitude, best.properties.latitude].map((v) => Math.round(v * 100) / 100);
}

/**
 * How to frame a card: a center and an angular radius (degrees) that covers its
 * main parts. Countries frame their largest piece, the parts near it and the
 * capital, so far-flung territories don't shrink the view to nothing.
 */
function framing(geometry, kind, capital) {
  const polys = polysOf(geometry).map((coords) => ({ type: 'Polygon', coordinates: coords }));
  let keep = polys;
  if (kind === 'country' && polys.length > 1) {
    const areas = polys.map((p) => geoArea(p));
    const main = polys[areas.indexOf(Math.max(...areas))];
    const c = geoCentroid(main);
    const deg = (p) => (geoDistance(geoCentroid(p), c) * 180) / Math.PI;
    // Nearby pieces, and sizeable ones within reach (Japan's islands, not Spain's Canaries).
    keep = polys.filter((p, k) => deg(p) < 6 || (deg(p) < 25 && areas[k] >= 0.02 * Math.max(...areas)));
  }
  const points = keep.flatMap((p) => p.coordinates[0]);
  if (capital) points.push(capital);
  const mid = geoCentroid({ type: 'MultiPolygon', coordinates: keep.map((p) => p.coordinates) });
  const radius = Math.max(...points.map((pt) => geoDistance(mid, pt))) * (180 / Math.PI);
  return { c: mid.map((v) => Math.round(v * 100) / 100), r: Math.round(radius * 10) / 10 };
}

// Sizeable land (over ~100,000 km²: Iceland, Cuba, Java and up) for orienting the
// view: a speck of an island in open ocean is unrecognizable without a coast nearby.
const bigLand = load('ne_50m_land').flatMap((f) => polysOf(f.geometry)).map(rewind)
  .map((rings) => ({ type: 'Polygon', coordinates: rings }))
  .filter((p) => geoArea(p) > 0.0025);
const bigLandPoints = bigLand.flatMap((p) => p.coordinates[0].filter((_, i) => i % 2 === 0));
function distanceToBigLand(pt) {
  if (bigLand.some((p) => geoContains(p, pt))) return 0;
  let best = Infinity;
  for (const q of bigLandPoints) best = Math.min(best, geoDistance(pt, q));
  return (best * 180) / Math.PI;
}

// ── Cards ──
const deck = [];
const shapes = [];
const groups = [['countries', COUNTRIES], ['water', WATER], ['islands', ISLANDS], ['land', LAND]];
const seen = new Set();
for (const [topic, list] of groups) {
  for (const [id, source, name, tier, extra = {}] of list) {
    if (seen.has(id)) errors.push(`duplicate id ${id}`);
    seen.add(id);
    const features = find(source);
    if (!features.length) continue;
    const geometry = merge(features);
    const kind = topic === 'countries' ? 'country' : extra.kind;
    const card = { id, name, kind, topic, tier };
    if (topic === 'countries') {
      card.iso = source.slice(2).split('+');
      card.cap = extra.cap;
      const at = extra.pt ?? capitalAt(card.iso[0], extra.at ?? extra.cap);
      if (at) card.capAt = at;
    }
    if (extra.note) card.note = extra.note;
    Object.assign(card, framing(geometry, kind, card.capAt));
    // How far the map should show: the feature, or out to the nearest sizeable land.
    const reach = distanceToBigLand(card.c);
    if (reach > card.r) card.v = Math.round(Math.max(card.r, Math.min(25, reach * 1.15 + 1)) * 10) / 10;
    if (topic !== 'countries') shapes.push({ feature: { type: 'Feature', properties: { id }, geometry }, r: card.r });
    deck.push(card);
  }
}

// "Best known first": tier by tier, the topics interleaved evenly, each topic in list order.
function interleave(lists) {
  const total = lists.reduce((n, l) => n + l.length, 0);
  const tagged = lists.flatMap((l) => l.map((card, k) => ({ card, at: (k + 0.5) / l.length })));
  tagged.sort((a, b) => a.at - b.at);
  return tagged.map((t) => t.card).slice(0, total);
}
const ordered = [1, 2, 3, 4].flatMap((tier) => interleave(groups.map(([topic]) => deck.filter((c) => c.topic === topic && c.tier === tier))));

// ── Map ──
// Base layers: every country (land and borders) and the larger lakes, as TopoJSON.
const tmp = mkdtempSync(join(tmpdir(), 'geo-'));
const fc = (features) => JSON.stringify({ type: 'FeatureCollection', features });
writeFileSync(join(tmp, 'countries.json'), fc(countries.map((f) => ({ type: 'Feature', properties: { id: f.properties.ADM0_A3 }, geometry: f.geometry }))));
writeFileSync(join(tmp, 'lakes.json'), fc(lakes.filter((f) => f.properties.scalerank === 0 && geoArea(f.geometry) > 2e-6).map((f) => ({ type: 'Feature', properties: {}, geometry: f.geometry }))));
// Each card shape is drawn at a size set by its radius, so thin it to match:
// about 1/250 of its radius (in meters), but never coarser than needed up close.
const thinned = [];
for (const { feature, r } of shapes) {
  const interval = Math.round((Math.max(3, Math.min(r, 90)) * 111_000) / 150);
  const out = await mapshaper.applyCommands(`-i in.json -simplify interval=${interval} keep-shapes -o out.json format=geojson`, { 'in.json': fc([feature]) });
  // Drop islets too small to see at this size, unless that would leave nothing.
  const f = JSON.parse(out['out.json']).features[0];
  const min = 4 * (interval / 6_371_000) ** 2;
  const polys = polysOf(f.geometry).map(rewind).sort((p, q) => geoArea({ type: 'Polygon', coordinates: q }) - geoArea({ type: 'Polygon', coordinates: p }));
  const big = polys.filter((p) => geoArea({ type: 'Polygon', coordinates: p }) >= min);
  f.geometry = { type: 'MultiPolygon', coordinates: big.length ? big : polys.slice(0, 40) };
  thinned.push(f);
}
// Card shapes overlap each other (a continent and its islands), which a shared
// topology would chop into thousands of arcs. So they get their own compact file:
// { id: [polygon: [ring: [x0, y0, dx, dy, …] in hundredths of a degree]] }.
const encoded = {};
for (const f of thinned) {
  encoded[f.properties.id] = polysOf(f.geometry).map((rings) => rings.map((ring) => {
    const out = [];
    let px = 0, py = 0;
    for (const [x, y] of ring) {
      const qx = Math.round(x * 100), qy = Math.round(y * 100);
      if (out.length && qx === px && qy === py) continue;
      out.push(qx - px, qy - py);
      px = qx; py = qy;
    }
    return out;
  }).filter((r) => r.length >= 8));
}
writeFileSync(join(ROOT, 'data/shapes.json'), JSON.stringify(encoded));
await mapshaper.runCommands([
  `-i ${join(tmp, 'countries.json')} ${join(tmp, 'lakes.json')} combine-files`,
  '-simplify 30% keep-shapes target=countries,lakes',
  '-clean target=countries,lakes',
  `-o ${join(ROOT, 'data/map.json')} target=* format=topojson quantization=60000 precision=0.0001`,
].join(' '));
rmSync(tmp, { recursive: true });

writeFileSync(join(ROOT, 'data/deck.json'), `[\n${ordered.map((c) => JSON.stringify(c)).join(',\n')}\n]\n`);

const counts = Object.fromEntries(groups.map(([t]) => [t, deck.filter((c) => c.topic === t).length]));
console.log(`${deck.length} cards`, counts);
for (const f of ['map.json', 'shapes.json']) console.log(f, (readFileSync(join(ROOT, 'data', f)).length / 1024).toFixed(0), 'KB');
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
