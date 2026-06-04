import React, { FormEvent, useEffect, useMemo, useState } from 'react';
import { createTrade, getTrades } from '../lib/database';
import { Trade, TradeType } from '../lib/types';

function money(value: number) {
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function dateTimeLocalValue(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function displayDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export default function TradeRecords() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [filters, setFilters] = useState({ stock_code: '', from: '', to: '' });
  const [form, setForm] = useState({
    stock_code: '',
    stock_name: '',
    trade_type: 'buy' as TradeType,
    quantity: '1',
    price: '',
    trade_time: dateTimeLocalValue(),
    note: '',
  });

  async function loadTrades() {
    setError('');
    const data = await getTrades({
      stock_code: filters.stock_code.trim(),
      from: filters.from,
      to: filters.to,
    });
    setTrades(data);
  }

  useEffect(() => {
    loadTrades()
      .catch(err => setError(err instanceof Error ? err.message : '交易记录加载失败'))
      .finally(() => setLoading(false));
  }, []);

  const summary = useMemo(() => {
    return trades.reduce(
      (acc, trade) => {
        const amount = Number(trade.quantity) * Number(trade.price);
        if (trade.trade_type === 'buy') acc.buy += amount;
        else acc.sell += amount;
        acc.count += 1;
        return acc;
      },
      { buy: 0, sell: 0, count: 0 }
    );
  }, [trades]);

  async function handleFilter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    await loadTrades()
      .catch(err => setError(err instanceof Error ? err.message : '交易记录加载失败'))
      .finally(() => setLoading(false));
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setMessage('');

    const quantity = Number(form.quantity);
    const price = Number(form.price);
    if (!form.stock_code.trim() || !form.stock_name.trim()) {
      setError('代码和名称不能为空');
      setSaving(false);
      return;
    }
    if (!Number.isInteger(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) {
      setError('数量必须是正整数，价格必须大于 0');
      setSaving(false);
      return;
    }

    try {
      await createTrade({
        stock_code: form.stock_code.trim().toUpperCase(),
        stock_name: form.stock_name.trim(),
        trade_type: form.trade_type,
        quantity,
        price,
        trade_time: new Date(form.trade_time).toISOString(),
        note: form.note.trim(),
      });
      setMessage('交易已添加，持仓已同步更新');
      setForm(current => ({
        ...current,
        quantity: '1',
        price: '',
        note: '',
        trade_time: dateTimeLocalValue(),
      }));
      await loadTrades();
    } catch (err) {
      setError(err instanceof Error ? err.message : '交易创建失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="page-stack">
      <div className="page-heading">
        <div>
          <h2>交易记录</h2>
          <p className="page-subtitle">买卖明细 · 自动同步持仓</p>
        </div>
      </div>

      {(message || error) && (
        <div className={error ? 'alert error' : 'alert success'}>{error || message}</div>
      )}

      <div className="metric-grid compact">
        <div className="metric-card">
          <span>交易笔数</span>
          <strong>{summary.count}</strong>
        </div>
        <div className="metric-card">
          <span>买入金额</span>
          <strong>{money(summary.buy)}</strong>
        </div>
        <div className="metric-card">
          <span>卖出金额</span>
          <strong>{money(summary.sell)}</strong>
        </div>
      </div>

      <div className="split-grid">
        <section className="panel">
          <h3>新增交易</h3>
          <form className="form-grid" onSubmit={handleCreate}>
            <label>
              <span>代码</span>
              <input
                value={form.stock_code}
                onChange={event => setForm({ ...form, stock_code: event.target.value })}
                placeholder="AVGO"
              />
            </label>
            <label>
              <span>名称</span>
              <input
                value={form.stock_name}
                onChange={event => setForm({ ...form, stock_name: event.target.value })}
                placeholder="博通"
              />
            </label>
            <label>
              <span>方向</span>
              <select
                value={form.trade_type}
                onChange={event => setForm({ ...form, trade_type: event.target.value as TradeType })}
              >
                <option value="buy">买入</option>
                <option value="sell">卖出</option>
              </select>
            </label>
            <label>
              <span>数量</span>
              <input
                inputMode="numeric"
                value={form.quantity}
                onChange={event => setForm({ ...form, quantity: event.target.value })}
              />
            </label>
            <label>
              <span>价格</span>
              <input
                inputMode="decimal"
                value={form.price}
                onChange={event => setForm({ ...form, price: event.target.value })}
              />
            </label>
            <label>
              <span>时间</span>
              <input
                type="datetime-local"
                value={form.trade_time}
                onChange={event => setForm({ ...form, trade_time: event.target.value })}
              />
            </label>
            <label className="wide">
              <span>备注</span>
              <input
                value={form.note}
                onChange={event => setForm({ ...form, note: event.target.value })}
                placeholder="可选"
              />
            </label>
            <button className="primary-button wide" disabled={saving} type="submit">
              {saving ? '保存中...' : '保存交易'}
            </button>
          </form>
        </section>

        <section className="panel">
          <h3>筛选</h3>
          <form className="form-grid" onSubmit={handleFilter}>
            <label className="wide">
              <span>股票代码</span>
              <input
                value={filters.stock_code}
                onChange={event => setFilters({ ...filters, stock_code: event.target.value })}
                placeholder="留空查看全部"
              />
            </label>
            <label>
              <span>开始日期</span>
              <input
                type="date"
                value={filters.from}
                onChange={event => setFilters({ ...filters, from: event.target.value })}
              />
            </label>
            <label>
              <span>结束日期</span>
              <input
                type="date"
                value={filters.to}
                onChange={event => setFilters({ ...filters, to: event.target.value })}
              />
            </label>
            <button className="secondary-button wide" type="submit">应用筛选</button>
          </form>
        </section>
      </div>

      <div className="table-shell">
        {loading ? (
          <div className="state-panel">正在加载交易记录...</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>代码</th>
                <th>名称</th>
                <th>方向</th>
                <th className="number">数量</th>
                <th className="number">价格</th>
                <th className="number">金额</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              {trades.map(trade => {
                const amount = Number(trade.quantity) * Number(trade.price);
                return (
                  <tr key={trade.id}>
                    <td>{displayDate(trade.trade_time)}</td>
                    <td><strong>{trade.stock_code}</strong></td>
                    <td>{trade.stock_name}</td>
                    <td>
                      <span className={trade.trade_type === 'buy' ? 'badge buy' : 'badge sell'}>
                        {trade.trade_type === 'buy' ? '买入' : '卖出'}
                      </span>
                    </td>
                    <td className="number">{trade.quantity}</td>
                    <td className="number">{money(Number(trade.price))}</td>
                    <td className="number">{money(amount)}</td>
                    <td>{trade.note || <span className="subtle">-</span>}</td>
                  </tr>
                );
              })}
              {trades.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <div className="empty-state">暂无交易记录</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
