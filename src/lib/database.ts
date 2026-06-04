import {
  CreateFundFlowInput,
  CreateTradeInput,
  FundFlow,
  Holding,
  PriceRefreshResult,
  Trade,
  User,
} from './types';

type RequestOptions = Omit<RequestInit, 'body'> & {
  body?: BodyInit | object;
};

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, ...rest } = options;
  const headers = new Headers(options.headers);
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
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new ApiError(response.status, data.error || `Request failed with ${response.status}`);
  }

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
  const result = await request<{ holdings: Holding[] }>('/api/holdings');
  return result.holdings;
}

export async function refreshHoldingPrices(): Promise<PriceRefreshResult> {
  return request<PriceRefreshResult>('/api/holdings/refresh-prices', { method: 'POST' });
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
  const result = await request<{ trades: Trade[] }>(`/api/trades${suffix}`);
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
  const result = await request<{ fund_flows: FundFlow[] }>('/api/fund-flows');
  return result.fund_flows;
}

export async function createFundFlow(input: CreateFundFlowInput): Promise<FundFlow> {
  const result = await request<{ fund_flow: FundFlow }>('/api/fund-flows', {
    method: 'POST',
    body: input,
  });
  return result.fund_flow;
}
