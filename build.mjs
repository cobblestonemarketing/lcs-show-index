// LCS show index builder. Runs nightly in GitHub Actions (Node 20, no dependencies).
// 1. Crawls https://localcardshopnearme.com/events?page=N (BD lists upcoming shows, 12 per page, soonest first).
// 2. For shows not already cached, reads the show page's schema.org Event JSON-LD for start date, venue, city and state.
// 3. Writes shows.json (every upcoming show) and m/<market>.json (one file per guide-page market).
import fs from 'node:fs/promises';

const SITE = 'https://localcardshopnearme.com';
const UA = 'Mozilla/5.0 (compatible; LCSNearMe-ShowIndex/1.0; +https://localcardshopnearme.com)';
const MAX_PAGES = 400;
const CONCURRENCY = 4;
const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
today.setHours(0, 0, 0, 0);

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' } });
      if (r.ok) return await r.text();
      if (r.status === 404) return null;
    } catch (e) { /* retry */ }
    await sleep(1500 * (i + 1));
  }
  return null;
}
const decode = s => s.replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/\s+/g, ' ').trim();

// ---- 1. list pages ----
function parseList(html) {
  const out = [];
  const re = /<a class="h3[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<b>(\d{2}\/\d{2}\/\d{4})<\/b>(?:\s*<span[^>]*>\s*([^<]*?)\s*<\/span>)?/g;
  let m;
  while ((m = re.exec(html))) out.push({ u: m[1], t: decode(m[2]), d: m[3], tm: decode(m[4] || '') });
  return out;
}

// ---- 2. show page ----
const US = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
function cityState(str) {
  if (!str) return null;
  const m = decode(str).match(/([A-Za-z][A-Za-z .'-]*?),\s*([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*(?:,\s*(?:US|USA|United States))?\s*\)?$/);
  if (m && US.has(m[2])) { const c = m[1].split(/\s+-\s+|\s+—\s+|,/).pop().trim(); return { c, s: m[2] }; }
  return null;
}
async function detail(u) {
  const html = await get(SITE + u);
  if (!html) return null;
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(x => x[1]);
  for (const b of blocks) {
    let j; try { j = JSON.parse(b); } catch { continue; }
    const ev = [j, ...(j['@graph'] || [])].find(x => x && x['@type'] === 'Event');
    if (!ev) continue;
    const a = (ev.location && ev.location.address) || {};
    let cs = null;
    if (a.addressLocality && US.has(a.addressRegion)) cs = { c: a.addressLocality, s: a.addressRegion };
    cs = cs || cityState(a.streetAddress) || cityState(ev.name);
    return { sd: (ev.startDate || '').slice(0, 10), ed: (ev.endDate || '').slice(0, 10), v: ev.location && ev.location.name ? decode(ev.location.name) : '', ...(cs || {}) };
  }
  return null;
}

// ---- main ----
const markets = JSON.parse(await fs.readFile('markets.json', 'utf8'));
let cache = {};
try { for (const s of JSON.parse(await fs.readFile('shows.json', 'utf8')).shows) cache[s.u] = s; } catch { }

const seen = new Map();
for (let p = 1; p <= MAX_PAGES; p++) {
  const html = await get(`${SITE}/events?page=${p}`);
  if (!html) break;
  const rows = parseList(html);
  let added = 0;
  for (const r of rows) if (!seen.has(r.u)) { seen.set(r.u, r); added++; }
  if (!rows.length || !added) break;
  await sleep(250);
}
console.log('listed', seen.size);
if (seen.size < 50) { console.error('Too few shows listed; refusing to overwrite the index.'); process.exit(1); }

const todo = [...seen.values()].filter(r => !(cache[r.u] && cache[r.u].s));
console.log('details to fetch', todo.length);
let idx = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (idx < todo.length) {
    const r = todo[idx++];
    const d = await detail(r.u);
    if (d) cache[r.u] = { ...cache[r.u], ...d };
    await sleep(200);
  }
}));

const shows = [];
for (const r of seen.values()) {
  const c = cache[r.u] || {};
  const [mm, dd, yy] = r.d.split('/');
  const date = c.sd || `${yy}-${mm}-${dd}`;
  if (new Date(date + 'T00:00:00') < today && !(c.ed && new Date(c.ed + 'T00:00:00') >= today)) continue;
  const fromTitle = (!c.c || !c.s) ? cityState(r.t.replace(/\s*\([^)]*\)\s*$/, '')) : null;
  shows.push({ u: r.u, t: r.t.replace(/\s*\((January|February|March|April|May|June|July|August|September|October|November|December)[^)]*\)\s*$/, ''), d: date, ed: c.ed && c.ed !== date ? c.ed : undefined, tm: r.tm || undefined, v: c.v || undefined, c: c.c || (fromTitle && fromTitle.c), s: c.s || (fromTitle && fromTitle.s) });
}
shows.sort((a, b) => a.d.localeCompare(b.d) || a.t.localeCompare(b.t));

const norm = x => (x || '').toLowerCase().replace(/^saint /, 'st. ').replace(/^st /, 'st. ').replace(/^mt\.? /, 'mount ').trim();
await fs.mkdir('m', { recursive: true });
const summary = [];
for (const mk of markets) {
  const cities = new Set(mk.cities.map(norm));
  const list = shows.filter(s => s.s && mk.states.includes(s.s) && cities.has(norm(s.c)));
  await fs.writeFile(`m/${mk.slug}.json`, JSON.stringify({ market: mk.name, slug: mk.slug, updated: new Date().toISOString(), shows: list }));
  summary.push([mk.slug, list.length]);
}
await fs.writeFile('shows.json', JSON.stringify({ updated: new Date().toISOString(), count: shows.length, shows }));
await fs.writeFile('summary.json', JSON.stringify(summary));
console.log('upcoming', shows.length, 'unlocated', shows.filter(s => !s.s).length);
console.log(summary.sort((a, b) => b[1] - a[1]).map(x => x.join(':')).join(' '));
