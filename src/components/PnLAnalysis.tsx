import React, { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getFundFlows, getHoldings, getTrades } from '../lib/database';
import { FundFlow, Holding, Trade } from '../lib/types';

const COLORS = ['#2563eb', '#16a34a', '#f59e0b', '#dc2626', '#7c3aed', '#0891b2', '#4b5563'];

function money(value: number) {
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function percent(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function pnlClass(value: number) {
  if (value > 0) return 'positive';
  if (value < 0) return 'negative';
  return 'neutral';
}

function monthKey(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export default function PnLAnalysis() {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [flows, setFlows] = useState<FundFlow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([getHoldings(), getTrades(), getFundFlows()])
      .then(([nextHoldings, nextTrades, nextFlows]) => {
        setHoldings(nextHoldings);
        setTrades(nextTrades);
        setFlows(nextFlows);
      })
      .catch(err => setError(err instanceof Error ? err.message : '盈亏数据加载失败'))
      .finally(() => setLoading(false));
  }, []);

  const analysis = useMemo(() => {
    const totalCost = holdings.reduce((sum, item) => sum + Number(item.total_cost), 0);
    const marketValue = holdings.reduce(
      (sum, item) => sum + Number(item.current_price) * Number(item.quantity),
      0
    );
    const unrealizedPnl = marketValue - totalCost;
    const pnlRate = totalCost > 0 ? (unrealizedPnl / totalCost) * 100 : 0;
    const cashBalance = flows.length > 0 ? Number(flows[0].balance_after) : 0;
    const netAssets = marketValue + cashBalance;
    const netCashIn = flows.reduce((sum, flow) => {
      return sum + (flow.flow_type === 'deposit' ? Number(flow.amount) : -Number(flow.amount));
    }, 0);
    const assetPnl = netAssets - netCashIn;

    const allocation = [...holdings]
      .map(item => ({
        name: item.stock_code,
        value: Number(item.current_price) * Number(item.quantity),
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 7);

    const monthMap = new Map<string, { month: string; buy: number; sell: number }>();
    trades.forEach(trade => {
      const key = monthKey(trade.trade_time);
      const row = monthMap.get(key) || { month: key, buy: 0, sell: 0 };
      const amount = Number(trade.quantity) * Number(trade.price);
      if (trade.trade_type === 'buy') row.buy += amount;
      else row.sell += amount;
      monthMap.set(key, row);
    });
    const tradeTrend = [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month)).slice(-8);

    const ranked = [...holdings]
      .map(item => {
        const value = Number(item.current_price) * Number(item.quantity);
        const pnl = value - Number(item.total_cost);
        const rate = Number(item.total_cost) > 0 ? (pnl / Number(item.total_cost)) * 100 : 0;
        return { ...item, value, pnl, rate };
      })
      .sort((a, b) => b.pnl - a.pnl);

    return {
      totalCost,
      marketValue,
      unrealizedPnl,
      pnlRate,
      cashBalance,
      netAssets,
      netCashIn,
      assetPnl,
      allocation,
      tradeTrend,
      ranked,
    };
  }, [holdings, trades, flows]);

  if (loading) return <div className="state-panel">正在加载盈亏分析...</div>;

  return (
    <section className="page-stack">
      <div className="page-heading">
        <div>
          <h2>盈亏分析</h2>
          <p className="page-subtitle">组合表现 · 仓位结构</p>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="metric-grid">
        <div className="metric-card">
          <span>净资产</span>
          <strong>{money(analysis.netAssets)}</strong>
        </div>
        <div className="metric-card">
          <span>持仓市值</span>
          <strong>{money(analysis.marketValue)}</strong>
        </div>
        <div className="metric-card">
          <span>浮动盈亏</span>
          <strong className={pnlClass(analysis.unrealizedPnl)}>
            {money(analysis.unrealizedPnl)}
          </strong>
        </div>
        <div className="metric-card">
          <span>持仓收益率</span>
          <strong className={pnlClass(analysis.pnlRate)}>{percent(analysis.pnlRate)}</strong>
        </div>
      </div>

      <div className="analytics-grid">
        <section className="panel chart-panel">
          <div className="panel-heading">
            <h3>资产分布</h3>
            <span className="subtle">按当前市值</span>
          </div>
          <ResponsiveContainer height={260} width="100%">
            <PieChart>
              <Pie
                data={analysis.allocation}
                dataKey="value"
                innerRadius={62}
                nameKey="name"
                outerRadius={96}
                paddingAngle={2}
              >
                {analysis.allocation.map((item, index) => (
                  <Cell fill={COLORS[index % COLORS.length]} key={item.name} />
                ))}
              </Pie>
              <Tooltip formatter={(value: number) => money(Number(value))} />
            </PieChart>
          </ResponsiveContainer>
          <div className="legend-list">
            {analysis.allocation.map((item, index) => (
              <span key={item.name}>
                <i style={{ background: COLORS[index % COLORS.length] }} />
                {item.name} {money(item.value)}
              </span>
            ))}
          </div>
        </section>

        <section className="panel chart-panel">
          <div className="panel-heading">
            <h3>月度交易规模</h3>
            <span className="subtle">买入 / 卖出</span>
          </div>
          <ResponsiveContainer height={260} width="100%">
            <BarChart data={analysis.tradeTrend}>
              <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip formatter={(value: number) => money(Number(value))} />
              <Bar dataKey="buy" fill="#2563eb" name="买入" radius={[4, 4, 0, 0]} />
              <Bar dataKey="sell" fill="#16a34a" name="卖出" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </section>
      </div>

      <div className="table-shell">
        <table>
          <thead>
            <tr>
              <th>代码</th>
              <th>名称</th>
              <th className="number">市值</th>
              <th className="number">成本</th>
              <th className="number">盈亏</th>
              <th className="number">收益率</th>
            </tr>
          </thead>
          <tbody>
            {analysis.ranked.map(item => (
              <tr key={item.id}>
                <td><strong>{item.stock_code}</strong></td>
                <td>{item.stock_name}</td>
                <td className="number">{money(item.value)}</td>
                <td className="number">{money(Number(item.total_cost))}</td>
                <td className={`number ${pnlClass(item.pnl)}`}>{money(item.pnl)}</td>
                <td className={`number ${pnlClass(item.rate)}`}>{percent(item.rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
