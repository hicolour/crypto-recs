// src/worker.ts (serves full HTML + external /app.js and JSON APIs)
export interface Env {}

type JSONValue = any;

const ORIGIN_TIMEOUT = 8000; // ms
async function fetchWithTimeout(url: string, ms = ORIGIN_TIMEOUT, init: RequestInit = {}){
  const ctrl = new AbortController(); const id = setTimeout(()=>ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal, cf: { cacheTtl: 0 } }); }
  finally { clearTimeout(id); }
}

function json(data: JSONValue, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

async function safeFetch(url: string): Promise<any> {
  const r = await fetchWithTimeout(url, ORIGIN_TIMEOUT, { headers: { "accept": "application/json", "user-agent":"crypto-recs/1.0" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url} :: ${await r.text().catch(()=> '')}`);
  return r.json();
}

// ---------- Binance helpers (public mirrors) ----------
const BV = "https://data-api.binance.vision";
const BF = "https://fapi.binance.com";
const BS = "https://api.binance.com";

async function fetchKlines(symbol: string, interval: string, limit: number) {
  const paths = [
    `${BV}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    `${BF}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    `${BS}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
  ];
  for (const u of paths) {
    try { return await safeFetch(u); } catch (_) {}
  }
  throw new Error(`All klines endpoints failed for ${symbol}`);
}

async function fetchDepth(symbol: string, limit: number = 100) {
  const limits = [limit, 100, 50, 20, 10, 5];
  const urls = limits.map(l => `${BV}/fapi/v1/depth?symbol=${symbol}&limit=${l}`)
    .concat(limits.map(l => `${BF}/fapi/v1/depth?symbol=${symbol}&limit=${l}`));
  for (const u of urls) {
    try { return await safeFetch(u); } catch (_) {}
  }
  throw new Error(`All depth endpoints failed for ${symbol}`);
}

function toNum(x: any): number { const n = Number(x); return isFinite(n) ? n : NaN; }
function sum(arr: number[]) { return arr.reduce((a,b)=>a+b,0); }

// ---------- Timeframe helpers (resampling) ----------
const SUPPORTED_TF = new Set(["1m","3m","5m","15m","30m","1h","2h","4h","6h","8h","12h","1d"]);

function resampleCandles(candles:any[], group:number){
  if (!Array.isArray(candles) || candles.length===0 || group<=1) return candles;
  const out:any[] = [];
  let i=0;
  while (i < candles.length){
    const chunk = candles.slice(i, i+group);
    if (chunk.length < group) break;
    const t0 = chunk[0][0];
    const o = Number(chunk[0][1]);
    const h = Math.max(...chunk.map((x:any)=>Number(x[2])));
    const l = Math.min(...chunk.map((x:any)=>Number(x[3])));
    const c = Number(chunk[chunk.length-1][4]);
    const v = sum(chunk.map((x:any)=>Number(x[5])));
    out.push([t0, o, h, l, c, v]);
    i += group;
  }
  return out;
}

async function getCandles(symbol:string, interval:string, limit:number){
  if (SUPPORTED_TF.has(interval)) return await fetchKlines(symbol, interval, limit);
  if (interval === "10m"){
    const base = await fetchKlines(symbol, "1m", Math.max(200, limit*10));
    return resampleCandles(base, 10).slice(-limit);
  }
  if (interval === "45m"){
    const base = await fetchKlines(symbol, "15m", Math.max(200, Math.ceil(limit*3)));
    return resampleCandles(base, 3).slice(-limit);
  }
  if (interval === "16h"){
    const base = await fetchKlines(symbol, "1h", Math.max(200, limit*16));
    return resampleCandles(base, 16).slice(-limit);
  }
  const map:any = { "2m":"1m", "4m":"3m", "7m":"5m", "20m":"15m" };
  const tf = map[interval] || "1m";
  return await fetchKlines(symbol, tf, limit);
}

// ---------- Indicators ----------
function calcIndicators(kl: any[]) {
  const close = kl.map((k:any)=> toNum(k[4]));
  const high  = kl.map((k:any)=> toNum(k[2]));
  const low   = kl.map((k:any)=> toNum(k[3]));
  const vol   = kl.map((k:any)=> toNum(k[5]));
  const n = close.length;
  const last = close[n-1];

  function ema(vals: number[], len: number) {
    const k = 2/(len+1); let e = vals[0];
    const out = [e];
    for (let i=1;i<vals.length;i++){ e = vals[i]*k + e*(1-k); out.push(e); }
    return out;
  }
  function sma(vals: number[], len: number) {
    const out: number[] = [];
    let acc = 0;
    for (let i=0;i<vals.length;i++){
      acc += vals[i];
      if (i>=len) acc -= vals[i-len];
      out.push( i>=len-1 ? acc/len : NaN );
    }
    return out;
  }
  function rsi(vals:number[], len=14){
    if (vals.length < len+2) return NaN;
    let gains=0,losses=0;
    for(let i=1;i<=len;i++){ const ch=vals[i]-vals[i-1]; if (ch>0) gains+=ch; else losses-=ch; }
    let avgGain=gains/len, avgLoss=losses/len;
    let out:number[] = Array(len).fill(NaN);
    for(let i=len+1;i<vals.length;i++){
      const ch=vals[i]-vals[i-1];
      const g=ch>0?ch:0, l=ch<0?-ch:0;
      avgGain=(avgGain*(len-1)+g)/len;
      avgLoss=(avgLoss*(len-1)+l)/len;
      const rs = avgLoss===0? 100 : (avgGain/avgLoss);
      out.push(100 - 100/(1+rs));
    }
    return out[out.length-1];
  }
  function kdj(h:number[], l:number[], c:number[], len=9, smoothD=3){
    if (c.length < len+1) return {K:NaN,D:NaN,J:NaN};
    const kArr:number[] = [];
    for(let i=0;i<c.length;i++){
      const a = Math.max(0, i-len+1);
      const hh = Math.max(...h.slice(a,i+1));
      const ll = Math.min(...l.slice(a,i+1));
      const k = (hh===ll)?50: ((c[i]-ll)/(hh-ll))*100;
      kArr.push(k);
    }
    const dArr = sma(kArr, smoothD);
    const K = kArr[kArr.length-1];
    const D = dArr[dArr.length-1];
    const J = isFinite(K)&&isFinite(D)? 3*K-2*D : NaN;
    return {K,D,J};
  }
  function macd(c:number[], fast=12, slow=26, signal=9){
    if (c.length < slow+signal+2) return { macd:NaN, signal:NaN, hist:NaN };
    const e12 = ema(c, fast);
    const e26 = ema(c, slow);
    const m = c.map((_,i)=> e12[i]-e26[i]);
    const sig = ema(m, signal);
    const hist = m.map((v,i)=> v - sig[i]);
    return {macd: m[m.length-1], signal: sig[sig.length-1], hist: hist[hist.length-1]};
  }
  function vwap(h:number[], l:number[], c:number[], v:number[]){
    const tp = c.map((_,i)=> (h[i]+l[i]+c[i])/3);
    let pv=0, vv=0;
    for(let i=0;i<c.length;i++){ pv += tp[i]*v[i]; vv += v[i]; }
    return vv? pv/vv : NaN;
  }
  function bb(c:number[], len=20, mult=2){
    if (c.length < len) return { mid:NaN, upper:NaN, lower:NaN };
    const m = sma(c, len);
    const mu = m[m.length-1];
    const arr = c.slice(-len);
    const mean = arr.reduce((a,b)=>a+b,0)/arr.length;
    const variance = arr.reduce((a,b)=> a + (b-mean)*(b-mean), 0)/arr.length;
    const sd = Math.sqrt(variance);
    return { mid: mu, upper: mu + mult*sd, lower: mu - mult*sd };
  }
  function atr(h:number[], l:number[], c:number[], len=14){
    if (c.length < len+1) return NaN;
    const tr:number[] = [];
    for(let i=0;i<h.length;i++){
      if (i===0){ tr.push(h[i]-l[i]); continue; }
      const x = Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1]));
      tr.push(x);
    }
    const a = sma(tr, len);
    return a[a.length-1];
  }
  function adx(h:number[], l:number[], c:number[], len=14){
    if (c.length < len+2) return NaN;
    const dmP:number[] = [NaN], dmN:number[]=[NaN]; const tr:number[]=[NaN];
    for(let i=1;i<h.length;i++){
      const up = h[i]-h[i-1], dn = l[i-1]-l[i];
      dmP.push(up>dn && up>0 ? up : 0);
      dmN.push(dn>up && dn>0 ? dn : 0);
      const t = Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1]));
      tr.push(t);
    }
    const smTR = (function(vals:number[],len:number){ const out:number[]=[]; let acc=0; for(let i=0;i<vals.length;i++){ acc+=vals[i]||0; if(i>=len) acc-=vals[i-len]||0; out.push(i>=len-1?acc/len:NaN);} return out; })(tr, len);
    const smP  = (function(vals:number[],len:number){ const out:number[]=[]; let acc=0; for(let i=0;i<vals.length;i++){ acc+=vals[i]||0; if(i>=len) acc-=vals[i-len]||0; out.push(i>=len-1?acc/len:NaN);} return out; })(dmP, len);
    const smN  = (function(vals:number[],len:number){ const out:number[]=[]; let acc=0; for(let i=0;i<vals.length;i++){ acc+=vals[i]||0; if(i>=len) acc-=vals[i-len]||0; out.push(i>=len-1?acc/len:NaN);} return out; })(dmN, len);
    const diP = 100 * (smP[smP.length-1] / smTR[smTR.length-1]);
    const diN = 100 * (smN[smN.length-1] / smTR[smTR.length-1]);
    const dx = 100 * Math.abs(diP-diN) / (diP+diN);
    return dx;
  }
  function stochRSI(c:number[], len=14){
    if (c.length < len+2) return NaN;
    const rs:number[] = [];
    for(let i=0;i<c.length;i++){
      const a = Math.max(0, i-len+1);
      const w = c.slice(a, i+1);
      const r = rsi(w, Math.min(len, w.length-1));
      rs.push(r);
    }
    const tail = rs.slice(-len).filter(x=>isFinite(x));
    if (!tail.length) return NaN;
    const min = Math.min(...tail), max = Math.max(...tail);
    const lastR = tail[tail.length-1];
    return (max===min)? 0.5 : (lastR - min) / (max - min);
  }

  const ind_rsi = rsi(close, 14);
  const kdjr = kdj(high, low, close, 9, 3);
  const K = kdjr.K, D = kdjr.D, J = kdjr.J;
  const mac = macd(close,12,26,9);
  const m = mac.macd, s = mac.signal, hst = mac.hist;
  const v = vwap(high, low, close, vol);
  const bbv = bb(close, 20, 2);
  const mid = bbv.mid, upper = bbv.upper, lower = bbv.lower;
  const a14 = atr(high, low, close, 14);
  const adx14 = adx(high, low, close, 14);
  const sRSI = stochRSI(close, 14);

  return {
    source: "klines",
    price: last, rsi: ind_rsi, k: K, d: D, j: J,
    macd: m, signal: s, hist: hst,
    vwap: v, bb_mid: mid, bb_upper: upper, bb_lower: lower,
    atr14: a14, adx14: adx14, stochRSI: sRSI,
  };
}

// ---------- Orderbook Imbalance ----------
function computeOB(depth: any, bpsList=[5,10,20]){
  const bids: [number, number][] = (depth.bids||[]).map((r:any)=> [toNum(r[0]), toNum(r[1])]);
  const asks: [number, number][] = (depth.asks||[]).map((r:any)=> [toNum(r[0]), toNum(r[1])]);
  bids.sort((a,b)=> b[0]-a[0]);
  asks.sort((a,b)=> a[0]-b[0]);
  const bestBid = bids.length ? bids[0][0] : NaN;
  const bestAsk = asks.length ? asks[0][0] : NaN;
  const midp = (bestBid + bestAsk)/2;
  const spread = bestAsk - bestBid;
  const res:any = { mid: midp, spread };

  for(const bps of bpsList){
    const width = (bps/10000)*midp;
    let bd=0, ad=0;
    for(const [p,q] of bids){ if (p >= midp-width) bd+=q; else break; }
    for(const [p,q] of asks){ if (p <= midp+width) ad+=q; else break; }
    const key = `r${bps}`;
    res[key] = bd && ad ? (bd/ad) : NaN;
  }
  return res;
}

// ---------- DIY Liq (placeholder) ----------
function liqStub(symbol: string){
  return { symbol, above: [], below: [], source: "est" };
}

// ---------- Recommendation ----------
function buildRecommendation(symbol: string, ind:any, ob:any, liq:any){
  const px = Number(ind.price);
  const belowVWAP = isFinite(ind.vwap) && isFinite(px) && px <= ind.vwap;
  const nearLowerBB = isFinite(ind.bb_lower) && isFinite(px) && px <= ind.bb_lower*1.01;
  const nearMidBB   = isFinite(ind.bb_mid)   && isFinite(px) && Math.abs(px - ind.bb_mid) / ind.bb_mid <= 0.005;
  const nearUpperBB = isFinite(ind.bb_upper) && isFinite(px) && px >= ind.bb_upper*0.995;
  const rsiBull   = isFinite(ind.rsi) && ind.rsi < 35;
  const stochBull = isFinite(ind.stochRSI) && ind.stochRSI < 0.2;
  const kdjBull   = isFinite(ind.k) && isFinite(ind.d) && ind.k > ind.d;
  const obBull    = isFinite(ob.r10) && ob.r10 > 1.1;
  const obFlip    = isFinite(ob.r10) && ob.r10 < 0.9;
  const adxv = Number(ind.adx14);
  const macd_hist = Number(ind.hist);
  const macdBull = isFinite(macd_hist) ? (macd_hist > 0 ? 1 : (macd_hist > -0.002 ? 0.5 : 0)) : 0.5;
  const macdBear = isFinite(macd_hist) ? (macd_hist < 0 ? 1 : (macd_hist < 0.002 ? 0.5 : 0)) : 0.5;
  const adxEntry = isFinite(adxv) ? Math.max(0, Math.min(1, 1 - adxv/40)) : 0.5;
  const adxExit  = isFinite(adxv) ? Math.max(0, Math.min(1,  adxv/40)) : 0.5;

  const wEntry = { vwapbb:0.30, osc:0.25, ob:0.20, macd:0.15, adx:0.10 };
  const f_vwapbb_entry = (belowVWAP?0.6:0) + (nearLowerBB?0.4:0);
  const f_osc_entry = ((rsiBull?1:0) + (stochBull?1:0) + (kdjBull?1:0)) / 3;
  const f_ob_entry = isFinite(ob.r10)? Math.max(0, Math.min(1, (ob.r10-1)/0.2)) : 0.5;
  const f_macd_entry = macdBull;
  const f_adx_entry = adxEntry;

  const entry_score = (
    wEntry.vwapbb * f_vwapbb_entry +
    wEntry.osc    * f_osc_entry +
    wEntry.ob     * f_ob_entry +
    wEntry.macd   * f_macd_entry +
    wEntry.adx    * f_adx_entry
  );
  const entry_label = entry_score >= 0.75 ? 'GOOD' : (entry_score >= 0.6 ? 'OK' : 'POOR');

  const entry_breakdown = [
    { key:'VWAP/BB', weight:wEntry.vwapbb, factor:f_vwapbb_entry, reason:(belowVWAP?'≤VWAP':'≥VWAP') + (nearLowerBB?' + ~BB lower':'') },
    { key:'Oscylatory', weight:wEntry.osc, factor:f_osc_entry, reason:(rsiBull?'RSI<35 ':'')+(stochBull?'StochRSI<0.2 ':'')+(kdjBull?'K>D ':'') },
    { key:'Orderbook', weight:wEntry.ob, factor:f_ob_entry, reason:(isFinite(ob.r10)?'r10='+ob.r10.toFixed(2):'r10 —') },
    { key:'MACD', weight:wEntry.macd, factor:f_macd_entry, reason:(isFinite(macd_hist)?('hist='+macd_hist.toFixed(3)):'hist —') },
    { key:'ADX', weight:wEntry.adx, factor:f_adx_entry, reason:(isFinite(adxv)?('ADX='+adxv.toFixed(1)):'ADX —') },
  ];

  const wTP = { liq:0.35, vwapbb:0.25, osc:0.15, macd:0.15, obflip:0.10 };
  const liqNear = (liq && liq.above && liq.above.length && isFinite(px)) ? (Math.abs(liq.above[0].price - px)/px <= 0.005) : false;
  const f_liq = liqNear ? 1 : (liq && liq.above && liq.above.length ? 0.6 : 0.0);
  const f_vwapbb_tp = (nearMidBB?0.5:0) + (nearUpperBB?0.5:0);
  const overbought = (isFinite(ind.rsi) && ind.rsi>65) || (isFinite(ind.j) && ind.j>100);
  const f_osc_tp = overbought ? 1.0 : 0.0;
  const f_macd_tp = macdBear;
  const f_obflip = obFlip ? 1.0 : 0.0;

  const tp_score = (
    wTP.liq    * f_liq +
    wTP.vwapbb * f_vwapbb_tp +
    wTP.osc    * f_osc_tp +
    wTP.macd   * f_macd_tp +
    wTP.obflip * f_obflip
  );
  const tp_label = tp_score >= 0.75 ? 'TP NOW' : (tp_score >= 0.55 ? 'PARTIAL TP' : 'NOT YET');

  const tp_breakdown = [
    { key:'Liq (targets)', weight:wTP.liq, factor:f_liq, reason: (liqNear?'near target':'') + ((liq&&liq.above&&liq.above[0])?(' ' + liq.above[0].price):'') },
    { key:'VWAP/BB', weight:wTP.vwapbb, factor:f_vwapbb_tp, reason:(nearMidBB?'~BB mid ':'')+(nearUpperBB?'~BB upper':'') },
    { key:'Oscylatory', weight:wTP.osc, factor:f_osc_tp, reason:(isFinite(ind.rsi)?('RSI '+ind.rsi.toFixed(1)):'') + (isFinite(ind.j)?(' J '+ind.j.toFixed(0)):'') },
    { key:'MACD', weight:wTP.macd, factor:f_macd_tp, reason:(isFinite(macd_hist)?('hist '+macd_hist.toFixed(3)):'') },
    { key:'Orderbook flip', weight:wTP.obflip, factor:f_obflip, reason:(isFinite(ob.r10)?('r10 '+ob.r10.toFixed(2)):'') },
  ];

  let score = Math.max(0.05, Math.min(0.98, entry_score));
  let action: 'LONG' | 'EXIT_LONG' | 'HOLD' = 'HOLD';
  if (score >= 0.60) action = 'LONG';

  let tp_price: number | null = null;
  let tp_note = '—';
  if (liq && liq.above && liq.above.length) { tp_price = liq.above[0].price; tp_note = 'Nearest liq above'; }
  else if (isFinite(ind.bb_mid)) { tp_price = ind.bb_mid; tp_note = 'BB mid'; }
  else if (isFinite(ind.bb_upper)) { tp_price = ind.bb_upper; tp_note = 'BB upper'; }

  const panels = {
    osc: (rsiBull || (isFinite(ind.hist)&&ind.hist>0)) ? 'bull' : ((isFinite(ind.rsi)&&ind.rsi>70 || (isFinite(ind.hist)&&ind.hist<0)) ? 'bear' : 'neutral'),
    pro: belowVWAP ? (nearLowerBB ? 'bull-strong' : 'bull') : 'neutral',
    ob: isFinite(ob.r10) ? (ob.r10>1.1 ? 'bull' : (ob.r10<0.9 ? 'bear' : 'neutral')) : 'neutral',
    ema: 'neutral',
    mmd: 'neutral',
    liq: (liq && liq.above && liq.above.length) ? 'ok' : 'weak'
  };

  const reasons:string[] = [];
  reasons.push(belowVWAP? "price ≤ VWAP (buy low)":"price ≥ VWAP (risk chase)");
  if (nearLowerBB) reasons.push("near lower BB");
  if (isFinite(ob.r10)) reasons.push(`OB 10bps ${Number(ob.r10).toFixed(2)}`);
  if (isFinite(ind.rsi)) reasons.push(`RSI ${Number(ind.rsi).toFixed(1)}`);
  if (isFinite(ind.adx14)) reasons.push(`ADX ${Number(ind.adx14).toFixed(1)}`);

  return {
    symbol,
    mark_price: px,
    action,
    confidence: score,
    entry: entry_label,
    entry_score,
    entry_breakdown,
    tp_label,
    tp_score,
    tp_breakdown,
    take_profit_price: tp_price,
    take_profit_note: tp_note,
    chop_risk: (isFinite(adxv) ? (adxv<15?'HIGH':(adxv>25?'LOW':'MED')) : 'MED'),
    panels,
    reasons
  };
}

// ---------- EMA-Margin (GPT LL v2) ----------
async function computeEmaMarginMatrix(symbol:string){
  const tfs = ["3m","5m","10m","15m","45m","1h","2h","4h","8h","12h","16h","1d"];
  const rows:any[] = [];
  for (const tf of tfs){
    try{
      const kl = await getCandles(symbol, tf, 200);
      const close = kl.map((k:any)=> Number(k[4]));
      const high  = kl.map((k:any)=> Number(k[2]));
      const low   = kl.map((k:any)=> Number(k[3]));
      const ema = (vals:number[], len:number)=>{ const k=2/(len+1); let e=vals[0]; const out=[e]; for(let i=1;i<vals.length;i++){ e=vals[i]*k+e*(1-k); out.push(e);} return out; };
      const e30 = ema(close,30), e60 = ema(close,60);
      const emaFast = e30[e30.length-1], emaSlow = e60[e60.length-1];
      const tr:number[] = []; for(let i=0;i<high.length;i++){ if(i===0){ tr.push(high[i]-low[i]); } else { tr.push(Math.max(high[i]-low[i], Math.abs(high[i]-close[i-1]), Math.abs(low[i]-close[i-1]))); } }
      const sma = (vals:number[], len:number)=>{ const out:number[]=[]; let acc=0; for(let i=0;i<vals.length;i++){ acc+=vals[i]; if(i>=len) acc-=vals[i-len]; out.push(i>=len-1?acc/len:NaN);} return out; };
      const atr60 = sma(tr,60)[tr.length-1];
      const thresh = 0.30 * atr60;
      const diff = emaFast - emaSlow;
      const state = (!isFinite(diff)||!isFinite(thresh)) ? "NEUTRAL" : (diff > thresh ? "BULL" : (diff < -thresh ? "BEAR" : "NEUTRAL"));
      rows.push({ tf, state, emaFast, emaSlow, atr60, thresh, diff });
    }catch(_){
      rows.push({ tf, state: "N/A" });
    }
  }
  return { rows };
}

// ---------- Massive Moves Detector ----------
async function computeMmdMatrix(symbol:string){
  const tfs = ["3m","5m","10m","15m","45m","1h","2h","4h","8h","12h","16h","1d"];
  const rows:any[] = [];
  for (const tf of tfs){
    try{
      const kl = await getCandles(symbol, tf, 200);
      const close = kl.map((k:any)=> Number(k[4]));
      const high  = kl.map((k:any)=> Number(k[2]));
      const low   = kl.map((k:any)=> Number(k[3]));
      const vol   = kl.map((k:any)=> Number(k[5]));
      const n = close.length;
      const tr:number[] = []; for(let i=0;i<n;i++){ if(i===0){tr.push(high[i]-low[i]);} else { tr.push(Math.max(high[i]-low[i], Math.abs(high[i]-close[i-1]), Math.abs(low[i]-close[i-1])));}}
      const sma = (vals:number[], len:number)=>{ const out:number[]=[]; let acc=0; for(let i=0;i<vals.length;i++){ acc+=vals[i]; if(i>=len) acc-=vals[i-len]; out.push(i>=len-1?acc/len:NaN);} return out; };
      const atr14 = sma(tr,14)[n-1];
      const natr = atr14 / close[n-1] * 100;
      const lookback = 20;
      const donHigh = Math.max(...high.slice(n-lookback-1, n-1));
      const donLow  = Math.min(...low.slice(n-lookback-1, n-1));
      const vMA = sma(vol, 20)[n-1];
      const volOk = vol[n-1] > vMA * 1.2;
      const natrThresh = 1.0;
      const breakoutUp = close[n-1] > donHigh && natr >= natrThresh && volOk;
      const breakoutDn = close[n-1] < donLow  && natr >= natrThresh && volOk;
      let lastSignal = "-";
      if (breakoutUp) lastSignal = "UP";
      else if (breakoutDn) lastSignal = "DOWN";
      rows.push({ tf, mode: "Breakout+ATR", lastSignal, natr, volOk });
    }catch(_){
      rows.push({ tf, mode: "Breakout+ATR", lastSignal: "N/A" });
    }
  }
  return { rows };
}

// ---------- Static HTML/JS ----------
const DASHBOARD_HTML = `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Crypto Dashboard</title>
<style>
  @font-face { font-family:'BinancePlex'; src: local('BinancePlex'), local('BinancePlex-Regular'); font-weight:400; font-style:normal; font-display:swap; }
  @font-face { font-family:'BinancePlex'; src: local('BinancePlex-Medium');  font-weight:500; font-style:normal; font-display:swap; }
  @font-face { font-family:'BinancePlex'; src: local('BinancePlex-SemiBold'); font-weight:600; font-style:normal; font-display:swap; }
  :root{--bg:#0b0e11;--fg:#EAECEF;--card:#181A20;--muted:#B7BDC6;--border:#2B3139;--green:#0ECB81;--red:#F6465D;--yellow:#F0B90B}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font-family:'BinancePlex',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'Noto Sans','PingFang SC','Hiragino Sans GB','Microsoft YaHei','WenQuanYi Micro Hei',sans-serif;font-variant-numeric:tabular-nums}
  .container{margin:0 auto;padding:16px}
  .toolbar{display:grid;grid-template-columns:repeat(6,auto);gap:12px;align-items:center;margin-bottom:12px}
  input,select,button{background:#0e1116;border:1px solid var(--border);color:var(--fg);border-radius:8px;padding:8px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:14px;margin:10px 0;padding:12px}
  .card h3{margin:0 0 8px 0;padding:0;font-weight:600;display:flex;align-items:center;justify-content:space-between}
  .row{display:grid;grid-template-columns:1fr;gap:12px}
  @media(min-width:1100px){ .row{grid-template-columns:1fr 1fr} }
  .row.duo{display:grid;grid-template-columns:1fr;gap:12px}
  @media(min-width:800px){ .row.duo{grid-template-columns:1fr 1fr} }
  .stat-dot{display:inline-block;width:10px;height:10px;border-radius:50%;vertical-align:middle;margin-left:6px}
  .stat-ok{background:var(--green)}.stat-bad{background:var(--red)}.stat-stale{background:var(--yellow)}
  .badge{padding:2px 8px;border-radius:12px;border:1px solid var(--border);font-weight:600}
  .badge.LONG{background:var(--green);color:#0b0e11}.badge.EXIT_LONG{background:var(--red);color:#ffffff}.badge.HOLD{background:#2B3139}
  .chip{display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid var(--border);margin:2px 4px 0 0}
  .good{background:var(--green);color:#0b0e11}.bad{background:var(--red);color:#ffffff}.ok{background:#2B3139}
  .muted{color:var(--muted)}
  .toggle{font-size:12px;line-height:1;background:transparent;border:1px solid var(--border);border-radius:8px;padding:2px 8px;color:#cfcfcf}
  .card.collapsed > div { display:none }
  /* Tooltips */
  .t, .info{position:relative; cursor:help; border-bottom:1px dotted #4a5568}
  .t::after, .info::after{
    content: attr(data-tip);
    position:absolute; left:0; bottom:120%;
    background:#111418; color:#EAECEF; border:1px solid #2B3139; padding:8px 10px; border-radius:8px; white-space:pre-wrap; min-width:220px; max-width:420px; font-size:12px; line-height:1.35; opacity:0; pointer-events:none; transform:translateY(5px);
    transition: opacity .12s ease, transform .12s ease;
    z-index:9999;
  }
  .t:hover::after, .info:hover::after{ opacity:1; transform:translateY(0) }
  .info{display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; border-radius:50%; background:#2B3139; color:#EAECEF; margin-left:8px}
  .hdr-left{display:flex; align-items:center}
</style>
</head>
<body>
<div class="container">

  <div class="toolbar">
    <label><span class="t" data-tip="Symbol / Pair">Symbol</span><br>
      <select id="symbol">
        <option>BTCUSDT</option>
        <option>ETHUSDT</option>
        <option>SOLUSDT</option>
      </select>
    </label>
    <label><span class="t" data-tip="Candle interval / interwał świec">TF</span><br>
      <select id="interval">
        <option>1m</option><option>3m</option><option>5m</option><option>10m</option><option>15m</option><option>45m</option>
        <option>1h</option><option>2h</option><option>4h</option><option>8h</option><option>12h</option><option>1d</option>
      </select>
    </label>
    <label><span class="t" data-tip="Language / Język interfejsu">Lang</span><br>
      <select id="lang"><option value="pl">PL</option><option value="en">EN</option></select>
    </label>
    <label><span class="t" data-tip="Time zone for timestamps">Time</span><br>
      <select id="tz"><option value="local">Local</option><option value="utc">UTC</option></select>
    </label>
    <label><span class="t" data-tip="Display time format">Format</span><br>
      <select id="tformat"><option value="abs">Absolute</option><option value="rel">Relative</option></select>
    </label>
    <div>
      <button id="refresh">⟳</button><br>
      <label class="muted">Auto:
        <select id="autoref">
          <option value="1000">1s</option>
          <option value="5000">5s</option>
          <option value="15000">15s</option>
          <option value="30000">30s</option>
          <option value="45000">45s</option>
          <option value="0">Off</option>
        </select>
      </label><br>
      <small id="last_upd" class="muted">—</small>
    </div>
  </div>

  <div class="row duo">
    <div id="entry_panel" class="card collapsible">
      <h3><span class="hdr-left"><span data-i="entry_title">Entry Score — Wejście LONG</span><span class="info" data-tip="Aggregates: VWAP/Bollinger (mean-reversion), Oscillators (RSI/KDJ/StochRSI), Orderbook 10bps (r10), MACD and ADX. Focused on buy-low setups."></span></span>
        <span><span id="stat_entry" class="stat-dot stat-stale"></span> <button class="toggle" data-for="entry_panel" aria-label="toggle">−</button></span>
      </h3>
      <div id="entry_body" class="muted">N/A</div>
    </div>

    <div id="exit_panel" class="card collapsible">
      <h3><span class="hdr-left"><span data-i="exit_title">TP/Exit Score — Realizacja zysków</span><span class="info" data-tip="Weights: Liquidity targets (above), VWAP/BB mid & upper, Overbought (RSI>65, J>100), MACD fading, Orderbook flip (r10<0.9)."></span></span>
        <span><span id="stat_exit" class="stat-dot stat-stale"></span> <button class="toggle" data-for="exit_panel" aria-label="toggle">−</button></span>
      </h3>
      <div id="exit_body" class="muted">N/A</div>
    </div>
  </div>

  <div id="rec" class="card collapsible">
    <h3><span class="hdr-left"><span data-i="rec_title">Sygnał / Rekomendacja</span><span class="info" data-tip="Final aggregation into LONG / HOLD / EXIT_LONG with confidence. Built from the panels below."></span></span>
      <span><span id="stat_rec" class="stat-dot stat-stale"></span> <button class="toggle" data-for="rec" aria-label="toggle">−</button></span>
    </h3>
    <div id="rec_body" class="muted">N/A</div>
  </div>

  <div id="osc" class="card collapsible">
    <h3><span class="hdr-left"><span data-i="osc_title">Oscylatory: <span class="t" data-tip="RSI — Relative Strength Index. Wyprzedanie <30, wykupienie >70. Dobre do wychwytywania odbić.">RSI</span> / <span class="t" data-tip="KDJ — Stochastic z linią J. Przecięcia K/D i skrajności J (>100 lub <0).">KDJ</span> / <span class="t" data-tip="MACD — momentum trendu (EMA12-EMA26) i jego zmiana (histogram).">MACD</span></span><span class="info" data-tip="Momentum & exhaustion: RSI/KDJ/StochRSI + MACD momentum. Helps confirm longs near lower bands/VWAP and warn near overbought."></span></span>
      <span><span id="stat_osc" class="stat-dot stat-stale"></span> <button class="toggle" data-for="osc" aria-label="toggle">−</button></span>
    </h3>
    <div id="osc_body" class="muted">N/A</div>
  </div>

  <div class="row">
    <div id="ob_card" class="card collapsible">
      <h3><span class="hdr-left"><span data-i="ob_title">Orderbook Imbalance (5/10/20 bps)</span><span class="info" data-tip="rX = bid volume / ask volume within ±X bps from mid. >1 bullish pressure, <1 bearish."></span></span>
        <span><span id="stat_ob" class="stat-dot stat-stale"></span> <button class="toggle" data-for="ob_card" aria-label="toggle">−</button></span>
      </h3>
      <div id="ob_multi" class="muted">N/A</div>
    </div>
    <div id="pro_card" class="card collapsible">
      <h3><span class="hdr-left"><span data-i="pro_title">PRO: VWAP / Bollinger / ATR / ADX / StochRSI / Basis</span><span class="info" data-tip="Context panel: mean (VWAP), dispersion (BB/ATR), trend strength (ADX), cyclical stretch (StochRSI), and basis (soon)."></span></span>
        <span><span id="stat_pro" class="stat-dot stat-stale"></span> <button class="toggle" data-for="pro_card" aria-label="toggle">−</button></span>
      </h3>
      <div id="pro_panel" class="muted">N/A</div>
    </div>
  </div>

  <div id="ema_card" class="card collapsible">
    <h3><span class="hdr-left"><span data-i="ema_title">EMA-Margin (GPT LL v2)</span><span class="info" data-tip="EMA(30) vs EMA(60) relative to ATR(60). BULL when diff > 0.30*ATR, BEAR when < -0.30*ATR."></span></span>
      <span><span id="stat_ema" class="stat-dot stat-stale"></span> <button class="toggle" data-for="ema_card" aria-label="toggle">−</button></span>
    </h3>
    <div id="ema_body" class="muted">Wkrótce</div>
  </div>

  <div id="mmd" class="card collapsible">
    <h3><span class="hdr-left"><span data-i="mmd_title">Massive Moves Detector</span><span class="info" data-tip="Breakout over Donchian levels confirmed by NATR and volume. Flags UP/DOWN impulses."></span></span>
      <span><span id="stat_mmd" class="stat-dot stat-stale"></span> <button class="toggle" data-for="mmd" aria-label="toggle">−</button></span>
    </h3>
    <div id="mmd_body" class="muted">Wkrótce</div>
  </div>

  <div id="liq_card" class="card collapsible">
    <h3><span class="hdr-left"><span data-i="liq_title">Liq (DIY est. levels)</span><span class="info" data-tip="Estimated liquidation/liquidity clusters (experimental). Used mainly as TP targets."></span></span>
      <span><span id="stat_liq" class="stat-dot stat-stale"></span> <button class="toggle" data-for="liq_card" aria-label="toggle">−</button></span>
    </h3>
    <div id="liq_body" class="muted">N/A</div>
  </div>

  <div class="row">
    <div id="latest_card" class="card collapsible">
      <h3><span class="hdr-left"><span data-i="latest_title">Ostatnie metryki</span><span class="info" data-tip="Current snapshot of key values."></span></span>
        <span><span id="stat_latest" class="stat-dot stat-stale"></span> <button class="toggle" data-for="latest_card" aria-label="toggle">−</button></span>
      </h3>
      <div id="latest_body" class="muted">N/A</div>
    </div>
    <div id="series_card" class="card collapsible">
      <h3><span class="hdr-left"><span data-i="series_title">Historia</span><span class="info" data-tip="Basic rolling history (UI stub)."></span></span>
        <span><span id="stat_series" class="stat-dot stat-stale"></span> <button class="toggle" data-for="series_card" aria-label="toggle">−</button></span>
      </h3>
      <div id="series_body" class="muted">N/A</div>
    </div>
  </div>

</div>
<script src="/app.js"></script>
</body>
</html>
`;
const APP_JS = `// /app.js (served by worker)
(function(){
  var $ = function(q){ return document.querySelector(q); };
  var fmt = function(x, d){ if(!isFinite(x)) return '—'; return Number(x).toFixed(d||2); };
  function setDot(id, cls, title){ var el = document.getElementById(id); if(el){ el.className = 'stat-dot '+cls; if(title) el.title=title; } }

  var i18n = {
    pl: {
      entry_title: "Entry Score — Wejście LONG",
      exit_title:  "TP/Exit Score — Realizacja zysków",
      rec_title:   "Sygnał / Rekomendacja",
      osc_title:   "Oscylatory: RSI / KDJ / MACD",
      ob_title:    "Orderbook Imbalance (5/10/20 bps)",
      pro_title:   "PRO: VWAP / Bollinger / ATR / ADX / StochRSI / Basis",
      ema_title:   "EMA-Margin (GPT LL v2)",
      mmd_title:   "Massive Moves Detector",
      liq_title:   "Liq (DIY est. levels)",
      latest_title:"Ostatnie metryki",
      series_title:"Historia",
      last_update:"Ostatnia aktualizacja"
    },
    en: {
      entry_title: "Entry Score — LONG entry",
      exit_title:  "TP/Exit Score — Take profits",
      rec_title:   "Signal / Recommendation",
      osc_title:   "Oscillators: RSI / KDJ / MACD",
      ob_title:    "Orderbook Imbalance (5/10/20 bps)",
      pro_title:   "PRO: VWAP / Bollinger / ATR / ADX / StochRSI / Basis",
      ema_title:   "EMA-Margin (GPT LL v2)",
      mmd_title:   "Massive Moves Detector",
      liq_title:   "Liq (DIY est. levels)",
      latest_title:"Latest metrics",
      series_title:"History",
      last_update:"Last update"
    }
  };
  function applyLang(lang){
    var dict = i18n[lang] || i18n.pl;
    document.querySelectorAll('[data-i]').forEach(function(el){ var k = el.getAttribute('data-i'); if (k && dict[k]) el.textContent = dict[k]; });
  }

  function initCollapse(){
    var cards = document.querySelectorAll('.card.collapsible');
    cards.forEach(function(card){
      var id = card.getAttribute('id') || '';
      var key = 'collapse:'+id;
      var h3 = card.querySelector('h3');
      var btn = card.querySelector('button.toggle');
      var collapsed = localStorage.getItem(key) === '1';
      if (collapsed) card.classList.add('collapsed');
      if (btn) btn.textContent = collapsed ? '+' : '−';
      function toggle(){
        card.classList.toggle('collapsed');
        var isCollapsed = card.classList.contains('collapsed');
        if (btn) btn.textContent = isCollapsed ? '+' : '−';
        if (id) try { localStorage.setItem(key, isCollapsed ? '1' : '0'); } catch(e){}
      }
      if (h3) h3.addEventListener('click', function(ev){
        if (ev.target && ev.target.closest && ev.target.closest('button.toggle')) return;
        toggle();
      });
      if (btn) btn.addEventListener('click', function(ev){ ev.stopPropagation(); toggle(); });
    });
  }

  function tsLabel(ms, mode, tz){
    var d = new Date(ms);
    if (mode==='rel'){
      var diff = Date.now() - ms;
      var s = Math.max(0, Math.round(diff/1000));
      if (s < 60) return s + 's ago';
      var m = Math.round(s/60); if (m<60) return m+'m ago';
      var h = Math.round(m/60); return h+'h ago';
    } else {
      if (tz==='utc') return d.toISOString().replace('T',' ').replace('Z',' UTC');
      var pad = function(n){ return (n<10?'0':'')+n; };
      return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());
    }
  }

  async function loadAll(){
    var sel = document.getElementById('symbol');
    var symbol = (sel && sel.value) ? sel.value : 'BTCUSDT';
    var tfSel = document.getElementById('interval');
    var interval = (tfSel && tfSel.value) ? tfSel.value : '1m';
    var langSel = document.getElementById('lang');
    var lastLang = localStorage.getItem('lang') || 'pl';
    if (langSel && !langSel.value) langSel.value = lastLang;
    var lang = (langSel && langSel.value) ? langSel.value : lastLang;
    applyLang(lang);
    try { localStorage.setItem('lang', lang); } catch(e){}

    var tzSel = document.getElementById('tz'); var tz = tzSel ? tzSel.value : 'local';
    var tfmtSel = document.getElementById('tformat'); var tmode = tfmtSel ? tfmtSel.value : 'abs';

    try{
      var results = await Promise.all([
        fetch('/api/indicators?symbol='+symbol+'&interval='+interval+'&limit=200').then(function(r){return r.json()}),
        fetch('/api/depth-multi?symbol='+symbol).then(function(r){return r.json()}),
        fetch('/api/liq-levels?symbol='+symbol).then(function(r){return r.json()}),
        fetch('/api/recommendation?symbol='+symbol+'&interval='+interval).then(function(r){return r.json()}),
        fetch('/api/ema-margin-matrix?symbol='+symbol).then(function(r){return r.json()}),
        fetch('/api/mmd-matrix?symbol='+symbol).then(function(r){return r.json()})
      ]);
      var ind = results[0], depth = results[1], liq = results[2], rec = results[3], emaMx = results[4], mmdMx = results[5];

      var lu = document.getElementById('last_upd'); if (lu){ var dict = i18n[lang]||i18n.pl; lu.textContent = (dict.last_update||'Last update')+': '+tsLabel(Date.now(), tmode, tz); }

      (function(){
        function row(k, w, f, reason){
          var cls = (f >= 0.67 ? 'good' : (f >= 0.33 ? 'ok' : 'bad'));
          return '<tr><td>'+k+'</td><td>'+Math.round(w*100)+'%</td><td><span class="chip '+cls+'">'+(Math.round(f*100))+'%</span></td><td class="muted">'+(reason||'')+'</td></tr>';
        }
        var eb = (rec && rec.entry_breakdown) ? rec.entry_breakdown : [];
        var ehtml = '<div><strong>'+rec.symbol+'</strong> @ '+fmt(rec.mark_price,2)+' — <span class="badge '+(rec.entry==='GOOD'?'LONG':'HOLD')+'">'+rec.entry+'</span> (score '+Math.round(rec.entry_score*100)+'%)</div>';
        ehtml += '<table><tr><th>Block</th><th>Weight</th><th>Score</th><th>Reason</th></tr>';
        eb.forEach(function(x){ ehtml += row(x.key, x.weight, x.factor, x.reason); });
        ehtml += '</table>';
        var el1 = document.getElementById('entry_body'); if (el1) el1.innerHTML = ehtml;
        setDot('stat_entry','stat-ok','OK');

        var tb = (rec && rec.tp_breakdown) ? rec.tp_breakdown : [];
        var lbadge = (rec.tp_label==='TP NOW'?'EXIT_LONG':(rec.tp_label==='PARTIAL TP'?'EXIT_LONG':'HOLD'));
        var xhtml = '<div><strong>'+rec.symbol+'</strong> @ '+fmt(rec.mark_price,2)+' — <span class="badge '+lbadge+'">'+rec.tp_label+'</span> (score '+Math.round(rec.tp_score*100)+'%)</div>';
        xhtml += '<table><tr><th>Block</th><th>Weight</th><th>Score</th><th>Reason</th></tr>';
        tb.forEach(function(x){ xhtml += row(x.key, x.weight, x.factor, x.reason); });
        xhtml += '</table>';
        var el2 = document.getElementById('exit_body'); if (el2) el2.innerHTML = xhtml;
        setDot('stat_exit','stat-ok','OK');
      })();

      (function(){
        var badge = '<span class="badge '+rec.action+'">'+rec.action+'</span>';
        function chip(label, tip){ return '<span class="chip t" data-tip="'+tip+'">'+label+'</span>'; }
        var panelPills = [
          chip('Osc', 'RSI/KDJ/MACD aggregate'),
          chip('PRO', 'VWAP/BB/ATR/ADX/StochRSI'),
          chip('OB', 'Orderbook imbalance r10'),
          chip('EMA', 'EMA-margin trend heat'),
          chip('MMD', 'Impulses UP/DOWN'),
          chip('Liq', 'Targets above/below')
        ].join(' ');
        var tp = (rec.take_profit_price? ('TP '+fmt(rec.take_profit_price,2)+' ('+(rec.take_profit_note||'')+')') : 'TP —');
        var html = '<div><strong>'+symbol+'</strong> @ '+fmt(rec.mark_price,2)+' — '+badge+' (conf '+fmt(rec.confidence,2)+')<br>'+panelPills+'<br><small>'+(rec.reasons||[]).join(' • ')+'</small><br><small>'+tp+'</small></div>';
        var el = document.getElementById('rec_body'); if (el) el.innerHTML = html;
        setDot('stat_rec','stat-ok','OK');
      })();

      (function(){
        var rsi = ind.rsi, K=ind.k, D=ind.d, J=ind.j, macd=ind.macd, signal=ind.signal, hist=ind.hist;
        function chip(label, cls, tip){ return '<span class="chip t '+cls+'" data-tip="'+tip+'">'+label+'</span>'; }
        var rsiCls   = isFinite(rsi) ? (rsi < 30 ? 'good' : (rsi > 70 ? 'bad' : 'ok')) : 'ok';
        var rsiTip   = 'RSI — Relative Strength Index\\n<30 oversold ⇒ mean-reversion long\\n>70 overbought ⇒ TP/avoid longs';
        var kdjCls   = (isFinite(K) && isFinite(D)) ? (K > D ? 'good' : 'bad') : 'ok';
        var kdjTip   = 'KDJ — K crossing D up ⇒ buy timing; down ⇒ sell timing\\nJ extremes (>100/<0) mark exhaustion';
        var jCls     = isFinite(J) ? (J > 100 ? 'bad' : (J < 0 ? 'good' : 'ok')) : 'ok';
        var macdCls  = isFinite(hist) ? (hist > 0 ? 'good' : 'bad') : 'ok';
        var macdTip  = 'MACD histogram >0 ⇒ bull momentum; <0 ⇒ bear momentum\\nShrinking green ⇒ momentum fading';
        var ohtml = '<table>' +
          '<tr><th><span class="t" data-tip="RSI — Relative Strength Index">RSI(14)</span></th><td>'+ (isFinite(rsi)? rsi.toFixed(1) : '') +'</td><td>'+ chip(isFinite(rsi)?rsi.toFixed(1):'', rsiCls, rsiTip) +'</td></tr>' +
          '<tr><th><span class="t" data-tip="KDJ — Stochastic with J line">KDJ</span></th><td>K='+(isFinite(K)?K.toFixed(1):'')+' / D='+(isFinite(D)?D.toFixed(1):'')+' / J='+(isFinite(J)?J.toFixed(1):'')+'</td><td>'+ chip('K vs D', kdjCls, kdjTip) + ' ' + chip('J', jCls, 'J — oversold/overbought extremum') +'</td></tr>' +
          '<tr><th><span class="t" data-tip="MACD — trend momentum">MACD</span></th><td>macd='+(isFinite(macd)?macd.toFixed(3):'')+', signal='+(isFinite(signal)?signal.toFixed(3):'')+', hist='+(isFinite(hist)?hist.toFixed(3):'')+'</td><td>'+ chip('hist', macdCls, macdTip) +'</td></tr>' +
        '</table>';
        var el = document.getElementById('osc_body'); if (el) el.innerHTML = ohtml;
        setDot('stat_osc','stat-ok','OK');
      })();

      (function(){
        var d = depth||{};
        var mid = d.mid, spread = d.spread, r5=d.r5, r10=d.r10, r20=d.r20;
        var mood = function(x){ if (!isFinite(x)) return 'ok'; if (x>1.1) return 'good'; if (x<0.9) return 'bad'; return 'ok'; };
        var html = '<table>' +
          '<tr><th>Mid</th><td>'+fmt(mid,2)+'</td><th>Spread</th><td>'+fmt(spread,2)+'</td></tr>' +
          '<tr><th>5 bps</th><td>'+fmt(r5,2)+'</td><td colspan="2"><span class="chip t '+mood(r5)+'" data-tip="r5 = bid/ask within ±5 bps">'+(isFinite(r5)?r5.toFixed(2):'')+'</span></td></tr>' +
          '<tr><th>10 bps</th><td>'+fmt(r10,2)+'</td><td colspan="2"><span class="chip t '+mood(r10)+'" data-tip="r10 = bid/ask within ±10 bps">'+(isFinite(r10)?r10.toFixed(2):'')+'</span></td></tr>' +
          '<tr><th>20 bps</th><td>'+fmt(r20,2)+'</td><td colspan="2"><span class="chip t '+mood(r20)+'" data-tip="r20 = bid/ask within ±20 bps">'+(isFinite(r20)?r20.toFixed(2):'')+'</span></td></tr>' +
        '</table>';
        var el = document.getElementById('ob_multi'); if (el) el.innerHTML = html;
        setDot('stat_ob','stat-ok','OK');
      })();

      (function(){
        var aboveVWAP = (isFinite(ind.price) && isFinite(ind.vwap)) ? (ind.price >= ind.vwap) : false;
        function t(label, tip, value){
          return '<div><strong><span class="t" data-tip="'+tip+'">'+label+'</span></strong>: '+value+'</div>';
        }
        var prohtml = '';
        prohtml += t('VWAP', 'Volume Weighted Average Price — mean level. Price below ⇒ buy-low bias; above ⇒ chase risk.', fmt(ind.vwap,2) + ' ('+(aboveVWAP?'above':'below')+')');
        prohtml += t('Bollinger', 'Dispersion bands. Touch lower ⇒ mean-reversion long; touch upper ⇒ TP zone.', 'L '+fmt(ind.bb_lower,2)+' / M '+fmt(ind.bb_mid,2)+' / U '+fmt(ind.bb_upper,2));
        prohtml += t('ATR14', 'Average True Range — typical bar range. For stops/trailing.', fmt(ind.atr14,2));
        prohtml += t('ADX14', 'Trend strength (0–50+). <15 chop, >25 trend.', fmt(ind.adx14,1));
        prohtml += t('StochRSI', '0–1 oscillator of RSI. <0.2 oversold, >0.8 overbought.', fmt(ind.stochRSI,2));
        prohtml += '<div class="muted"><small>Basis/Funding/RV — soon</small></div>';
        var _pp = document.getElementById('pro_panel'); if(_pp){ _pp.innerHTML = prohtml; }
        setDot('stat_pro','stat-ok','OK');
      })();

      (function(){
        var rows = (emaMx && emaMx.rows) ? emaMx.rows : [];
        var html = '<table><tr><th>TF</th><th>State</th><th>ΔEMA</th><th>Thr</th></tr>';
        rows.forEach(function(r){
          var cls = r.state==='BULL'?'good':(r.state==='BEAR'?'bad':'ok');
          var d = (isFinite(r.diff)? Number(r.diff).toFixed(2) : '');
          var th = (isFinite(r.thresh)? Number(r.thresh).toFixed(2) : '');
          html += '<tr><td>'+r.tf+'</td><td><span class="chip '+cls+'">'+(r.state||'')+'</span></td><td>'+d+'</td><td>'+th+'</td></tr>';
        });
        html += '</table>';
        var el = document.getElementById('ema_body'); if (el) el.innerHTML = html;
        setDot('stat_ema', rows.length? 'stat-ok':'stat-stale', rows.length?'OK':'stale');
      })();

      (function(){
        var rows = (mmdMx && mmdMx.rows) ? mmdMx.rows : [];
        var html = '<table><tr><th>TF</th><th>Mode</th><th>Signal</th><th>NATR%</th><th>Vol OK</th></tr>';
        rows.forEach(function(r){
          var cls = r.lastSignal==='UP'?'good':(r.lastSignal==='DOWN'?'bad':'ok');
          var natr = (isFinite(r.natr)? Number(r.natr).toFixed(2) : '');
          var vol = (typeof r.volOk==='boolean' ? (r.volOk?'Yes':'No') : '');
          html += '<tr><td>'+r.tf+'</td><td>'+(r.mode||'')+'</td><td><span class="chip '+cls+'">'+(r.lastSignal||'-')+'</span></td><td>'+natr+'</td><td>'+vol+'</td></tr>';
        });
        html += '</table>';
        var el = document.getElementById('mmd_body'); if (el) el.innerHTML = html;
        setDot('stat_mmd', rows.length? 'stat-ok':'stat-stale', rows.length?'OK':'stale');
      })();

      (function(){
        var lb = document.getElementById('latest_body');
        if (lb) lb.innerHTML = '<div>Price: '+fmt(ind.price,2)+'</div><div>RSI: '+fmt(ind.rsi,1)+'</div><div>ADX14: '+fmt(ind.adx14,1)+'</div>';
        setDot('stat_latest','stat-ok','OK');
        var sb = document.getElementById('series_body');
        if (sb) sb.innerHTML = '<span class="muted">History soon</span>';
        setDot('stat_series','stat-stale','stub');
      })();

    }catch(e){
      var msg = (e && e.message) ? e.message : String(e);
      var recBody = document.getElementById('rec_body'); if (recBody) recBody.innerHTML = '<span class="muted">'+msg+'</span>';
      setDot('stat_rec','stat-bad','błąd');
    }
  }

  var _btn=document.getElementById('refresh'); if(_btn){ _btn.addEventListener('click', function(){ loadAll(); }); }
  var autoTimer = 0;
  function scheduleAuto(){
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = 0; }
    var sel = document.getElementById('autoref');
    var ms = sel ? Number(sel.value) : 1000;
    if (!isFinite(ms) || ms < 0) ms = 1000;
    if (ms > 0) {
      autoTimer = setTimeout(function tick(){ loadAll(); scheduleAuto(); }, ms);
    }
  }

  ['symbol','interval','lang','tz','tformat'].forEach(function(id){
    var el = document.getElementById(id); if (el){
      el.addEventListener('change', function(){
        if (id==='lang'){ try{ localStorage.setItem('lang', el.value); }catch(_){} }
        loadAll();
      });
    }
  });

  (function init(){
    initCollapse();
    var ar = document.getElementById('autoref');
    var saved = null;
    try { saved = localStorage.getItem('autoMs'); } catch(e) {}
    if (ar) {
      if (saved) ar.value = saved;
      ar.addEventListener('change', function(){ try { localStorage.setItem('autoMs', ar.value); } catch(_){} scheduleAuto(); });
    }
    loadAll();
    scheduleAuto();
  })();
})();
`;

// ---------- Router ----------
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/") {
      return new Response(DASHBOARD_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }

    if (path === "/app.js") {
      return new Response(APP_JS, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" } });
    }

    if (path === "/api/indicators") {
      const symbol = url.searchParams.get("symbol") || "BTCUSDT";
      const interval = url.searchParams.get("interval") || "1m";
      const limit = Math.min(500, Number(url.searchParams.get("limit") || "200"));
      try {
        const kl = await getCandles(symbol, interval, limit);
        const ind = calcIndicators(kl);
        return json(ind);
      } catch (e:any) {
        return json({ error: e?.message || String(e), stale:true, symbol, interval, limit });
      }
    }

    if (path === "/api/depth-multi") {
      const symbol = url.searchParams.get("symbol") || "BTCUSDT";
      try {
        const depth = await fetchDepth(symbol, 100);
        const ob = computeOB(depth, [5,10,20]);
        return json(ob);
      } catch (e:any) {
        return json({ error: e?.message || String(e) }, 200);
      }
    }

    if (path === "/api/liq-levels") {
      const symbol = url.searchParams.get("symbol") || "BTCUSDT";
      return json(liqStub(symbol));
    }

    if (path === "/api/recommendation") {
      const symbol = url.searchParams.get("symbol") || "BTCUSDT";
      const interval = url.searchParams.get("interval") || "1m";
      try {
        const [kl, depth, ema, mmd] = await Promise.all([
          getCandles(symbol, interval, 200),
          fetchDepth(symbol, 100),
          computeEmaMarginMatrix(symbol),
          computeMmdMatrix(symbol)
        ]);
        const ind = calcIndicators(kl);
        const ob = computeOB(depth, [5,10,20]);
        const liq = liqStub(symbol);
        const rec = buildRecommendation(symbol, ind, ob, liq);
        try {
          let bull=0, bear=0; (ema.rows||[]).forEach((r:any)=>{ if(r.state==='BULL') bull++; else if(r.state==='BEAR') bear++; });
          (rec as any).panels.ema = bull>bear? 'bull' : bear>bull? 'bear' : 'neutral';
        } catch(_){}
        try {
          let up=0, dn=0; (mmd.rows||[]).forEach((r:any)=>{ if(r.lastSignal==='UP') up++; else if(r.lastSignal==='DOWN') dn++; });
          (rec as any).panels.mmd = up>dn? 'bull' : dn>up? 'bear' : 'neutral';
        } catch(_){}
        return json(rec);
      } catch (e:any) {
        try {
          const depth = await fetchDepth(symbol, 100);
          const ob = computeOB(depth, [5,10,20]);
          const liq = liqStub(symbol);
          const ind:any = { price: NaN, rsi: NaN, k: NaN, d: NaN, j: NaN, macd: NaN, signal: NaN, hist: NaN, vwap: NaN, bb_mid: NaN, bb_upper: NaN, bb_lower: NaN, atr14: NaN, adx14: NaN, stochRSI: NaN };
          const rec = buildRecommendation(symbol, ind, ob, liq);
          (rec as any).error = e?.message || String(e);
          (rec as any).stale = true;
          return json(rec);
        } catch (e2:any) {
          return json({ error: (e?.message||'') + ' / ' + (e2?.message||'') }, 200);
        }
      }
    }

    if (path === "/api/ema-margin-matrix") {
      const symbol = url.searchParams.get("symbol") || "BTCUSDT";
      try {
        const out = await computeEmaMarginMatrix(symbol);
        return json(out);
      } catch (e:any) {
        return json({ error: e?.message || String(e) }, 200);
      }
    }

    if (path === "/api/mmd-matrix") {
      const symbol = url.searchParams.get("symbol") || "BTCUSDT";
      try {
        const out = await computeMmdMatrix(symbol);
        return json(out);
      } catch (e:any) {
        return json({ error: e?.message || String(e) }, 200);
      }
    }

    if (path === "/admin/collect-now") {
      const symbol = url.searchParams.get("symbol") || "BTCUSDT";
      const report:any = { symbol };
      try { const x = await getCandles(symbol, "1m", 50); report.indicators = { ok:true, n:x.length }; } catch(e:any){ report.indicators = { ok:false, error: e?.message || String(e) }; }
      try { const d = await fetchDepth(symbol, 50); report.depth = { ok:true, bids:(d.bids||[]).length, asks:(d.asks||[]).length }; } catch(e:any){ report.depth = { ok:false, error: e?.message || String(e) }; }
      return json(report);
    }

    return new Response("Not found", { status: 404 });
  }
};
