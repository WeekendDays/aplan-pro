import {
  CreateFundFlowInput,
  CreateTradeInput,
  FundFlow,
  Holding,
  PerformanceRange,
  PortfolioNavResult,
  PriceRefreshResult,
  Trade,
  User,
} from './types';

type RequestOptions = Omit<RequestInit, 'body'> & {
  body?: BodyInit | object;
  cacheTtlMs?: number;
  shouldCache?: (data: unknown) => boolean;
};

const PORTFOLIO_DATA_CACHE_TTL_MS = 30 * 1000;
const MAX_CACHED_GET_RESPONSES = 32;
const cachedGetResponses = new Map<string, { data: unknown; expiresAt: number }>();
const inflightGetResponses = new Map<string, Promise<unknown>>();
let cacheVersion = 0;

function clearDataCache() {
  cacheVersion += 1;
  cachedGetResponses.clear();
  inflightGetResponses.clear();
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, cacheTtlMs = 0, shouldCache, ...rest } = options;
  const method = String(rest.method || 'GET').toUpperCase();
  const cacheKey = `${method} ${path}`;
  const isCacheable = method === 'GET' && !body && cacheTtlMs > 0;

  if (isCacheable) {
    const cached = cachedGetResponses.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data as T;
    }

    const inflight = inflightGetResponses.get(cacheKey);
    if (inflight) return inflight as Promise<T>;
  }

  const versionAtStart = cacheVersion;
  const responsePromise = performRequest<T>(path, body, rest, method);

  if (isCacheable) {
    inflightGetResponses.set(cacheKey, responsePromise);
    responsePromise
      .then(data => {
        if (cacheVersion !== versionAtStart) return;
        if (shouldCache && !shouldCache(data)) return;
        cachedGetResponses.set(cacheKey, {
          data,
          expiresAt: Date.now() + cacheTtlMs,
        });
        while (cachedGetResponses.size > MAX_CACHED_GET_RESPONSES) {
          const oldestKey = cachedGetResponses.keys().next().value;
          if (!oldestKey) break;
          cachedGetResponses.delete(oldestKey);
        }
      })
      .catch(() => {
        cachedGetResponses.delete(cacheKey);
      })
      .finally(() => {
        if (inflightGetResponses.get(cacheKey) === responsePromise) {
          inflightGetResponses.delete(cacheKey);
        }
      });
  }

  return responsePromise;
}

async function performRequest<T>(
  path: string,
  body: RequestOptions['body'],
  rest: Omit<RequestOptions, 'body' | 'cacheTtlMs' | 'shouldCache'>,
  method: string
): Promise<T> {
  const headers = new Headers(rest.headers);
  const init: RequestInit = {
    ...rest,
    credentials: 'include',
    headers,
  };

  const shouldJsonEncode =
    body &&
    typeof body === 'object' &&
    !(body instanceof FormData) &&
    !(body instanceof URLSearchParams) &&
    !(body instanceof Blob) &&
    !(body instanceof ArrayBuffer);

  if (shouldJsonEncode) {
    headers.set('Content-Type', 'application/json');
    init.body = JSON.stringify(body);
  } else if (body) {
    init.body = body as BodyInit;
  }

  const response = await fetch(path, init);
  const text = await response.text();
  let data: Record<string, unknown> = {};

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      typeof data.error === 'string' && data.error
        ? data.error
        : `Request failed with ${response.status}`
    );
  }

  if (method !== 'GET') clearDataCache();

  return data as T;
}

export async function getSession(): Promise<User | null> {
  try {
    const result = await request<{ user: User }>('/api/me');
    return result.user;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export async function login(username: string, password: string): Promise<User> {
  const result = await request<{ user: User }>('/api/login', {
    method: 'POST',
    body: { username, password },
  });
  return result.user;
}

export async function logout(): Promise<void> {
  await request<{ ok: boolean }>('/api/logout', { method: 'POST' });
}

export async function getHoldings(): Promise<Holding[]> {
  const result = await request<{ holdings: Holding[] }>('/api/holdings', {
    cacheTtlMs: PORTFOLIO_DATA_CACHE_TTL_MS,
  });
  return result.holdings;
}

export async function refreshHoldingPrices(): Promise<PriceRefreshResult> {
  return request<PriceRefreshResult>('/api/holdings/refresh-prices', { method: 'POST' });
}

export async function getPortfolioNav(range: PerformanceRange): Promise<PortfolioNavResult> {
  return request<PortfolioNavResult>(`/api/portfolio/nav?range=${encodeURIComponent(range)}`, {
    cacheTtlMs: PORTFOLIO_DATA_CACHE_TTL_MS,
    shouldCache: data => Array.isArray((data as PortfolioNavResult).points) && (data as PortfolioNavResult).points.length > 0,
  });
}

export async function updateHoldingCurrentPrice(id: string, currentPrice: number): Promise<Holding> {
  const result = await request<{ holding: Holding }>(
    `/api/holdings/${encodeURIComponent(id)}/current-price`,
    {
      method: 'PATCH',
      body: { current_price: currentPrice },
    }
  );
  return result.holding;
}

export async function getTrades(params: {
  stock_code?: string;
  from?: string;
  to?: string;
} = {}): Promise<Trade[]> {
  const query = new URLSearchParams();
  if (params.stock_code) query.set('stock_code', params.stock_code);
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const result = await request<{ trades: Trade[] }>(`/api/trades${suffix}`, {
    cacheTtlMs: PORTFOLIO_DATA_CACHE_TTL_MS,
  });
  return result.trades;
}

export async function createTrade(input: CreateTradeInput): Promise<Trade> {
  const result = await request<{ trade: Trade }>('/api/trades', {
    method: 'POST',
    body: input,
  });
  return result.trade;
}

export async function getFundFlows(): Promise<FundFlow[]> {
  const result = await request<{ fund_flows: FundFlow[] }>('/api/fund-flows', {
    cacheTtlMs: PORTFOLIO_DATA_CACHE_TTL_MS,
  });
  return result.fund_flows;
}

export async function createFundFlow(input: CreateFundFlowInput): Promise<FundFlow> {
  const result = await request<{ fund_flow: FundFlow }>('/api/fund-flows', {
    method: 'POST',
    body: input,
  });
  return result.fund_flow;
}
