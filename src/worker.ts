// Cloudflare Worker — agregator Binance + proste rekomendacje
// Minimalny, bez zewn. bibliotek. TS/ESM. D1 jako timeseria.
// Autor: (tu możesz wpisać siebie)

export interface Env {
  DB: D1Database;
  SYMBOLS: string;           // Np. "BTCUSDT,ETHUSDT,SOLUSDT"
  DEPTH_LIMIT?: string;      // 100/200/500/1000 (uwaga na weight)
  DEPTH_BPS?: string;        // bps do liczenia depthu od mid (domyślnie 10)
}

const FAPI = "https://fapi.binance.com"; // USDⓈ-M Futures
const SPOT = "https://api.binance.com";  // Spot

// Utils
const nowMs = () => Date.now();
const floorMin = (ms: number) => Math.floor(ms / 60000) * 60000;
function toNumber(x: any, d = 0) { const n = Number(x); return Number.isFinite(n) ? n : d; }

// ---- Binance fetchers ----
async function getJSON(url: string) {
  const r = await fetch(url, { headers: { "User-Agent": "cf-worker-crypto-recs/1.0" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

// Open Interest (bieżące)
async function fetchOI(symbol: string) {
  const j = await getJSON(`${FAPI}/fapi/v1/openInterest?symbol=${symbol}`);
  return { oi: toNumber(j.openInterest), time: toNumber(j.time) };
}

// PremiumIndex — mark price + funding live
async function fetchPremiumIndex(symbol: string) {
  const j = await getJSON(`${FAPI}/fapi/v1/premiumIndex?symbol=${symbol}`);
  return {
    markPrice: toNumber(j.markPrice),
    indexPrice: toNumber(j.indexPrice),
    lastFundingRate: toNumber(j.lastFundingRate),
    nextFundingTime: toNumber(j.nextFundingTime),
    time: toNumber(j.time),
  };
}

// AggTrades (perp & spot) — liczenie 1-min CVD z pola `m` (buyer is maker)
async function fetchAggTradesDelta(base: string, path: string, symbol: string, startTime: number, endTime: number) {
  const url = `${base}${path}?symbol=${symbol}&startTime=${startTime}&endTime=${endTime}&limit=1000`;
  const arr = await getJSON(url);
  let delta = 0;
  for (const t of arr) {
    const qty = toNumber(t.q || t.l || t.quantity || 0); // futures: q, czasem l
    const buyerIsMaker = !!t.m; // true => agresor = sprzedający => delta -
    delta += buyerIsMaker ? -qty : +qty;
  }
  return delta;
}

// Orderbook snapshot (futures). Zwraca depth w X bps i spread.
async function fetchDepth(symbol: string, limit: number, bps: number) {
  const j = await getJSON(`${FAPI}/fapi/v1/depth?symbol=${symbol}&limit=${limit}`);
  const bids: [string, string][] = j.bids || [];
  const asks: [string, string][] = j.asks || [];
  const bestBid = bids.length ? toNumber(bids[0][0]) : NaN;
  const bestAsk = asks.length ? toNumber(asks[0][0]) : NaN;
  const mid = (bestBid + bestAsk) / 2;
  const width = (bps / 10000) * mid; // 10 bps = 0.001 * mid
  let bidDepth = 0, askDepth = 0;
  for (const [p, q] of bids) {
    const price = toNumber(p); const qty = toNumber(q);
    if (price >= mid - width) bidDepth += qty; else break;
  }
  for (const [p, q] of asks) {
    const price = toNumber(p); const qty = toNumber(q);
    if (price <= mid + width) askDepth += qty; else break;
  }
  const spread = bestAsk - bestBid;
  return { bidDepth, askDepth, spread };
}

// ---- Heurystyki rekomendacji ----
// Pobiera ostatni i poprzedni rekord, buduje prostą sugestię.
function makeRecommendation(latest: any, prev: any | null) {
  if (!latest) return { action: "NO_DATA", confidence: 0, reasons: ["brak danych"] };
  const reasons: string[] = [];
  const fr = toNumber(latest.funding_rate);
  const cvdPerp = toNumber(latest.cvd_perp_delta);
  const cvdSpot = toNumber(latest.cvd_spot_delta);
  const depthRatio = latest.ask_depth_10bps > 0 ? (latest.bid_depth_10bps / latest.ask_depth_10bps) : 1;
  const spread = toNumber(latest.spread);
  const dOI = prev ? toNumber(latest.oi) - toNumber(prev.oi) : 0;

  let action = "WAIT"; let confidence = 0.5;

  // Divergence filtr: gdy CVD spot i perp mają przeciwne znaki — ryzyko chop
  if (cvdPerp * cvdSpot < 0) {
    reasons.push("dywergencja CVD spot vs perp → ryzyko chop");
    action = "NO_TRADE"; confidence = 0.6;
  }

  // Long bias — napływ agresywnych kupujących, przewaga bidów w depth
  if (cvdPerp > 0 && cvdSpot > 0 && depthRatio > 1.3) {
    reasons.push(`napływ kupna (CVD>0) + bid/ask ${depthRatio.toFixed(2)}>1.3`);
    action = "LONG_BIAS"; confidence = Math.min(0.9, 0.6 + Math.log10(depthRatio));
  }

  // Short bias — przewaga agresywnej sprzedaży + podaż w księdze
  if (cvdPerp < 0 && cvdSpot < 0 && depthRatio < 0.77) {
    reasons.push(`napływ sprzedaży (CVD<0) + bid/ask ${depthRatio.toFixed(2)}<0.77`);
    action = "SHORT_BIAS"; confidence = Math.min(0.9, 0.6 + Math.log10(1/(depthRatio||1)));
  }

  // Squeeze sygnały (ostrożność):
  if (fr < -0.0005 && cvdPerp > 0 && dOI > 0) {
    reasons.push("ryzyko short squeeze: funding < 0, CVD>0, OI rośnie");
    if (action === "SHORT_BIAS") { action = "NO_TRADE"; }
  }
  if (fr > 0.0005 && cvdPerp < 0 && dOI > 0) {
    reasons.push("ryzyko long liquidation: funding > 0, CVD<0, OI rośnie");
    if (action === "LONG_BIAS") { action = "NO_TRADE"; }
  }

  // Spread sanity
  if (spread > 0 && spread / latest.mark_price > 0.0008) {
    reasons.push("szeroki spread → gorsze wejścia");
  }

  return { action, confidence: Number(confidence.toFixed(2)), reasons };
}

// ---- Persist ----
async function initSchema(env: Env) {
  // Execute schema statements separately to avoid D1 multi-statement parsing issues
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS metrics (
      ts INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      oi REAL,
      funding_rate REAL,
      mark_price REAL,
      cvd_perp_delta REAL,
      cvd_spot_delta REAL,
      bid_depth_10bps REAL,
      ask_depth_10bps REAL,
      spread REAL,
      PRIMARY KEY (ts, symbol)
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_metrics_symbol_ts ON metrics(symbol, ts)`)
  ]);
}

async function insertMetrics(env: Env, row: any) {
  const sql = `INSERT OR REPLACE INTO metrics
    (ts, symbol, oi, funding_rate, mark_price, cvd_perp_delta, cvd_spot_delta, bid_depth_10bps, ask_depth_10bps, spread)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  await env.DB.prepare(sql).bind(
    row.ts, row.symbol, row.oi, row.funding_rate, row.mark_price, row.cvd_perp_delta,
    row.cvd_spot_delta, row.bid_depth_10bps, row.ask_depth_10bps, row.spread
  ).run();
}

async function getLatest(env: Env, symbol: string) {
  const sql = `SELECT * FROM metrics WHERE symbol = ? ORDER BY ts DESC LIMIT 1`;
  const { results } = await env.DB.prepare(sql).bind(symbol).all();
  return (results && results[0]) || null;
}

async function getPrev(env: Env, symbol: string, ts: number) {
  const sql = `SELECT * FROM metrics WHERE symbol = ? AND ts < ? ORDER BY ts DESC LIMIT 1`;
  const { results } = await env.DB.prepare(sql).bind(symbol, ts).all();
  return (results && results[0]) || null;
}

async function getSeries(env: Env, symbol: string, limit = 120) {
  const sql = `SELECT * FROM metrics WHERE symbol = ? ORDER BY ts DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(symbol, limit).all();
  return results || [];
}

// ---- Scheduler ----
export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    await initSchema(env);
    const symbols = (env.SYMBOLS || "BTCUSDT").split(",").map(s => s.trim()).filter(Boolean);
    const limit = Number(env.DEPTH_LIMIT || 200);
    const bps = Number(env.DEPTH_BPS || 10);

    const end = floorMin(nowMs());
    const start = end - 60000; // ostatnia minuta

    for (const symbol of symbols) {
      try {
        // Równoległe pobrania
        const [oi, px, perpDelta, spotDelta, depth] = await Promise.all([
          fetchOI(symbol),
          fetchPremiumIndex(symbol),
          fetchAggTradesDelta(FAPI, "/fapi/v1/aggTrades", symbol, start, end),
          fetchAggTradesDelta(SPOT, "/api/v3/aggTrades", symbol, start, end),
          fetchDepth(symbol, limit, bps),
        ]);

        const row = {
          ts: end,
          symbol,
          oi: oi.oi,
          funding_rate: px.lastFundingRate,
          mark_price: px.markPrice,
          cvd_perp_delta: perpDelta,
          cvd_spot_delta: spotDelta,
          bid_depth_10bps: depth.bidDepth,
          ask_depth_10bps: depth.askDepth,
          spread: depth.spread,
        };

        await insertMetrics(env, row);
      } catch (err: any) {
        console.error("collect error", symbol, err?.message || err);
      }
    }
  },

  // ---- API & dashboard ----
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/api/latest") {
      const symbol = url.searchParams.get("symbol") || "BTCUSDT";
      const latest = await getLatest(env, symbol);
      return json(latest || { error: "no data" });
    }

    if (path === "/api/series") {
      const symbol = url.searchParams.get("symbol") || "BTCUSDT";
      const limit = Number(url.searchParams.get("limit") || 120);
      const rows = await getSeries(env, symbol, limit);
      return json({ rows: rows.reverse() });
    }

    if (path === "/api/recommendation") {
      const symbol = url.searchParams.get("symbol") || "BTCUSDT";
      const latest = await getLatest(env, symbol);
      if (!latest) return json({ action: "NO_DATA", reasons: ["brak danych"] });
      const prev = await getPrev(env, symbol, latest.ts);
      const rec = makeRecommendation(latest, prev);
      return json({ symbol, ts: latest.ts, mark_price: latest.mark_price, ...rec });
    }

    if (path === "/api/symbols") {
      const symbols = (env.SYMBOLS || "BTCUSDT").split(",").map(s => s.trim()).filter(Boolean);
      return json({ symbols });
    }

    // Prosty dashboard HTML
    if (path === "/") {
      return html(DASHBOARD_HTML);
    }

    return new Response("Not Found", { status: 404 });
  }
};

function json(data: any) { return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } }); }
function html(s: string) { return new Response(s, { headers: { "content-type": "text/html; charset=utf-8" } }); }

const DASHBOARD_HTML = `<!doctype html>
<html lang="pl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Crypto Recs (CF Worker)</title>
  <style>
    :root { font-family: ui-sans-serif, system-ui; }
    body { max-width: 1100px; margin: 2rem auto; padding: 0 1rem; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 1rem; margin: 1rem 0; }
    .row { display: flex; gap: 1rem; flex-wrap: wrap; }
    .row .card { flex: 1; min-width: 260px; }
    .badge { padding: .25rem .5rem; border-radius: 8px; font-weight: 600; }
    .LONG_BIAS { background: #e6ffed; color: #03660a; }
    .SHORT_BIAS { background: #ffecec; color: #8a0b0b; }
    .NO_TRADE { background: #f7f7f7; color: #555; }
    .WAIT { background: #eef3ff; color: #1b3a8a; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: right; padding: .25rem .5rem; border-bottom: 1px solid #eee; }
    th:first-child, td:first-child { text-align: left; }
  </style>
</head>
<body>
  <h1>Crypto Recs — Binance OI/CVD/Funding/Orderbook</h1>
  <p>Worker odświeża dane co minutę via CRON. Wybierz symbol, zobacz ostatnie metryki i rekomendację.</p>
  <div>
    Symbol: <select id="sym"></select>
    <button id="refresh">Odśwież</button>
  </div>

  <div id="rec" class="card"></div>

  <div class="row">
    <div class="card">
      <h3>Ostatnie metryki</h3>
      <table id="latest"></table>
    </div>
    <div class="card">
      <h3>Historia (ostatnie 60 min)</h3>
      <table id="series"></table>
    </div>
  </div>

  <script>
    const $ =(s)=>document.querySelector(s);
    const fmt =(x, d=4)=> (x==null?"":Number(x).toFixed(d));

    async function loadSymbols(){
      const r = await fetch('/api/symbols');
      const j = await r.json();
      const sel = $('#sym');
      sel.innerHTML = '';
      j.symbols.forEach(s=>{
        const o = document.createElement('option'); o.value=s; o.textContent=s; sel.appendChild(o);
      });
      sel.value = j.symbols[0] || 'BTCUSDT';
    }

    async function loadAll(){
      const symbol = $('#sym').value;
      const [rec, latest, series] = await Promise.all([
        fetch(\`/api/recommendation?symbol=\${symbol}\`).then(r=>r.json()),
        fetch(\`/api/latest?symbol=\${symbol}\`).then(r=>r.json()),
        fetch(\`/api/series?symbol=\${symbol}&limit=60\`).then(r=>r.json())
      ]);

      // Rec
      const badge = \`<span class="badge \${rec.action}">\${rec.action}</span>\`;
      $('#rec').innerHTML = \`<div><strong>\${symbol}</strong> @ \${fmt(rec.mark_price,2)} — \${badge} (conf \${fmt(rec.confidence,2)})<br><small>\${(rec.reasons||[]).join(' • ')}</small></div>\`;

      // Latest
      const L = latest||{};
      $('#latest').innerHTML = \`
        <tr><th>pole</th><th>wartość</th></tr>
        <tr><td>ts</td><td>\${new Date(L.ts||0).toLocaleTimeString()}</td></tr>
        <tr><td>mark_price</td><td>\${fmt(L.mark_price,2)}</td></tr>
        <tr><td>funding_rate</td><td>\${fmt(L.funding_rate,5)}</td></tr>
        <tr><td>oi</td><td>\${fmt(L.oi,0)}</td></tr>
        <tr><td>cvd_perp_delta</td><td>\${fmt(L.cvd_perp_delta,2)}</td></tr>
        <tr><td>cvd_spot_delta</td><td>\${fmt(L.cvd_spot_delta,2)}</td></tr>
        <tr><td>bid_depth_10bps</td><td>\${fmt(L.bid_depth_10bps,2)}</td></tr>
        <tr><td>ask_depth_10bps</td><td>\${fmt(L.ask_depth_10bps,2)}</td></tr>
        <tr><td>spread</td><td>\${fmt(L.spread,2)}</td></tr>
      \`;

      // Series
      const rows = (series.rows||[]).slice(-60);
      $('#series').innerHTML = '<tr><th>czas</th><th>mpx</th><th>fund</th><th>OI</th><th>CVDp</th><th>CVDs</th><th>bid10</th><th>ask10</th></tr>' +
        rows.map(r=>\`<tr><td>\${new Date(r.ts).toLocaleTimeString()}</td><td>\${fmt(r.mark_price,0)}</td><td>\${fmt(r.funding_rate,5)}</td><td>\${fmt(r.oi,0)}</td><td>\${fmt(r.cvd_perp_delta,1)}</td><td>\${fmt(r.cvd_spot_delta,1)}</td><td>\${fmt(r.bid_depth_10bps,0)}</td><td>\${fmt(r.ask_depth_10bps,0)}</td></tr>\`).join('');
    }

    $('#refresh').addEventListener('click', loadAll);
    (async()=>{ await loadSymbols(); await loadAll(); })();
  </script>
</body>
</html>`;
