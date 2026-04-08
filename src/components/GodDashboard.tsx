/**
 * God Mode Dashboard -- Phase 5 / Phase 7 / Phase 8
 *
 * Tabs:
 *   Overview   -- agents, events, world log, injection, economy summary
 *   Inspector  -- click agent → browse live workspace files
 *   Relations  -- SVG interaction graph
 *   Economy    -- price history sparklines, shortage tracker, trade log
 *   Systems    -- live knob configuration, scenario presets
 */

import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import AgentInspector from './AgentInspector';
import RelationshipGraph from './RelationshipGraph';
import EconomyPanel from './EconomyPanel';
import SystemsPanel from './SystemsPanel';
import AgentConfigPanel from './AgentConfigPanel';
import RunConsolePanel from './RunConsolePanel';
import { TickSummaryCard } from './RunConsolePanel';
import LiveSimulationFrame from './LiveSimulationFrame.tsx';

// ── Tension bar colour ────────────────────────────────────────────────────────

function tensionColour(score: number): string {
  if (score >= 70) return '#ef4444';   // red
  if (score >= 40) return '#f97316';   // orange
  if (score >= 20) return '#eab308';   // yellow
  return '#22c55e';                     // green
}

function statColour(value: number, inverted = false): string {
  const bad = inverted ? value > 70 : value < 30;
  const mid = inverted ? value > 50 : value < 50;
  if (bad) return '#ef4444';
  if (mid) return '#f97316';
  return '#22c55e';
}

// ── Mini stat bar ─────────────────────────────────────────────────────────────

function StatBar({ value, inverted = false }: { value: number; inverted?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <div style={{ width: 40, height: 6, background: '#374151', borderRadius: 3, overflow: 'hidden', flexShrink: 0 }}>
        <div style={{
          width: `${Math.min(100, value)}%`,
          height: '100%',
          background: statColour(value, inverted),
          transition: 'width 0.3s',
        }} />
      </div>
      <span style={{ fontSize: 11, color: '#9ca3af', minWidth: 22, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

// ── Agent card ────────────────────────────────────────────────────────────────

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCostUsd(usd: number): string {
  if (usd === 0) return '$0.000';
  if (usd < 0.001) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(3)}`;
}

function repColour(score: number): string {
  if (score >= 70) return '#22c55e';
  if (score >= 40) return '#f97316';
  if (score < 20)  return '#ef4444';
  return '#fbbf24';
}

function AgentCard({ agent, repScore }: { agent: any; repScore?: number }) {
  const [expanded, setExpanded] = useState(false);
  const inv = JSON.parse(agent.inventory ?? '{}') as Record<string, number>;

  return (
    <div
      onClick={() => setExpanded(!expanded)}
      style={{
        background: '#1f2937',
        border: '1px solid #374151',
        borderRadius: 6,
        padding: '8px 10px',
        cursor: 'pointer',
        transition: 'border-color 0.2s',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = '#6b7280')}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = '#374151')}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontWeight: 600, color: '#f9fafb', fontSize: 13, lineHeight: 1.2 }}>{agent.name}</div>
          <div style={{ color: '#9ca3af', fontSize: 11, lineHeight: 1.2, marginTop: 2 }}>{agent.role}</div>
        </div>
        <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          {repScore !== undefined && (
            <span style={{
              fontSize: 10, padding: '1px 5px', borderRadius: 3,
              background: repColour(repScore) + '22',
              color: repColour(repScore),
              fontWeight: 700,
            }}>★{repScore}</span>
          )}
          <span style={{
            fontSize: 11,
            padding: '1px 6px',
            borderRadius: 3,
            background: agent.busy ? '#7c3aed22' : '#05966922',
            color: agent.busy ? '#a78bfa' : '#34d399',
          }}>
            {agent.busy ? 'busy' : agent.location}
          </span>
        </div>
      </div>
      <div style={{ marginTop: 6, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 2 }}>
        <div>
          <span style={{ fontSize: 10, color: '#6b7280' }}>⚡ </span>
          <StatBar value={agent.energy} />
        </div>
        <div>
          <span style={{ fontSize: 10, color: '#6b7280' }}>❤ </span>
          <StatBar value={agent.health} />
        </div>
        <div>
          <span style={{ fontSize: 10, color: '#6b7280' }}>🍞 </span>
          <StatBar value={agent.hunger} inverted />
        </div>
      </div>
      <div style={{ marginTop: 4, fontSize: 11, color: '#9ca3af' }}>
        {agent.coin}c
        {agent.busy && agent.busyUntilTick && (
          <span style={{ marginLeft: 8, color: '#a78bfa' }}>busy until tick {agent.busyUntilTick}</span>
        )}
      </div>
      {((agent.lifetimeInputTokens ?? 0) > 0 || (agent.lifetimeOutputTokens ?? 0) > 0) && (
        <div style={{ marginTop: 4, fontSize: 11, color: '#6b7280', fontFamily: 'ui-monospace, monospace' }}>
          {formatTokenCount(agent.lifetimeInputTokens ?? 0)} in
          {' / '}
          {formatTokenCount(agent.lifetimeOutputTokens ?? 0)} out
          {(agent.lifetimeCostUsd ?? 0) > 0 && (
            <span style={{ color: '#fde68a', marginLeft: 8 }}>{formatCostUsd(agent.lifetimeCostUsd ?? 0)}</span>
          )}
        </div>
      )}
      {expanded && (
        <div style={{ marginTop: 8, borderTop: '1px solid #374151', paddingTop: 8 }}>
          <div style={{ fontSize: 11, color: '#9ca3af' }}>
            {Object.entries(inv).length === 0 ? 'empty inventory' : (
              Object.entries(inv).map(([item, qty]) => (
                <span key={item} style={{ marginRight: 8 }}>{item}: {qty}</span>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Section header ────────────────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: '#6b7280', textTransform: 'uppercase', marginBottom: 8, borderBottom: '1px solid #1f2937', paddingBottom: 4 }}>
      {children}
    </div>
  );
}

// ── Main dashboard ────────────────────────────────────────────────────────────

type Tab = 'overview' | 'live' | 'run' | 'economy' | 'systems' | 'agents';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview',  label: 'Overview'  },
  { id: 'live',      label: 'Live'      },
  { id: 'run',       label: 'Run'       },
  { id: 'economy',   label: 'Economy'   },
  { id: 'systems',   label: 'Systems'   },
  { id: 'agents',    label: 'Agents'    },
];

export default function GodDashboard({ onClose }: { onClose?: () => void }) {
  const dashboard = useQuery(api.rocklaw.god.getDashboard);
  const runConsole = useQuery(api.rocklaw.god.getRunConsole);
  const startSim = useMutation(api.rocklaw.god.startSim);
  const stopSim = useMutation(api.rocklaw.god.stopSim);

  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [selectedAgentName, setSelectedAgentName] = useState<string | null>(null);

  if (!dashboard) {
    return (
      <div style={PAGE_STYLE}>
        <div style={{ ...PANEL_STYLE, display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200 }}>
          <span style={{ color: '#6b7280' }}>Loading world state...</span>
        </div>
      </div>
    );
  }

  const { worldState, agents, prices, recentPrayers, tension, repByAgent } = dashboard as any;
  const recentTickHistory = (runConsole?.tickHistory ?? []).slice(0, 8);
  const effectiveSelectedAgent = agents.some((agent: any) => agent.name === selectedAgentName)
    ? selectedAgentName
    : agents[0]?.name ?? null;

  const shortages = prices.filter((p: any) => p.shortageLevel !== 'none');
  const isRunning = worldState?.isRunning ?? false;

  return (
    <div style={PAGE_STYLE}>
      <div style={PANEL_STYLE}>

        {/* ── Header ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <span style={{ fontSize: 18, fontWeight: 700, color: '#f9fafb', letterSpacing: '0.05em' }}>
              ROCKLAW CONTROL
            </span>
            <span style={{ marginLeft: 12, fontSize: 13, color: '#9ca3af' }}>
              Day {worldState?.day ?? '?'}, {worldState?.timeOfDay ?? '?'} — Tick {worldState?.tick ?? '?'}
            </span>
            <div style={{ marginTop: 4, fontSize: 12, color: '#64748b' }}>
              Analytical dashboard first. Open the Live tab when you want the town view.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Tension meter */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: '#6b7280' }}>TENSION</span>
              <div style={{ width: 80, height: 8, background: '#374151', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ width: `${tension.score}%`, height: '100%', background: tensionColour(tension.score), transition: 'width 0.5s' }} />
              </div>
              <span style={{ fontSize: 12, color: tensionColour(tension.score), fontWeight: 600 }}>{tension.score}</span>
            </div>
            {/* Run / stop */}
            <button
              onClick={() => isRunning ? stopSim({}) : startSim({})}
              style={{
                fontSize: 12, padding: '4px 12px', borderRadius: 4, cursor: 'pointer', fontWeight: 600,
                background: isRunning ? '#7f1d1d' : '#14532d',
                color: isRunning ? '#fca5a5' : '#86efac',
                border: `1px solid ${isRunning ? '#ef444444' : '#22c55e44'}`,
              }}
            >
              {isRunning ? '⏸ Stop' : '▶ Start'}
            </button>
            {onClose && (
              <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#9ca3af', fontSize: 18, cursor: 'pointer', padding: '0 4px' }}>✕</button>
            )}
          </div>
        </div>

        {/* ── Tabs ── */}
        <div style={{ display: 'flex', gap: 2, marginBottom: 16, borderBottom: '1px solid #1f2937', paddingBottom: 0 }}>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: '6px 16px',
                fontSize: 12,
                fontWeight: activeTab === tab.id ? 700 : 400,
                cursor: 'pointer',
                background: 'transparent',
                border: 'none',
                borderBottom: activeTab === tab.id ? '2px solid #818cf8' : '2px solid transparent',
                color: activeTab === tab.id ? '#e0e7ff' : '#6b7280',
                fontFamily: 'inherit',
                letterSpacing: '0.04em',
                marginBottom: -1,
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* ── Tab: Agents ── */}
        {activeTab === 'agents' && (
          <div style={{ display: 'grid', gap: 20 }}>
            <AgentConfigPanel
              agents={agents}
              repByAgent={repByAgent ?? {}}
              selectedAgentName={effectiveSelectedAgent}
              onSelectAgent={setSelectedAgentName}
            />

            <div style={{ display: 'grid', gap: 20 }}>
              <div style={{ minWidth: 0, paddingTop: 4 }}>
                <SectionHeader>Inspector</SectionHeader>
                <div style={{ marginTop: 10 }}>
                  <AgentInspector
                    selectedAgentName={effectiveSelectedAgent}
                    onSelectAgent={setSelectedAgentName}
                  />
                </div>
              </div>

              <div style={{ minWidth: 0, paddingTop: 4 }}>
                <SectionHeader>Relations</SectionHeader>
                <div style={{ marginTop: 10 }}>
                  <RelationshipGraph focusAgent={effectiveSelectedAgent} />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Tab: Run ── */}
        {activeTab === 'run' && <RunConsolePanel />}

        {/* ── Tab: Live ── */}
        {activeTab === 'live' && <LiveSimulationFrame />}

        {/* ── Tab: Economy ── */}
        {activeTab === 'economy' && <EconomyPanel />}

        {/* ── Tab: Systems ── */}
        {activeTab === 'systems' && <SystemsPanel />}

        {/* ── Tab: Overview (main grid) ── */}
        {activeTab === 'overview' && <div style={{ display: 'grid', gridTemplateColumns: '250px 1fr', gap: 16, minHeight: 0 }}>

          {/* ── Column 1: Agents ── */}
          <div style={{ overflowY: 'auto', maxHeight: 540, paddingRight: 10 }}>
            <SectionHeader>Agents ({agents.length})</SectionHeader>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {agents.map((a: any) => <AgentCard key={a._id} agent={a} repScore={(repByAgent ?? {})[a.name]} />)}
            </div>
          </div>

          {/* ── Column 2: World log + Economy + Prayers ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto', maxHeight: 540, paddingRight: 10 }}>

            {/* World log */}
            <div>
              <SectionHeader>World Log</SectionHeader>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {recentTickHistory.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#4b5563', fontStyle: 'italic' }}>No tick history yet.</div>
                ) : recentTickHistory.map((entry: any) => (
                  <TickSummaryCard key={entry._id} summary={entry.summary} showDetails={false} />
                ))}
              </div>
            </div>

            {/* Economy */}
            <div>
              <SectionHeader>Economy</SectionHeader>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                {prices.map((p: any) => (
                  <div key={p.item} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '3px 6px', background: p.shortageLevel !== 'none' ? '#1f2937' : 'transparent', borderRadius: 3, border: p.shortageLevel !== 'none' ? '1px solid #37415166' : 'none' }}>
                    <span style={{ color: p.shortageLevel !== 'none' ? '#fbbf24' : '#9ca3af' }}>{p.item}</span>
                    <span style={{ color: '#e5e7eb' }}>{p.price}c {p.shortageLevel !== 'none' && <span style={{ color: '#ef4444' }}>⚠</span>}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Prayers (god-only) */}
            {recentPrayers.length > 0 && (
              <div>
                <SectionHeader>Prayers</SectionHeader>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {recentPrayers.map((p: any) => (
                    <div key={p._id} style={{ fontSize: 11, padding: '5px 8px', background: '#111827', borderRadius: 4, borderLeft: '2px solid #7c3aed' }}>
                      <span style={{ color: '#a78bfa', marginRight: 6 }}>{p.agentName}</span>
                      <span style={{ color: '#6b7280', marginRight: 6 }}>D{p.day}</span>
                      <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>"{p.message}"</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const PAGE_STYLE: React.CSSProperties = {
  minHeight: '100vh',
  background: 'linear-gradient(180deg, #090f1a 0%, #0f172a 100%)',
  display: 'flex',
  alignItems: 'stretch',
  justifyContent: 'center',
  padding: 20,
};

const PANEL_STYLE: React.CSSProperties = {
  background: '#111827',
  border: '1px solid #374151',
  borderRadius: 8,
  padding: 20,
  width: '100%',
  maxWidth: 1500,
  minHeight: 'calc(100vh - 40px)',
  overflowY: 'auto',
  overflowX: 'hidden',
  color: '#e5e7eb',
  fontFamily: 'ui-monospace, monospace',
};

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  background: '#1f2937',
  border: '1px solid #374151',
  borderRadius: 4,
  padding: '5px 8px',
  color: '#e5e7eb',
  fontSize: 12,
  fontFamily: 'ui-monospace, monospace',
  outline: 'none',
  boxSizing: 'border-box',
};
