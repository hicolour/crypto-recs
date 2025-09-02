-- migrations/0001_init.sql
-- D1 schema for crypto-recs Worker (metrics + DIY liquidation levels); unchanged for v2.5
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

CREATE TABLE IF NOT EXISTS liq_levels (
  symbol TEXT NOT NULL,
  bin REAL NOT NULL,
  usd REAL NOT NULL,
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY (symbol, bin)
);
CREATE INDEX IF NOT EXISTS idx_liq_levels_symbol_bin ON liq_levels(symbol, bin);
