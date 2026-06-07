const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function normalizeStore(store) {
  return {
    holdings: Array.isArray(store && store.holdings)
      ? store.holdings.map(normalizeHolding)
      : [],
    trades: Array.isArray(store && store.trades)
      ? store.trades.map(normalizeTrade)
      : [],
    fund_flows: Array.isArray(store && store.fund_flows) ? store.fund_flows : [],
    quote_history: Array.isArray(store && store.quote_history)
      ? store.quote_history.map(normalizeQuoteHistory).filter(Boolean)
      : [],
  };
}

function normalizeSectors(value) {
  let raw = value;

  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return [];

    try {
      raw = JSON.parse(text);
    } catch {
      raw = text.split(/[,，、;；]/);
    }
  }

  if (!Array.isArray(raw)) return [];

  const seen = new Set();
  return raw
    .map(item => String(item || '').trim())
    .filter(item => {
      const key = item.toLowerCase();
      if (!item || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeHolding(holding) {
  return {
    ...holding,
    sectors: normalizeSectors(holding && holding.sectors),
  };
}

function normalizeTrade(trade) {
  const commission = Number(trade && trade.commission);
  return {
    ...trade,
    commission: Number.isFinite(commission) ? commission : 0,
    sectors: normalizeSectors(trade && trade.sectors),
  };
}

function normalizeQuoteHistory(item) {
  if (!item) return null;
  const close = Number(item.close);
  const date = String(item.date || '').slice(0, 10);
  const stockCode = requiredString(item.stock_code).toUpperCase();

  if (!stockCode || !date || !Number.isFinite(close) || close <= 0) return null;

  return {
    stock_code: stockCode,
    date,
    close,
    source: String(item.source || ''),
    observed_at: String(item.observed_at || item.created_at || new Date().toISOString()),
  };
}

function sqlString(value) {
  if (value === undefined || value === null) return 'NULL';
  return `'${String(value).replace(/\u0000/g, '').replace(/'/g, "''")}'`;
}

function sqlNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : String(fallback);
}

function sqlInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) ? String(number) : String(fallback);
}

function requiredString(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function commandExists(command) {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function createStorage({ dataDir, dataFile, isProduction }) {
  const driver = process.env.STORAGE_DRIVER || (isProduction ? 'sqlite' : 'json');
  const sqliteBin = process.env.SQLITE_BIN || 'sqlite3';
  const dbFile = path.resolve(process.env.DB_FILE || path.join(dataDir, 'aplan.sqlite'));
  let ensured = false;

  if (!['json', 'sqlite'].includes(driver)) {
    throw new Error('STORAGE_DRIVER must be either json or sqlite');
  }

  function ensure() {
    if (ensured) return;
    if (driver === 'sqlite') ensureSqliteStore();
    else ensureJsonStore();
    ensured = true;
  }

  function ensureJsonStore() {
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(dataFile)) {
      writeJsonStore({ holdings: [], trades: [], fund_flows: [], quote_history: [] });
    }
  }

  function readJsonStore() {
    ensureJsonStore();
    const raw = fs.readFileSync(dataFile, 'utf8');
    return normalizeStore(JSON.parse(raw));
  }

  function writeJsonStore(store) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmpFile = `${dataFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(normalizeStore(store), null, 2));
    fs.renameSync(tmpFile, dataFile);
  }

  function runSql(sql) {
    return execFileSync(sqliteBin, [dbFile], {
      encoding: 'utf8',
      input: sql,
      maxBuffer: 10 * 1024 * 1024,
    });
  }

  function querySql(sql) {
    const output = execFileSync(sqliteBin, ['-json', dbFile, sql], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
    return output ? JSON.parse(output) : [];
  }

  function ensureSqliteStore() {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });

    if (!commandExists(sqliteBin)) {
      throw new Error(`SQLite storage requires the "${sqliteBin}" command. Install sqlite3 or set STORAGE_DRIVER=json.`);
    }

    runSql(`
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

      CREATE TABLE IF NOT EXISTS quote_history (
        stock_code TEXT NOT NULL,
        date TEXT NOT NULL,
        close REAL NOT NULL CHECK(close > 0),
        source TEXT DEFAULT '',
        observed_at TEXT NOT NULL,
        PRIMARY KEY (stock_code, date)
      );

      CREATE INDEX IF NOT EXISTS idx_trades_stock_code ON trades(stock_code);
      CREATE INDEX IF NOT EXISTS idx_trades_trade_time ON trades(trade_time);
      CREATE INDEX IF NOT EXISTS idx_fund_flows_flow_date ON fund_flows(flow_date);
      CREATE INDEX IF NOT EXISTS idx_quote_history_date ON quote_history(date);
    `);

    ensureSqliteColumns();
    importJsonStoreIfEmpty();
  }

  function ensureSqliteColumns() {
    const holdingColumns = querySql('PRAGMA table_info(holdings);').map(column => column.name);
    const desiredHoldingColumns = [
      ['sectors', "TEXT DEFAULT '[]'"],
      ['quote_symbol', 'TEXT'],
      ['quote_source', 'TEXT'],
      ['quote_time', 'TEXT'],
      ['quote_change', 'REAL DEFAULT 0'],
      ['quote_change_percent', 'REAL DEFAULT 0'],
      ['quote_updated_at', 'TEXT'],
    ];

    desiredHoldingColumns.forEach(([name, definition]) => {
      if (!holdingColumns.includes(name)) {
        runSql(`ALTER TABLE holdings ADD COLUMN ${name} ${definition};`);
      }
    });

    const tradeColumns = querySql('PRAGMA table_info(trades);').map(column => column.name);
    const desiredTradeColumns = [
      ['sectors', "TEXT DEFAULT '[]'"],
      ['commission', 'REAL NOT NULL DEFAULT 0'],
    ];

    desiredTradeColumns.forEach(([name, definition]) => {
      if (!tradeColumns.includes(name)) {
        runSql(`ALTER TABLE trades ADD COLUMN ${name} ${definition};`);
      }
    });
  }

  function importJsonStoreIfEmpty() {
    if (process.env.SQLITE_IMPORT_JSON === 'false') return;
    if (!fs.existsSync(dataFile)) return;

    const counts = querySql(`
      SELECT
        (SELECT COUNT(*) FROM holdings) AS holdings,
        (SELECT COUNT(*) FROM trades) AS trades,
        (SELECT COUNT(*) FROM fund_flows) AS fund_flows,
        (SELECT COUNT(*) FROM quote_history) AS quote_history;
    `)[0] || { holdings: 0, trades: 0, fund_flows: 0 };

    if (
      Number(counts.holdings) +
      Number(counts.trades) +
      Number(counts.fund_flows) +
      Number(counts.quote_history || 0) >
      0
    ) return;

    const store = readJsonStore();
    if (store.holdings.length + store.trades.length + store.fund_flows.length + store.quote_history.length === 0) return;

    writeSqliteStore(store);
    console.log(`[stock-app] imported JSON data from ${dataFile} into ${dbFile}`);
  }

  function readSqliteStore() {
    const holdings = querySql(`
      SELECT
        id,
        stock_code,
        stock_name,
        sectors,
        quantity,
        cost_price,
        total_cost,
        current_price,
        quote_symbol,
        quote_source,
        quote_time,
        quote_change,
        quote_change_percent,
        quote_updated_at,
        updated_at,
        created_at
      FROM holdings
      ORDER BY stock_code COLLATE NOCASE;
    `);

    const trades = querySql(`
      SELECT
        id,
        stock_code,
        stock_name,
        sectors,
        trade_type,
        quantity,
        price,
        commission,
        trade_time,
        note,
        created_by,
        created_at
      FROM trades;
    `);

    const fundFlows = querySql(`
      SELECT
        id,
        flow_type,
        amount,
        balance_after,
        note,
        flow_date,
        created_by,
        created_at
      FROM fund_flows;
    `);

    const quoteHistory = querySql(`
      SELECT
        stock_code,
        date,
        close,
        source,
        observed_at
      FROM quote_history;
    `);

    return normalizeStore({ holdings, trades, fund_flows: fundFlows, quote_history: quoteHistory });
  }

  function writeSqliteStore(store) {
    const normalized = normalizeStore(store);
    const statements = [
      'PRAGMA foreign_keys=OFF;',
      'BEGIN IMMEDIATE;',
      'DELETE FROM quote_history;',
      'DELETE FROM fund_flows;',
      'DELETE FROM trades;',
      'DELETE FROM holdings;',
    ];

    normalized.holdings.forEach(holding => {
      const now = new Date().toISOString();
      statements.push(`
        INSERT INTO holdings (
          id,
          stock_code,
          stock_name,
          sectors,
          quantity,
          cost_price,
          total_cost,
          current_price,
          quote_symbol,
          quote_source,
          quote_time,
          quote_change,
          quote_change_percent,
          quote_updated_at,
          updated_at,
          created_at
        ) VALUES (
          ${sqlString(holding.id || crypto.randomUUID())},
          ${sqlString(requiredString(holding.stock_code))},
          ${sqlString(holding.stock_name || '')},
          ${sqlString(JSON.stringify(normalizeSectors(holding.sectors)))},
          ${sqlInteger(Number(holding.quantity))},
          ${sqlNumber(holding.cost_price)},
          ${sqlNumber(holding.total_cost)},
          ${sqlNumber(holding.current_price)},
          ${sqlString(holding.quote_symbol)},
          ${sqlString(holding.quote_source)},
          ${sqlString(holding.quote_time)},
          ${sqlNumber(holding.quote_change)},
          ${sqlNumber(holding.quote_change_percent)},
          ${sqlString(holding.quote_updated_at)},
          ${sqlString(holding.updated_at || now)},
          ${sqlString(holding.created_at || now)}
        );
      `);
    });

    normalized.trades.forEach(trade => {
      const now = new Date().toISOString();
      statements.push(`
        INSERT INTO trades (
          id,
          stock_code,
          stock_name,
          sectors,
          trade_type,
          quantity,
          price,
          commission,
          trade_time,
          note,
          created_by,
          created_at
        ) VALUES (
          ${sqlString(trade.id || crypto.randomUUID())},
          ${sqlString(requiredString(trade.stock_code))},
          ${sqlString(trade.stock_name || '')},
          ${sqlString(JSON.stringify(normalizeSectors(trade.sectors)))},
          ${sqlString(trade.trade_type)},
          ${sqlInteger(Number(trade.quantity))},
          ${sqlNumber(trade.price)},
          ${sqlNumber(trade.commission)},
          ${sqlString(trade.trade_time)},
          ${sqlString(trade.note || '')},
          ${sqlString(trade.created_by)},
          ${sqlString(trade.created_at || now)}
        );
      `);
    });

    normalized.fund_flows.forEach(fundFlow => {
      const now = new Date().toISOString();
      statements.push(`
        INSERT INTO fund_flows (
          id,
          flow_type,
          amount,
          balance_after,
          note,
          flow_date,
          created_by,
          created_at
        ) VALUES (
          ${sqlString(fundFlow.id || crypto.randomUUID())},
          ${sqlString(fundFlow.flow_type)},
          ${sqlNumber(fundFlow.amount)},
          ${sqlNumber(fundFlow.balance_after)},
          ${sqlString(fundFlow.note || '')},
          ${sqlString(fundFlow.flow_date)},
          ${sqlString(fundFlow.created_by)},
          ${sqlString(fundFlow.created_at || now)}
        );
      `);
    });

    normalized.quote_history.forEach(item => {
      statements.push(`
        INSERT INTO quote_history (
          stock_code,
          date,
          close,
          source,
          observed_at
        ) VALUES (
          ${sqlString(item.stock_code)},
          ${sqlString(item.date)},
          ${sqlNumber(item.close)},
          ${sqlString(item.source || '')},
          ${sqlString(item.observed_at || new Date().toISOString())}
        );
      `);
    });

    statements.push('COMMIT;');
    runSql(statements.join('\n'));
  }

  return {
    dbFile,
    driver,
    dataFile,
    ensure,
    read() {
      ensure();
      return driver === 'sqlite' ? readSqliteStore() : readJsonStore();
    },
    write(store) {
      ensure();
      if (driver === 'sqlite') writeSqliteStore(store);
      else writeJsonStore(store);
    },
  };
}

module.exports = { createStorage };
