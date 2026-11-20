# Geo

Map flashcards with spaced repetition. Each card shows a small map with one place
highlighted; the back names it and, for countries, gives the capital (marked on the
map). 580 cards in four topics the learner can switch on and off:

| Topic | Cards | What's in it |
|---|---|---|
| Countries and capitals | 197 | the 193 UN members, plus Vatican City, Palestine, Kosovo and Taiwan |
| Oceans, seas and lakes | 168 | oceans, seas, gulfs and bays, straits and channels, lakes |
| Islands | 85 | islands and island groups |
| Mountains, deserts and regions | 130 | continents, ranges, deserts, peninsulas, plains, basins, deltas… |

A sibling of [Words](https://github.com/mco-gh/words): the same scheduler, layout and
behavior, English only, in its own "Atlas" color scheme. A fully static,
offline-capable progressive web app: no server code, no login, all progress in the
browser's localStorage.

## Where it lives

Published at https://mco.dev/geo/. This repo is mounted in
[mco-gh/mco.dev](https://github.com/mco-gh/mco.dev) (a Hugo site) as a git submodule
at `static/geo`, so **everything in this repo is public** at `https://mco.dev/geo/...`.

## Run it locally

From a checkout of mco.dev, serve the site's `static/` folder so URLs match production:

    python3 -m http.server 4174 --directory static

Then open http://localhost:4174/geo/. The service worker caches everything, so while
developing, unregister it (DevTools → Application) or reloads may show old files.

## Files

| File | What it does |
|---|---|
| `index.html`, `styles.css` | the page and its look |
| `app.js` | sessions, the List and Progress views, settings, backup |
| `srs.js` | the SM-2-style scheduler and new-card order (shared with Words) |
| `store.js` | localStorage persistence (`geo:settings`, `geo:progress`, `geo:scheme`) |
| `map.js` | draws a card's map: an orthographic globe turned and zoomed to the place |
| `vendor/geo.js` | d3-geo and topojson-client, bundled (see below) |
| `data/deck.json` | the cards, best known first, with framing and capital coordinates |
| `data/map.json` | base map: every country and the larger lakes (TopoJSON) |
| `data/shapes.json` | shapes for the non-country cards (delta-encoded, 0.01°) |
| `build/` | the sources for everything in `data/` and `vendor/` |

Progress is keyed by card id (`fra`, `baikal`, `himalayas`…), so cards can be added or
reordered without disturbing anyone's progress. Never rename or reuse an id.

## Changing the deck

The cards live in `build/deck.mjs`: one line each, with the Natural Earth feature it
comes from, a display name, a tier (1 = very well known … 4 = for the keen), and for
countries the capital. Then rebuild:

    cd build && npm install && cd ..
    node build/build.mjs <folder of Natural Earth GeoJSON>

The folder needs these files from
[natural-earth-vector/geojson](https://github.com/nvkelso/natural-earth-vector/tree/master/geojson):
`ne_50m_admin_0_countries`, `ne_50m_land`, `ne_50m_lakes`,
`ne_10m_geography_marine_polys`, `ne_10m_geography_regions_polys` and
`ne_10m_populated_places_simple` (all `.geojson`). The build checks every source and
capital and exits non-zero naming anything it couldn't find.

A few water features exist in Natural Earth only as label points (Drake Passage,
Luzon Strait, Scotia Sea) or not at all (Strait of Hormuz, Bering Strait); those are
hand-drawn outlines in `deck.mjs`. They're drawn under the land, so a rough outline
is clipped to the real coast. The Southern Ocean is everything south of 60°S.

To rebuild the vendored map library:

    npx --prefix build esbuild build/vendor.mjs --bundle --format=esm --minify --outfile=vendor/geo.js

## How the maps work

Every map is an orthographic projection (a globe) rotated to face the place. The
build gives each card a center and an angular radius covering its main parts
(countries ignore far-flung territories, so France isn't framed with French Guiana).
The app zooms to fit that radius, never closer than 3°, and never further out than the
whole globe. Specks of land far out at sea get a wider view (`v`) reaching to the
nearest sizeable land, so there's a coast to orient by. Anything under 16px, and every
strait, gets a ring. Island groups are rough outlines in Natural Earth, so they're
shaded as an area with the islands inside picked out.

## Updating

Bump `VERSION` in `sw.js` whenever any file changes, so installed copies pick it up.
Icons are rendered from `icons/icon.svg` and `build/icons/full-bleed.svg` with
`bash build/icons/render.sh`.

## Credits

Map data: [Natural Earth](https://www.naturalearthdata.com/) (public domain).
Projection: [d3-geo](https://d3js.org/d3-geo) and
[topojson-client](https://github.com/topojson/topojson-client) (ISC).
