-- 0001_init.sql
-- Create metrics table and index for the CF Worker project

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
