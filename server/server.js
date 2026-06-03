const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const DATA_FILE = path.resolve(process.env.DATA_FILE || path.join(DATA_DIR, 'store.json'));
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || path.join(process.cwd(), 'dist'));
const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 30);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const QUOTE_REFRESH_TIMEOUT_MS = Number(process.env.QUOTE_REFRESH_TIMEOUT_MS || 10000);
const PRICE_SYMBOL_MAP = process.env.PRICE_SYMBOL_MAP ? JSON.parse(process.env.PRICE_SYMBOL_MAP) : {};
const LOGIN_RATE_LIMIT_WINDOW_MS = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS || 10);

const loginAttempts = new Map();
const users = loadUsers();
validateProductionConfig();

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

function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    writeStore({ holdings: [], trades: [], fund_flows: [] });
  }
}

function readStore() {
  ensureStore();
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  return JSON.parse(raw);
}

function writeStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmpFile = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2));
  fs.renameSync(tmpFile, DATA_FILE);
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

function sortByDateDesc(items, field) {
  return [...items].sort((a, b) => new Date(b[field]).getTime() - new Date(a[field]).getTime());
}

function updateHoldingsForTrade(store, trade) {
  const existing = store.holdings.find(holding => holding.stock_code === trade.stock_code);
  const now = new Date().toISOString();

  if (trade.trade_type === 'buy') {
    if (existing) {
      const newQty = Number(existing.quantity) + trade.quantity;
      const newCost = Number(existing.total_cost) + trade.quantity * trade.price;
      existing.quantity = newQty;
      existing.total_cost = newCost;
      existing.cost_price = newCost / newQty;
      existing.current_price = Number(existing.current_price || trade.price);
      existing.stock_name = trade.stock_name || existing.stock_name;
      existing.updated_at = now;
    } else {
      store.holdings.push({
        id: crypto.randomUUID(),
        stock_code: trade.stock_code,
        stock_name: trade.stock_name,
        quantity: trade.quantity,
        cost_price: trade.price,
        total_cost: trade.quantity * trade.price,
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
    existing.updated_at = now;
  }
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

async function refreshHoldingPrices(store) {
  const stockCodes = store.holdings.map(holding => holding.stock_code);
  const { quotes, symbolPairs } = await fetchTencentQuotes(stockCodes);
  const symbolByCode = new Map(symbolPairs.map(item => [item.stockCode, item.quoteSymbol.toLowerCase()]));
  const refreshed = [];
  const failed = [];

  store.holdings.forEach(holding => {
    const quoteKey = symbolByCode.get(holding.stock_code);
    const quote = quoteKey ? quotes.get(quoteKey) : null;
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
      const stockCode = String(body.stock_code || '').trim().toUpperCase();
      const stockName = String(body.stock_name || '').trim();
      const tradeType = body.trade_type;
      const quantity = numberFrom(body.quantity, 'quantity');
      const price = numberFrom(body.price, 'price');
      const tradeTime = new Date(body.trade_time);

      if (!stockCode || !stockName) throw new Error('stock_code and stock_name are required');
      if (!['buy', 'sell'].includes(tradeType)) throw new Error('trade_type must be buy or sell');
      if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('quantity must be a positive integer');
      if (price <= 0) throw new Error('price must be greater than 0');
      if (Number.isNaN(tradeTime.getTime())) throw new Error('trade_time is invalid');

      const now = new Date().toISOString();
      const trade = {
        id: crypto.randomUUID(),
        stock_code: stockCode,
        stock_name: stockName,
        trade_type: tradeType,
        quantity,
        price,
        trade_time: tradeTime.toISOString(),
        note: String(body.note || ''),
        created_by: user.id,
        created_at: now,
      };

      const store = readStore();
      store.trades.push(trade);
      updateHoldingsForTrade(store, trade);
      writeStore(store);
      sendJson(res, 201, { trade });
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

ensureStore();

http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url);
    return;
  }

  serveStatic(req, res, url);
}).listen(PORT, HOST, () => {
  console.log(`[stock-app] listening on http://${HOST}:${PORT}`);
  console.log(`[stock-app] data file: ${DATA_FILE}`);
});
