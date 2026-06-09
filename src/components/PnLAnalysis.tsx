import React, { useEffect, useMemo, useState } from 'react';
import { getFundFlows, getHoldings, getPortfolioNav, getTrades } from '../lib/database';
import {
  calculateCashBalance,
  calculateNetFundFlow,
  calculateRealizedPnl,
  tradeCommission,
} from '../lib/portfolio';
import { FundFlow, Holding, PortfolioNavPoint, PortfolioNavResult, Trade } from '../lib/types';

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

function signedMoney(value: number) {
  return `${value >= 0 ? '+' : ''}${money(value)}`;
}

function dateKey(value = new Date()) {
  const date = new Date(value);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function monthFromDateKey(value: string) {
  return value.slice(0, 7);
}

function parseMonthKey(value: string) {
  const [year, month] = value.split('-').map(Number);
  return new Date(year, month - 1, 1);
}

function formatCalendarMonth(value: string) {
  const [year, month] = value.split('-');
  return `${year}年 ${month}月`;
}

function addMonths(value: string, offset: number) {
  const date = parseMonthKey(value);
  date.setMonth(date.getMonth() + offset);
  return monthFromDateKey(dateKey(date));
}

function compareDateKey(left: string, right: string) {
  return left.localeCompare(right);
}

function buildCalendarCells(month: string) {
  const date = parseMonthKey(month);
  const year = date.getFullYear();
  const monthIndex = date.getMonth();
  const firstWeekday = new Date(year, monthIndex, 1).getDay();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const blanks = Array.from({ length: firstWeekday }, () => null);
  const days = Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    return `${month}-${String(day).padStart(2, '0')}`;
  });
  return [...blanks, ...days];
}

type DailyPnl = {
  amount: number | null;
  date: string;
  point: PortfolioNavPoint;
  rate: number | null;
};

function buildDailyPnl(points: PortfolioNavPoint[]) {
  const sorted = [...points].sort((a, b) => compareDateKey(a.date, b.date));
  const map = new Map<string, DailyPnl>();

  sorted.forEach((point, index) => {
    const previous = sorted[index - 1];
    const rate = previous && previous.unitNav > 0
      ? ((point.unitNav - previous.unitNav) / previous.unitNav) * 100
      : null;
    const amount = previous ? (point.unitNav - previous.unitNav) * point.units : null;
    map.set(point.date, {
      amount: amount === null ? null : Number(amount.toFixed(2)),
      date: point.date,
      point,
      rate: rate === null ? null : Number(rate.toFixed(4)),
    });
  });

  return map;
}

export default function PnLAnalysis() {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [flows, setFlows] = useState<FundFlow[]>([]);
  const [navResult, setNavResult] = useState<PortfolioNavResult | null>(null);
  const [calendarMonth, setCalendarMonth] = useState('');
  const [selectedDate, setSelectedDate] = useState('');
  const [showRate, setShowRate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([getHoldings(), getTrades(), getFundFlows(), getPortfolioNav('YTD')])
      .then(([nextHoldings, nextTrades, nextFlows, nextNavResult]) => {
        setHoldings(nextHoldings);
        setTrades(nextTrades);
        setFlows(nextFlows);
        setNavResult(nextNavResult);
        const latestDate = nextNavResult.points[nextNavResult.points.length - 1]?.date;
        if (latestDate) {
          setCalendarMonth(monthFromDateKey(latestDate));
          setSelectedDate(latestDate);
        }
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
    const { realizedPnl, totalBuyCost, totalSellNet } = calculateRealizedPnl(trades);
    const totalPnl = realizedPnl + unrealizedPnl;
    const totalPnlRate = totalBuyCost > 0 ? (totalPnl / totalBuyCost) * 100 : 0;
    const totalCommission = trades.reduce((sum, trade) => sum + tradeCommission(trade), 0);
    const cashBalance = calculateCashBalance(flows, trades);
    const netAssets = marketValue + cashBalance;
    const netCashIn = calculateNetFundFlow(flows);
    const assetPnl = netAssets - netCashIn;

    return {
      totalCost,
      marketValue,
      unrealizedPnl,
      pnlRate,
      realizedPnl,
      totalPnl,
      totalPnlRate,
      totalBuyCost,
      totalSellNet,
      totalCommission,
      cashBalance,
      netAssets,
      netCashIn,
      assetPnl,
    };
  }, [holdings, trades, flows]);

  const calendar = useMemo(() => {
    const points = navResult?.points || [];
    const dailyPnl = buildDailyPnl(points);
    const month = calendarMonth || monthFromDateKey(points[points.length - 1]?.date || dateKey());
    const cells = buildCalendarCells(month);
    const today = dateKey();
    const visibleDays = cells.filter((item): item is string => Boolean(item));
    const daysWithData = visibleDays
      .map(day => dailyPnl.get(day))
      .filter((item): item is DailyPnl => Boolean(item));
    const monthAmount = daysWithData.reduce((sum, item) => sum + (item.amount || 0), 0);
    const firstPoint = daysWithData[0]?.point;
    const lastPoint = daysWithData[daysWithData.length - 1]?.point;
    const monthRate = firstPoint && lastPoint && firstPoint.unitNav > 0
      ? ((lastPoint.unitNav - firstPoint.unitNav) / firstPoint.unitNav) * 100
      : 0;
    const selected = selectedDate ? dailyPnl.get(selectedDate) : daysWithData[daysWithData.length - 1];
    const minMonth = points[0] ? monthFromDateKey(points[0].date) : month;
    const maxMonth = points[points.length - 1] ? monthFromDateKey(points[points.length - 1].date) : month;

    return {
      cells,
      dailyPnl,
      maxMonth,
      minMonth,
      month,
      monthAmount,
      monthRate,
      selected,
      today,
    };
  }, [calendarMonth, navResult, selectedDate]);

  if (loading) return <div className="state-panel">正在加载盈亏分析...</div>;

  return (
    <section className="page-stack">
      <div className="page-heading">
        <div>
          <h2>盈亏分析</h2>
          <p className="page-subtitle">组合表现 · 盈亏日历</p>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="metric-grid">
        <div className="metric-card">
          <span>净资产</span>
          <strong>{money(analysis.netAssets)}</strong>
        </div>
        <div className="metric-card profit-card">
          <span>总盈亏</span>
          <strong className={pnlClass(analysis.totalPnl)}>
            {money(analysis.totalPnl)}
          </strong>
          <div className={`metric-corner ${pnlClass(analysis.totalPnlRate)}`}>
            <small>收益率</small>
            <b>{percent(analysis.totalPnlRate)}</b>
          </div>
        </div>
        <div className="metric-card">
          <span>已实现盈亏</span>
          <strong className={pnlClass(analysis.realizedPnl)}>
            {money(analysis.realizedPnl)}
          </strong>
        </div>
        <div className="metric-card">
          <span>持仓盈亏</span>
          <strong className={pnlClass(analysis.unrealizedPnl)}>
            {money(analysis.unrealizedPnl)}
          </strong>
        </div>
        <div className="metric-card">
          <span>持仓市值</span>
          <strong>{money(analysis.marketValue)}</strong>
        </div>
        <div className="metric-card">
          <span>持仓收益率</span>
          <strong className={pnlClass(analysis.pnlRate)}>{percent(analysis.pnlRate)}</strong>
        </div>
        <div className="metric-card">
          <span>卖出净额</span>
          <strong>{money(analysis.totalSellNet)}</strong>
        </div>
        <div className="metric-card">
          <span>佣金合计</span>
          <strong>{money(analysis.totalCommission)}</strong>
        </div>
      </div>

      <section className="panel pnl-calendar-panel">
        <div className="pnl-calendar-head">
          <div className="pnl-calendar-summary">
            <span>本月盈亏</span>
            <strong className={pnlClass(calendar.monthAmount)}>{signedMoney(calendar.monthAmount)}</strong>
            <small className={pnlClass(calendar.monthRate)}>收益率 {percent(calendar.monthRate)}</small>
          </div>
          <button className="secondary-button" onClick={() => setShowRate(value => !value)} type="button">
            {showRate ? '看盈亏额' : '看收益率'}
          </button>
        </div>

        <div className="pnl-month-switcher">
          <button
            aria-label="上个月"
            className="icon-button"
            disabled={compareDateKey(calendar.month, calendar.minMonth) <= 0}
            onClick={() => setCalendarMonth(month => addMonths(month || calendar.month, -1))}
            type="button"
          >
            ‹
          </button>
          <strong>{formatCalendarMonth(calendar.month)}</strong>
          <button
            aria-label="下个月"
            className="icon-button"
            disabled={compareDateKey(calendar.month, calendar.maxMonth) >= 0}
            onClick={() => setCalendarMonth(month => addMonths(month || calendar.month, 1))}
            type="button"
          >
            ›
          </button>
        </div>

        <div className="pnl-weekdays" aria-hidden="true">
          {['日', '一', '二', '三', '四', '五', '六'].map(day => (
            <span key={day}>{day}</span>
          ))}
        </div>

        <div className="pnl-calendar-grid">
          {calendar.cells.map((cell, index) => {
            if (!cell) return <div className="pnl-calendar-empty" key={`empty-${index}`} />;

            const dayData = calendar.dailyPnl.get(cell);
            const value = showRate ? dayData?.rate : dayData?.amount;
            const className = [
              'pnl-calendar-day',
              cell === calendar.today ? 'today' : '',
              cell === selectedDate ? 'selected' : '',
              value === undefined || value === null ? 'muted-day' : pnlClass(value),
            ].filter(Boolean).join(' ');

            return (
              <button
                className={className}
                key={cell}
                onClick={() => setSelectedDate(cell)}
                type="button"
              >
                <strong>{Number(cell.slice(-2))}</strong>
                <span>
                  {value === undefined || value === null
                    ? '--'
                    : showRate
                      ? percent(value)
                      : signedMoney(value)}
                </span>
              </button>
            );
          })}
        </div>

        <div className="pnl-calendar-detail">
          <span>{calendar.selected?.date || selectedDate || calendar.month}</span>
          <strong className={pnlClass(calendar.selected?.amount || 0)}>
            {calendar.selected?.amount === null || calendar.selected?.amount === undefined
              ? '--'
              : signedMoney(calendar.selected.amount)}
          </strong>
          <small className={pnlClass(calendar.selected?.rate || 0)}>
            {calendar.selected?.rate === null || calendar.selected?.rate === undefined
              ? '收益率 --'
              : `收益率 ${percent(calendar.selected.rate)}`}
          </small>
        </div>
      </section>
    </section>
  );
}
