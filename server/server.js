const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createStorage } = require('./storage');

loadLocalEnv();

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const DATA_FILE = path.resolve(process.env.DATA_FILE || path.join(DATA_DIR, 'store.json'));
const LOGO_CACHE_DIR = path.resolve(process.env.LOGO_CACHE_DIR || path.join(DATA_DIR, 'logo-cache'));
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || path.join(process.cwd(), 'dist'));
const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 30);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const QUOTE_REFRESH_TIMEOUT_MS = Number(process.env.QUOTE_REFRESH_TIMEOUT_MS || 10000);
const NAV_HISTORY_TIMEOUT_MS = Number(process.env.NAV_HISTORY_TIMEOUT_MS || 8000);
const PRICE_SYMBOL_MAP = process.env.PRICE_SYMBOL_MAP ? JSON.parse(process.env.PRICE_SYMBOL_MAP) : {};
const ALPACA_API_KEY_ID = process.env.ALPACA_API_KEY_ID || process.env.ALPACA_KEY || '';
const ALPACA_API_SECRET_KEY = process.env.ALPACA_API_SECRET_KEY || process.env.ALPACA_SECRET || '';
const ALPACA_SYMBOL_MAP = process.env.ALPACA_SYMBOL_MAP ? JSON.parse(process.env.ALPACA_SYMBOL_MAP) : {};
const ALPACA_DATA_FEED = process.env.ALPACA_DATA_FEED || 'iex';
const ALPACA_DATA_ADJUSTMENT = process.env.ALPACA_DATA_ADJUSTMENT || 'raw';
const ALPACA_DATA_BASE_URL = normalizeAlpacaBaseUrl(
  process.env.ALPACA_DATA_BASE_URL || process.env.ALPACA_MARKET_DATA_ENDPOINT || process.env.ALPACA_ENDPOINT,
);
const ALPACA_QUOTE_TIMEOUT_MS = Number(process.env.ALPACA_QUOTE_TIMEOUT_MS || QUOTE_REFRESH_TIMEOUT_MS);
const ALPACA_HISTORY_TIMEOUT_MS = Number(process.env.ALPACA_HISTORY_TIMEOUT_MS || NAV_HISTORY_TIMEOUT_MS);
const NAV_CACHE_TTL_MS = Math.max(0, Number(process.env.NAV_CACHE_TTL_MS || 10 * 60 * 1000));
const LOGO_CACHE_TTL_MS = Math.max(0, Number(process.env.LOGO_CACHE_TTL_MS || 30 * 24 * 60 * 60 * 1000));
const LOGO_FETCH_TIMEOUT_MS = Number(process.env.LOGO_FETCH_TIMEOUT_MS || 6000);
const LOGO_MAX_BYTES = Number(process.env.LOGO_MAX_BYTES || 256 * 1024);
const LOGIN_RATE_LIMIT_WINDOW_MS = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS || 10);
const storage = createStorage({ dataDir: DATA_DIR, dataFile: DATA_FILE, isProduction: IS_PRODUCTION });

const loginAttempts = new Map();
const portfolioNavCache = new Map();
const portfolioNavInflight = new Map();
const providerWarnings = new Set();
const users = loadUsers();
validateProductionConfig();

const LOGO_DOMAINS = {
  AAPL: 'apple.com',
  AMAT: 'appliedmaterials.com',
  AVGO: 'broadcom.com',
  DRAM: 'globalxetfs.com',
  NOK: 'nokia.com',
  NVDA: 'nvidia.com',
  QLD: 'proshares.com',
  SMH: 'vaneck.com',
  VGT: 'vanguard.com',
};

function loadLocalEnv() {
  ['.env.local', '.env'].forEach(fileName => {
    const filePath = path.resolve(process.cwd(), fileName);
    if (!fs.existsSync(filePath)) return;

    fs.readFileSync(filePath, 'utf8').split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const index = trimmed.indexOf('=');
      if (index < 0) return;

      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if (!key || process.env[key] !== undefined) return;
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    });
  });
}

function loadUsers() {
  if (process.env.STOCK_APP_USERNAME && process.env.STOCK_APP_PASSWORD) {
    return [
      normalizeUser({
        id: process.env.STOCK_APP_USERNAME,
        username: process.env.STOCK_APP_USERNAME,
        name: process.env.STOCK_APP_NAME || 'User',
        password: process.env.STOCK_APP_PASSWORD,
      }),
    ];
  }

  if (process.env.STOCK_APP_USERNAME || process.env.STOCK_APP_PASSWORD) {
    throw new Error('Both STOCK_APP_USERNAME and STOCK_APP_PASSWORD must be set');
  }

  if (IS_PRODUCTION) {
    throw new Error('STOCK_APP_USERNAME and STOCK_APP_PASSWORD must be set in production');
  }

  console.warn('[stock-app] STOCK_APP_USERNAME/STOCK_APP_PASSWORD are not set. Development account is enabled.');
  return [
    normalizeUser({ id: 'operator', username: 'operator', name: 'Operator', password: 'operator123', role: 'operator' }),
  ];
}

function normalizeUser(user) {
  if (!user.id || !user.password) {
    throw new Error('The login account needs id and password');
  }
  return {
    id: String(user.id),
    username: String(user.username || user.id),
    password: String(user.password),
    name: String(user.name || user.id),
    avatar: String(user.avatar || ''),
    department: String(user.department || ''),
    role: 'operator',
  };
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    avatar: user.avatar,
    department: user.department,
    role: user.role,
  };
}

function readStore() {
  return storage.read();
}

function writeStore(store) {
  storage.write(store);
  clearPortfolioNavCache();
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...securityHeaders(),
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, error) {
  sendJson(res, status, { error });
}

function sendBinary(res, status, body, contentType, headers = {}) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    ...securityHeaders(),
    ...headers,
  });
  res.end(body);
}

function parseCookies(req) {
  const result = {};
  const cookieHeader = req.headers.cookie || '';
  cookieHeader.split(';').forEach(part => {
    const [key, ...rest] = part.trim().split('=');
    if (key) result[key] = decodeURIComponent(rest.join('=') || '');
  });
  return result;
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
      "font-src 'self' https://cdnjs.cloudflare.com data:",
      "img-src 'self' data: https:",
      "connect-src 'self'",
    ].join('; '),
  };
}

function normalizeLogoSymbol(value) {
  const symbol = String(value || '').toUpperCase();
  if (!/^[A-Z0-9._-]{1,16}$/.test(symbol)) return '';
  return symbol;
}

function logoSources(symbol) {
  const domain = LOGO_DOMAINS[symbol];
  return [
    `https://finnhub.io/api/logo?symbol=${encodeURIComponent(symbol)}`,
    domain ? `https://img.logo.dev/${domain}?size=72` : '',
  ].filter(Boolean);
}

function logoCachePaths(symbol) {
  return {
    data: path.join(LOGO_CACHE_DIR, `${symbol}.logo`),
    meta: path.join(LOGO_CACHE_DIR, `${symbol}.json`),
  };
}

function detectImageContentType(contentType, body) {
  if (contentType.startsWith('image/')) return contentType;
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) {
    return 'image/jpeg';
  }
  if (body.length >= 6) {
    const signature = body.subarray(0, 6).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  }
  if (
    body.length >= 12 &&
    body.subarray(0, 4).toString('ascii') === 'RIFF' &&
    body.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (body.subarray(0, 512).toString('utf8').trimStart().startsWith('<svg')) {
    return 'image/svg+xml';
  }

  return '';
}

function readCachedLogo(symbol, allowExpired = false) {
  const { data, meta } = logoCachePaths(symbol);
  if (!fs.existsSync(data) || !fs.existsSync(meta)) return null;

  try {
    const metadata = JSON.parse(fs.readFileSync(meta, 'utf8'));
    if (!allowExpired && Number(metadata.expiresAt || 0) <= Date.now()) return null;

    const body = fs.readFileSync(data);
    if (body.length <= 0) return null;

    return {
      body,
      contentType: typeof metadata.contentType === 'string' ? metadata.contentType : 'image/png',
    };
  } catch {
    return null;
  }
}

function writeCachedLogo(symbol, logo) {
  fs.mkdirSync(LOGO_CACHE_DIR, { recursive: true });
  const { data, meta } = logoCachePaths(symbol);
  fs.writeFileSync(data, logo.body);
  fs.writeFileSync(meta, JSON.stringify({
    contentType: logo.contentType,
    expiresAt: Date.now() + LOGO_CACHE_TTL_MS,
    source: logo.source,
    updatedAt: new Date().toISOString(),
  }));
}

async function fetchLogoSource(source) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOGO_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(source, {
      headers: {
        Accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*,*/*;q=0.8',
        'User-Agent': 'Aplan logo cache/1.0',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const rawContentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length <= 0 || body.length > LOGO_MAX_BYTES) return null;

    const contentType = detectImageContentType(rawContentType, body);
    if (!contentType) return null;

    return { body, contentType, source };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTickerLogo(symbol) {
  for (const source of logoSources(symbol)) {
    const logo = await fetchLogoSource(source);
    if (logo) return logo;
  }

  return null;
}

async function sendTickerLogo(res, symbol) {
  const cached = readCachedLogo(symbol);
  if (cached) {
    sendBinary(res, 200, cached.body, cached.contentType, {
      'Cache-Control': 'public, max-age=604800, immutable',
      'X-Logo-Cache': 'hit',
    });
    return;
  }

  const fresh = await fetchTickerLogo(symbol);
  if (fresh) {
    writeCachedLogo(symbol, fresh);
    sendBinary(res, 200, fresh.body, fresh.contentType, {
      'Cache-Control': 'public, max-age=604800, immutable',
      'X-Logo-Cache': 'miss',
    });
    return;
  }

  const stale = readCachedLogo(symbol, true);
  if (stale) {
    sendBinary(res, 200, stale.body, stale.contentType, {
      'Cache-Control': 'public, max-age=3600',
      'X-Logo-Cache': 'stale',
    });
    return;
  }

  res.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
    ...securityHeaders(),
  });
  res.end('Logo not found');
}

function validateProductionConfig() {
  if (!IS_PRODUCTION) return;
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET must be set to at least 32 characters in production');
  }
  if (!COOKIE_SECURE) {
    throw new Error('COOKIE_SECURE=true must be set in production');
  }
  if (!Number.isFinite(SESSION_TTL_MS) || SESSION_TTL_MS <= 0) {
    throw new Error('SESSION_TTL_DAYS or SESSION_TTL_MS must be positive');
  }
}

function sessionCookie(token, maxAgeSeconds) {
  const parts = [
    `stock_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (maxAgeSeconds <= 0) {
    parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  if (COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}

function hmac(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function sessionSecret(user) {
  return process.env.SESSION_SECRET || `stock-app-session:${user.id}:${user.username}:${user.password}`;
}

function safeStringEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createSessionToken(user) {
  const payload = {
    userId: user.id,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encodedPayload}.${hmac(encodedPayload, sessionSecret(user))}`;
}

function getSessionUser(req) {
  const token = parseCookies(req).stock_session;
  if (!token) return null;

  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!payload.expiresAt || payload.expiresAt < Date.now()) return null;

  const user = users.find(item => item.id === payload.userId);
  if (!user) return null;

  const expectedSignature = hmac(encodedPayload, sessionSecret(user));
  if (!safeStringEqual(signature, expectedSignature)) return null;

  return user || null;
}

function requireAuth(req, res) {
  const user = getSessionUser(req);
  if (!user) {
    sendError(res, 401, 'Not authenticated');
    return null;
  }
  return user;
}

function requireOperator(user, res) {
  if (user.role !== 'operator') {
    sendError(res, 403, 'Only operators can change portfolio data');
    return false;
  }
  return true;
}

function safePasswordEqual(left, right) {
  const leftHash = crypto.createHash('sha256').update(left).digest();
  const rightHash = crypto.createHash('sha256').update(right).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function clientIp(req) {
  const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return String(req.headers['x-real-ip'] || forwardedFor || req.socket.remoteAddress || 'unknown');
}

function isLoginRateLimited(req) {
  const key = clientIp(req);
  const now = Date.now();
  const record = loginAttempts.get(key);
  if (!record || record.resetAt <= now) return false;
  return record.count >= LOGIN_MAX_ATTEMPTS;
}

function recordFailedLogin(req) {
  const key = clientIp(req);
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_RATE_LIMIT_WINDOW_MS });
    return;
  }
  current.count += 1;
}

function clearFailedLogins(req) {
  loginAttempts.delete(clientIp(req));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body is too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function numberFrom(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${field} must be a valid number`);
  return number;
}

function optionalNumberFrom(value, field, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  return numberFrom(value, field);
}

function normalizeSectors(value) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();
  return value
    .map(item => String(item || '').trim())
    .filter(item => {
      const key = item.toLowerCase();
      if (!item || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function sortByDateDesc(items, field) {
  return [...items].sort((a, b) => new Date(b[field]).getTime() - new Date(a[field]).getTime());
}

function dateKey(value) {
  if (!value) return '';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function utcDate(key) {
  return new Date(`${key}T00:00:00.000Z`);
}

function addDays(key, days) {
  const date = utcDate(key);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function compareDateKeys(a, b) {
  return a.localeCompare(b);
}

function isWeekend(key) {
  const day = utcDate(key).getUTCDay();
  return day === 0 || day === 6;
}

function previousTradingDate(key) {
  let current = addDays(key, -1);
  while (isWeekend(current)) current = addDays(current, -1);
  return current;
}

function rangeStartDate(range, latestDate) {
  if (range === '1D') return previousTradingDate(latestDate);
  if (range === '7D') return addDays(latestDate, -6);
  if (range === '1M') return addDays(latestDate, -30);
  if (range === 'YTD') return `${latestDate.slice(0, 4)}-01-01`;
  return addDays(latestDate, -6);
}

function normalizePerformanceRange(range) {
  return ['1D', '7D', '1M', 'YTD'].includes(range) ? range : '7D';
}

function clearPortfolioNavCache() {
  portfolioNavCache.clear();
}

function prunePortfolioNavCache(now = Date.now()) {
  portfolioNavCache.forEach((entry, key) => {
    if (!entry || entry.expiresAt <= now) portfolioNavCache.delete(key);
  });

  while (portfolioNavCache.size > 16) {
    const oldestKey = portfolioNavCache.keys().next().value;
    if (!oldestKey) break;
    portfolioNavCache.delete(oldestKey);
  }
}

function portfolioNavCacheKey(range, version) {
  return `${range}:${version}`;
}

function portfolioNavCacheVersion(store) {
  const payload = {
    asOfDate: dateKey(new Date()),
    fund_flows: [...(store.fund_flows || [])]
      .map(flow => [
        flow.id,
        flow.flow_type,
        Number(flow.amount) || 0,
        Number(flow.balance_after) || 0,
        dateKey(flow.flow_date),
        flow.created_at,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    holdings: [...(store.holdings || [])]
      .map(holding => [
        String(holding.stock_code || '').toUpperCase(),
        Number(holding.current_price) || 0,
        Number(holding.quote_change) || 0,
        dateKey(holding.quote_time || holding.quote_updated_at || holding.updated_at),
        holding.quote_source || '',
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    quote_history: ensureQuoteHistory(store)
      .map(item => [
        String(item.stock_code || '').toUpperCase(),
        dateKey(item.date),
        Number(item.close) || 0,
      ])
      .filter(item => item[0] && item[1] && item[2] > 0)
      .sort((a, b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`)),
    trades: [...(store.trades || [])]
      .map(trade => [
        trade.id,
        String(trade.stock_code || '').toUpperCase(),
        trade.trade_type,
        Number(trade.quantity) || 0,
        Number(trade.price) || 0,
        Number(trade.commission) || 0,
        dateKey(trade.trade_time),
        trade.created_at,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  };

  return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
}

function enumerateValuationDates(startDate, endDate, eventDates = new Set()) {
  const dates = [];
  for (let current = startDate; compareDateKeys(current, endDate) <= 0; current = addDays(current, 1)) {
    if (!isWeekend(current) || eventDates.has(current)) dates.push(current);
  }
  return dates;
}

function ensureQuoteHistory(store) {
  if (!Array.isArray(store.quote_history)) store.quote_history = [];
  return store.quote_history;
}

function upsertQuoteHistory(store, item, options = {}) {
  const stockCode = String(item.stock_code || '').trim().toUpperCase();
  const date = dateKey(item.date);
  const close = Number(item.close);
  if (!stockCode || !date || !Number.isFinite(close) || close <= 0) return false;

  const history = ensureQuoteHistory(store);
  const existing = history.find(row => row.stock_code === stockCode && row.date === date);
  const shouldPreserveProviderRow =
    existing &&
    options.preserveProviderRow &&
    !String(existing.source || '').includes('holding');
  const next = {
    stock_code: stockCode,
    date,
    close,
    source: String(item.source || ''),
    observed_at: String(item.observed_at || new Date().toISOString()),
  };

  if (existing) {
    if (shouldPreserveProviderRow) return false;

    if (
      Number(existing.close) === close &&
      String(existing.source || '') === next.source &&
      String(existing.observed_at || '') === next.observed_at
    ) {
      return false;
    }

    Object.assign(existing, next);
    return true;
  }

  history.push(next);
  return true;
}

function seedQuoteHistoryFromHoldings(store) {
  let changed = false;
  ensureQuoteHistory(store);

  store.holdings.forEach(holding => {
    const currentPrice = Number(holding.current_price);
    const quoteDate = dateKey(holding.quote_time || holding.quote_updated_at || holding.updated_at);
    if (!quoteDate || !Number.isFinite(currentPrice) || currentPrice <= 0) return;

    changed = upsertQuoteHistory(store, {
      stock_code: holding.stock_code,
      date: quoteDate,
      close: currentPrice,
      source: holding.quote_source || 'holding-current',
      observed_at: holding.quote_updated_at || holding.updated_at || new Date().toISOString(),
    }, { preserveProviderRow: true }) || changed;

    const quoteChange = Number(holding.quote_change);
    const previousClose = currentPrice - quoteChange;
    if (Number.isFinite(quoteChange) && quoteChange !== 0 && previousClose > 0) {
      changed = upsertQuoteHistory(store, {
        stock_code: holding.stock_code,
        date: previousTradingDate(quoteDate),
        close: previousClose,
        source: `${holding.quote_source || 'holding'}-previous-close`,
        observed_at: holding.quote_updated_at || holding.updated_at || new Date().toISOString(),
      }, { preserveProviderRow: true }) || changed;
    }
  });

  return changed;
}

function updateHoldingsForTrade(store, trade) {
  const existing = store.holdings.find(holding => holding.stock_code === trade.stock_code);
  const now = new Date().toISOString();
  const commission = Number(trade.commission || 0);
  const grossAmount = trade.quantity * trade.price;
  const tradeSectors = normalizeSectors(trade.sectors);

  function syncStockProfile(holding) {
    holding.stock_name = trade.stock_name || holding.stock_name;
    if (tradeSectors.length > 0) holding.sectors = tradeSectors;
    holding.updated_at = now;
  }

  if (trade.trade_type === 'buy') {
    if (existing) {
      const newQty = Number(existing.quantity) + trade.quantity;
      const newCost = Number(existing.total_cost) + grossAmount + commission;
      existing.quantity = newQty;
      existing.total_cost = newCost;
      existing.cost_price = newCost / newQty;
      existing.current_price = Number(existing.current_price || trade.price);
      syncStockProfile(existing);
    } else {
      store.holdings.push({
        id: crypto.randomUUID(),
        stock_code: trade.stock_code,
        stock_name: trade.stock_name,
        sectors: tradeSectors,
        quantity: trade.quantity,
        cost_price: (grossAmount + commission) / trade.quantity,
        total_cost: grossAmount + commission,
        current_price: trade.price,
        updated_at: now,
        created_at: now,
      });
    }
    return;
  }

  if (!existing) return;
  const newQty = Number(existing.quantity) - trade.quantity;
  if (newQty <= 0) {
    store.holdings = store.holdings.filter(holding => holding.stock_code !== trade.stock_code);
  } else {
    existing.quantity = newQty;
    existing.total_cost = Number(existing.cost_price) * newQty;
    syncStockProfile(existing);
  }
}

function tradeFromBody(body, user, existing = {}) {
  const stockCode = String(body.stock_code || '').trim().toUpperCase();
  const stockName = String(body.stock_name || '').trim();
  const tradeType = body.trade_type;
  const quantity = numberFrom(body.quantity, 'quantity');
  const price = numberFrom(body.price, 'price');
  const commission = optionalNumberFrom(body.commission, 'commission', 0);
  const sectors = normalizeSectors(body.sectors);
  const tradeTime = new Date(body.trade_time);

  if (!stockCode || !stockName) throw new Error('stock_code and stock_name are required');
  if (!['buy', 'sell'].includes(tradeType)) throw new Error('trade_type must be buy or sell');
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('quantity must be a positive integer');
  if (price <= 0) throw new Error('price must be greater than 0');
  if (commission < 0) throw new Error('commission must be greater than or equal to 0');
  if (Number.isNaN(tradeTime.getTime())) throw new Error('trade_time is invalid');

  const now = new Date().toISOString();
  return {
    id: existing.id || crypto.randomUUID(),
    stock_code: stockCode,
    stock_name: stockName,
    sectors,
    trade_type: tradeType,
    quantity,
    price,
    commission,
    trade_time: tradeTime.toISOString(),
    note: String(body.note || ''),
    created_by: existing.created_by || user.id,
    created_at: existing.created_at || now,
  };
}

function rebuildHoldingsFromTrades(store) {
  const previousHoldings = new Map(
    (store.holdings || []).map(holding => [String(holding.stock_code || '').toUpperCase(), { ...holding }])
  );

  store.holdings = [];
  [...(store.trades || [])]
    .sort((a, b) => {
      const dateDiff = new Date(a.trade_time).getTime() - new Date(b.trade_time).getTime();
      if (dateDiff !== 0) return dateDiff;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    })
    .forEach(trade => updateHoldingsForTrade(store, trade));

  store.holdings.forEach(holding => {
    const previous = previousHoldings.get(String(holding.stock_code || '').toUpperCase());
    if (!previous) return;

    holding.id = previous.id || holding.id;
    holding.created_at = previous.created_at || holding.created_at;
    if (Number(previous.current_price) > 0) holding.current_price = Number(previous.current_price);

    [
      'quote_symbol',
      'quote_source',
      'quote_time',
      'quote_change',
      'quote_change_percent',
      'quote_updated_at',
    ].forEach(field => {
      if (previous[field] !== undefined && previous[field] !== null && previous[field] !== '') {
        holding[field] = previous[field];
      }
    });
  });
}

function normalizeTencentSymbol(stockCode) {
  const code = String(stockCode || '').trim().toUpperCase();
  if (PRICE_SYMBOL_MAP[code]) return PRICE_SYMBOL_MAP[code];
  if (!code) return '';

  const compact = code.replace(/\s+/g, '');
  if (/^(SH|SZ|HK|US)[A-Z0-9.]+$/i.test(compact)) {
    return compact.toLowerCase().startsWith('us')
      ? `us${compact.slice(2).toUpperCase()}`
      : compact.toLowerCase();
  }

  if (/^\d{6}$/.test(compact)) {
    return compact.startsWith('6') || compact.startsWith('9') ? `sh${compact}` : `sz${compact}`;
  }

  if (/^\d{5}$/.test(compact)) {
    return `hk${compact}`;
  }

  const usCode = compact
    .replace(/\.US$/, '')
    .replace(/\.OQ$/, '')
    .replace(/\.N$/, '');
  return `us${usCode}`;
}

function warnProviderOnce(key, error) {
  if (providerWarnings.has(key)) return;
  providerWarnings.add(key);
  console.warn(`[stock-app] ${key}: ${error && error.message ? error.message : error}`);
}

function normalizeAlpacaBaseUrl(value) {
  const fallback = 'https://data.alpaca.markets/v2';
  const candidate = String(value || '').trim();
  if (!candidate) return fallback;
  if (/^https:\/\/(paper-)?api\.alpaca\.markets\/v2\/?$/i.test(candidate)) {
    return fallback;
  }
  if (/^https?:\/\/.+\/v2\/?$/i.test(candidate)) return candidate.replace(/\/+$/, '');
  return fallback;
}

function normalizeAlpacaSymbol(stockCode) {
  const code = String(stockCode || '').trim().toUpperCase();
  if (ALPACA_SYMBOL_MAP[code]) return ALPACA_SYMBOL_MAP[code];
  if (!code) return '';

  return code
    .replace(/\s+/g, '')
    .replace(/^US/i, '')
    .replace(/\.US$/i, '')
    .replace(/\.OQ$/i, '')
    .replace(/\.N$/i, '');
}

function alpacaSymbolPairs(stockCodes) {
  return stockCodes
    .map(stockCode => ({
      stockCode: String(stockCode || '').trim().toUpperCase(),
      quoteSymbol: normalizeAlpacaSymbol(stockCode),
    }))
    .filter(item => item.stockCode && item.quoteSymbol);
}

function alpacaHeaders() {
  if (!ALPACA_API_KEY_ID || !ALPACA_API_SECRET_KEY) {
    throw new Error('Alpaca API credentials are not configured');
  }

  return {
    Accept: 'application/json',
    'APCA-API-KEY-ID': ALPACA_API_KEY_ID,
    'APCA-API-SECRET-KEY': ALPACA_API_SECRET_KEY,
  };
}

async function fetchAlpacaJson(pathname, params, timeoutMs) {
  const url = new URL(pathname.replace(/^\/+/, ''), `${ALPACA_DATA_BASE_URL}/`);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  const response = await fetch(url, {
    headers: alpacaHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const message = payload.message || payload.error || `Alpaca provider returned ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

function alpacaBarClose(bar) {
  const close = Number(bar && bar.c);
  return Number.isFinite(close) && close > 0 ? close : null;
}

async function fetchAlpacaQuotes(stockCodes) {
  const symbolPairs = alpacaSymbolPairs(stockCodes);
  const uniqueSymbols = [...new Set(symbolPairs.map(item => item.quoteSymbol))];
  if (uniqueSymbols.length === 0) return { quotes: new Map(), symbolPairs };

  const [latestTradesPayload, latestBarsPayload, latestQuotesPayload, recentDailyHistory] = await Promise.all([
    fetchAlpacaJson(
      'stocks/trades/latest',
      { symbols: uniqueSymbols.join(','), feed: ALPACA_DATA_FEED },
      ALPACA_QUOTE_TIMEOUT_MS,
    ),
    fetchAlpacaJson(
      'stocks/bars/latest',
      { symbols: uniqueSymbols.join(','), feed: ALPACA_DATA_FEED },
      ALPACA_QUOTE_TIMEOUT_MS,
    ),
    fetchAlpacaJson(
      'stocks/quotes/latest',
      { symbols: uniqueSymbols.join(','), feed: ALPACA_DATA_FEED },
      ALPACA_QUOTE_TIMEOUT_MS,
    ),
    fetchAlpacaDailyHistory(
      stockCodes,
      addDays(dateKey(new Date()), -14),
      dateKey(new Date()),
    ).catch(error => {
      warnProviderOnce('Alpaca daily bars for quote changes unavailable', error);
      return [];
    }),
  ]);
  const latestTrades = latestTradesPayload.trades && typeof latestTradesPayload.trades === 'object'
    ? latestTradesPayload.trades
    : {};
  const latestBars = latestBarsPayload.bars && typeof latestBarsPayload.bars === 'object'
    ? latestBarsPayload.bars
    : {};
  const latestQuotes = latestQuotesPayload.quotes && typeof latestQuotesPayload.quotes === 'object'
    ? latestQuotesPayload.quotes
    : {};
  const historyByCode = new Map();
  recentDailyHistory.forEach(item => {
    if (!historyByCode.has(item.stock_code)) historyByCode.set(item.stock_code, []);
    historyByCode.get(item.stock_code).push({ date: item.date, close: item.close });
  });
  historyByCode.forEach(rows => rows.sort((a, b) => compareDateKeys(a.date, b.date)));

  function priceInfoForSymbol(quoteSymbol) {
    const trade = latestTrades[quoteSymbol] || latestTrades[String(quoteSymbol).toUpperCase()];
    const tradePrice = Number(trade && trade.p);
    if (Number.isFinite(tradePrice) && tradePrice > 0) {
      return { price: tradePrice, time: String(trade.t || new Date().toISOString()) };
    }

    const bar = latestBars[quoteSymbol] || latestBars[String(quoteSymbol).toUpperCase()];
    const barClose = alpacaBarClose(bar);
    if (barClose) {
      return { price: barClose, time: String(bar.t || new Date().toISOString()) };
    }

    const quote = latestQuotes[quoteSymbol] || latestQuotes[String(quoteSymbol).toUpperCase()];
    const bid = Number(quote && quote.bp);
    const ask = Number(quote && quote.ap);
    if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0) {
      return { price: (bid + ask) / 2, time: String(quote.t || new Date().toISOString()) };
    }

    return null;
  }

  function previousCloseForStock(stockCode, quoteDate) {
    const rows = historyByCode.get(stockCode) || [];
    let match = null;
    rows.forEach(row => {
      if (!quoteDate || compareDateKeys(row.date, quoteDate) < 0) match = row.close;
    });
    if (match) return match;
    return rows.length >= 2 ? rows[rows.length - 2].close : null;
  }

  const quotes = new Map();
  symbolPairs.forEach(({ stockCode, quoteSymbol }) => {
    const priceInfo = priceInfoForSymbol(quoteSymbol);
    if (!priceInfo) return;

    const quoteDate = dateKey(priceInfo.time);
    const previousClose = previousCloseForStock(stockCode, quoteDate);
    const quoteChange = previousClose ? priceInfo.price - previousClose : 0;
    const quoteChangePercent = previousClose ? (quoteChange / previousClose) * 100 : 0;

    quotes.set(stockCode, {
      quote_symbol: quoteSymbol,
      current_price: priceInfo.price,
      quote_name: '',
      quote_time: priceInfo.time,
      quote_change: quoteChange,
      quote_change_percent: quoteChangePercent,
      quote_source: `alpaca-${ALPACA_DATA_FEED}`,
      quote_updated_at: new Date().toISOString(),
    });
  });

  return { quotes, symbolPairs };
}

async function fetchAlpacaDailyHistory(stockCodes, fromDate, toDate) {
  const updates = [];
  const symbolPairs = alpacaSymbolPairs(stockCodes);
  const uniqueSymbols = [...new Set(symbolPairs.map(item => item.quoteSymbol))];
  if (uniqueSymbols.length === 0) return updates;

  let pageToken = '';
  const endExclusive = addDays(toDate, 1);
  const symbolByQuoteSymbol = new Map(symbolPairs.map(item => [item.quoteSymbol, item.stockCode]));

  do {
    const payload = await fetchAlpacaJson(
      'stocks/bars',
      {
        symbols: uniqueSymbols.join(','),
        timeframe: '1Day',
        start: fromDate,
        end: endExclusive,
        limit: 10000,
        adjustment: ALPACA_DATA_ADJUSTMENT,
        feed: ALPACA_DATA_FEED,
        page_token: pageToken,
      },
      ALPACA_HISTORY_TIMEOUT_MS,
    );
    const barsBySymbol = payload.bars && typeof payload.bars === 'object' ? payload.bars : {};
    Object.entries(barsBySymbol).forEach(([quoteSymbol, rows]) => {
      const stockCode = symbolByQuoteSymbol.get(quoteSymbol);
      if (!stockCode || !Array.isArray(rows)) return;

      rows.forEach(row => {
        const date = dateKey(row && row.t);
        const close = alpacaBarClose(row);
        if (!date || compareDateKeys(date, fromDate) < 0 || compareDateKeys(date, toDate) > 0 || !close) return;

        updates.push({
          stock_code: stockCode,
          date,
          close,
          source: `alpaca-${ALPACA_DATA_FEED}-${ALPACA_DATA_ADJUSTMENT}`,
          observed_at: new Date().toISOString(),
        });
      });
    });
    pageToken = String(payload.next_page_token || '');
  } while (pageToken);

  return updates;
}

function parseTencentQuotes(rawText) {
  const quotes = new Map();
  const quotePattern = /v_([^=]+)="([^"]*)";/g;
  let match;

  while ((match = quotePattern.exec(rawText))) {
    const quoteSymbol = match[1];
    const fields = match[2].split('~');
    const currentPrice = Number(fields[3]);
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) continue;

    quotes.set(quoteSymbol.toLowerCase(), {
      quote_symbol: quoteSymbol,
      current_price: currentPrice,
      quote_name: fields[1] || '',
      quote_time: fields[30] || '',
      quote_change: Number(fields[31]) || 0,
      quote_change_percent: Number(fields[32]) || 0,
      quote_source: 'tencent',
      quote_updated_at: new Date().toISOString(),
    });
  }

  return quotes;
}

async function fetchTencentQuotes(stockCodes) {
  const symbolPairs = stockCodes
    .map(stockCode => ({ stockCode, quoteSymbol: normalizeTencentSymbol(stockCode) }))
    .filter(item => item.quoteSymbol);

  const uniqueSymbols = [...new Set(symbolPairs.map(item => item.quoteSymbol))];
  if (uniqueSymbols.length === 0) return { quotes: new Map(), symbolPairs };

  const endpoint = `https://qt.gtimg.cn/q=${uniqueSymbols.map(symbol => encodeURIComponent(symbol)).join(',')}`;
  const response = await fetch(endpoint, {
    headers: {
      'User-Agent': 'Mozilla/5.0 stock-portfolio/1.0',
      Accept: 'text/plain,*/*',
    },
    signal: AbortSignal.timeout(QUOTE_REFRESH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Quote provider returned ${response.status}`);
  }

  const text = await response.text();
  return { quotes: parseTencentQuotes(text), symbolPairs };
}

async function fetchTencentDailyHistory(stockCodes, fromDate, toDate) {
  const updates = [];
  const symbolPairs = stockCodes
    .map(stockCode => ({ stockCode, quoteSymbol: normalizeTencentSymbol(stockCode) }))
    .filter(item => item.quoteSymbol);
  const uniquePairs = [...new Map(symbolPairs.map(item => [item.stockCode, item])).values()];

  await Promise.all(uniquePairs.map(async ({ stockCode, quoteSymbol }) => {
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${encodeURIComponent(quoteSymbol)},day,${fromDate},${toDate},320,qfq`;

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 stock-portfolio/1.0',
          Referer: 'https://gu.qq.com/',
          Accept: 'application/json,text/plain,*/*',
        },
        signal: AbortSignal.timeout(NAV_HISTORY_TIMEOUT_MS),
      });
      if (!response.ok) return;

      const payload = await response.json();
      const rows = payload && payload.data && payload.data[quoteSymbol] && payload.data[quoteSymbol].day;
      if (!Array.isArray(rows)) return;

      rows.forEach(row => {
        if (!Array.isArray(row)) return;
        const date = dateKey(row[0]);
        const close = Number(row[2]);
        if (!date || compareDateKeys(date, fromDate) < 0 || compareDateKeys(date, toDate) > 0) return;
        if (!Number.isFinite(close) || close <= 0) return;

        updates.push({
          stock_code: stockCode,
          date,
          close,
          source: 'tencent-history',
          observed_at: new Date().toISOString(),
        });
      });
    } catch {
      // Historical data is best effort; cached quotes and trade prices still produce a transparent series.
    }
  }));

  return updates;
}

async function refreshHoldingPrices(store) {
  const stockCodes = store.holdings.map(holding => String(holding.stock_code || '').toUpperCase()).filter(Boolean);
  const { quotes } = await fetchAlpacaQuotes(stockCodes);
  const failed = [];
  const refreshed = [];

  store.holdings.forEach(holding => {
    const stockCode = String(holding.stock_code || '').toUpperCase();
    const quote = quotes.get(stockCode);
    if (!quote) {
      failed.push(holding.stock_code);
      return;
    }

    holding.current_price = quote.current_price;
    holding.quote_symbol = quote.quote_symbol;
    holding.quote_source = quote.quote_source;
    holding.quote_time = quote.quote_time;
    holding.quote_change = quote.quote_change;
    holding.quote_change_percent = quote.quote_change_percent;
    holding.quote_updated_at = quote.quote_updated_at;
    holding.updated_at = quote.quote_updated_at;
    const quoteDate = dateKey(quote.quote_time || quote.quote_updated_at);
    upsertQuoteHistory(store, {
      stock_code: holding.stock_code,
      date: quoteDate,
      close: quote.current_price,
      source: quote.quote_source,
      observed_at: quote.quote_updated_at,
    });
    if (Number.isFinite(Number(quote.quote_change)) && Number(quote.quote_change) !== 0) {
      const previousClose = quote.current_price - Number(quote.quote_change);
      if (quoteDate && previousClose > 0) {
        upsertQuoteHistory(store, {
          stock_code: holding.stock_code,
          date: previousTradingDate(quoteDate),
          close: previousClose,
          source: `${quote.quote_source}-previous-close`,
          observed_at: quote.quote_updated_at,
        });
      }
    }
    refreshed.push(holding.stock_code);
  });

  if (refreshed.length > 0) {
    writeStore(store);
  }

  return {
    holdings: [...store.holdings].sort((a, b) => a.stock_code.localeCompare(b.stock_code)),
    refreshed,
    failed,
    refreshed_at: new Date().toISOString(),
  };
}

function buildQuoteMaps(store) {
  const byCode = new Map();
  ensureQuoteHistory(store).forEach(item => {
    const stockCode = String(item.stock_code || '').toUpperCase();
    const date = dateKey(item.date);
    const close = Number(item.close);
    if (!stockCode || !date || !Number.isFinite(close) || close <= 0) return;
    if (!byCode.has(stockCode)) byCode.set(stockCode, []);
    byCode.get(stockCode).push({ date, close });
  });

  byCode.forEach(rows => rows.sort((a, b) => compareDateKeys(a.date, b.date)));
  return byCode;
}

function latestQuotePriceOnOrBefore(quoteMaps, stockCode, date) {
  const rows = quoteMaps.get(stockCode);
  if (!rows || rows.length === 0) return null;

  let match = null;
  for (const row of rows) {
    if (compareDateKeys(row.date, date) > 0) break;
    match = row;
  }
  return match;
}

function valuePortfolio({ cash, positions, latestTradePrices, quoteMaps }, date) {
  let marketValue = 0;
  let pricedPositions = 0;
  let quotePricedPositions = 0;
  let fallbackPricedPositions = 0;
  let missingPriceCount = 0;

  positions.forEach((quantity, stockCode) => {
    if (quantity <= 0) return;
    const quote = latestQuotePriceOnOrBefore(quoteMaps, stockCode, date);
    const fallbackPrice = latestTradePrices.get(stockCode);
    const price = quote ? quote.close : fallbackPrice;

    if (!Number.isFinite(price) || price <= 0) {
      missingPriceCount += 1;
      return;
    }

    pricedPositions += 1;
    if (quote) quotePricedPositions += 1;
    else fallbackPricedPositions += 1;
    marketValue += quantity * price;
  });

  return {
    cash,
    fallbackPricedPositions,
    marketValue,
    missingPriceCount,
    pricedPositions,
    quotePricedPositions,
    totalAssets: cash + marketValue,
  };
}

function adjustPosition(positions, stockCode, delta) {
  const next = Number(positions.get(stockCode) || 0) + delta;
  if (Math.abs(next) < 1e-9) positions.delete(stockCode);
  else positions.set(stockCode, next);
}

function sortedTradeEvents(trades) {
  return [...trades]
    .map(trade => ({ ...trade, date: dateKey(trade.trade_time), time: new Date(trade.trade_time).getTime() }))
    .filter(trade => trade.date && Number.isFinite(trade.time))
    .sort((a, b) => a.time - b.time);
}

function sortedFundFlowEvents(flows) {
  return [...flows]
    .map(flow => ({ ...flow, date: dateKey(flow.flow_date), time: new Date(flow.created_at || flow.flow_date).getTime() }))
    .filter(flow => flow.date && Number.isFinite(flow.time))
    .sort((a, b) => a.time - b.time);
}

function buildPortfolioNavSeries(store, range) {
  const trades = sortedTradeEvents(store.trades || []);
  const fundFlows = sortedFundFlowEvents(store.fund_flows || []);
  const quoteMaps = buildQuoteMaps(store);
  const quoteDates = ensureQuoteHistory(store).map(item => dateKey(item.date)).filter(Boolean);
  const tradeDates = trades.map(trade => trade.date);
  const flowDates = fundFlows.map(flow => flow.date);
  const firstTradeDate = [...tradeDates].sort(compareDateKeys)[0] || '';
  const firstFlowDate = [...flowDates].sort(compareDateKeys)[0] || '';
  const allDates = [...quoteDates, ...tradeDates, ...flowDates].sort(compareDateKeys);
  const latestDate = allDates[allDates.length - 1] || dateKey(new Date());
  const firstEventDate = [...tradeDates, ...flowDates].sort(compareDateKeys)[0] || latestDate;
  const startDate = rangeStartDate(range, latestDate);
  const processStartDate = compareDateKeys(firstEventDate, startDate) < 0 ? firstEventDate : startDate;
  const eventDates = new Set([...tradeDates, ...flowDates, latestDate]);
  const valuationDates = enumerateValuationDates(processStartDate, latestDate, eventDates);
  const inferTradeFlows =
    fundFlows.length === 0 ||
    Boolean(firstTradeDate && firstFlowDate && compareDateKeys(firstFlowDate, firstTradeDate) > 0);
  const state = {
    cash: 0,
    latestTradePrices: new Map(),
    positions: new Map(),
    quoteMaps,
    units: 0,
    lastUnitNav: 1,
  };
  const points = [];
  let tradeIndex = 0;
  let flowIndex = 0;
  let totalFallbackPricedPositions = 0;
  let totalMissingPriceCount = 0;
  let totalQuotePricedPositions = 0;

  function currentNav(date) {
    if (state.units <= 0) return state.lastUnitNav || 1;
    const valuation = valuePortfolio(state, date);
    return valuation.totalAssets > 0 ? valuation.totalAssets / state.units : state.lastUnitNav || 1;
  }

  function applyFundFlow(flow) {
    const amount = Number(flow.amount);
    if (!Number.isFinite(amount) || amount <= 0) return;

    const nav = currentNav(flow.date);
    if (flow.flow_type === 'deposit') {
      state.units += amount / nav;
      state.cash += amount;
      return;
    }

    const unitsToBurn = Math.min(state.units, amount / nav);
    state.units -= unitsToBurn;
    state.cash -= amount;
  }

  function applyTrade(trade) {
    const stockCode = String(trade.stock_code || '').toUpperCase();
    const quantity = Number(trade.quantity);
    const price = Number(trade.price);
    const commission = Number(trade.commission || 0);
    if (!stockCode || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) return;

    const grossAmount = quantity * price;
    state.latestTradePrices.set(stockCode, price);

    if (inferTradeFlows && trade.trade_type === 'buy') {
      const contribution = grossAmount + commission;
      const nav = currentNav(trade.date);
      state.units += contribution / nav;
      adjustPosition(state.positions, stockCode, quantity);
      state.lastUnitNav = currentNav(trade.date);
      return;
    }

    if (inferTradeFlows && trade.trade_type === 'sell') {
      const nav = currentNav(trade.date);
      const proceeds = Math.max(0, grossAmount - commission);
      adjustPosition(state.positions, stockCode, -quantity);
      state.units -= Math.min(state.units, proceeds / nav);
      state.lastUnitNav = state.units > 0 ? currentNav(trade.date) : nav;
      return;
    }

    if (trade.trade_type === 'buy') {
      state.cash -= grossAmount + commission;
      adjustPosition(state.positions, stockCode, quantity);
    } else {
      state.cash += grossAmount - commission;
      adjustPosition(state.positions, stockCode, -quantity);
    }
  }

  valuationDates.forEach(date => {
    while (flowIndex < fundFlows.length && compareDateKeys(fundFlows[flowIndex].date, date) <= 0) {
      applyFundFlow(fundFlows[flowIndex]);
      flowIndex += 1;
    }

    while (tradeIndex < trades.length && compareDateKeys(trades[tradeIndex].date, date) <= 0) {
      applyTrade(trades[tradeIndex]);
      tradeIndex += 1;
    }

    if (compareDateKeys(date, startDate) < 0 || state.units <= 0) return;

    const valuation = valuePortfolio(state, date);
    if (valuation.totalAssets <= 0 || valuation.missingPriceCount > 0) {
      totalMissingPriceCount += valuation.missingPriceCount;
      return;
    }

    const unitNav = valuation.totalAssets / state.units;
    state.lastUnitNav = unitNav;
    totalFallbackPricedPositions += valuation.fallbackPricedPositions;
    totalQuotePricedPositions += valuation.quotePricedPositions;

    points.push({
      cashBalance: Number(valuation.cash.toFixed(4)),
      date,
      fallbackPricedPositions: valuation.fallbackPricedPositions,
      marketValue: Number(valuation.marketValue.toFixed(4)),
      quotePricedPositions: valuation.quotePricedPositions,
      totalAssets: Number(valuation.totalAssets.toFixed(4)),
      unitNav: Number(unitNav.toFixed(6)),
      units: Number(state.units.toFixed(6)),
    });
  });

  const first = points[0];
  const last = points[points.length - 1];
  const returnRate = first && last ? ((last.unitNav - first.unitNav) / first.unitNav) * 100 : null;
  const dataNote = totalMissingPriceCount > 0
    ? '单位净值按交易记录重建；缺失价格的日期已跳过'
    : totalFallbackPricedPositions > 0
      ? '单位净值按交易记录重建；部分日期缺少历史收盘价，使用最近成交价估值'
      : inferTradeFlows && fundFlows.length > 0
        ? '单位净值按交易记录推断早期资金流，并叠加资金流水和历史收盘价计算'
        : inferTradeFlows
          ? '单位净值按交易记录推断资金流，并结合历史收盘价计算'
          : '单位净值按交易记录、资金流水和历史收盘价计算';

  return {
    data_note: dataNote,
    fallback_priced_positions: totalFallbackPricedPositions,
    generated_at: new Date().toISOString(),
    infer_trade_flows: inferTradeFlows,
    latest_date: latestDate,
    points,
    quote_priced_positions: totalQuotePricedPositions,
    range,
    return_rate: Number.isFinite(returnRate) ? Number(returnRate.toFixed(4)) : null,
    start_date: startDate,
  };
}

async function getPortfolioNav(store, range) {
  const normalizedRange = normalizePerformanceRange(range);
  let changed = seedQuoteHistoryFromHoldings(store);
  if (changed) writeStore(store);

  const now = Date.now();
  const initialVersion = portfolioNavCacheVersion(store);
  const initialCacheKey = portfolioNavCacheKey(normalizedRange, initialVersion);
  const cached = portfolioNavCache.get(initialCacheKey);
  if (NAV_CACHE_TTL_MS > 0 && cached && cached.expiresAt > now) {
    return cached.result;
  }

  const inflight = portfolioNavInflight.get(initialCacheKey);
  if (inflight) return inflight;

  const request = (async () => {
    const result = await buildFreshPortfolioNav(store, normalizedRange);
    if (NAV_CACHE_TTL_MS > 0) {
      const finalVersion = portfolioNavCacheVersion(store);
      portfolioNavCache.set(portfolioNavCacheKey(normalizedRange, finalVersion), {
        expiresAt: Date.now() + NAV_CACHE_TTL_MS,
        result,
      });
      prunePortfolioNavCache();
    }
    return result;
  })();

  portfolioNavInflight.set(initialCacheKey, request);
  try {
    return await request;
  } finally {
    portfolioNavInflight.delete(initialCacheKey);
  }
}

async function buildFreshPortfolioNav(store, normalizedRange) {
  let changed = false;
  const allStockCodes = [
    ...new Set([
      ...store.holdings.map(item => item.stock_code),
      ...store.trades.map(item => item.stock_code),
    ].filter(Boolean).map(item => String(item).toUpperCase())),
  ];
  const seededDates = ensureQuoteHistory(store).map(item => dateKey(item.date)).filter(Boolean).sort(compareDateKeys);
  const latestDate = seededDates[seededDates.length - 1] || dateKey(new Date());
  const fromDate = rangeStartDate(normalizedRange, latestDate);
  let historyUpdates = [];

  try {
    historyUpdates = await fetchAlpacaDailyHistory(allStockCodes, fromDate, latestDate);
  } catch (error) {
    warnProviderOnce('Alpaca history provider unavailable; using cached quote history', error);
  }

  historyUpdates.forEach(item => {
    changed = upsertQuoteHistory(store, item) || changed;
  });

  if (changed) writeStore(store);
  return buildPortfolioNavSeries(store, normalizedRange);
}

async function handleApi(req, res, url) {
  try {
    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (isLoginRateLimited(req)) {
        sendError(res, 429, 'Too many login attempts. Please try again later.');
        return;
      }

      const body = await readBody(req);
      const username = String(body.username || '');
      const password = String(body.password || '');
      const user = users.find(item => item.username === username || item.id === username);

      if (!user || !safePasswordEqual(password, user.password)) {
        recordFailedLogin(req);
        sendError(res, 401, 'Invalid username or password');
        return;
      }

      clearFailedLogins(req);
      const sessionToken = createSessionToken(user);
      sendJson(res, 200, { user: publicUser(user) }, {
        'Set-Cookie': sessionCookie(sessionToken, Math.floor(SESSION_TTL_MS / 1000)),
      });
      return;
    }

    if (url.pathname === '/api/logout' && req.method === 'POST') {
      sendJson(res, 200, { ok: true }, {
        'Set-Cookie': sessionCookie('', 0),
      });
      return;
    }

    const user = requireAuth(req, res);
    if (!user) return;

    if (url.pathname === '/api/me' && req.method === 'GET') {
      sendJson(res, 200, { user: publicUser(user) });
      return;
    }

    const logoMatch = url.pathname.match(/^\/api\/logos\/([^/]+)$/);
    if (logoMatch && req.method === 'GET') {
      const symbol = normalizeLogoSymbol(decodeURIComponent(logoMatch[1]));
      if (!symbol) {
        sendError(res, 404, 'Logo not found');
        return;
      }

      await sendTickerLogo(res, symbol);
      return;
    }

    if (url.pathname === '/api/holdings' && req.method === 'GET') {
      const store = readStore();
      sendJson(res, 200, {
        holdings: [...store.holdings].sort((a, b) => a.stock_code.localeCompare(b.stock_code)),
      });
      return;
    }

    if (url.pathname === '/api/holdings/refresh-prices' && req.method === 'POST') {
      const store = readStore();
      const result = await refreshHoldingPrices(store);
      sendJson(res, 200, result);
      return;
    }

    if (url.pathname === '/api/portfolio/nav' && req.method === 'GET') {
      const store = readStore();
      const result = await getPortfolioNav(store, url.searchParams.get('range') || '7D');
      sendJson(res, 200, result);
      return;
    }

    const priceMatch = url.pathname.match(/^\/api\/holdings\/([^/]+)\/current-price$/);
    if (priceMatch && req.method === 'PATCH') {
      if (!requireOperator(user, res)) return;
      const id = decodeURIComponent(priceMatch[1]);
      const body = await readBody(req);
      const currentPrice = numberFrom(body.current_price, 'current_price');
      if (currentPrice <= 0) throw new Error('current_price must be greater than 0');

      const store = readStore();
      const holding = store.holdings.find(item => item.id === id);
      if (!holding) {
        sendError(res, 404, 'Holding not found');
        return;
      }

      holding.current_price = currentPrice;
      holding.updated_at = new Date().toISOString();
      writeStore(store);
      sendJson(res, 200, { holding });
      return;
    }

    if (url.pathname === '/api/trades' && req.method === 'GET') {
      const store = readStore();
      const stockCode = url.searchParams.get('stock_code');
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      let trades = store.trades;

      if (stockCode) trades = trades.filter(trade => trade.stock_code === stockCode.toUpperCase());
      if (from) trades = trades.filter(trade => new Date(trade.trade_time) >= new Date(from));
      if (to) trades = trades.filter(trade => new Date(trade.trade_time) <= new Date(to));

      sendJson(res, 200, { trades: sortByDateDesc(trades, 'trade_time') });
      return;
    }

    if (url.pathname === '/api/trades' && req.method === 'POST') {
      if (!requireOperator(user, res)) return;
      const body = await readBody(req);
      const trade = tradeFromBody(body, user);

      const store = readStore();
      store.trades.push(trade);
      updateHoldingsForTrade(store, trade);
      writeStore(store);
      sendJson(res, 201, { trade });
      return;
    }

    const tradeMatch = url.pathname.match(/^\/api\/trades\/([^/]+)$/);
    if (tradeMatch && req.method === 'PATCH') {
      if (!requireOperator(user, res)) return;
      const id = decodeURIComponent(tradeMatch[1]);
      const body = await readBody(req);
      const store = readStore();
      const index = store.trades.findIndex(trade => trade.id === id);

      if (index < 0) {
        sendError(res, 404, 'Trade not found');
        return;
      }

      const trade = tradeFromBody(body, user, store.trades[index]);
      store.trades[index] = trade;
      rebuildHoldingsFromTrades(store);
      writeStore(store);
      sendJson(res, 200, { trade });
      return;
    }

    if (tradeMatch && req.method === 'DELETE') {
      if (!requireOperator(user, res)) return;
      const id = decodeURIComponent(tradeMatch[1]);
      const store = readStore();
      const existing = store.trades.find(trade => trade.id === id);

      if (!existing) {
        sendError(res, 404, 'Trade not found');
        return;
      }

      store.trades = store.trades.filter(trade => trade.id !== id);
      rebuildHoldingsFromTrades(store);
      writeStore(store);
      sendJson(res, 200, { ok: true, trade: existing });
      return;
    }

    if (url.pathname === '/api/fund-flows' && req.method === 'GET') {
      const store = readStore();
      const fundFlows = [...store.fund_flows].sort((a, b) => {
        const dateDiff = new Date(b.flow_date).getTime() - new Date(a.flow_date).getTime();
        if (dateDiff !== 0) return dateDiff;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
      sendJson(res, 200, { fund_flows: fundFlows });
      return;
    }

    if (url.pathname === '/api/fund-flows' && req.method === 'POST') {
      if (!requireOperator(user, res)) return;
      const body = await readBody(req);
      const flowType = body.flow_type;
      const amount = numberFrom(body.amount, 'amount');
      const flowDate = new Date(body.flow_date);
      if (!['deposit', 'withdraw'].includes(flowType)) throw new Error('flow_type must be deposit or withdraw');
      if (amount <= 0) throw new Error('amount must be greater than 0');
      if (Number.isNaN(flowDate.getTime())) throw new Error('flow_date is invalid');

      const store = readStore();
      const ordered = [...store.fund_flows].sort((a, b) => {
        const dateDiff = new Date(b.flow_date).getTime() - new Date(a.flow_date).getTime();
        if (dateDiff !== 0) return dateDiff;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
      const lastBalance = ordered.length > 0 ? Number(ordered[0].balance_after) : 0;
      const balanceAfter = flowType === 'deposit' ? lastBalance + amount : lastBalance - amount;
      const now = new Date().toISOString();
      const fundFlow = {
        id: crypto.randomUUID(),
        flow_type: flowType,
        amount,
        balance_after: balanceAfter,
        note: String(body.note || ''),
        flow_date: body.flow_date,
        created_by: user.id,
        created_at: now,
      };

      store.fund_flows.push(fundFlow);
      writeStore(store);
      sendJson(res, 201, { fund_flow: fundFlow });
      return;
    }

    sendError(res, 404, 'API route not found');
  } catch (error) {
    sendError(res, 400, error.message || 'Bad request');
  }
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath);
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  }[ext] || 'application/octet-stream';
}

function serveStatic(req, res, url) {
  if (!fs.existsSync(STATIC_DIR)) {
    sendError(res, 503, 'Frontend build is missing. Run npm run build before npm start.');
    return;
  }

  const pathname = decodeURIComponent(url.pathname);
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let filePath = path.resolve(STATIC_DIR, requested);

  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(STATIC_DIR, 'index.html');
  }

  res.writeHead(200, {
    'Content-Type': contentTypeFor(filePath),
    'Cache-Control': 'no-store',
    ...securityHeaders(),
  });
  fs.createReadStream(filePath).pipe(res);
}

storage.ensure();

http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()), storage: storage.driver });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url);
    return;
  }

  serveStatic(req, res, url);
}).listen(PORT, HOST, () => {
  console.log(`[stock-app] listening on http://${HOST}:${PORT}`);
  console.log(`[stock-app] storage: ${storage.driver}`);
  console.log(`[stock-app] data file: ${storage.driver === 'sqlite' ? storage.dbFile : storage.dataFile}`);
});
