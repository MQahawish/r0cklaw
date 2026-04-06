/**
 * Economy Panel -- Phase 7
 * Price history sparklines, shortage tracker, recent trade log.
 */

import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { EconomyDiagnostic, PricePoint } from '../../convex/rocklaw/observe';

// ── Sparkline ─────────────────────────────────────────────────────────────────

function Sparkline({ points, basePrice }: { points: PricePoint[]; basePrice: number }) {
  if (points.length < 2) {
    return <span style={{ fontSize: 10, color: '#4b5563' }}>no data</span>;
  }

  const W = 80, H = 24;
  const prices = points.map((p) => p.price);
  const minP = Math.min(...prices, basePrice) * 0.9;
  const maxP = Math.max(...prices, basePrice) * 1.1;
  const range = maxP - minP || 1;

  const toX = (i: number) => (i / (points.length - 1)) * W;
  const toY = (p: number) => H - ((p - minP) / range) * H;

  const polyline = points.map((p, i) => `${toX(i).toFixed(1)},${toY(p.price).toFixed(1)}`).join(' ');
  const baseY = toY(basePrice).toFixed(1);

  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  const trending = last.price > prev.price ? 'up' : last.price < prev.price ? 'down' : 'flat';
  const lineColour = trending === 'up' ? '#ef4444' : trending === 'down' ? '#22c55e' : '#6b7280';

  return (
    <svg width={W} height={H} style={{ overflow: 'visible' }}>
      {/* Base price reference line */}
      <line x1={0} y1={baseY} x2={W} y2={baseY} stroke="#374151" strokeWidth={1} strokeDasharray="2,2" />
      {/* Price line */}
      <polyline points={polyline} fill="none" stroke={lineColour} strokeWidth={1.5} strokeLinejoin="round" />
      {/* Last point dot */}
      <circle
        cx={toX(points.length - 1)}
        cy={toY(last.price)}
        r={2}
        fill={lineColour}
      />
    </svg>
  );
}

// ── Shortage badge ────────────────────────────────────────────────────────────

function ShortageBadge({ level }: { level: string }) {
  if (level === 'none') {
    return (
      <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, fontWeight: 700, textTransform: 'uppercase' as const, background: '#1f2937', color: '#9ca3af', border: '1px solid #37415166' }}>
        stable
      </span>
    );
  }
  const style = level === 'critical'
    ? { background: '#7f1d1d', color: '#fca5a5', border: '1px solid #ef444444' }
    : { background: '#78350f', color: '#fcd34d', border: '1px solid #f59e0b44' };
  return (
    <span style={{ ...style, fontSize: 9, padding: '1px 5px', borderRadius: 3, fontWeight: 700, textTransform: 'uppercase' as const }}>
      {level}
    </span>
  );
}

// ── Trend arrow ───────────────────────────────────────────────────────────────

function TrendArrow({ points }: { points: PricePoint[] }) {
  if (points.length < 2) return <span style={{ color: '#4b5563' }}>—</span>;
  const last = points[points.length - 1].price;
  const first = points[0].price;
  const pct = ((last - first) / first) * 100;
  if (Math.abs(pct) < 2) return <span style={{ color: '#6b7280', fontSize: 11 }}>stable</span>;
  const up = pct > 0;
  return (
    <span style={{ color: up ? '#ef4444' : '#22c55e', fontSize: 11 }}>
      {up ? '↑' : '↓'} {Math.abs(pct).toFixed(0)}%
    </span>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function EconomyPanel() {
  const history = useQuery(api.rocklaw.observe.getPriceHistory, { ticks: 60 }) ?? [];
  const dashboard = useQuery(api.rocklaw.god.getDashboard);
  const diagnostics = useQuery(api.rocklaw.observe.getEconomyDiagnostics) ?? [];
  const diagnosticsByItem = new Map(diagnostics.map((entry) => [entry.item, entry]));

  const shortages = history.filter((h) => {
    const last = h.history[h.history.length - 1];
    return last && last.shortageLevel !== 'none';
  });

  const recentTrades = dashboard?.recentActions
    .filter((a: any) => ['buy', 'sell', 'trade', 'give'].includes(a.action))
    .slice(0, 15) ?? [];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 260px', gap: 20, height: 520, overflowY: 'auto' }}>

      {/* Left: Price table */}
      <div>
        {/* Shortage alerts */}
        {shortages.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={SECTION_LABEL}>⚠ Active Shortages</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {shortages.map((h) => {
                const last = h.history[h.history.length - 1]!;
                const diagnostic = diagnosticsByItem.get(h.item);
                return (
                  <div key={h.item} style={{ width: 240, fontSize: 12, padding: '8px 10px', borderRadius: 6, background: last.shortageLevel === 'critical' ? '#7f1d1d' : '#78350f', color: last.shortageLevel === 'critical' ? '#fca5a5' : '#fcd34d', border: `1px solid ${last.shortageLevel === 'critical' ? '#ef444444' : '#f59e0b44'}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <span>{h.item}</span>
                      <span>{last.price}c</span>
                    </div>
                    {diagnostic && (
                      <div style={{ marginTop: 4 }}>
                        <ShortageWhy diagnostic={diagnostic} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Price table */}
        <div style={SECTION_LABEL}>Price History</div>
        {history.length === 0 ? (
          <div style={MUTED}>No price history yet. Prices are recorded when they change.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: '#6b7280', fontSize: 10, textAlign: 'left' }}>
                <th style={TH}>Item</th>
                <th style={TH}>Current</th>
                <th style={TH}>Base</th>
                <th style={TH}>Trend</th>
                <th style={TH}>Sparkline</th>
                <th style={TH}>Status</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => {
                const last = h.history[h.history.length - 1];
                if (!last) return null;
                return (
                  <tr key={h.item} style={{ borderBottom: '1px solid #111827' }}>
                    <td style={TD}><span style={{ color: '#e5e7eb' }}>{h.item}</span></td>
                    <td style={TD}><span style={{ color: '#f9fafb', fontWeight: 600 }}>{last.price}c</span></td>
                    <td style={TD}><span style={{ color: '#6b7280' }}>{h.basePrice}c</span></td>
                    <td style={TD}><TrendArrow points={h.history} /></td>
                    <td style={{ ...TD, paddingTop: 4, paddingBottom: 4 }}>
                      <Sparkline points={h.history} basePrice={h.basePrice} />
                    </td>
                    <td style={TD}><ShortageBadge level={last.shortageLevel} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Right: Trade log */}
      <div style={{ borderLeft: '1px solid #1f2937', paddingLeft: 16 }}>
        <div style={SECTION_LABEL}>Recent Trades</div>
        {recentTrades.length === 0 ? (
          <div style={MUTED}>No trades yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {recentTrades.map((t: any) => (
              <div key={t._id} style={{ fontSize: 11, padding: '5px 0', borderBottom: '1px solid #111827' }}>
                <div>
                  <span style={{ color: '#e5e7eb' }}>{t.agentName.split(' ')[0]}</span>
                  <span style={{ color: '#4b5563', margin: '0 4px' }}>{t.action}</span>
                  {t.target && <span style={{ color: '#93c5fd' }}>{t.target}</span>}
                </div>
                {t.message && (
                  <div style={{ color: '#6b7280', marginTop: 1, fontStyle: 'italic' }}>
                    "{t.message.slice(0, 50)}{t.message.length > 50 ? '…' : ''}"
                  </div>
                )}
                <div style={{ color: '#374151', marginTop: 1 }}>Day {t.day}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ShortageWhy({ diagnostic }: { diagnostic: EconomyDiagnostic }) {
  const stockLine =
    diagnostic.shortageLevel === 'critical'
      ? `${diagnostic.totalSupply} left village-wide. Critical shortage.`
      : `${diagnostic.totalSupply} left village-wide. Low stock.`;

  let demandLine = '';
  if (diagnostic.demandMultiplier >= 1.35) {
    demandLine = 'Demand is high right now.';
  } else if (diagnostic.demandMultiplier >= 1.1) {
    demandLine = 'Demand is a bit elevated.';
  } else {
    demandLine = 'Demand is normal.';
  }

  const topReason = diagnostic.reasons[0]
    ?.replace(/^Supply is at \d+, /, '')
    .replace(/^inside the shortage band up to /, 'Low-stock threshold is ')
    .replace(/^below the critical threshold of /, 'Critical threshold is ')
    .replace(/^above the shortage thresholds\./, 'Stock is above shortage thresholds.')
    .replace(/\.$/, '');

  return (
    <div style={{ fontSize: 10, color: '#fde68a', lineHeight: 1.35 }}>
      {stockLine}
      {' '}
      {demandLine}
      {topReason ? ` ${topReason}.` : ''}
    </div>
  );
}

const SECTION_LABEL: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.08em',
  color: '#4b5563',
  textTransform: 'uppercase',
  marginBottom: 8,
};

const MUTED: React.CSSProperties = {
  fontSize: 11,
  color: '#4b5563',
  fontStyle: 'italic',
};

const TH: React.CSSProperties = {
  padding: '4px 8px',
  fontWeight: 600,
  borderBottom: '1px solid #1f2937',
};

const TD: React.CSSProperties = {
  padding: '5px 8px',
  color: '#9ca3af',
};
