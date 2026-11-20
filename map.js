// Draws a card's map: a globe (orthographic projection) turned to face the
// feature and zoomed to fit it, with the feature highlighted: countries, islands
// and lakes in solid color, approximate areas (seas, ranges, deserts, regions) as
// a tinted outline. Small features get a ring so they can be spotted. Output is an SVG string set on the target <svg>.
import { geoOrthographic, geoPath, geoGraticule10, geoDistance, feature, mesh } from './vendor/geo.js';

let world = null;

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

/** data/shapes.json rings are flat [x0, y0, dx, dy, …] in hundredths of a degree. */
function decodeShape(polygons) {
  return {
    type: 'MultiPolygon',
    coordinates: polygons.map((rings) => rings.map((flat) => {
      const ring = [];
      let x = 0, y = 0;
      for (let k = 0; k < flat.length; k += 2) {
        x += flat[k]; y += flat[k + 1];
        ring.push([x / 100, y / 100]);
      }
      if (ring.length) ring.push(ring[0]);
      return ring;
    })),
  };
}

/** Load the base map (TopoJSON) and the card shapes, once. */
export async function loadMap(mapUrl, shapesUrl) {
  const [topo, shapes] = await Promise.all([fetchJson(mapUrl), fetchJson(shapesUrl)]);
  const countries = feature(topo, topo.objects.countries).features;
  world = {
    countries,
    land: { type: 'FeatureCollection', features: countries },
    borders: mesh(topo, topo.objects.countries, (a, b) => a !== b),
    lakes: feature(topo, topo.objects.lakes),
    shapes: new Map(Object.entries(shapes).map(([id, polys]) => [id, decodeShape(polys)])),
  };
}

// Kinds drawn beneath the land, so the coastline always comes from the land layer.
const SEA_KINDS = new Set(['ocean', 'sea', 'gulf', 'bay', 'strait', 'channel', 'estuary', 'reef']);
// Kinds whose shapes are approximate areas rather than real coastlines or borders:
// shown as a light tint inside a smoothed outline, not a solid fill.
const AREA_KINDS = new Set([...SEA_KINDS, 'islands', 'continent', 'mountains', 'desert', 'peninsula', 'region',
  'plain', 'plateau', 'basin', 'valley', 'wetland', 'delta', 'isthmus', 'canyon']);
const graticule = geoGraticule10();
const MIN_RADIUS = 3.6;    // degrees: the closest the map zooms in
const FIT = 0.5;           // the share of the frame's half-height the feature's radius fills
let clipCount = 0;
const RING_BELOW = 16;     // px: features smaller than this get a ring

/** Projected rings of a shape, as point arrays (what geoPath would draw). */
function projectedRings(projection, object) {
  const rings = [];
  let ring = null;
  geoPath(projection, {
    moveTo(x, y) { ring = [[x, y]]; rings.push(ring); },
    lineTo(x, y) { ring.push([x, y]); },
    closePath() {},
    arc() {},
  })(object);
  return rings.filter((r) => r.length > 2);
}

/** Round off a closed ring's corners (Chaikin's corner cutting, twice). */
function chaikin(ring, rounds = 2) {
  let pts = ring;
  for (let n = 0; n < rounds; n++) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
      out.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
    }
    pts = out;
  }
  return pts;
}

const smoothPath = (projection, object) => projectedRings(projection, object)
  .map((r) => `M${chaikin(r).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}Z`).join('');

function shapeOf(card) {
  if (card.iso) {
    const features = world.countries.filter((f) => card.iso.includes(f.properties.id));
    return { type: 'FeatureCollection', features };
  }
  return world.shapes.get(card.id);
}

/**
 * @param {SVGSVGElement} svg
 * @param {object} card     a deck entry: { c: [lon, lat], r: degrees, iso? , id, kind }
 * @param {object} [opts]   { capital: true to mark the capital }
 */
export function drawMap(svg, card, { capital = false } = {}) {
  if (!world) return;
  const W = 400, H = 300;
  const half = Math.min(W, H) / 2;
  // v: a wider view for specks of land far out at sea, so a coast is in sight.
  const r = Math.max(MIN_RADIUS, card.v ?? card.r);
  // Fit the feature's radius into half the frame, leaving context around it; never smaller than the whole globe.
  const fit = (half * FIT) / Math.sin((Math.min(r, 89) * Math.PI) / 180);
  const scale = Math.max(half * 0.94, fit);
  const projection = geoOrthographic()
    .rotate([-card.c[0], -card.c[1]])
    .translate([W / 2, H / 2])
    .scale(scale)
    .clipAngle(90)
    .precision(0.3);
  // Zoomed in, most of the world is off the frame: cut it off before it becomes path data.
  const framed = geoOrthographic().rotate(projection.rotate()).translate(projection.translate()).scale(scale)
    .clipAngle(90).clipExtent([[-8, -8], [W + 8, H + 8]]).precision(0.3);
  const path = geoPath(framed);
  const spherePath = geoPath(projection);
  const shape = shapeOf(card);
  const sea = SEA_KINDS.has(card.kind);
  const area = AREA_KINDS.has(card.kind);
  const zoomed = scale > half * 1.6;

  const parts = [];
  parts.push(`<path class="m-sphere" d="${spherePath({ type: 'Sphere' })}"/>`);
  parts.push(`<path class="m-grid" d="${path(graticule)}"/>`);
  const zone = area && shape ? smoothPath(framed, shape) : '';
  // An area is a wide outline with an opaque fill on top: only the outer half of
  // the outline shows, and seams between the pieces an area is made of vanish.
  const zoneOf = (cls) => `<path class="m-zone-edge" d="${zone}"/><path class="m-zone ${cls}" d="${zone}"/>`;
  // Water areas sit under the land, so the coast hides their rough landward edges.
  if (sea && zone) parts.push(zoneOf('water'));
  parts.push(`<path class="m-land" d="${path(world.land) ?? ''}"/>`);
  parts.push(`<path class="m-lake" d="${path(world.lakes) ?? ''}"/>`);
  if (card.kind === 'islands' && zone) {
    // Island groups: the outline around them, and the land inside it picked out.
    const id = `clip-${++clipCount}`;
    parts.push(zoneOf('land'));
    parts.push(`<clipPath id="${id}"><path d="${zone}"/></clipPath><path class="m-hl m-hl-land" clip-path="url(#${id})" d="${path(world.land) ?? ''}"/>`);
  } else if (!sea && zone) {
    parts.push(zoneOf('land'));
  } else if (!area && shape) {
    parts.push(`<path class="m-hl" d="${path(shape) ?? ''}"/>`);
  }
  parts.push(`<path class="m-border${zoomed ? ' zoomed' : ''}" d="${path(world.borders) ?? ''}"/>`);
  if (!zoomed) parts.push(`<path class="m-rim" d="${spherePath({ type: 'Sphere' })}"/>`);

  // A ring around anything too small to see.
  if (shape) {
    const [[x0, y0], [x1, y1]] = path.bounds(shape);
    const size = Math.max(x1 - x0, y1 - y0);
    // Straits are narrow and partly hidden by the coast, so they're always ringed.
    const passage = card.kind === 'strait' || card.kind === 'channel';
    if (!Number.isFinite(size) || size < RING_BELOW || (passage && size < 120)) {
      const at = Number.isFinite(size) ? [(x0 + x1) / 2, (y0 + y1) / 2] : projection(card.c);
      const radius = Math.max(13, Math.min(60, size / 2 + 6) || 13);
      if (at) parts.push(`<circle class="m-ring" cx="${at[0].toFixed(1)}" cy="${at[1].toFixed(1)}" r="${radius.toFixed(1)}"/>`);
    }
  }

  if (capital && card.capAt && geoDistance(card.capAt, card.c) < Math.PI / 2 - 0.05) {
    const [x, y] = projection(card.capAt);
    parts.push(`<g class="m-capital" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><circle r="5.5"/><circle r="2.2" class="dot"/></g>`);
  }

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = parts.join('');
}
