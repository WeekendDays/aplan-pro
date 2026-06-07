export type Role = 'operator' | 'viewer';

export interface User {
  id: string;
  name: string;
  avatar: string;
  department: string;
  role: Role;
}

export interface Holding {
  id: string;
  stock_code: string;
  stock_name: string;
  sectors: string[];
  quantity: number;
  cost_price: number;
  total_cost: number;
  current_price: number;
  updated_at: string;
  created_at: string;
  quote_symbol?: string;
  quote_source?: string;
  quote_time?: string;
  quote_change?: number;
  quote_change_percent?: number;
  quote_updated_at?: string;
}

export type TradeType = 'buy' | 'sell';

export interface Trade {
  id: string;
  stock_code: string;
  stock_name: string;
  sectors: string[];
  trade_type: TradeType;
  quantity: number;
  price: number;
  commission: number;
  trade_time: string;
  note: string;
  created_by: string;
  created_at: string;
}

export type FlowType = 'deposit' | 'withdraw';

export interface FundFlow {
  id: string;
  flow_type: FlowType;
  amount: number;
  balance_after: number;
  note: string;
  flow_date: string;
  created_by: string;
  created_at: string;
}

export interface CreateTradeInput {
  stock_code: string;
  stock_name: string;
  sectors?: string[];
  trade_type: TradeType;
  quantity: number;
  price: number;
  commission?: number;
  trade_time: string;
  note?: string;
}

export type UpdateTradeInput = CreateTradeInput;

export interface CreateFundFlowInput {
  flow_type: FlowType;
  amount: number;
  flow_date: string;
  note?: string;
}

export interface PriceRefreshResult {
  holdings: Holding[];
  refreshed: string[];
  failed: string[];
  refreshed_at: string;
}

export type PerformanceRange = '1D' | '7D' | '1M' | 'YTD';

export interface PortfolioNavPoint {
  cashBalance: number;
  date: string;
  fallbackPricedPositions: number;
  marketValue: number;
  quotePricedPositions: number;
  totalAssets: number;
  unitNav: number;
  units: number;
}

export interface PortfolioNavResult {
  data_note: string;
  fallback_priced_positions: number;
  generated_at: string;
  infer_trade_flows: boolean;
  latest_date: string;
  points: PortfolioNavPoint[];
  quote_priced_positions: number;
  range: PerformanceRange;
  return_rate: number | null;
  start_date: string;
}
