# Cincinnati 311 Pothole Map

Static D3 + Leaflet visualization for Cincinnati pothole (`PTHOLE`) service requests (no React/TypeScript).

## Setup

1. Copy `js/config.example.js` to `js/config.local.js`.
2. In `js/config.local.js`, set `SOCRATA_APP_TOKEN` (Socrata open data) and `THUNDERFOREST_API_KEY` (or `THUNDERFOREST_API`) for the OpenCycleMap basemap toggle. Without a Thunderforest key, the map stays on OpenStreetMap only.
3. **Thunderforest tiles:** In your Thunderforest account (see [API keys](https://www.thunderforest.com/docs/apikeys/)), add **allowed domains / referrers** for where you host the app (for example `localhost`, `127.0.0.1`, and your production URL). If tiles stay blank or grey, check the browser Network tab: tile URLs should return **200**, not **401** / **403**.
4. Serve the project locally (for example, with VS Code Live Server) or deploy (e.g. Vercel).

## Data scope

- Live API: pothole requests from **2004** through **2026** (2026 is partial in the portal; treat year totals accordingly).
- Fallback: local `data/311Sample.csv` if the API fails.

## Notes

- `js/config.local.js` is ignored by git.
- **Color encoding (documentation):** map point color modes use a **sequential** light-to-dark scheme for quantitative *days to update*; **categorical** palettes for nominal fields (neighborhood, department); and **ordinal** styling for priority where levels imply order.
