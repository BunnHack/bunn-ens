# Tropical Tidbits — Material Design recreation

Vue 3 + TypeScript recreation with live WNC2, WNC3 (WNV3) and WM-6 ensemble guidance.

WM-6 uses WindBorne's Tropical Cyclone Tracker API. The short response lists cyclones for the latest published initialization; the app then requests the selected cyclone's provider `mean_path`, complete `members_path` tracks and member landfalls. `format=geojson` remains available as map-ready summary data, but cone features are excluded from the browser response and export. The app draws a generalized Natural Earth coastline and colors member segments by `max_wind_kt`. The API key remains server-side in Cloudflare Pages and never enters browser JavaScript.

The page includes live WNC2 and **WM-6 Ensemble** forecast guidance.

## Weather Tools

The former Aircraft Recon navigation item now opens the internal `/#weather-tools` view. Its six cards follow the supplied reference: GIS系集預報, 洋區系集預報, 颱風攻擊機率, AIFS 風雨預報, 華南氣象愛好者 and 廣東省天氣實況. The responsive grid uses three columns on desktop, two on tablet and one on mobile, with cropped reference thumbnails, category badges, dates and outlined detail links.

Each card has a deep-linkable detail view (`/#weather-tools/{id}`), reference-data disclosure and working resource links. Existing WNC2/WM-6 tools remain available through the ensemble links. Unintegrated AIFS/GENC/EAGLE/observation products are not presented as live, and the recommended social account is not claimed as this project's official account. Thumbnail artwork and dates are from the user-supplied screenshot, not live forecasts. `tests/weather-tools.test.mjs` covers navigation, all six details, deep links, state preservation, assets and responsive CSS.

### Basin ensemble screen

`/#weather-tools/basin` opens a full-width three-column viewer: collapsible forecast/model navigation, central map and a control panel with initialization, light/color/dark themes, eleven regional views and CSV export. **WN3C** uses live Google **WNV3** CSV, **WN2C** uses FNV3P1 and **WM-6** defaults to `include_unofficial_ids=true`, with an explicit checkbox to hide unmatched candidates. Matched cyclones use real `members_path`; per the API contract, each unmatched summary `path` is already its single-member track. The original generated ID is preserved and the member comes from its `_M###` suffix (verified against detail); unknown formats or missing paths request real detail instead of inventing an ID/member. This avoids hundreds of unnecessary detail requests. Detail concurrency is bounded to three and pinned to the list initialization, with explicit partial-failure disclosure. No cones, polygons or landfall markers are rendered.

SVG charts plot independent `(sample, track_id)` paths, hollow MSLP-colored forecast points and global Natural Earth coastlines with longitude wrapping and strict 0–312h filtering. Genesis IDs remain sample-scoped. Regional CSV export contains only the current initialization's in-region points, with unknown wind left empty instead of invented. Latest refreshes every five minutes in visible tabs; manual failure clears the previous map, and WNC2 fallback snapshots remain clearly labeled. WNV3 never falls back to a different model. ECMWF/AIFS/GEFS/AIGEFS/GENC remain explicitly unavailable.

WM-6 matched/unmatched counts distinguish the full upstream response from the current map. Unmatched tracks are member-specific candidates, not independent confirmed storms or official genesis probabilities, and are never merged into a named cyclone. `/tropical_cyclones/index` spans initialization times and is **not** used as a current-run forecast source. Forecast hours remain anchored to upstream `forecast_zero`, not necessarily `initialization_time`. In the audited `2026-10-17T01:00:00Z` run, the anchor is `2026-10-17T00:00:00Z`; upstream returned 3 matched cyclones and 644 unmatched tracks, with 27,963 unmatched path points inside 0–312h.

The **原始 kt / hPa 核對** panel and tooltips retain paired wind/pressure at the same member/time. For that run, WP292026 member 28 at +126h is **949.8 hPa / 56.9 kt** in the upstream JSON; the maximum member wind is a different point (member 125, +159h, **64.3 kt / 969.5 hPa**). These are not pressure-to-wind conversions or swapped fields. A low-pressure/weak-wind combination alone does not establish an upstream unit error; wind-field definition, sampling and calibration need supplier confirmation. No speculative m/s↔kt correction is applied. `tests/wm6-genesis.test.mjs` covers generated-track inclusion, independence, bounded fetch count, explicit opt-out, unknown-ID fallback, paired units, forecast-zero metadata and single-member selection without a fake mean.

### Typhoon potential screen

Click **台風潛勢預報** in the sidebar or open `/#weather-tools/typhoon`. This screenshot-inspired three-column workspace provides model selection, initialization, four product controls, actual cyclone-ID buttons, sample-specific genesis selection and a current-selection summary. WNC2/WNC3/WM-6 ensemble maps use raw-wind category colors, per-member peak labels, coastlines and a dark mean with lead-hour labels. WNC means use circular longitude and only lead times retaining ≥25% of members; matched WM-6 cyclones use the provider mean. Unmatched WM-6 tracks are grouped separately in the selector and have no ensemble mean or mean legend line. Member IDs are shown as supplied (WeatherNext starts at 0). Numeric genesis IDs are never merged between samples. The cyclone CSV contains only the selected track and 0–312h.

**機率預報** now calculates a local **120 km passage fraction** from matched WNC2/WNC3/WM-6 member tracks, rather than substituting a screenshot. Select a 0–312h window; every member counts at most once at each location. WM-6 uses provider `ens_size` and refuses missing denominators; WeatherNext uses the member count from the entire global CSV, not the subset tracking the selected cyclone (omitted whole members could bias this denominator). Spherical shortest-arc interpolation handles the date line; gaps >12h are not bridged. Missing/untracked members are not hits, not evidence of no risk. These are uncalibrated local ensemble fractions, **not official attack, landfall or damage probabilities**. Single-member genesis candidates cannot receive fake 100% probabilities. The map has 5/25/50/75/100% contours, mean/member lines and seven city-centre point percentages, not county-wide coverage. It defaults to the ≥5% corridor with a full-member-extent toggle. SST and heat-content products remain explicitly unavailable.

Maps now use simplified public-domain **Natural Earth 1:50 million** coastlines and country borders, encoded losslessly after quantization; these are not street/provincial/county maps. `ChartFrame.vue` provides fullscreen, 100–400% zoom, drag/touch scrolling, self-contained SVG and aspect-correct PNG downloads, plus actual PNG previews for mobile long-press saving. Shared controls cover basin/typhoon and main WNC2 charts; WM-6 retains its existing download controls. `tests/chart-frame.test.mjs` covers sizing, styling, fullscreen/Escape, panning and download/error behavior. DOM tests mock browser rasterization; live SVGs also rasterize with CairoSVG.

**Intensity Guidance** displays the user-supplied **TRUDY (21E), 2026-10-17 00Z** PNG, with enlargement and original PNG download. It is explicitly a dated static reference, **not live or Invest 96W guidance**, and does not offer fake cycle switching.

Verification: all **79 tests** pass, including new probability geometry/denominator/window/genesis and intensity-reference tests. Real WNV3 2026-10-16 18Z and WM-6 2026-10-17 01Z probability SVGs rasterized successfully. WNV3 uses 64 members; Taichung's point has 31/64 passages (48.4375%). WM-6 uses 128 members. No wind inflation, cones or landfalls were introduced.

## WM-6 Forecast Models and GitHub Actions

Open **Forecast Models** or `/#forecast-models` for the screenshot-inspired weather-map workspace. Only **WM-6 global 0.25° / 128-member ensemble mean** is supported; other model-category tabs are disabled. Four genuine gridded products cover East Asia, West Pacific and North America: 6h mean total precipitation rate + MSLP + 1000–500 hPa thickness; 10m wind + MSLP; 500 hPa height/temperature; and 2m temperature. Published 6-hourly frames are selectable within 0–312h, with a slider, playback, keyboard controls, run/region switching, zoom/pan and PNG/SVG/GIF downloads. Missing frames/errors are explicit and never replaced with another run or screenshot. Existing storm-ensemble state survives internal navigation.

`.github/workflows/wm6-forecast-charts.yml` runs at **00:25/06:25/12:25/18:25 UTC** (GitHub schedules are best-effort), or by `workflow_dispatch` with exact initialization and maximum hour. `scripts/wm6_forecast.py` pins every native NetCDF request to a single initialization and verifies file model, initialization, `forecast_zero`, lead hour, grid coordinates and units. Valid time is **forecast_zero + forecast_hour**, not publication initialization. Two adjoining same-run `total_precipitation_3h` accumulations divided by 6 produce the genuine 6h mm/h rate; +0h precipitation is unavailable. All precipitation types are combined rather than inventing snow/freezing-rain fields. Pa→hPa, geopotential→height/dam, K→°C and documented native gridded m/s→kt conversions do not modify tropical-cyclone `max_wind_kt`.

The encrypted repository secret is **`WM_API_KEY`**. GitHub's short-lived `GITHUB_TOKEN`/OIDC publishes **only `.generated-site`** to [GitHub Pages chart storage](https://bunnhack.github.io/bunn-ens/forecast-models/index.json); the Vue site remains on Cloudflare Pages. No personal GitHub token, API key, native NetCDF, or presigned URL is published. The site validates a fixed-origin manifest and preserves/discloses old charts on refresh failure. Charts are generated server-side, not on every visitor request. Downloaded SVGs are genuine self-contained vectors, losslessly stored as SVGZ and decompressed to `.svg` by modern browsers; older browsers can use PNG. Palette PNGs reduce storage without reducing the native input grid. A cache retains up to two initializations; old history is pruned when needed to stay below a 900 MiB publication budget. Forecast GIFs advance valid times; Trend GIFs compare **the same valid time** across different initializations only.

API schemas and units were read through authenticated WindBorne MCP (`https://mcp.windbornesystems.com/mcp`), then verified against real NetCDF metadata. Python checks: `pip install -r scripts/requirements-forecast.txt && python -m unittest discover -s tests -p 'test_forecast*.py' -v`. The native HDF5-reader test runs on Ubuntu Actions (skipped on Termux without h5py); the other tests also run locally. `tests/forecast-models.test.mjs` covers manifest/run/URL validation, gzip SVG round trips, unavailable frames, playback, downloads, fullscreen, error disclosures, routing/state preservation and secret-free publication configuration.

## Local run and checks

```sh
npm install
npm run dev -- --host 0.0.0.0
npm test
npm run build
npm run preview -- --host 0.0.0.0
```

Vite normally serves the local preview at `http://localhost:5173/`.

## Cloudflare Pages deployment

The Pages project uses **Advanced Mode** with a GitHub source connection to `BunnHack/bunn-ens` (`main`), build command `npm run build` and output directory `dist`. It was initially created using Direct Upload.

- `public/_worker.js` is copied into `dist/_worker.js` and routes `/api/wnc2` and `/api/wm6` while serving static assets through `env.ASSETS.fetch()`.
- `GET /api/wnc2?model=FNV3P1&cycle=latest` discovers the latest published six-hour run in the previous 72 hours, probes 00/06/12/18Z in descending order, fetches the fixed Google DeepMind WeatherNext source, validates the CSV, and returns JSON metadata plus CSV.
- `cycle=00z|06z|12z|18z` performs an exact-cycle discovery; add `date=YYYY-MM-DD` for an exact historical run. `model=FNV3P1|FNV3P2|WNV3` is allowlisted. For the supplied WNC3 run use `/api/wnc2?model=WNV3&cycle=18z&date=2026-10-16`.
- Cloudflare `fetch` cache is used for upstream WeatherNext CSV responses for 5 minutes. The frontend checks latest every 5 minutes while visible and refreshes on tab visibility.
- `public/data/FNV3P1_2026_10_13T00_00_cyclogenesis.csv` is a downloaded 00Z fallback. The UI labels fallback data as not confirmed latest. Other runs fail instead of silently reusing old data.
- `GET /api/wm6?initialization_time=latest&include_details=true&format=json` proxies WindBorne's WM-6 tropical cyclone list through the Pages Worker. It supports basin filtering and optional unmatched member tracks. Cone fields and polygon features are removed before caching and returning the response. After selecting a cyclone, the app pins the returned `initialization_time` and requests `/api/wm6/{id}?include_members=true`; the detail response supplies the provider's `mean_path`, every `members_path` and member landfalls.

### Deploy using the Cloudflare dashboard/API

The GitHub source was connected using the Pages source API. Verify the GitHub App authorization and actual build/deployment status after a push; a saved source configuration alone is not proof of a successful automatic deployment. Direct Upload via the authenticated API remains available as a fallback without removing the Git connection. The deployment output is `dist`; build command is `npm run build`.

**Live site:** https://tropical-tidbits-material.pages.dev/

The project was deployed successfully through the authenticated Cloudflare MCP/API (production branch `main`). Its Pages Advanced Mode Worker is active. Both static assets and `/api/wnc2` are served from this same origin. The local `cf` / Wrangler installers require a `workerd` binary unavailable on Termux Android ARM64, so the initial deployment used the Pages asset-upload API and multipart Worker bundle instead.

On a normal Node/Linux/macOS environment, deploy with the official Wrangler command:

```sh
npm run build
npx wrangler pages deploy dist --project-name tropical-tidbits-material --branch main
```

For the first deployment, choose production branch `main` when prompted. Pages Advanced Mode requires `_worker.js` in the output; dashboard drag-and-drop does not compile Functions, so use Wrangler or the Cloudflare API for this project.

### Cloudflare production caveat

The Vite dev server uses `server/wnc2-proxy.ts` for WNC2; Cloudflare production uses `public/_worker.js` for WNC2 and WM-6. `tests/pages-worker.test.mjs` covers production routing, discovery, caching, request validation, initialization mismatch, upstream failures and the 10 MB response bound. WM-6 worker tests cover secret-authenticated list/detail proxying, GeoJSON and cone removal. `tests/wm6-plot.test.mjs` covers coastlines in multiple basins, dateline member paths, local WNC2 C1–C5 classification even when upstream reports TS, missing-wind gray, finite empty-map bounds and absence of landfall markers. `tests/wm6-image.test.mjs` covers self-contained SVG serialization and PNG canvas export with mobile image fallback.

Verification after the image/intensity update: production deployment `5a719c08-aa56-469a-9456-c8196d01fdaa` succeeded and public HTML/JS/CSS match the local build byte-for-byte. Live Vue integration used initialization `2026-10-16T09:00:00Z` and rendered `WP292026` with 128 member tracks, 9,326 colored segments, 75 provider-mean points and 22 coastline paths; no red landfall points or legend remain. The run's actual peak member wind is 65 kt (three C1 points), so C2–C5 are not invented. Fixture tests confirm all WNC2 category thresholds and SVG/PNG controls, including real `<img>` preview and export-error handling; PNG rasterization/download APIs are mocked in DOM tests. The exported live SVG also rasterizes successfully with CairoSVG. `npm test` passes all 45 tests and `npm run build` passes.

### WM-6 map and intensity colors

- Land data: `src/data/wm6-land.json`, Natural Earth 1:110m land polygons, public domain: https://www.naturalearthdata.com/downloads/110m-physical-vectors/110m-land/ . This generalized basemap is not the upstream landfall-detection shoreline.
- Each member segment uses the starting point's `max_wind_kt` with the existing WNC2 wind thresholds; absent/non-finite wind is gray. Identical colors do not imply identical model calibration or wind averaging definitions.
- Provider mean remains a thick dark line. Member landfall markers, count and legend are removed from both charts and exported images; hidden landfalls no longer affect bounds. Landfall data remain available in the separate GeoJSON export. Detail upstream requests force `include_cones=false`.
- `windCategory` in `src/data/wnc2.ts` is shared by WNC2 colors and WM-6 colors, labels and member-peak classification. Provider `storm_type` is not used; raw wind is never multiplied to manufacture a higher category.
- **Save chart PNG** exports a 2000×1580 image and opens an actual `<img>` preview for mobile long-press saving. **Save chart SVG** downloads a self-contained vector image including fonts, map, labels and legend. The live chart is SVG, not canvas; canvas is used only to rasterize the PNG.
- Coastline rings use continuous longitude unwrapping and neighboring world copies to avoid filling across the antimeridian.

## WNC2 data behavior

- `src/data/wnc2.ts`: typed CSV parsing, 0–312h filtering, sample-specific track grouping, wind thresholds, means, latest metadata and 96W diagnostics.
- `src/components/Wnc2Plot.vue`: native SVG rendering from coordinates, dynamic regional bounds, wind-colored tracks, ensemble mean, lead-hour markers and interactive member labels.
- `src/components/Wnc2Ensemble.vue`: automatic latest discovery state, 5-minute refresh, visible-tab refresh, manual cycles/date, model selection, 0–312h range, track selection and diagnostics.
- **96W check:** For the supplied `FNV3P1_2026_10_13T00_00` CSV, Google’s official track is `WP962026(4)`. 36/50 members continue beyond +24h. 14 early-ending members have heuristic nearby numeric-track candidates with no lead-time overlap; this is reported as likely tracking re-identification, not treated as proof of splitting. 29 later genesis tracks appear after +168h in the regional filter. Numeric IDs are scoped per sample and are never silently merged.
- The user’s specified 2026-10-13 CSV has raw rows to +360h, but the UI deliberately displays only **0–312h (13 days)**. No points beyond +312h enter chart or means.

WeatherNext license/terms:
- https://storage.googleapis.com/weathernext-public/terms-of-use.pdf
- https://creativecommons.org/licenses/by/4.0/

This is an AI forecast visualization, not an official warning service. The original 96W details and satellite images remain screenshot references and are not live data.
