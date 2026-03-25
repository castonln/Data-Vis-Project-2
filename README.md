# Cincinnati 311 Pothole Map

Static **D3** + **Leaflet** visualization for Cincinnati pothole (`PTHOLE`) service requests (no React/TypeScript). The layout uses [**Oat**](https://oat.ink/) CSS on top of local styles.

## Setup

1. Copy `js/config.example.js` to `js/config.local.js`.
2. In `js/config.local.js`, set:
   - **`SOCRATA_APP_TOKEN`** — Socrata open-data token (raises rate limits).
   - **`SOCRATA_DOMAIN`** — optional; defaults to `data.cincinnati-oh.gov` if omitted.
   - **`THUNDERFOREST_API_KEY`** or **`THUNDERFOREST_API`** — for the OpenCycleMap basemap toggle. Without a key, the map stays on OpenStreetMap only.
3. **Thunderforest tiles:** In your Thunderforest account (see [API keys](https://www.thunderforest.com/docs/apikeys/)), add **allowed domains / referrers** for where you host the app (for example `localhost`, `127.0.0.1`, and your production URL). If tiles stay blank or grey, check the browser Network tab: tile URLs should return **200**, not **401** / **403**.
4. Serve the project over **http://localhost** (for example VS Code Live Server, `npx serve`, or `python -m http.server`). Opening `index.html` as `file://` can break API and data loading.
5. Deploy as a static site (e.g. Vercel, Netlify, GitHub Pages).

## Data scope

- Live API: pothole requests from **2004** through **2026** (2026 is partial in the portal—e.g. through March 21; treat year totals accordingly).
- Fallback: local `data/311Sample.csv` if the API fails.

## What’s in the app

- **Map:** colored points (by time-to-update, neighborhood, priority, or department), optional **heatmap**, basemap toggle (OSM / OpenCycleMap), zoom bounds centered on Cincinnati.
- **Timeline:** monthly bins for all years, or weekly bins when a single year is selected; brush to filter by date. Timeline year also filters the map and side charts.
- **Filters:** department, neighborhood (tags), priority.
- **Large datasets:** point layers subsample for SVG performance; heatmap subsamples very large sets. The legend notes when sampling is active.

## Notes

- `js/config.local.js` is ignored by git.
- **Color encoding (documentation):** map point color modes use a **sequential** light-to-dark scheme for quantitative *days to update*; **categorical** palettes for nominal fields (neighborhood, department); and **ordinal** styling for priority where levels imply order.
