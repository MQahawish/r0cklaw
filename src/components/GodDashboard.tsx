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

import { useMemo, useState } from 'react';
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

function hasUsageData(inputTokens: number, outputTokens: number): boolean {
  return inputTokens > 0 || outputTokens > 0;
}

function repColour(score: number): string {
  if (score >= 70) return '#22c55e';
  if (score >= 40) return '#f97316';
  if (score < 20)  return '#ef4444';
  return '#fbbf24';
}

function eldersCountdown(day: number, eldersDay: number): { text: string; color: string } {
  const daysLeft = Math.max(0, eldersDay - day);
  if (daysLeft === 0) return { text: "Elder's Day is TODAY", color: '#ef4444' };
  const color = daysLeft <= 3 ? '#ef4444' : daysLeft <= 7 ? '#fbbf24' : '#9ca3af';
  return { text: `${daysLeft}d until Elder's Day`, color };
}

function AgentCard({ agent, repScore, hiddenRole }: { agent: any; repScore?: number; hiddenRole?: any }) {
  const [expanded, setExpanded] = useState(false);
  const inv = JSON.parse(agent.inventory ?? '{}') as Record<string, number>;
  const inputTokens = agent.lifetimeInputTokens ?? 0;
  const outputTokens = agent.lifetimeOutputTokens ?? 0;
  const usageAvailable = hasUsageData(inputTokens, outputTokens);

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
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {hiddenRole && (() => {
            const s = ROLE_STYLE[hiddenRole.roleType] ?? { bg: '#37415122', color: '#9ca3af' };
            return (
              <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: s.bg, color: s.color, fontWeight: 700, letterSpacing: '0.04em' }}>
                {hiddenRole.roleType.toUpperCase()}
              </span>
            );
          })()}
          {repScore !== undefined && (
            <span style={{
              fontSize: 10, padding: '1px 5px', borderRadius: 3,
              background: repColour(repScore) + '22',
              color: repColour(repScore),
              fontWeight: 700,
            }}>★{repScore}</span>
          )}
          {agent.busy && (
            <span style={{
              fontSize: 11,
              padding: '1px 6px',
              borderRadius: 3,
              background: '#7c3aed22',
              color: '#a78bfa',
            }}>
              busy
            </span>
          )}
          <span style={{
            fontSize: 11,
            padding: '1px 6px',
            borderRadius: 3,
            background: '#05966922',
            color: '#34d399',
          }}>
            {agent.location}
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
      <div style={{ marginTop: 4, fontSize: 11, color: '#6b7280', fontFamily: 'ui-monospace, monospace' }}>
        {usageAvailable ? (
          <>
            {formatTokenCount(inputTokens)} in
            {' / '}
            {formatTokenCount(outputTokens)} out
          </>
        ) : (
          <span>tokens: no data yet</span>
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

// ── Section header ────────────────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: '#6b7280', textTransform: 'uppercase', marginBottom: 8, borderBottom: '1px solid #1f2937', paddingBottom: 4 }}>
      {children}
    </div>
  );
}

// ── Hidden Roles section ──────────────────────────────────────────────────────

const ROLE_STYLE: Record<string, { bg: string; color: string }> = {
  Saboteur: { bg: '#ef444422', color: '#f87171' },
  Usurper:  { bg: '#a78bfa22', color: '#c4b5fd' },
  Heir:     { bg: '#fbbf2422', color: '#fcd34d' },
};

function HiddenRolesSection({
  hiddenRoles,
  bakeryGrain,
  gossipHitsByAgent,
  agentCoinMap,
}: {
  hiddenRoles: any[];
  bakeryGrain: number;
  gossipHitsByAgent: Record<string, number>;
  agentCoinMap: Record<string, number>;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <SectionHeader>Hidden Roles</SectionHeader>
      {(!hiddenRoles || hiddenRoles.length === 0) ? (
        <div style={{ fontSize: 12, color: '#4b5563', fontStyle: 'italic' }}>Roles not yet assigned.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {hiddenRoles.map((role: any) => {
            const s = ROLE_STYLE[role.roleType] ?? { bg: '#37415122', color: '#9ca3af' };
            let stat: React.ReactNode = null;

            if (role.roleType === 'Saboteur') {
              const ok = bakeryGrain < 10;
              stat = (
                <span style={{ color: ok ? '#34d399' : '#f87171', fontSize: 11 }}>
                  grain: {bakeryGrain} {ok ? '✓' : '✗'}
                </span>
              );
            } else if (role.roleType === 'Usurper') {
              const hits = gossipHitsByAgent[role.agentName] ?? 0;
              stat = <span style={{ color: '#c4b5fd', fontSize: 11 }}>hits: {hits}</span>;
            } else if (role.roleType === 'Heir') {
              const myCoin = agentCoinMap[role.agentName] ?? 0;
              const rivalCoin = role.rival ? (agentCoinMap[role.rival] ?? 0) : null;
              const diff = rivalCoin !== null ? myCoin - rivalCoin : null;
              stat = rivalCoin === null ? (
                <span style={{ color: '#9ca3af', fontSize: 11 }}>rival unknown</span>
              ) : (
                <span style={{ color: diff! > 0 ? '#34d399' : diff === 0 ? '#fbbf24' : '#f87171', fontSize: 11 }}>
                  vs {role.rival}: {diff! > 0 ? `+${diff}c` : diff === 0 ? 'tied' : `${diff}c`}
                </span>
              );
            }

            return (
              <div key={role._id} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '5px 8px', background: '#1f2937',
                borderRadius: 4, border: `1px solid ${s.color}44`,
              }}>
                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: s.bg, color: s.color, fontWeight: 700, flexShrink: 0 }}>
                  {role.roleType.toUpperCase()}
                </span>
                <span style={{ fontSize: 12, color: '#e5e7eb', flex: 1 }}>{role.agentName}</span>
                {stat}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function trimInline(text: string | null | undefined, max = 120) {
  const compact = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1).trimEnd()}…`;
}

function conversationStatusLabel(conversation: any) {
  if (conversation.status === 'live') return 'live';
  if (conversation.kind === 'thread' && conversation.status === 'unread') return 'thread · unread';
  if (conversation.kind === 'thread') return 'thread';
  if (conversation.status === 'closed') return 'closed';
  return conversation.status ?? conversation.kind;
}

function ConversationBrowser({
  conversations,
}: {
  conversations: any[] | undefined;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedConversation = useMemo(() => {
    const rows = conversations ?? [];
    const fallbackKey = rows[0]?.key ?? null;
    const activeKey = rows.some((row) => row.key === selectedKey) ? selectedKey : fallbackKey;
    return rows.find((row) => row.key === activeKey) ?? null;
  }, [conversations, selectedKey]);

  if (!conversations) {
    return <div style={{ fontSize: 12, color: '#4b5563', fontStyle: 'italic' }}>Loading conversations…</div>;
  }
  if (conversations.length === 0) {
    return <div style={{ fontSize: 12, color: '#4b5563', fontStyle: 'italic' }}>No conversations yet.</div>;
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '280px minmax(0, 1fr)', gap: 12, minHeight: 360 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 420, overflowY: 'auto', paddingRight: 6 }}>
        {conversations.map((conversation) => {
          const selected = selectedConversation?.key === conversation.key;
          return (
            <button
              key={conversation.key}
              onClick={() => setSelectedKey(conversation.key)}
              style={{
                textAlign: 'left',
                background: selected ? '#132238' : '#111827',
                border: `1px solid ${selected ? '#3b82f6' : '#1f2937'}`,
                borderRadius: 8,
                padding: '10px 12px',
                cursor: 'pointer',
                color: '#e5e7eb',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#f9fafb' }}>
                  {conversation.participants.join(' ↔ ')}
                </div>
                <div style={{ fontSize: 10, color: conversation.status === 'live' ? '#fbbf24' : '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  {conversationStatusLabel(conversation)}
                </div>
              </div>
              <div style={{ marginTop: 4, fontSize: 11, color: '#94a3b8' }}>
                {conversation.location ? `@ ${conversation.location}` : 'private thread'}
                {conversation.nextSpeaker ? ` · next ${conversation.nextSpeaker}` : ''}
              </div>
              {conversation.latestText && (
                <div style={{ marginTop: 6, fontSize: 11, color: '#cbd5e1', lineHeight: 1.35 }}>
                  {trimInline(conversation.latestText, 110)}
                </div>
              )}
            </button>
          );
        })}
      </div>

      <div style={{ background: '#0b1220', border: '1px solid #1f2937', borderRadius: 8, minHeight: 360, display: 'flex', flexDirection: 'column' }}>
        {selectedConversation ? (
          <>
            <div style={{ padding: '12px 14px', borderBottom: '1px solid #1f2937' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#f9fafb' }}>
                  {selectedConversation.participants.join(' ↔ ')}
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8' }}>
                  {selectedConversation.location ? `@ ${selectedConversation.location}` : 'thread'}
                  {selectedConversation.nextSpeaker ? ` · next ${selectedConversation.nextSpeaker}` : ''}
                </div>
              </div>
            </div>
            <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 420, overflowY: 'auto' }}>
              {(selectedConversation.messages ?? []).length === 0 ? (
                <div style={{ fontSize: 12, color: '#4b5563', fontStyle: 'italic' }}>No messages in this conversation yet.</div>
              ) : (
                selectedConversation.messages.map((message: any, index: number) => {
                  const isLeft = message.fromAgent === selectedConversation.participants[0];
                  return (
                    <div
                      key={`${selectedConversation.key}-${index}`}
                      style={{
                        alignSelf: isLeft ? 'flex-start' : 'flex-end',
                        maxWidth: '78%',
                        background: isLeft ? '#172032' : '#1d3049',
                        border: '1px solid #243244',
                        borderRadius: 10,
                        padding: '8px 10px',
                      }}
                    >
                      <div style={{ fontSize: 10, color: '#93c5fd', marginBottom: 4 }}>
                        {message.fromAgent} · D{message.sentDay} t{message.sentTick}
                      </div>
                      <div style={{ fontSize: 12, color: '#e5e7eb', lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {message.text}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ── Main dashboard ────────────────────────────────────────────────────────────

type Tab = 'overview' | 'run' | 'economy' | 'systems' | 'agents';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview',  label: 'Overview'  },
  { id: 'run',       label: 'Run'       },
  { id: 'economy',   label: 'Economy'   },
  { id: 'systems',   label: 'Systems'   },
  { id: 'agents',    label: 'Agents'    },
];

export default function GodDashboard({ onClose }: { onClose?: () => void }) {
  const dashboard = useQuery(api.rocklaw.god.getDashboard);
  const runConsole = useQuery(api.rocklaw.god.getRunConsole);
  const conversations = useQuery(api.rocklaw.observe.getConversationOverview);
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

  const { worldState, agents, prices, recentPrayers, tension, repByAgent, hiddenRoles, bakeryGrain, gossipHitsByAgent, agentCoinMap } = dashboard as any;
  const recentTickHistory = (runConsole?.tickHistory ?? []).slice(0, 8);
  const effectiveSelectedAgent = agents.some((agent: any) => agent.name === selectedAgentName)
    ? selectedAgentName
    : agents[0]?.name ?? null;
  const totalInputTokens = agents.reduce((sum: number, agent: any) => sum + (agent.lifetimeInputTokens ?? 0), 0);
  const totalOutputTokens = agents.reduce((sum: number, agent: any) => sum + (agent.lifetimeOutputTokens ?? 0), 0);
  const totalUsageAvailable = hasUsageData(totalInputTokens, totalOutputTokens);

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
              {worldState?.eldersDay != null && (() => {
                const { text, color } = eldersCountdown(worldState.day ?? 0, worldState.eldersDay);
                return <span style={{ marginLeft: 10, color, fontWeight: worldState.eldersDay - (worldState.day ?? 0) <= 3 ? 700 : 400 }}>— {text}</span>;
              })()}
            </span>
            <div style={{ marginTop: 4, fontSize: 12, color: '#64748b' }}>
              Analytical dashboard first. The live town view is now embedded in Overview.
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
              hiddenRoles={hiddenRoles ?? []}
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

        {/* ── Tab: Economy ── */}
        {activeTab === 'economy' && <EconomyPanel />}

        {/* ── Tab: Systems ── */}
        {activeTab === 'systems' && <SystemsPanel />}

        {/* ── Tab: Overview (main grid) ── */}
        {activeTab === 'overview' && <div style={{ display: 'grid', gridTemplateColumns: '250px 1fr', gap: 16, minHeight: 0 }}>

          {/* ── Column 1: Agents ── */}
          <div style={{ overflowY: 'auto', maxHeight: 'calc(100vh - 180px)', paddingRight: 10 }}>
            <SectionHeader>Agents ({agents.length})</SectionHeader>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {agents.map((a: any) => <AgentCard key={a._id} agent={a} repScore={(repByAgent ?? {})[a.name]} hiddenRole={(hiddenRoles ?? []).find((r: any) => r.agentName === a.name)} />)}
            </div>
          </div>

          {/* ── Column 2: World log + Economy + Prayers ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto', maxHeight: 'calc(100vh - 180px)', paddingRight: 10 }}>

            <HiddenRolesSection
              hiddenRoles={hiddenRoles ?? []}
              bakeryGrain={bakeryGrain ?? 0}
              gossipHitsByAgent={gossipHitsByAgent ?? {}}
              agentCoinMap={agentCoinMap ?? {}}
            />

            <div>
              <SectionHeader>Usage</SectionHeader>
              <div style={{ background: '#0f1923', border: '1px solid #1f2937', borderRadius: 6, padding: '8px 10px', fontSize: 12, fontFamily: 'ui-monospace, monospace' }}>
                {totalUsageAvailable ? (
                  <div style={{ color: '#9ca3af' }}>
                    <span>{formatTokenCount(totalInputTokens)} in</span>
                    <span style={{ margin: '0 8px' }}>·</span>
                    <span>{formatTokenCount(totalOutputTokens)} out</span>
                  </div>
                ) : (
                  <div style={{ color: '#6b7280' }}>Tokens: no data yet</div>
                )}
              </div>
            </div>

            <div>
              <SectionHeader>Live Scene</SectionHeader>
              <LiveSimulationFrame mode="compact" />
            </div>

            <div>
              <SectionHeader>Conversations</SectionHeader>
              <ConversationBrowser conversations={conversations as any[] | undefined} />
            </div>

            {/* World log */}
            <div>
              <SectionHeader>World Log</SectionHeader>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {recentTickHistory.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#4b5563', fontStyle: 'italic' }}>No tick history yet.</div>
                ) : recentTickHistory.map((entry: any) => (
                  <TickSummaryCard key={entry._id} summary={entry.summary} showDetails={true} />
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
  padding: 0,
};

const PANEL_STYLE: React.CSSProperties = {
  background: '#111827',
  border: 'none',
  borderRadius: 0,
  padding: 20,
  width: '100%',
  maxWidth: 'none',
  minHeight: '100vh',
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
