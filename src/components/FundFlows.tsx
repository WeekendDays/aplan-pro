import React, { FormEvent, useEffect, useMemo, useState } from 'react';
import { createFundFlow, getFundFlows } from '../lib/database';
import { FlowType, FundFlow } from '../lib/types';

function money(value: number) {
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function todayValue() {
  return new Date().toISOString().slice(0, 10);
}

function displayDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
}

export default function FundFlows() {
  const [flows, setFlows] = useState<FundFlow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    flow_type: 'deposit' as FlowType,
    amount: '',
    flow_date: todayValue(),
    note: '',
  });

  async function loadFlows() {
    setError('');
    const data = await getFundFlows();
    setFlows(data);
  }

  useEffect(() => {
    loadFlows()
      .catch(err => setError(err instanceof Error ? err.message : '资金流水加载失败'))
      .finally(() => setLoading(false));
  }, []);

  const summary = useMemo(() => {
    return flows.reduce(
      (acc, flow, index) => {
        if (index === 0) acc.balance = Number(flow.balance_after);
        if (flow.flow_type === 'deposit') acc.deposit += Number(flow.amount);
        else acc.withdraw += Number(flow.amount);
        return acc;
      },
      { balance: 0, deposit: 0, withdraw: 0 }
    );
  }, [flows]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setMessage('');
    const amount = Number(form.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      setError('金额必须大于 0');
      setSaving(false);
      return;
    }

    try {
      await createFundFlow({
        flow_type: form.flow_type,
        amount,
        flow_date: form.flow_date,
        note: form.note.trim(),
      });
      setForm(current => ({ ...current, amount: '', note: '', flow_date: todayValue() }));
      setMessage('资金流水已保存');
      await loadFlows();
    } catch (err) {
      setError(err instanceof Error ? err.message : '资金流水保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="page-stack">
      <div className="page-heading">
        <div>
          <h2>资金流水</h2>
          <p className="page-subtitle">资金流入流出 · 余额追踪</p>
        </div>
      </div>

      {(message || error) && (
        <div className={error ? 'alert error' : 'alert success'}>{error || message}</div>
      )}

      <div className="metric-grid compact">
        <div className="metric-card">
          <span>当前余额</span>
          <strong>{money(summary.balance)}</strong>
        </div>
        <div className="metric-card">
          <span>累计入金</span>
          <strong className="positive">{money(summary.deposit)}</strong>
        </div>
        <div className="metric-card">
          <span>累计出金</span>
          <strong className="negative">{money(summary.withdraw)}</strong>
        </div>
      </div>

      <section className="panel">
        <h3>新增流水</h3>
        <form className="form-grid three" onSubmit={handleCreate}>
          <label>
            <span>类型</span>
            <select
              value={form.flow_type}
              onChange={event => setForm({ ...form, flow_type: event.target.value as FlowType })}
            >
              <option value="deposit">入金</option>
              <option value="withdraw">出金</option>
            </select>
          </label>
          <label>
            <span>金额</span>
            <input
              inputMode="decimal"
              value={form.amount}
              onChange={event => setForm({ ...form, amount: event.target.value })}
              placeholder="1000"
            />
          </label>
          <label>
            <span>日期</span>
            <input
              type="date"
              value={form.flow_date}
              onChange={event => setForm({ ...form, flow_date: event.target.value })}
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
          <button className="primary-button" disabled={saving} type="submit">
            {saving ? '保存中...' : '保存流水'}
          </button>
        </form>
      </section>

      <div className="table-shell">
        {loading ? (
          <div className="state-panel">正在加载资金流水...</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>日期</th>
                <th>类型</th>
                <th className="number">金额</th>
                <th className="number">操作后余额</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              {flows.map(flow => (
                <tr key={flow.id}>
                  <td>{displayDate(flow.flow_date)}</td>
                  <td>
                    <span className={flow.flow_type === 'deposit' ? 'badge buy' : 'badge sell'}>
                      {flow.flow_type === 'deposit' ? '入金' : '出金'}
                    </span>
                  </td>
                  <td className={`number ${flow.flow_type === 'deposit' ? 'positive' : 'negative'}`}>
                    {flow.flow_type === 'deposit' ? '+' : '-'}{money(Number(flow.amount))}
                  </td>
                  <td className="number">{money(Number(flow.balance_after))}</td>
                  <td>{flow.note || <span className="subtle">-</span>}</td>
                </tr>
              ))}
              {flows.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty-state">暂无资金流水</div>
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
