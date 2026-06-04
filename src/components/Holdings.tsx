import React, { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  getHoldings,
  refreshHoldingPrices,
  updateHoldingCurrentPrice,
} from '../lib/database';
import { Holding } from '../lib/types';

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

export default function Holdings() {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [priceDraft, setPriceDraft] = useState('');

  async function loadHoldings() {
    setError('');
    const data = await getHoldings();
    setHoldings(data);
  }

  useEffect(() => {
    loadHoldings()
      .catch(err => setError(err instanceof Error ? err.message : '持仓加载失败'))
      .finally(() => setLoading(false));
  }, []);

  const summary = useMemo(() => {
    const totalCost = holdings.reduce((sum, item) => sum + Number(item.total_cost), 0);
    const marketValue = holdings.reduce(
      (sum, item) => sum + Number(item.current_price) * Number(item.quantity),
      0
    );
    const pnl = marketValue - totalCost;
    const pnlRate = totalCost > 0 ? (pnl / totalCost) * 100 : 0;
    return { totalCost, marketValue, pnl, pnlRate };
  }, [holdings]);

  async function handleRefreshPrices() {
    setRefreshing(true);
    setError('');
    setMessage('');
    try {
      const result = await refreshHoldingPrices();
      setHoldings(result.holdings);
    } catch (err) {
      setError(err instanceof Error ? err.message : '行情刷新失败');
    } finally {
      setRefreshing(false);
    }
  }

  function startEdit(holding: Holding) {
    setEditingId(holding.id);
    setPriceDraft(String(holding.current_price));
  }

  async function handleUpdatePrice(event: FormEvent<HTMLFormElement>, holding: Holding) {
    event.preventDefault();
    setError('');
    setMessage('');
    const nextPrice = Number(priceDraft);

    if (!Number.isFinite(nextPrice) || nextPrice <= 0) {
      setError('现价必须是大于 0 的数字');
      return;
    }

    try {
      const updated = await updateHoldingCurrentPrice(holding.id, nextPrice);
      setHoldings(items => items.map(item => (item.id === updated.id ? updated : item)));
      setEditingId('');
      setMessage(`${holding.stock_code} 现价已更新`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '现价更新失败');
    }
  }

  if (loading) return <div className="state-panel">正在加载持仓...</div>;

  return (
    <section className="page-stack">
      <div className="page-heading">
        <div>
          <h2>持仓总览</h2>
          <p className="page-subtitle">实时行情 · 自动刷新</p>
        </div>
        <button className="secondary-button refresh-button" disabled={refreshing} onClick={handleRefreshPrices} type="button">
          {refreshing ? '刷新中...' : '刷新行情'}
        </button>
      </div>

      {(message || error) && (
        <div className={error ? 'alert error' : 'alert success'}>{error || message}</div>
      )}

      <div className="metric-grid">
        <div className="metric-card">
          <span>总市值</span>
          <strong>{money(summary.marketValue)}</strong>
        </div>
        <div className="metric-card">
          <span>总成本</span>
          <strong>{money(summary.totalCost)}</strong>
        </div>
        <div className="metric-card">
          <span>持仓盈亏</span>
          <strong className={pnlClass(summary.pnl)}>{money(summary.pnl)}</strong>
        </div>
        <div className="metric-card">
          <span>收益率</span>
          <strong className={pnlClass(summary.pnlRate)}>{percent(summary.pnlRate)}</strong>
        </div>
      </div>

      <div className="table-shell">
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th className="number">市值</th>
              <th className="number">持股/可卖</th>
              <th className="number">现价/成本</th>
              <th className="number">持仓盈亏</th>
              <th className="number">今日盈亏</th>
              <th className="number">个股仓位</th>
            </tr>
          </thead>
          <tbody>
            {holdings.map(holding => {
              const marketValue = Number(holding.current_price) * Number(holding.quantity);
              const pnl = marketValue - Number(holding.total_cost);
              const pnlRate = Number(holding.total_cost) > 0 ? (pnl / Number(holding.total_cost)) * 100 : 0;
              const positionRate = summary.marketValue > 0 ? (marketValue / summary.marketValue) * 100 : 0;
              const quoteChange = Number(holding.quote_change || 0);
              const quoteChangePercent = Number(holding.quote_change_percent || 0);
              const todayPnl = quoteChange * Number(holding.quantity);
              return (
                <tr key={holding.id}>
                  <td className="stock-name-cell">
                    <strong>{holding.stock_code}</strong>
                    <span>{holding.stock_name}</span>
                  </td>
                  <td className="number value-cell">
                    <strong>{money(marketValue)}</strong>
                    <span>{positionRate.toFixed(2)}%</span>
                  </td>
                  <td className="number value-cell">
                    <strong>{holding.quantity}</strong>
                    <span>{holding.quantity}</span>
                  </td>
                  <td className="number price-cell value-cell">
                    {editingId === holding.id ? (
                      <form className="inline-form" onSubmit={event => handleUpdatePrice(event, holding)}>
                        <input
                          inputMode="decimal"
                          value={priceDraft}
                          onChange={event => setPriceDraft(event.target.value)}
                        />
                        <button className="small-button" type="submit">保存</button>
                      </form>
                    ) : (
                      <button className="text-button" onClick={() => startEdit(holding)} type="button">
                        {money(Number(holding.current_price))}
                      </button>
                    )}
                    <span>{money(Number(holding.cost_price))}</span>
                  </td>
                  <td className={`number value-cell ${pnlClass(pnl)}`}>
                    <strong>{money(pnl)}</strong>
                    <span>{percent(pnlRate)}</span>
                  </td>
                  <td className={`number value-cell ${pnlClass(todayPnl)}`}>
                    <strong>{money(todayPnl)}</strong>
                    <span>{percent(quoteChangePercent)}</span>
                  </td>
                  <td className="number position-cell">
                    <span>{positionRate.toFixed(2)}%</span>
                    <div className="position-track" aria-hidden="true">
                      <i style={{ width: `${Math.max(4, Math.min(positionRate, 100))}%` }} />
                    </div>
                  </td>
                </tr>
              );
            })}
            {holdings.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <div className="empty-state">暂无持仓，先在交易页添加买入记录。</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
