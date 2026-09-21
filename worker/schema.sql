-- Trading market data schema
CREATE TABLE IF NOT EXISTS candles (
  symbol TEXT NOT NULL,
  timeframe INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (symbol, timeframe, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_candles_symbol_tf_time
ON candles(symbol, timeframe, timestamp DESC);
