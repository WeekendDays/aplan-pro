import { FundFlow, Trade } from './types';

export const DEFAULT_SECTORS = [
  '科技',
  '半导体',
  'AI',
  'ETF',
  '通信',
  '金融',
  '消费',
  '医药',
  '新能源',
  '工业',
  '港股',
  '美股',
];

export function normalizeSectors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  return value
    .map(item => String(item || '').trim())
    .filter(item => {
      const key = item.toLowerCase();
      if (!item || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function mergeSectors(...groups: Array<unknown>): string[] {
  return normalizeSectors(groups.flatMap(group => (Array.isArray(group) ? group : [])));
}

export function tradeGrossAmount(trade: Pick<Trade, 'quantity' | 'price'>): number {
  return Number(trade.quantity) * Number(trade.price);
}

export function tradeCommission(trade: Pick<Trade, 'commission'>): number {
  const commission = Number(trade.commission || 0);
  return Number.isFinite(commission) ? commission : 0;
}

export function tradeNetAmount(trade: Pick<Trade, 'quantity' | 'price' | 'commission' | 'trade_type'>): number {
  const gross = tradeGrossAmount(trade);
  const commission = tradeCommission(trade);
  return trade.trade_type === 'buy' ? gross + commission : gross - commission;
}

export function calculateNetFundFlow(flows: FundFlow[]) {
  return flows.reduce((sum, flow) => {
    const amount = Number(flow.amount);
    if (!Number.isFinite(amount)) return sum;
    return sum + (flow.flow_type === 'deposit' ? amount : -amount);
  }, 0);
}

export function calculateTradeCashImpact(trades: Trade[]) {
  return trades.reduce((sum, trade) => {
    const amount = tradeNetAmount(trade);
    if (!Number.isFinite(amount)) return sum;
    return sum + (trade.trade_type === 'buy' ? -amount : amount);
  }, 0);
}

export function calculateCashBalance(flows: FundFlow[], trades: Trade[]) {
  return calculateNetFundFlow(flows) + calculateTradeCashImpact(trades);
}

export function calculateRealizedPnl(trades: Trade[]) {
  const positions = new Map<string, { quantity: number; totalCost: number }>();
  let realizedPnl = 0;
  let totalBuyCost = 0;
  let totalSellNet = 0;

  [...trades]
    .sort((a, b) => {
      const dateDiff = new Date(a.trade_time).getTime() - new Date(b.trade_time).getTime();
      if (dateDiff !== 0) return dateDiff;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    })
    .forEach(trade => {
      const quantity = Number(trade.quantity);
      const gross = tradeGrossAmount(trade);
      const commission = tradeCommission(trade);
      const current = positions.get(trade.stock_code) || { quantity: 0, totalCost: 0 };

      if (trade.trade_type === 'buy') {
        const cost = gross + commission;
        current.quantity += quantity;
        current.totalCost += cost;
        totalBuyCost += cost;
        positions.set(trade.stock_code, current);
        return;
      }

      const avgCost = current.quantity > 0 ? current.totalCost / current.quantity : 0;
      const matchedQuantity = Math.min(quantity, current.quantity);
      const costBasis = avgCost * matchedQuantity;
      const netProceeds = gross - commission;

      realizedPnl += netProceeds - costBasis;
      totalSellNet += netProceeds;
      current.quantity = Math.max(0, current.quantity - quantity);
      current.totalCost = current.quantity > 0 ? avgCost * current.quantity : 0;
      positions.set(trade.stock_code, current);
    });

  return { realizedPnl, totalBuyCost, totalSellNet };
}
