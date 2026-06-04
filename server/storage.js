const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function normalizeStore(store) {
  return {
    holdings: Array.isArray(store && store.holdings) ? store.holdings : [],
    trades: Array.isArray(store && store.trades) ? store.trades : [],
    fund_flows: Array.isArray(store && store.fund_flows) ? store.fund_flows : [],
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
      writeJsonStore({ holdings: [], trades: [], fund_flows: [] });
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
        trade_type TEXT NOT NULL CHECK(trade_type IN ('buy', 'sell')),
        quantity INTEGER NOT NULL CHECK(quantity > 0),
        price REAL NOT NULL CHECK(price > 0),
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
    `);

    ensureSqliteColumns();
    importJsonStoreIfEmpty();
  }

  function ensureSqliteColumns() {
    const holdingColumns = querySql('PRAGMA table_info(holdings);').map(column => column.name);
    const desiredColumns = [
      ['quote_symbol', 'TEXT'],
      ['quote_source', 'TEXT'],
      ['quote_time', 'TEXT'],
      ['quote_change', 'REAL DEFAULT 0'],
      ['quote_change_percent', 'REAL DEFAULT 0'],
      ['quote_updated_at', 'TEXT'],
    ];

    desiredColumns.forEach(([name, definition]) => {
      if (!holdingColumns.includes(name)) {
        runSql(`ALTER TABLE holdings ADD COLUMN ${name} ${definition};`);
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
        (SELECT COUNT(*) FROM fund_flows) AS fund_flows;
    `)[0] || { holdings: 0, trades: 0, fund_flows: 0 };

    if (Number(counts.holdings) + Number(counts.trades) + Number(counts.fund_flows) > 0) return;

    const store = readJsonStore();
    if (store.holdings.length + store.trades.length + store.fund_flows.length === 0) return;

    writeSqliteStore(store);
    console.log(`[stock-app] imported JSON data from ${dataFile} into ${dbFile}`);
  }

  function readSqliteStore() {
    const holdings = querySql(`
      SELECT
        id,
        stock_code,
        stock_name,
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
        trade_type,
        quantity,
        price,
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

    return normalizeStore({ holdings, trades, fund_flows: fundFlows });
  }

  function writeSqliteStore(store) {
    const normalized = normalizeStore(store);
    const statements = [
      'PRAGMA foreign_keys=OFF;',
      'BEGIN IMMEDIATE;',
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
          trade_type,
          quantity,
          price,
          trade_time,
          note,
          created_by,
          created_at
        ) VALUES (
          ${sqlString(trade.id || crypto.randomUUID())},
          ${sqlString(requiredString(trade.stock_code))},
          ${sqlString(trade.stock_name || '')},
          ${sqlString(trade.trade_type)},
          ${sqlInteger(Number(trade.quantity))},
          ${sqlNumber(trade.price)},
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
