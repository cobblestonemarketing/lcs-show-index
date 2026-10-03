# LCS show index

Nightly index of upcoming card shows on [LCS Near Me](https://localcardshopnearme.com), used by the "Card Shows in {Market}" guide pages.

- `build.mjs` crawls `/events`, reads each show page's Event schema for date, venue, city and state, and drops past shows.
- `markets.json` defines the 100 guide-page markets (cities + states). Edit it to add or adjust a market.
- Output: `shows.json` (all upcoming shows) and `m/<slug>.json` (one per market).
- Served to the site from jsDelivr: `https://cdn.jsdelivr.net/gh/cobblestonemarketing/lcs-show-index@main/m/<slug>.json`.
- Runs daily via GitHub Actions (`.github/workflows/build.yml`); run it by hand from the Actions tab after a big import.
