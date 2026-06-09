import React, { FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  getFundFlows,
  getHoldings,
  getPortfolioNav,
  getTrades,
  refreshHoldingPrices,
  updateHoldingCurrentPrice,
} from '../lib/database';
import { calculateCashBalance, normalizeSectors } from '../lib/portfolio';
import { Holding, PerformanceRange, PortfolioNavPoint, PortfolioNavResult } from '../lib/types';

const usdFormatter = new Intl.NumberFormat('en-US', {
  currency: 'USD',
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: 'currency',
});

function numberOrNull(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function money(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return usdFormatter.format(value);
}

function signedMoney(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (Object.is(value, -0) || value === 0) return money(0);
  return value > 0 ? `+${money(value)}` : money(value);
}

function percent(value: number | null | undefined, signed = true) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const prefix = signed && value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(2)}%`;
}

function unitNav(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(4);
}

function formatShares(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function clampPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(value, 100));
}

function valueTone(value: number | null | undefined, rate?: number | null) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'neutral';
  if (value > 0) return 'positive';
  if (value === 0) return 'neutral';

  const severity = Math.abs(rate ?? 0);
  if (severity >= 25) return 'negative-strong';
  if (severity >= 8) return 'negative';
  return 'negative-soft';
}

function pnlClass(value: number | null | undefined, rate?: number | null) {
  const tone = valueTone(value, rate);
  return tone === 'negative-soft' || tone === 'negative-strong' ? tone : tone;
}

type HoldingFilter = 'all' | 'stock' | 'etf' | 'profit' | 'loss';
type SortDirection = 'asc' | 'desc';
type SortKey = 'marketValue' | 'cumulativePnl' | 'cumulativeReturn' | 'positionRate' | 'todayPnl';
type RefreshStatus = { text: string; tone: 'error' | 'success' } | null;

interface SortConfig {
  direction: SortDirection;
  key: SortKey;
}

interface HoldingMetrics {
  assetType: 'ETF' | 'Stock';
  companyName: string;
  costPrice: number | null;
  cumulativePnl: number | null;
  cumulativeReturn: number | null;
  currentPrice: number | null;
  hasDailyQuote: boolean;
  hasValidPrice: boolean;
  holding: Holding;
  marketValue: number | null;
  positionRate: number | null;
  previousMarketValue: number | null;
  quantity: number | null;
  todayPnl: number | null;
  todayReturn: number | null;
  totalCost: number;
}

interface PortfolioSummary {
  cumulativePnl: number | null;
  cumulativeReturn: number | null;
  marketValue: number | null;
  previousMarketValue: number | null;
  priceDataComplete: boolean;
  priceMissingCount: number;
  todayDataComplete: boolean;
  todayMissingCount: number;
  todayPnl: number | null;
  todayReturn: number | null;
  totalAssets: number | null;
  totalCost: number;
}

const filterOptions: Array<{ value: HoldingFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'stock', label: '股票' },
  { value: 'etf', label: 'ETF' },
  { value: 'profit', label: '盈利' },
  { value: 'loss', label: '亏损' },
];

const performanceOptions: PerformanceRange[] = ['1D', '7D', '1M', 'YTD'];

const companyNames: Record<string, string> = {
  AAPL: 'Apple Inc.',
  AMAT: 'Applied Materials, Inc.',
  AVGO: 'Broadcom Inc.',
  DRAM: 'Global X Memory ETF',
  NOK: 'Nokia Oyj ADR',
  NVDA: 'NVIDIA Corp.',
  QLD: 'ProShares Ultra QQQ',
  SMH: 'VanEck Semiconductor ETF',
  VGT: 'Vanguard Information Technology ETF',
};

const etfCodes = new Set(['DRAM', 'QLD', 'SMH', 'VGT', 'SPY', 'QQQ', 'VOO', 'IVV']);

const logoDomains: Record<string, string> = {
  AAPL: 'apple.com',
  AMAT: 'appliedmaterials.com',
  AVGO: 'broadcom.com',
  DRAM: 'globalxetfs.com',
  NOK: 'nokia.com',
  NVDA: 'nvidia.com',
  QLD: 'proshares.com',
  SMH: 'vaneck.com',
  VGT: 'vanguard.com',
};

const US_MARKET_TIME_ZONE = 'America/New_York';
const LOGO_CACHE_PREFIX = 'aplan:ticker-logo:';
const LOGO_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGO_CACHE_MAX_BYTES = 160 * 1024;
const logoFetches = new Map<string, Promise<string | null>>();

type LogoCacheEntry = {
  dataUrl: string;
  expiresAt: number;
  source: string;
};

function getCompanyName(holding: Holding) {
  return companyNames[holding.stock_code.toUpperCase()] || holding.stock_name;
}

function isEtf(holding: Holding) {
  const code = holding.stock_code.toUpperCase();
  const sectors = normalizeSectors(holding.sectors).join(' ').toUpperCase();
  const name = `${holding.stock_name} ${getCompanyName(holding)}`.toUpperCase();
  return etfCodes.has(code) || sectors.includes('ETF') || name.includes('ETF');
}

function formatDateTime(value?: string) {
  if (!value) return '暂无行情时间';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat('zh-CN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Shanghai',
  }).format(date);
}

function marketDateKey(value: string | Date = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone: US_MARKET_TIME_ZONE,
    year: 'numeric',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));

  return `${values.year}-${values.month}-${values.day}`;
}

function isCurrentMarketDate(value?: string) {
  if (!value) return false;
  return marketDateKey(value) === marketDateKey();
}

function latestQuoteUpdate(holdings: Holding[]) {
  const timestamps = holdings
    .map(holding => holding.quote_updated_at)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());

  return timestamps[0];
}

function positionTier(positionRate: number | null) {
  if (positionRate === null) return 'tier-low';
  if (positionRate < 10) return 'tier-low';
  if (positionRate < 25) return 'tier-medium';
  if (positionRate < 35) return 'tier-high';
  return 'tier-heavy';
}

function logoSources(code: string) {
  const symbol = code.toUpperCase();
  const domain = logoDomains[symbol];
  return [
    `/api/logos/${encodeURIComponent(symbol)}`,
    `https://finnhub.io/api/logo?symbol=${encodeURIComponent(symbol)}`,
    domain ? `https://img.logo.dev/${domain}?size=72` : '',
    `/assets/logos/${symbol}.png`,
  ].filter(Boolean);
}

function logoCacheKey(symbol: string) {
  return `${LOGO_CACHE_PREFIX}${symbol}`;
}

function readCachedLogo(symbol: string) {
  if (typeof window === 'undefined') return '';

  try {
    const raw = window.localStorage.getItem(logoCacheKey(symbol));
    if (!raw) return '';

    const entry = JSON.parse(raw) as Partial<LogoCacheEntry>;
    if (typeof entry.dataUrl !== 'string' || typeof entry.expiresAt !== 'number') return '';
    if (entry.expiresAt <= Date.now()) {
      window.localStorage.removeItem(logoCacheKey(symbol));
      return '';
    }

    return entry.dataUrl;
  } catch {
    return '';
  }
}

function writeCachedLogo(symbol: string, source: string, dataUrl: string) {
  if (typeof window === 'undefined') return;

  try {
    const entry: LogoCacheEntry = {
      dataUrl,
      expiresAt: Date.now() + LOGO_CACHE_TTL_MS,
      source,
    };
    window.localStorage.setItem(logoCacheKey(symbol), JSON.stringify(entry));
  } catch {
    // Logo caching is an optimization; rendering should continue when storage is full or unavailable.
  }
}

function clearCachedLogo(symbol: string) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.removeItem(logoCacheKey(symbol));
  } catch {
    // Ignore storage failures and let the normal fallback chain handle the logo.
  }
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Logo cache read failed'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsDataURL(blob);
  });
}

async function fetchLogoDataUrl(source: string) {
  const response = await fetch(source, { cache: 'force-cache', mode: 'cors' });
  if (!response.ok) return null;

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) return null;

  const blob = await response.blob();
  if (blob.size <= 0 || blob.size > LOGO_CACHE_MAX_BYTES) return null;

  const dataUrl = await blobToDataUrl(blob);
  return dataUrl || null;
}

function cacheLogoSource(symbol: string, source: string) {
  const key = `${symbol}:${source}`;
  const existing = logoFetches.get(key);
  if (existing) return existing;

  const task = fetchLogoDataUrl(source)
    .then(dataUrl => {
      if (dataUrl) writeCachedLogo(symbol, source, dataUrl);
      return dataUrl;
    })
    .catch(() => null)
    .finally(() => {
      logoFetches.delete(key);
    });

  logoFetches.set(key, task);
  return task;
}

function TickerLogo({ code }: { code: string }) {
  const [sourceIndex, setSourceIndex] = useState(0);
  const symbol = code.toUpperCase();
  const sources = useMemo(() => logoSources(symbol), [symbol]);
  const [cachedSource, setCachedSource] = useState(() => readCachedLogo(symbol));
  const currentSource = cachedSource || sources[sourceIndex];

  useEffect(() => {
    setSourceIndex(0);
    setCachedSource(readCachedLogo(symbol));
  }, [symbol]);

  useEffect(() => {
    if (cachedSource || !currentSource) return undefined;

    let cancelled = false;
    cacheLogoSource(symbol, currentSource).then(dataUrl => {
      if (!cancelled && dataUrl) setCachedSource(dataUrl);
    });

    return () => {
      cancelled = true;
    };
  }, [cachedSource, currentSource, symbol]);

  if (!currentSource) {
    return (
      <span className="ticker-logo fallback" aria-hidden="true">
        {symbol.slice(0, 1)}
      </span>
    );
  }

  return (
    <span className="ticker-logo">
      <img
        alt={`${symbol} logo`}
        decoding="async"
        loading="lazy"
        onError={() => {
          if (cachedSource) {
            clearCachedLogo(symbol);
            setCachedSource('');
            return;
          }

          setSourceIndex(index => index + 1);
        }}
        src={currentSource}
      />
    </span>
  );
}

function SummaryMetricCard({
  label,
  note,
  tone = 'neutral',
  value,
}: {
  label: string;
  note?: React.ReactNode;
  tone?: string;
  value: React.ReactNode;
}) {
  return (
    <div className="summary-metric-card">
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
      {note && <small className={tone}>{note}</small>}
    </div>
  );
}

function FilterTabs({
  active,
  onChange,
  options,
}: {
  active: HoldingFilter;
  onChange: (value: HoldingFilter) => void;
  options: Array<{ value: HoldingFilter; label: string }>;
}) {
  return (
    <div className="segmented-control" aria-label="持仓筛选">
      {options.map(option => (
        <button
          className={active === option.value ? 'active' : ''}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function PositionWeightBar({ value }: { value: number | null }) {
  const width = clampPercent(value);

  return (
    <div className={`position-weight ${positionTier(value)}`}>
      <span>{percent(value, false)}</span>
      <div className="position-track" aria-hidden="true">
        <i style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function PortfolioTrendChart({
  data,
  dataNote,
  error,
  loading,
  onRangeChange,
  range,
}: {
  data: PortfolioNavPoint[];
  dataNote: string;
  error: string;
  loading: boolean;
  onRangeChange: (range: PerformanceRange) => void;
  range: PerformanceRange;
}) {
  const gradientId = useId().replace(/:/g, '');
  const [hovered, setHovered] = useState<{ point: PortfolioNavPoint & { changePercent: number }; x: number; y: number } | null>(null);
  const width = 640;
  const height = 152;
  const padding = { bottom: 22, left: 48, right: 12, top: 12 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const series = data.length > 1 ? data : [];
  const startPoint = series[0];
  const currentPoint = series[series.length - 1];
  const minPoint = series.reduce<PortfolioNavPoint | null>((min, point) => {
    if (!min || point.unitNav < min.unitNav) return point;
    return min;
  }, null);
  const min = series.length ? Math.min(...series.map(point => point.unitNav)) : 0;
  const max = series.length ? Math.max(...series.map(point => point.unitNav)) : 1;
  const rangeValue = max - min || 1;
  const plotted = series.map((point, index) => {
    const x = padding.left + (index / (series.length - 1 || 1)) * plotWidth;
    const y = padding.top + plotHeight - ((point.unitNav - min) / rangeValue) * plotHeight;
    const changePercent = startPoint ? ((point.unitNav - startPoint.unitNav) / startPoint.unitNav) * 100 : 0;
    return { ...point, changePercent, x, y };
  });
  const currentChangePercent = currentPoint && startPoint
    ? ((currentPoint.unitNav - startPoint.unitNav) / startPoint.unitNav) * 100
    : 0;
  const isUp = currentPoint && startPoint ? currentPoint.unitNav >= startPoint.unitNav : true;
  const tone = valueTone(currentPoint && startPoint ? currentPoint.unitNav - startPoint.unitNav : 0, currentChangePercent);
  const color = isUp ? '#22c55e' : tone === 'negative-soft' ? '#fb7185' : '#ef4444';
  const points = plotted.map(point => `${point.x},${point.y}`);
  const areaPath =
    plotted.length > 1
      ? `M ${plotted[0].x} ${padding.top + plotHeight} L ${points.join(' L ')} L ${plotted[plotted.length - 1].x} ${padding.top + plotHeight} Z`
      : '';
  const yTicks = [max, min + rangeValue / 2, min];

  function handleMouseMove(event: React.MouseEvent<SVGSVGElement>) {
    if (plotted.length === 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * width;
    const nearest = plotted.reduce((best, point) => (
      Math.abs(point.x - x) < Math.abs(best.x - x) ? point : best
    ));
    setHovered({ point: nearest, x: nearest.x, y: nearest.y });
  }

  const tooltipClassName = hovered
    ? [
        'chart-tooltip',
        hovered.x < width * 0.25 ? 'align-left' : '',
        hovered.x > width * 0.75 ? 'align-right' : '',
        hovered.y < height * 0.6 ? 'placement-below' : '',
      ].filter(Boolean).join(' ')
    : 'chart-tooltip';

  return (
    <div className="metric-card portfolio-trend-card">
      <div className="trend-card-head">
        <div>
          <span>单位净值走势</span>
          <small>{dataNote}</small>
        </div>
        <div className="range-switcher" aria-label="组合净值走势周期">
          {performanceOptions.map(option => (
            <button
              className={range === option ? 'active' : ''}
              key={option}
              onClick={() => onRangeChange(option)}
              type="button"
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      {plotted.length > 1 ? (
        <div className="performance-chart-wrap" onMouseLeave={() => setHovered(null)}>
          <svg
            aria-label={`单位净值走势，周期 ${range}`}
            className="hero-area-chart"
            height={height}
            onMouseMove={handleMouseMove}
            role="img"
            viewBox={`0 0 ${width} ${height}`}
            width={width}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.14" />
                <stop offset="100%" stopColor={color} stopOpacity="0.018" />
              </linearGradient>
            </defs>
            {yTicks.map((tick, index) => {
              const y = padding.top + plotHeight - ((tick - min) / rangeValue) * plotHeight;
              return (
                <g key={`${tick}-${index}`}>
                  <line
                    className="chart-grid-line"
                    x1={padding.left}
                    x2={width - padding.right}
                    y1={y}
                    y2={y}
                  />
                  <text className="chart-axis-label" x={0} y={y + 4}>
                    {unitNav(tick)}
                  </text>
                </g>
              );
            })}
            <path d={areaPath} fill={`url(#${gradientId})`} />
            <polyline
              fill="none"
              points={points.join(' ')}
              stroke={color}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
            />
            {plotted.map((point, index) => {
              const isLast = index === plotted.length - 1;
              const isLowest = minPoint?.date === point.date && minPoint?.unitNav === point.unitNav;
              return (
                <g key={`${point.date}-${index}`}>
                  {(isLast || index === 0 || isLowest) && (
                    <circle
                      className={isLast ? 'chart-point current' : 'chart-point'}
                      cx={point.x}
                      cy={point.y}
                      fill="#0b1220"
                      r={isLast ? 3.5 : 3}
                      stroke={color}
                      strokeWidth="1.8"
                    />
                  )}
                </g>
              );
            })}
          </svg>
          {hovered && (
            <div
              className={tooltipClassName}
              style={{
                left: `${(hovered.x / width) * 100}%`,
                top: `${(hovered.y / height) * 100}%`,
              }}
            >
              <span>{hovered.point.date}</span>
              <strong>单位净值 {unitNav(hovered.point.unitNav)}</strong>
              <small>{money(hovered.point.totalAssets)}</small>
              <b className={pnlClass(hovered.point.changePercent)}>{percent(hovered.point.changePercent)}</b>
            </div>
          )}
        </div>
      ) : (
        <div className="trend-empty">
          {loading ? '正在计算单位净值...' : error || '单位净值数据不足，等待交易和历史行情累积后展示。'}
        </div>
      )}
    </div>
  );
}

function SortHeader({
  active,
  children,
  className = '',
  onSort,
  sortConfig,
}: {
  active: SortKey;
  children: React.ReactNode;
  className?: string;
  onSort: (key: SortKey) => void;
  sortConfig: SortConfig;
}) {
  const isActive = sortConfig.key === active;

  return (
    <th className={className} aria-sort={isActive ? (sortConfig.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button className={`sort-header ${isActive ? 'active' : ''}`} onClick={() => onSort(active)} type="button">
        {children}
        <span>{isActive ? (sortConfig.direction === 'asc' ? '↑' : '↓') : '↕'}</span>
      </button>
    </th>
  );
}

function HoldingsTable({
  editingId,
  metrics,
  onOpenDetails,
  onSort,
  onStartEdit,
  onUpdatePrice,
  priceDraft,
  setPriceDraft,
  sortConfig,
  totalHoldings,
}: {
  editingId: string;
  metrics: HoldingMetrics[];
  onOpenDetails: (
    event: React.KeyboardEvent<HTMLTableRowElement> | React.MouseEvent<HTMLTableRowElement>,
    holding: Holding
  ) => void;
  onSort: (key: SortKey) => void;
  onStartEdit: (holding: Holding) => void;
  onUpdatePrice: (event: FormEvent<HTMLFormElement>, holding: Holding) => void;
  priceDraft: string;
  setPriceDraft: (value: string) => void;
  sortConfig: SortConfig;
  totalHoldings: number;
}) {
  return (
    <div className="table-shell holdings-table-shell">
      <table className="holdings-table">
        <colgroup>
          <col className="holding-col-stock" />
          <col className="holding-col-quantity" />
          <col className="holding-col-market" />
          <col className="holding-col-price" />
          <col className="holding-col-pnl" />
          <col className="holding-col-return" />
          <col className="holding-col-today" />
          <col className="holding-col-position" />
        </colgroup>
        <thead>
          <tr>
            <th>股票 / 公司</th>
            <th className="number">持股数量</th>
            <SortHeader active="marketValue" className="number" onSort={onSort} sortConfig={sortConfig}>
              当前市值
            </SortHeader>
            <th className="number">现价 / 成本</th>
            <SortHeader active="cumulativePnl" className="number" onSort={onSort} sortConfig={sortConfig}>
              累计盈亏
            </SortHeader>
            <SortHeader active="cumulativeReturn" className="number" onSort={onSort} sortConfig={sortConfig}>
              累计收益率
            </SortHeader>
            <SortHeader active="todayPnl" className="number" onSort={onSort} sortConfig={sortConfig}>
              今日涨跌
            </SortHeader>
            <SortHeader active="positionRate" className="number" onSort={onSort} sortConfig={sortConfig}>
              仓位占比
            </SortHeader>
          </tr>
        </thead>
        <tbody>
          {metrics.map(metric => (
            <HoldingRow
              editingId={editingId}
              key={metric.holding.id}
              metric={metric}
              onOpenDetails={onOpenDetails}
              onStartEdit={onStartEdit}
              onUpdatePrice={onUpdatePrice}
              priceDraft={priceDraft}
              setPriceDraft={setPriceDraft}
            />
          ))}
          {metrics.length === 0 && (
            <tr>
              <td colSpan={8}>
                <div className="empty-state">
                  <strong>{totalHoldings === 0 ? '暂无持仓' : '没有匹配的持仓'}</strong>
                  <span>
                    {totalHoldings === 0 ? '先在交易页添加买入记录，系统会同步生成持仓。' : '调整筛选条件或搜索关键词后再试。'}
                  </span>
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function HoldingRow({
  editingId,
  metric,
  onOpenDetails,
  onStartEdit,
  onUpdatePrice,
  priceDraft,
  setPriceDraft,
}: {
  editingId: string;
  metric: HoldingMetrics;
  onOpenDetails: (
    event: React.KeyboardEvent<HTMLTableRowElement> | React.MouseEvent<HTMLTableRowElement>,
    holding: Holding
  ) => void;
  onStartEdit: (holding: Holding) => void;
  onUpdatePrice: (event: FormEvent<HTMLFormElement>, holding: Holding) => void;
  priceDraft: string;
  setPriceDraft: (value: string) => void;
}) {
  const { holding } = metric;
  const cumulativeTone = pnlClass(metric.cumulativePnl, metric.cumulativeReturn);
  const todayTone = pnlClass(metric.todayPnl, metric.todayReturn);

  return (
    <tr
      aria-label={`${holding.stock_code} 持仓详情`}
      onClick={event => onOpenDetails(event, holding)}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpenDetails(event, holding);
        }
      }}
      role="link"
      tabIndex={0}
      title={`${holding.stock_code} 详情`}
    >
      <td className="stock-name-cell">
        <div className="stock-identity">
          <TickerLogo code={holding.stock_code} />
          <div className="stock-copy">
            <strong>{holding.stock_code}</strong>
            <span>{metric.companyName}</span>
            <em className={metric.assetType === 'ETF' ? 'asset-type-badge etf' : 'asset-type-badge stock'}>
              {metric.assetType}
            </em>
          </div>
        </div>
      </td>
      <td className="number quantity-cell">{formatShares(metric.quantity)}</td>
      <td className="number value-cell">
        <strong>{money(metric.marketValue)}</strong>
      </td>
      <td className="number price-cell">
        {editingId === holding.id ? (
          <form className="inline-form" onSubmit={event => onUpdatePrice(event, holding)}>
            <input
              inputMode="decimal"
              onChange={event => setPriceDraft(event.target.value)}
              value={priceDraft}
            />
            <button className="small-button" type="submit">保存</button>
          </form>
        ) : (
          <button className="price-edit-button" onClick={() => onStartEdit(holding)} type="button">
            <span>现价</span>
            <strong>{money(metric.currentPrice)}</strong>
          </button>
        )}
        <div className="price-cost-stack">
          <span>成本 {money(metric.costPrice)}</span>
        </div>
      </td>
      <td className={`number value-cell pnl-value ${cumulativeTone}`}>
        <strong>{signedMoney(metric.cumulativePnl)}</strong>
      </td>
      <td className={`number value-cell pnl-rate ${cumulativeTone}`}>
        <strong>{percent(metric.cumulativeReturn)}</strong>
      </td>
      <td className={`number value-cell today-cell ${todayTone}`} title={metric.hasDailyQuote ? '今日盈亏基于报价涨跌额计算' : '缺少报价涨跌额，无法计算今日盈亏'}>
        <strong>{signedMoney(metric.todayPnl)}</strong>
        <span>{metric.hasDailyQuote ? percent(metric.todayReturn) : '行情缺失'}</span>
      </td>
      <td className="number position-cell">
        <PositionWeightBar value={metric.positionRate} />
      </td>
    </tr>
  );
}

function deriveHoldingBase(holding: Holding, quoteRefreshFailed = false): Omit<HoldingMetrics, 'positionRate'> {
  const quantity = numberOrNull(holding.quantity);
  const currentPrice = numberOrNull(holding.current_price);
  const costPrice = numberOrNull(holding.cost_price);
  const totalCost = numberOrNull(holding.total_cost) ?? 0;
  const quoteChange = numberOrNull(holding.quote_change);
  const hasValidPrice = currentPrice !== null && currentPrice > 0 && quantity !== null && quantity > 0;
  const marketValue = hasValidPrice ? currentPrice * quantity : null;
  const cumulativePnl = marketValue !== null ? marketValue - totalCost : null;
  const cumulativeReturn = totalCost > 0 && cumulativePnl !== null ? (cumulativePnl / totalCost) * 100 : null;
  const hasDailyQuote =
    !quoteRefreshFailed &&
    hasValidPrice &&
    quoteChange !== null &&
    isCurrentMarketDate(holding.quote_time) &&
    Boolean(holding.quote_updated_at || holding.quote_time || holding.quote_source);
  const todayPnl = hasDailyQuote ? quoteChange * quantity : null;
  const previousPrice = hasDailyQuote && currentPrice !== null && quoteChange !== null ? currentPrice - quoteChange : null;
  const previousMarketValue = previousPrice !== null && previousPrice > 0 && quantity !== null ? previousPrice * quantity : null;
  const todayReturn = previousMarketValue && previousMarketValue > 0 && todayPnl !== null
    ? (todayPnl / previousMarketValue) * 100
    : null;

  return {
    assetType: isEtf(holding) ? 'ETF' : 'Stock',
    companyName: getCompanyName(holding),
    costPrice,
    cumulativePnl,
    cumulativeReturn,
    currentPrice,
    hasDailyQuote,
    hasValidPrice,
    holding,
    marketValue,
    previousMarketValue,
    quantity,
    todayPnl,
    todayReturn,
    totalCost,
  };
}

function buildSummary(metrics: HoldingMetrics[], cashBalance: number): PortfolioSummary {
  const totalCost = metrics.reduce((sum, item) => sum + item.totalCost, 0);
  const priceMissingCount = metrics.filter(item => !item.hasValidPrice).length;
  const todayMissingCount = metrics.filter(item => !item.hasDailyQuote).length;
  const priceDataComplete = priceMissingCount === 0;
  const todayDataComplete = todayMissingCount === 0;
  const marketValue = priceDataComplete
    ? metrics.reduce((sum, item) => sum + (item.marketValue ?? 0), 0)
    : null;
  const cumulativePnl = marketValue !== null ? marketValue - totalCost : null;
  const cumulativeReturn = totalCost > 0 && cumulativePnl !== null ? (cumulativePnl / totalCost) * 100 : null;
  const todayPnl = todayDataComplete
    ? metrics.reduce((sum, item) => sum + (item.todayPnl ?? 0), 0)
    : null;
  const previousMarketValue = todayDataComplete
    ? metrics.reduce((sum, item) => sum + (item.previousMarketValue ?? 0), 0)
    : null;
  const todayReturn = previousMarketValue && previousMarketValue > 0 && todayPnl !== null
    ? (todayPnl / previousMarketValue) * 100
    : null;
  const totalAssets = marketValue !== null ? marketValue + cashBalance : null;

  return {
    cumulativePnl,
    cumulativeReturn,
    marketValue,
    previousMarketValue,
    priceDataComplete,
    priceMissingCount,
    todayDataComplete,
    todayMissingCount,
    todayPnl,
    todayReturn,
    totalAssets,
    totalCost,
  };
}

function sortValue(metric: HoldingMetrics, key: SortKey) {
  switch (key) {
    case 'marketValue':
      return metric.marketValue;
    case 'cumulativePnl':
      return metric.cumulativePnl;
    case 'cumulativeReturn':
      return metric.cumulativeReturn;
    case 'positionRate':
      return metric.positionRate;
    case 'todayPnl':
      return metric.todayPnl;
    default:
      return null;
  }
}

export default function Holdings() {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [cashBalance, setCashBalance] = useState(0);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState<RefreshStatus>(null);
  const [quoteFailures, setQuoteFailures] = useState<Set<string>>(() => new Set());
  const [editingId, setEditingId] = useState('');
  const [priceDraft, setPriceDraft] = useState('');
  const [holdingFilter, setHoldingFilter] = useState<HoldingFilter>('all');
  const [performanceRange, setPerformanceRange] = useState<PerformanceRange>('1D');
  const [sortConfig, setSortConfig] = useState<SortConfig>({ direction: 'desc', key: 'marketValue' });
  const [navResult, setNavResult] = useState<PortfolioNavResult | null>(null);
  const [navLoading, setNavLoading] = useState(false);
  const [navError, setNavError] = useState('');
  const [navReloadKey, setNavReloadKey] = useState(0);
  const navCacheRef = useRef(new Map<PerformanceRange, PortfolioNavResult>());

  async function loadHoldings() {
    setError('');
    const [data, flows, trades] = await Promise.all([
      getHoldings(),
      getFundFlows().catch(() => []),
      getTrades().catch(() => []),
    ]);
    setHoldings(data);
    setCashBalance(calculateCashBalance(flows, trades));
    setQuoteFailures(new Set());
  }

  useEffect(() => {
    loadHoldings()
      .catch(err => setError(err instanceof Error ? err.message : '持仓加载失败'))
      .finally(() => setLoading(false));
  }, []);

  const baseMetrics = useMemo(
    () => holdings.map(holding => deriveHoldingBase(holding, quoteFailures.has(holding.stock_code.toUpperCase()))),
    [holdings, quoteFailures]
  );

  const metrics = useMemo(() => {
    const portfolioMarketValue = baseMetrics.reduce((sum, item) => sum + (item.marketValue ?? 0), 0);
    return baseMetrics.map(metric => ({
      ...metric,
      positionRate: portfolioMarketValue > 0 && metric.marketValue !== null
        ? (metric.marketValue / portfolioMarketValue) * 100
        : null,
    }));
  }, [baseMetrics]);

  const summary = useMemo(() => buildSummary(metrics, cashBalance), [cashBalance, metrics]);
  const latestUpdate = useMemo(() => latestQuoteUpdate(holdings), [holdings]);

  useEffect(() => {
    let cancelled = false;
    setNavError('');
    const cached = navCacheRef.current.get(performanceRange);
    if (cached) {
      setNavResult(cached);
      setNavLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setNavLoading(true);

    getPortfolioNav(performanceRange)
      .then(result => {
        navCacheRef.current.set(performanceRange, result);
        if (!cancelled) setNavResult(result);
      })
      .catch(err => {
        if (!cancelled) setNavError(err instanceof Error ? err.message : '单位净值加载失败');
      })
      .finally(() => {
        if (!cancelled) setNavLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [navReloadKey, performanceRange]);

  const filteredAndSortedMetrics = useMemo(() => {
    const filtered = metrics.filter(metric => {
      return (
        holdingFilter === 'all' ||
        (holdingFilter === 'etf' && metric.assetType === 'ETF') ||
        (holdingFilter === 'stock' && metric.assetType === 'Stock') ||
        (holdingFilter === 'profit' && (metric.cumulativePnl ?? 0) > 0) ||
        (holdingFilter === 'loss' && (metric.cumulativePnl ?? 0) < 0)
      );
    });

    return [...filtered].sort((a, b) => {
      const left = sortValue(a, sortConfig.key);
      const right = sortValue(b, sortConfig.key);

      if (left === null && right === null) return a.holding.stock_code.localeCompare(b.holding.stock_code);
      if (left === null) return 1;
      if (right === null) return -1;

      const diff = left - right;
      return sortConfig.direction === 'asc' ? diff : -diff;
    });
  }, [holdingFilter, metrics, sortConfig]);

  async function handleRefreshPrices() {
    setRefreshing(true);
    setError('');
    setMessage('');
    setRefreshStatus(null);
    try {
      const result = await refreshHoldingPrices();
      setHoldings(result.holdings);
      setQuoteFailures(new Set(result.failed.map(code => code.toUpperCase())));
      if (result.failed.length > 0) {
        setRefreshStatus({
          text: `部分行情加载失败：${result.failed.join(', ')}`,
          tone: 'error',
        });
      } else {
        setRefreshStatus({
          text: `行情已刷新：${formatDateTime(result.refreshed_at)}`,
          tone: 'success',
        });
      }
      setNavReloadKey(value => value + 1);
      navCacheRef.current.clear();
    } catch (err) {
      setRefreshStatus({
        text: err instanceof Error ? err.message : '行情刷新失败',
        tone: 'error',
      });
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
      navCacheRef.current.clear();
      setNavReloadKey(value => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : '现价更新失败');
    }
  }

  function handleSort(key: SortKey) {
    setSortConfig(current => {
      if (current.key !== key) return { direction: 'desc', key };
      return { direction: current.direction === 'desc' ? 'asc' : 'desc', key };
    });
  }

  function openHoldingDetails(
    event: React.KeyboardEvent<HTMLTableRowElement> | React.MouseEvent<HTMLTableRowElement>,
    holding: Holding
  ) {
    const target = event.target as HTMLElement;
    if (target.closest('button, input, form, a, select')) return;

    const nextHash = `#/holdings?symbol=${encodeURIComponent(holding.stock_code)}`;
    if (window.location.hash !== nextHash) {
      window.history.pushState(null, '', `${window.location.pathname}${window.location.search}${nextHash}`);
    }
  }

  if (loading) return <div className="state-panel">正在加载持仓...</div>;

  const quoteUpdateNote = `最近行情更新：${formatDateTime(latestUpdate)}`;

  return (
    <section className="page-stack holdings-page">
      {(message || error) && (
        <div className={error ? 'alert error' : 'alert success'}>{error || message}</div>
      )}
      {summary.priceMissingCount > 0 && (
        <div className="alert warning">
          {summary.priceMissingCount} 个持仓缺少有效现价，市值、累计盈亏和仓位占比暂以占位显示。
        </div>
      )}
      {summary.todayMissingCount > 0 && holdings.length > 0 && (
        <div className="alert warning">
          {summary.todayMissingCount} 个持仓缺少当日涨跌额，今日盈亏 / 今日收益率暂不展示合计值。
        </div>
      )}

      <div className="portfolio-summary-grid">
        <div className="metric-card portfolio-summary-card">
          <div className="summary-hero-main">
            <span>总资产</span>
            <strong>{money(summary.totalAssets)}</strong>
            <small>持仓市值 {money(summary.marketValue)} · 可用资金 {money(cashBalance)}</small>
          </div>
          <div className="summary-metric-grid">
            <SummaryMetricCard
              label="累计盈亏"
              note={percent(summary.cumulativeReturn)}
              tone={pnlClass(summary.cumulativePnl, summary.cumulativeReturn)}
              value={signedMoney(summary.cumulativePnl)}
            />
            <SummaryMetricCard
              label="今日盈亏"
              note={percent(summary.todayReturn)}
              tone={pnlClass(summary.todayPnl, summary.todayReturn)}
              value={signedMoney(summary.todayPnl)}
            />
          </div>
        </div>

        <PortfolioTrendChart
          data={navResult?.points || []}
          dataNote={navResult?.data_note || '单位净值按交易记录、资金流水和历史行情计算'}
          error={navError}
          loading={navLoading}
          onRangeChange={setPerformanceRange}
          range={performanceRange}
        />
      </div>

      <div className="holdings-filter-row">
        <FilterTabs active={holdingFilter} onChange={setHoldingFilter} options={filterOptions} />
        <div className="holdings-table-actions">
          {refreshStatus && (
            <span className={`refresh-status ${refreshStatus.tone}`}>{refreshStatus.text}</span>
          )}
          <button
            className={`secondary-button refresh-button ${refreshing ? 'loading' : ''}`}
            disabled={refreshing}
            onClick={handleRefreshPrices}
            type="button"
          >
            {refreshing ? '刷新中...' : '刷新行情'}
          </button>
        </div>
      </div>

      <HoldingsTable
        editingId={editingId}
        metrics={filteredAndSortedMetrics}
        onOpenDetails={openHoldingDetails}
        onSort={handleSort}
        onStartEdit={startEdit}
        onUpdatePrice={handleUpdatePrice}
        priceDraft={priceDraft}
        setPriceDraft={setPriceDraft}
        sortConfig={sortConfig}
        totalHoldings={holdings.length}
      />

      <div className="holdings-footer">
        <span>{quoteUpdateNote}</span>
      </div>
    </section>
  );
}
