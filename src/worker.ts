// Cloudflare Worker — agregator Binance + proste rekomendacje
// Minimalny, bez zewn. bibliotek. TS/ESM. D1 jako timeseria.
// Autor: (tu możesz wpisać siebie)


export interface Env {
DB: D1Database;
SYMBOLS: string; // Np. "BTCUSDT,ETHUSDT,SOLUSDT"
DEPTH_LIMIT?: string; // 100/200/500/1000 (uwaga na weight)
DEPTH_BPS?: string; // bps do liczenia depthu od mid (domyślnie 10)
}


const FAPI = "https://fapi.binance.com"; // USDⓈ-M Futures
const SPOT = "https://api.binance.com"; // Spot


// Utils
const nowMs = () => Date.now();
const floorMin = (ms: number) => Math.floor(ms / 60000) * 60000;
function toNumber(x: any, d = 0) { const n = Number(x); return Number.isFinite(n) ? n : d; }


// SQL (tworzenie tabeli jeśli brak)
const SQL_INIT = `
CREATE TABLE IF NOT EXISTS metrics (
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
);
CREATE INDEX IF NOT EXISTS idx_metrics_symbol_ts ON metrics(symbol, ts);
`;


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


// AggTrades (perp & spot) — liczenie 1‑min CVD z pola `m` (buyer is maker)
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
</html>`;
