import React, { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createTrade, deleteTrade, getHoldings, getTrades, updateTrade } from '../lib/database';
import {
  DEFAULT_SECTORS,
  mergeSectors,
  normalizeSectors,
  tradeCommission,
  tradeGrossAmount,
  tradeNetAmount,
} from '../lib/portfolio';
import { Holding, Trade, TradeType } from '../lib/types';

type StockProfile = {
  stock_code: string;
  stock_name: string;
  sectors: string[];
};

type TradeMonthGroup = {
  key: string;
  label: string;
  latestTime: number;
  summary: {
    buy: number;
    sell: number;
    commission: number;
    count: number;
  };
  trades: Trade[];
};

type TradeFormState = {
  stock_code: string;
  stock_name: string;
  sectors: string[];
  trade_type: TradeType;
  quantity: string;
  price: string;
  commission: string;
  trade_time: string;
  note: string;
};

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

function monthKey(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function monthLabel(key: string) {
  if (key === 'unknown') return '日期未识别';
  const [year, month] = key.split('-');
  return `${year}年${Number(month)}月`;
}

function sameSectors(left: string[], right: string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function emptyTradeForm(): TradeFormState {
  return {
    stock_code: '',
    stock_name: '',
    sectors: [],
    trade_type: 'buy',
    quantity: '1',
    price: '',
    commission: '0',
    trade_time: dateTimeLocalValue(),
    note: '',
  };
}

function tradeToForm(trade: Trade): TradeFormState {
  return {
    stock_code: trade.stock_code,
    stock_name: trade.stock_name,
    sectors: normalizeSectors(trade.sectors),
    trade_type: trade.trade_type,
    quantity: String(trade.quantity),
    price: String(trade.price),
    commission: String(trade.commission ?? 0),
    trade_time: dateTimeLocalValue(new Date(trade.trade_time)),
    note: trade.note || '',
  };
}

function buildStockProfiles(holdings: Holding[], trades: Trade[]): StockProfile[] {
  const profiles = new Map<string, StockProfile>();

  function upsert(stockCode: string, stockName: string, sectors: string[]) {
    const code = stockCode.trim().toUpperCase();
    if (!code) return;

    const current = profiles.get(code);
    profiles.set(code, {
      stock_code: code,
      stock_name: stockName || current?.stock_name || '',
      sectors: mergeSectors(current?.sectors || [], sectors),
    });
  }

  trades
    .slice()
    .sort((a, b) => new Date(a.trade_time).getTime() - new Date(b.trade_time).getTime())
    .forEach(trade => upsert(trade.stock_code, trade.stock_name, normalizeSectors(trade.sectors)));

  holdings.forEach(holding => {
    upsert(holding.stock_code, holding.stock_name, normalizeSectors(holding.sectors));
  });

  return [...profiles.values()].sort((a, b) => a.stock_code.localeCompare(b.stock_code));
}

function SectorBadges({ sectors }: { sectors: string[] }) {
  const items = normalizeSectors(sectors);
  if (items.length === 0) return <span className="subtle">-</span>;

  return (
    <div className="sector-list compact">
      {items.map(sector => (
        <span key={sector}>{sector}</span>
      ))}
    </div>
  );
}

function TradeTable({
  trades,
  deletingTradeId,
  onDelete,
  onEdit,
}: {
  trades: Trade[];
  deletingTradeId: string;
  onDelete: (trade: Trade) => void;
  onEdit: (trade: Trade) => void;
}) {
  return (
    <div className="table-shell trade-table-shell">
      <table className="trade-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>代码</th>
            <th>名称</th>
            <th>板块</th>
            <th>方向</th>
            <th className="number">数量</th>
            <th className="number">价格</th>
            <th className="number">佣金</th>
            <th className="number">净额</th>
            <th>备注</th>
            <th className="trade-actions-col">操作</th>
          </tr>
        </thead>
        <tbody>
          {trades.map(trade => {
            const grossAmount = tradeGrossAmount(trade);
            const netAmount = trade.trade_type === 'buy'
              ? grossAmount + tradeCommission(trade)
              : grossAmount - tradeCommission(trade);
            return (
              <tr key={trade.id}>
                <td>{displayDate(trade.trade_time)}</td>
                <td><strong>{trade.stock_code}</strong></td>
                <td>{trade.stock_name}</td>
                <td><SectorBadges sectors={trade.sectors} /></td>
                <td>
                  <span className={trade.trade_type === 'buy' ? 'badge buy' : 'badge sell'}>
                    {trade.trade_type === 'buy' ? '买入' : '卖出'}
                  </span>
                </td>
                <td className="number">{trade.quantity}</td>
                <td className="number">{money(Number(trade.price))}</td>
                <td className="number">{money(tradeCommission(trade))}</td>
                <td className="number">{money(netAmount)}</td>
                <td>{trade.note || <span className="subtle">-</span>}</td>
                <td>
                  <div className="trade-row-actions">
                    <button className="text-button trade-action-button" onClick={() => onEdit(trade)} type="button">
                      编辑
                    </button>
                    <button
                      className="text-button trade-action-button danger-button"
                      disabled={deletingTradeId === trade.id}
                      onClick={() => onDelete(trade)}
                      type="button"
                    >
                      {deletingTradeId === trade.id ? '删除中' : '删除'}
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function TradeRecords() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [stockProfiles, setStockProfiles] = useState<StockProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [customSector, setCustomSector] = useState('');
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set());
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingTrade, setEditingTrade] = useState<Trade | null>(null);
  const [deletingTradeId, setDeletingTradeId] = useState('');
  const initializedMonthRef = useRef(false);
  const [form, setForm] = useState<TradeFormState>(() => emptyTradeForm());

  async function loadTrades() {
    setError('');
    const data = await getTrades();
    setTrades(data);
    if (!initializedMonthRef.current) {
      const latestMonth = data[0] ? monthKey(data[0].trade_time) : '';
      setExpandedMonths(latestMonth ? new Set([latestMonth]) : new Set());
      initializedMonthRef.current = true;
    }
  }

  async function loadStockProfiles() {
    const [holdings, allTrades] = await Promise.all([getHoldings(), getTrades()]);
    setStockProfiles(buildStockProfiles(holdings, allTrades));
  }

  useEffect(() => {
    Promise.all([loadTrades(), loadStockProfiles()])
      .catch(err => setError(err instanceof Error ? err.message : '交易记录加载失败'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (editingTrade) return;

    const code = form.stock_code.trim().toUpperCase();
    if (!code) return;

    const profile = stockProfiles.find(item => item.stock_code === code);
    if (!profile) return;

    setForm(current => {
      const currentCode = current.stock_code.trim().toUpperCase();
      if (currentCode !== code) return current;

      const nextSectors = normalizeSectors(profile.sectors);
      if (current.stock_name === profile.stock_name && sameSectors(current.sectors, nextSectors)) {
        return current;
      }

      return {
        ...current,
        stock_name: profile.stock_name || current.stock_name,
        sectors: nextSectors,
      };
    });
  }, [editingTrade, stockProfiles, form.stock_code]);

  const allSectorOptions = useMemo(() => {
    return mergeSectors(
      DEFAULT_SECTORS,
      stockProfiles.flatMap(profile => profile.sectors),
      form.sectors
    );
  }, [form.sectors, stockProfiles]);

  const summary = useMemo(() => {
    return trades.reduce(
      (acc, trade) => {
        const netAmount = tradeNetAmount(trade);
        if (trade.trade_type === 'buy') acc.buy += netAmount;
        else acc.sell += netAmount;
        acc.commission += tradeCommission(trade);
        acc.count += 1;
        return acc;
      },
      { buy: 0, sell: 0, commission: 0, count: 0 }
    );
  }, [trades]);

  const monthGroups = useMemo<TradeMonthGroup[]>(() => {
    const groups = new Map<string, TradeMonthGroup>();

    trades.forEach(trade => {
      const key = monthKey(trade.trade_time);
      const group = groups.get(key) || {
        key,
        label: monthLabel(key),
        latestTime: 0,
        summary: { buy: 0, sell: 0, commission: 0, count: 0 },
        trades: [],
      };

      const time = new Date(trade.trade_time).getTime();
      const netAmount = tradeNetAmount(trade);
      group.latestTime = Math.max(group.latestTime, Number.isFinite(time) ? time : 0);
      group.trades.push(trade);
      group.summary.count += 1;
      group.summary.commission += tradeCommission(trade);
      if (trade.trade_type === 'buy') group.summary.buy += netAmount;
      else group.summary.sell += netAmount;
      groups.set(key, group);
    });

    return [...groups.values()].sort((a, b) => b.latestTime - a.latestTime);
  }, [trades]);

  function applyStockCode(value: string) {
    const stockCode = value.trim().toUpperCase();
    const profile = stockProfiles.find(item => item.stock_code === stockCode);

    setForm(current => {
      const previousCode = current.stock_code.trim().toUpperCase();
      const changedStock = previousCode !== stockCode;

      return {
        ...current,
        stock_code: value.toUpperCase(),
        stock_name: profile?.stock_name || (changedStock ? '' : current.stock_name),
        sectors: profile ? normalizeSectors(profile.sectors) : changedStock ? [] : current.sectors,
      };
    });
  }

  function toggleSector(sector: string) {
    setForm(current => {
      const exists = current.sectors.includes(sector);
      return {
        ...current,
        sectors: exists
          ? current.sectors.filter(item => item !== sector)
          : mergeSectors(current.sectors, [sector]),
      };
    });
  }

  function handleAddCustomSector() {
    const sector = customSector.trim();
    if (!sector) return;
    setForm(current => ({ ...current, sectors: mergeSectors(current.sectors, [sector]) }));
    setCustomSector('');
  }

  function handleCustomSectorKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    handleAddCustomSector();
  }

  function toggleMonth(key: string) {
    setExpandedMonths(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function openCreateModal() {
    setEditingTrade(null);
    setForm(emptyTradeForm());
    setCustomSector('');
    setIsCreateOpen(true);
    setError('');
    setMessage('');
  }

  function closeTradeModal() {
    setIsCreateOpen(false);
    setEditingTrade(null);
    setCustomSector('');
  }

  function startEdit(trade: Trade) {
    setForm(tradeToForm(trade));
    setEditingTrade(trade);
    setCustomSector('');
    setIsCreateOpen(false);
    setError('');
    setMessage('');
  }

  async function handleDelete(trade: Trade) {
    const confirmed = window.confirm(`删除 ${trade.stock_code} ${displayDate(trade.trade_time)} 的交易？删除后持仓会重新计算。`);
    if (!confirmed) return;

    setDeletingTradeId(trade.id);
    setError('');
    setMessage('');

    try {
      await deleteTrade(trade.id);
      setMessage('交易已删除，持仓已重新计算');
      await Promise.all([loadTrades(), loadStockProfiles()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '交易删除失败');
    } finally {
      setDeletingTradeId('');
    }
  }

  async function handleSubmitTrade(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setMessage('');

    const quantity = Number(form.quantity);
    const price = Number(form.price);
    const commission = form.commission.trim() ? Number(form.commission) : 0;
    const tradeTime = new Date(form.trade_time);
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
    if (!Number.isFinite(commission) || commission < 0) {
      setError('佣金必须是大于等于 0 的数字');
      setSaving(false);
      return;
    }
    if (Number.isNaN(tradeTime.getTime())) {
      setError('交易时间无效');
      setSaving(false);
      return;
    }

    try {
      const payload = {
        stock_code: form.stock_code.trim().toUpperCase(),
        stock_name: form.stock_name.trim(),
        sectors: normalizeSectors(form.sectors),
        trade_type: form.trade_type,
        quantity,
        price,
        commission,
        trade_time: tradeTime.toISOString(),
        note: form.note.trim(),
      };
      const savedTrade = editingTrade
        ? await updateTrade(editingTrade.id, payload)
        : await createTrade(payload);

      setMessage(editingTrade ? '交易已更新，持仓已重新计算' : '交易已添加，持仓已同步更新');
      if (editingTrade) {
        closeTradeModal();
      } else {
        setForm(current => ({
          ...current,
          quantity: '1',
          price: '',
          commission: '0',
          note: '',
          trade_time: dateTimeLocalValue(),
        }));
        closeTradeModal();
      }
      setExpandedMonths(current => new Set([monthKey(savedTrade.trade_time), ...current]));
      await Promise.all([loadTrades(), loadStockProfiles()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : editingTrade ? '交易更新失败' : '交易创建失败');
    } finally {
      setSaving(false);
    }
  }

  const isTradeModalOpen = isCreateOpen || editingTrade !== null;
  const tradeModalTitle = editingTrade ? '编辑交易' : '新增交易';

  return (
    <section className="page-stack">
      <div className="page-heading">
        <div>
          <h2>交易记录</h2>
          <p className="page-subtitle">买卖明细 · 自动同步持仓</p>
        </div>
        <button className="primary-button" onClick={openCreateModal} type="button">
          新增交易
        </button>
      </div>

      {(message || error) && (
        <div className={error ? 'alert error' : 'alert success'}>{error || message}</div>
      )}

      <div className="metric-grid">
        <div className="metric-card">
          <span>交易笔数</span>
          <strong>{summary.count}</strong>
        </div>
        <div className="metric-card">
          <span>买入成本</span>
          <strong>{money(summary.buy)}</strong>
        </div>
        <div className="metric-card">
          <span>卖出净额</span>
          <strong>{money(summary.sell)}</strong>
        </div>
        <div className="metric-card">
          <span>佣金合计</span>
          <strong>{money(summary.commission)}</strong>
        </div>
      </div>

      {isTradeModalOpen && (
        <div className="modal-backdrop" onMouseDown={closeTradeModal}>
          <section
            aria-labelledby="trade-create-title"
            aria-modal="true"
            className="modal-panel trade-modal"
            onMouseDown={event => event.stopPropagation()}
            role="dialog"
          >
            <div className="modal-heading">
              <div>
                <h3 id="trade-create-title">{tradeModalTitle}</h3>
                <p className="page-subtitle">{editingTrade ? '保存后重新计算持仓' : '保存后自动同步持仓'}</p>
              </div>
              <button
                aria-label={`关闭${tradeModalTitle}`}
                className="icon-button"
                onClick={closeTradeModal}
                type="button"
              >
                ×
              </button>
            </div>
            <form className="form-grid" onSubmit={handleSubmitTrade}>
              <label>
                <span>代码</span>
                <input
                  list="stock-code-options"
                  value={form.stock_code}
                  onChange={event => applyStockCode(event.target.value)}
                  placeholder="AVGO"
                />
                <datalist id="stock-code-options">
                  {stockProfiles.map(profile => (
                    <option key={profile.stock_code} value={profile.stock_code}>
                      {profile.stock_name}
                    </option>
                  ))}
                </datalist>
              </label>
              <label>
                <span>名称</span>
                <input
                  value={form.stock_name}
                  onChange={event => setForm({ ...form, stock_name: event.target.value })}
                  placeholder="博通"
                />
              </label>
              <div className="form-field wide">
                <span className="field-label">板块</span>
                <div className="sector-selector">
                  {allSectorOptions.map(sector => (
                    <label
                      className={form.sectors.includes(sector) ? 'sector-chip selected' : 'sector-chip'}
                      key={sector}
                    >
                      <input
                        checked={form.sectors.includes(sector)}
                        onChange={() => toggleSector(sector)}
                        type="checkbox"
                      />
                      <span>{sector}</span>
                    </label>
                  ))}
                </div>
                <div className="add-sector-row">
                  <input
                    value={customSector}
                    onChange={event => setCustomSector(event.target.value)}
                    onKeyDown={handleCustomSectorKeyDown}
                    placeholder="自定义板块"
                  />
                  <button className="secondary-button" onClick={handleAddCustomSector} type="button">
                    添加
                  </button>
                </div>
              </div>
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
                <span>佣金</span>
                <input
                  inputMode="decimal"
                  value={form.commission}
                  onChange={event => setForm({ ...form, commission: event.target.value })}
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
              <div className="modal-actions wide">
                <button className="secondary-button" onClick={closeTradeModal} type="button">
                  取消
                </button>
                <button className="primary-button" disabled={saving} type="submit">
                  {saving ? '保存中...' : editingTrade ? '保存修改' : '保存交易'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      <div className="trade-month-list">
        {loading ? (
          <div className="table-shell">
            <div className="state-panel">正在加载交易记录...</div>
          </div>
        ) : monthGroups.length > 0 ? (
          monthGroups.map((group, index) => {
            const expanded = expandedMonths.has(group.key);
            return (
              <section className="trade-month-panel" key={group.key}>
                <button
                  aria-expanded={expanded}
                  className="trade-month-header"
                  onClick={() => toggleMonth(group.key)}
                  type="button"
                >
                  <span className={expanded ? 'month-chevron open' : 'month-chevron'}>›</span>
                  <span className="trade-month-title">
                    <strong>{group.label}</strong>
                    <small>{index === 0 ? '最新 · ' : ''}{group.summary.count} 笔</small>
                  </span>
                  <span className="trade-month-stats">
                    <span>买入 {money(group.summary.buy)}</span>
                    <span>卖出 {money(group.summary.sell)}</span>
                    <span>佣金 {money(group.summary.commission)}</span>
                  </span>
                </button>
                {expanded && (
                  <TradeTable
                    deletingTradeId={deletingTradeId}
                    onDelete={handleDelete}
                    onEdit={startEdit}
                    trades={group.trades}
                  />
                )}
              </section>
            );
          })
        ) : (
          <div className="table-shell">
            <div className="empty-state">暂无交易记录</div>
          </div>
        )}
      </div>
    </section>
  );
}
