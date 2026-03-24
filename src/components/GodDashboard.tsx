/**
 * God Mode Dashboard -- Phase 5 / Phase 7
 *
 * Tabs:
 *   Overview   -- agents, events, world log, injection, economy summary
 *   Inspector  -- click agent → browse live workspace files
 *   Relations  -- SVG interaction graph
 *   Economy    -- price history sparklines, shortage tracker, trade log
 */

import { useState } from 'react';
import { useQuery, useMutation, useAction } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { EventSuggestion } from '../../convex/rocklaw/god';
import AgentInspector from './AgentInspector';
import RelationshipGraph from './RelationshipGraph';
import EconomyPanel from './EconomyPanel';

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
      <div style={{ width: 48, height: 6, background: '#374151', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{
          width: `${Math.min(100, value)}%`,
          height: '100%',
          background: statColour(value, inverted),
          transition: 'width 0.3s',
        }} />
      </div>
      <span style={{ fontSize: 11, color: '#9ca3af', minWidth: 26 }}>{value}</span>
    </div>
  );
}

// ── Agent card ────────────────────────────────────────────────────────────────

function AgentCard({ agent }: { agent: any }) {
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
          <span style={{ fontWeight: 600, color: '#f9fafb', fontSize: 13 }}>{agent.name}</span>
          <span style={{ color: '#9ca3af', fontSize: 11, marginLeft: 6 }}>{agent.role}</span>
        </div>
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

// ── Event pill ────────────────────────────────────────────────────────────────

const SEVERITY_STYLE: Record<string, { bg: string; text: string }> = {
  low:    { bg: '#05966922', text: '#34d399' },
  medium: { bg: '#d9770622', text: '#fb923c' },
  high:   { bg: '#ef444422', text: '#f87171' },
};

function ActiveEventRow({ event, onResolve }: { event: any; onResolve: (id: Id<'rl_world_events'>) => void }) {
  const s = SEVERITY_STYLE[event.severity] ?? SEVERITY_STYLE.low;
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 8px',
      background: '#1f2937',
      borderRadius: 4,
      border: `1px solid ${s.text}44`,
    }}>
      <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 3, background: s.bg, color: s.text, flexShrink: 0 }}>
        {event.severity}
      </span>
      <span style={{ fontSize: 12, color: '#e5e7eb', flex: 1 }}>{event.description}</span>
      <button
        onClick={() => onResolve(event._id)}
        style={{ fontSize: 10, color: '#6b7280', background: 'transparent', border: '1px solid #374151', borderRadius: 3, padding: '2px 6px', cursor: 'pointer', flexShrink: 0 }}
      >
        resolve
      </button>
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

type Tab = 'overview' | 'inspector' | 'relations' | 'economy';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview',  label: 'Overview'  },
  { id: 'inspector', label: 'Inspector' },
  { id: 'relations', label: 'Relations' },
  { id: 'economy',   label: 'Economy'   },
];

export default function GodDashboard({ onClose }: { onClose: () => void }) {
  const dashboard = useQuery(api.rocklaw.god.getDashboard);
  const injectEvent = useMutation(api.rocklaw.god.injectEvent);
  const resolveEvent = useMutation(api.rocklaw.god.resolveEvent);
  const startSim = useMutation(api.rocklaw.god.startSim);
  const stopSim = useMutation(api.rocklaw.god.stopSim);
  const suggestEventsAction = useAction(api.rocklaw.god.suggestEvents);

  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [customType, setCustomType] = useState('');
  const [customDesc, setCustomDesc] = useState('');
  const [customSeverity, setCustomSeverity] = useState<'low' | 'medium' | 'high'>('medium');
  const [suggestions, setSuggestions] = useState<EventSuggestion[] | null>(null);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);

  const handleSuggest = async () => {
    setLoadingSuggestions(true);
    try {
      const results = await suggestEventsAction({});
      setSuggestions(results);
    } finally {
      setLoadingSuggestions(false);
    }
  };

  const handleInject = async (type: string, description: string, severity: 'low' | 'medium' | 'high') => {
    if (!description.trim()) return;
    await injectEvent({ type, description, severity });
  };

  const handleCustomInject = async () => {
    if (!customDesc.trim()) return;
    await injectEvent({ type: customType || 'custom', description: customDesc, severity: customSeverity });
    setCustomType('');
    setCustomDesc('');
  };

  if (!dashboard) {
    return (
      <div style={{ ...OVERLAY_STYLE }}>
        <div style={{ ...PANEL_STYLE, display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200 }}>
          <span style={{ color: '#6b7280' }}>Loading world state...</span>
        </div>
      </div>
    );
  }

  const { worldState, agents, activeEvents, recentActions, prices, recentPrayers, tension } = dashboard;

  const shortages = prices.filter((p: any) => p.shortageLevel !== 'none');
  const isRunning = worldState?.isRunning ?? false;

  return (
    <div style={OVERLAY_STYLE} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={PANEL_STYLE}>

        {/* ── Header ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <span style={{ fontSize: 18, fontWeight: 700, color: '#f9fafb', letterSpacing: '0.05em' }}>
              ⚡ ROCKLAW GOD MODE
            </span>
            <span style={{ marginLeft: 12, fontSize: 13, color: '#9ca3af' }}>
              Day {worldState?.day ?? '?'}, {worldState?.timeOfDay ?? '?'} — Tick {worldState?.tick ?? '?'}
            </span>
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
            <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#9ca3af', fontSize: 18, cursor: 'pointer', padding: '0 4px' }}>✕</button>
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

        {/* ── Tab: Inspector ── */}
        {activeTab === 'inspector' && <AgentInspector />}

        {/* ── Tab: Relations ── */}
        {activeTab === 'relations' && <RelationshipGraph />}

        {/* ── Tab: Economy ── */}
        {activeTab === 'economy' && <EconomyPanel />}

        {/* ── Tab: Overview (main grid) ── */}
        {activeTab === 'overview' && <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr 1fr', gap: 16, minHeight: 0 }}>

          {/* ── Column 1: Agents ── */}
          <div style={{ overflowY: 'auto', maxHeight: 540 }}>
            <SectionHeader>Agents ({agents.length})</SectionHeader>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {agents.map((a: any) => <AgentCard key={a._id} agent={a} />)}
            </div>
          </div>

          {/* ── Column 2: Events + Injection ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto', maxHeight: 540 }}>

            {/* Active events */}
            <div>
              <SectionHeader>Active Events ({activeEvents.length})</SectionHeader>
              {activeEvents.length === 0 ? (
                <div style={{ fontSize: 12, color: '#4b5563', fontStyle: 'italic' }}>No active events. The village is quiet.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {activeEvents.map((e: any) => (
                    <ActiveEventRow key={e._id} event={e} onResolve={(id) => resolveEvent({ eventId: id })} />
                  ))}
                </div>
              )}
            </div>

            {/* Event injection */}
            <div>
              <SectionHeader>Inject Event</SectionHeader>

              {/* AI suggestions */}
              <div style={{ marginBottom: 10 }}>
                <button
                  onClick={handleSuggest}
                  disabled={loadingSuggestions}
                  style={{
                    fontSize: 12, padding: '5px 12px', borderRadius: 4, cursor: loadingSuggestions ? 'default' : 'pointer',
                    background: '#1e3a5f', color: '#93c5fd', border: '1px solid #1d4ed844',
                    opacity: loadingSuggestions ? 0.6 : 1,
                  }}
                >
                  {loadingSuggestions ? '⋯ Reading world state...' : '✦ Suggest events'}
                </button>
              </div>

              {suggestions && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
                  {suggestions.map((s, i) => {
                    const sty = SEVERITY_STYLE[s.severity] ?? SEVERITY_STYLE.low;
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '6px 8px', background: '#111827', borderRadius: 4, border: '1px solid #1f2937' }}>
                        <span style={{ fontSize: 10, padding: '2px 5px', borderRadius: 3, background: sty.bg, color: sty.text, flexShrink: 0, marginTop: 1 }}>{s.severity}</span>
                        <span style={{ fontSize: 11, color: '#d1d5db', flex: 1, lineHeight: 1.4 }}>{s.description}</span>
                        <button
                          onClick={() => handleInject(s.type, s.description, s.severity)}
                          style={{ fontSize: 10, padding: '2px 8px', borderRadius: 3, background: '#1f2937', color: '#93c5fd', border: '1px solid #374151', cursor: 'pointer', flexShrink: 0 }}
                        >
                          inject
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Custom event */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input
                  value={customType}
                  onChange={(e) => setCustomType(e.target.value)}
                  placeholder="type (e.g. drought)"
                  style={INPUT_STYLE}
                />
                <textarea
                  value={customDesc}
                  onChange={(e) => setCustomDesc(e.target.value)}
                  placeholder="Describe the event as the villagers would experience it..."
                  rows={2}
                  style={{ ...INPUT_STYLE, resize: 'vertical', fontFamily: 'inherit' }}
                />
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {(['low', 'medium', 'high'] as const).map((sev) => (
                    <button
                      key={sev}
                      onClick={() => setCustomSeverity(sev)}
                      style={{
                        fontSize: 11, padding: '3px 8px', borderRadius: 3, cursor: 'pointer',
                        background: customSeverity === sev ? SEVERITY_STYLE[sev].bg : '#1f2937',
                        color: customSeverity === sev ? SEVERITY_STYLE[sev].text : '#6b7280',
                        border: `1px solid ${customSeverity === sev ? SEVERITY_STYLE[sev].text + '44' : '#374151'}`,
                      }}
                    >
                      {sev}
                    </button>
                  ))}
                  <button
                    onClick={handleCustomInject}
                    disabled={!customDesc.trim()}
                    style={{
                      fontSize: 12, padding: '3px 14px', borderRadius: 4, cursor: customDesc.trim() ? 'pointer' : 'default',
                      background: customDesc.trim() ? '#4f46e5' : '#1f2937',
                      color: customDesc.trim() ? '#e0e7ff' : '#4b5563',
                      border: 'none', marginLeft: 'auto',
                    }}
                  >
                    Inject →
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* ── Column 3: World log + Economy + Prayers ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto', maxHeight: 540 }}>

            {/* World log */}
            <div>
              <SectionHeader>World Log</SectionHeader>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {recentActions.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#4b5563', fontStyle: 'italic' }}>No actions yet.</div>
                ) : recentActions.map((a: any) => (
                  <div key={a._id} style={{ fontSize: 11, color: '#9ca3af', padding: '3px 0', borderBottom: '1px solid #111827' }}>
                    <span style={{ color: '#6b7280', marginRight: 4 }}>D{a.day}</span>
                    <span style={{ color: '#e5e7eb', fontWeight: 500 }}>{a.agentName}</span>
                    <span style={{ color: '#4b5563', margin: '0 3px' }}>→</span>
                    <span style={{ color: a.outcome === 'failed' ? '#f87171' : '#93c5fd' }}>{a.action}</span>
                    {a.target && <span style={{ color: '#6b7280' }}> {a.target}</span>}
                    {a.message && <span style={{ color: '#4b5563' }}> "{a.message.slice(0, 40)}{a.message.length > 40 ? '…' : ''}"</span>}
                  </div>
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

const OVERLAY_STYLE: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.75)',
  zIndex: 50,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
};

const PANEL_STYLE: React.CSSProperties = {
  background: '#111827',
  border: '1px solid #374151',
  borderRadius: 8,
  padding: 20,
  width: '100%',
  maxWidth: 1100,
  maxHeight: '90vh',
  overflowY: 'auto',
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
