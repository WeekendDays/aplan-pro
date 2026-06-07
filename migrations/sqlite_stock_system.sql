PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS holdings (
  id TEXT PRIMARY KEY,
  stock_code TEXT NOT NULL UNIQUE,
  stock_name TEXT NOT NULL DEFAULT '',
  sectors TEXT DEFAULT '[]',
  quantity INTEGER NOT NULL DEFAULT 0,
  cost_price REAL NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0,
  current_price REAL NOT NULL DEFAULT 0,
  quote_symbol TEXT,
  quote_source TEXT,
  quote_time TEXT,
  quote_change REAL DEFAULT 0,
  quote_change_percent REAL DEFAULT 0,
  quote_updated_at TEXT,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  stock_code TEXT NOT NULL,
  stock_name TEXT NOT NULL DEFAULT '',
  sectors TEXT DEFAULT '[]',
  trade_type TEXT NOT NULL CHECK(trade_type IN ('buy', 'sell')),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  price REAL NOT NULL CHECK(price > 0),
  commission REAL NOT NULL DEFAULT 0,
  trade_time TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fund_flows (
  id TEXT PRIMARY KEY,
  flow_type TEXT NOT NULL CHECK(flow_type IN ('deposit', 'withdraw')),
  amount REAL NOT NULL CHECK(amount > 0),
  balance_after REAL NOT NULL DEFAULT 0,
  note TEXT DEFAULT '',
  flow_date TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trades_stock_code ON trades(stock_code);
CREATE INDEX IF NOT EXISTS idx_trades_trade_time ON trades(trade_time);
CREATE INDEX IF NOT EXISTS idx_fund_flows_flow_date ON fund_flows(flow_date);
