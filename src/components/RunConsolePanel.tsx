import { useEffect, useMemo, useState } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';

const AGENT_OPTIONS = [
  { slug: 'elena', label: 'Elena' },
  { slug: 'marcus', label: 'Marcus' },
  { slug: 'finn', label: 'Finn' },
  { slug: 'lena', label: 'Lena' },
  { slug: 'sera', label: 'Sera' },
];

type RunMode = 'fresh' | 'continue';
type RunProfile = 'blank-self' | 'seeded';

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

function trimInline(text: string | null | undefined, max = 84) {
  const compact = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1).trimEnd()}…`;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.08em',
        color: '#64748b',
        textTransform: 'uppercase',
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

function providerSummary(config: {
  selectedAgentConfigs: Array<{
    slug: string;
    agentName: string;
    effectiveProvider: string;
    effectiveModel: string;
    providerSource: string;
    modelSource: string;
  }>;
}) {
  if (config.selectedAgentConfigs.length === 0) {
    return 'No agents selected.';
  }
  return 'Agent models come from the Agents tab. The next run will use the provider/model currently configured for each selected agent.';
}

function runModeSummary(mode: RunMode, profile: RunProfile) {
  if (mode === 'fresh' && profile === 'blank-self') {
    return 'Start from a fresh world and clear each selected agent’s self-state.';
  }
  if (mode === 'fresh' && profile === 'seeded') {
    return 'Start from a fresh world and keep each selected agent’s seeded self-state.';
  }
  if (mode === 'continue' && profile === 'blank-self') {
    return 'Keep the current world, but clear each selected agent’s self-state.';
  }
  return 'Keep the current world and each selected agent’s seeded self-state.';
}

function CompactLogLine({ text, subtle = false }: { text: string; subtle?: boolean }) {
  return (
    <div
      style={{
        fontSize: 11,
        lineHeight: 1.3,
        color: subtle ? '#94a3b8' : '#dbe4f0',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace',
        whiteSpace: 'pre-wrap',
      }}
    >
      {text}
    </div>
  );
}

export function TickSummaryCard({
  summary,
  defaultExpanded = false,
  showDetails = true,
}: {
  summary: any;
  defaultExpanded?: boolean;
  showDetails?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  if (!summary) return null;

  const actionRows = Array.isArray(summary.currentTickActions) ? summary.currentTickActions : [];
  const sceneRows = Array.isArray(summary.liveScenes) ? summary.liveScenes : [];
  const offerRows = Array.isArray(summary.transactionDeltas) ? summary.transactionDeltas : [];
  const deltaRows = Array.isArray(summary.priceDeltas) ? summary.priceDeltas : [];
  const interruptRows = Array.isArray(summary.interrupts) ? summary.interrupts : [];
  const suspiciousRows = actionRows.filter((entry: any) => entry.outcome !== 'success');

  return (
    <div
      style={{
        background: '#111827',
        border: '1px solid #374151',
        borderRadius: 8,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div style={{ cursor: 'pointer', flex: 1 }} onClick={() => setExpanded((value) => !value)}>
          <div style={{ fontSize: 13, color: '#f9fafb', fontWeight: 700 }}>
            Tick {summary.tick} · Day {summary.day} · {summary.timeOfDay}
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
            live scenes: {summary.liveScenes?.length ?? 0}
            {' · '}
            pending offers: {summary.pendingOfferCount ?? 0}
            {' · '}
            shortages: {(summary.criticalShortages ?? []).join(', ') || 'none'}
          </div>
        </div>
        {showDetails && (
          <button onClick={() => setExpanded((value) => !value)} style={MINI_BUTTON_STYLE}>
            {expanded ? 'Collapse' : 'Expand'}
          </button>
        )}
      </div>

      {expanded && (
        <div style={{ display: 'grid', gap: 12, borderTop: '1px solid #1f2937', paddingTop: 10 }}>
          <div>
            <SectionLabel>Agent Actions</SectionLabel>
            <div style={{ display: 'grid', gap: 4 }}>
              {actionRows.length === 0 && (summary.agents ?? []).filter((a: any) => a.busy).length === 0 ? (
                <div style={{ fontSize: 11, color: '#6b7280', fontStyle: 'italic' }}>No actions recorded this tick.</div>
              ) : (
                <>
                  {actionRows.map((entry: any, index: number) => (
                    <div key={`${entry.agentName}-${index}`} style={{ fontSize: 12, color: '#d1d5db' }}>
                      <span style={{ color: '#f3f4f6', fontWeight: 600 }}>{entry.agentName}</span>
                      <span style={{ color: '#6b7280', margin: '0 6px' }}>→</span>
                      <span style={{ color: entry.outcome === 'success' ? '#93c5fd' : '#f87171' }}>{entry.action}</span>
                      {entry.target && <span style={{ color: '#9ca3af' }}> {entry.target}</span>}
                      {entry.message && <span style={{ color: '#e5e7eb', fontStyle: 'italic' }}> "{trimInline(entry.message, 256)}"</span>}
                      {entry.outcomeNote && <span style={{ color: '#6b7280', margin: '0 4px' }}> · {trimInline(entry.outcomeNote, 256)}</span>}
                    </div>
                  ))}
                  {/* Show all agents in the expanded view for a complete status report */}
                  {(summary.agents ?? [])
                    .sort((a: any, b: any) => a.name.localeCompare(b.name))
                    .map((a: any) => {
                      const hasAction = actionRows.some((ar: any) => ar.agentName === a.name);
                      if (hasAction) return null; // Already shown in the actions section above
                      
                      return (
                        <div key={`status-${a.name}`} style={{ fontSize: 12, color: '#94a3b8' }}>
                          <span style={{ color: '#94a3af', fontWeight: 600 }}>{a.name}</span>
                          <span style={{ color: '#4b5563', margin: '0 6px' }}>·</span>
                          {a.busy ? (
                            <span style={{ color: '#7c3aed', fontSize: 11, fontStyle: 'italic' }}>{a.busyLabel ?? 'busy'}</span>
                          ) : (
                            <span style={{ color: '#64748b', fontSize: 11, fontStyle: 'italic' }}>idle</span>
                          )}
                        </div>
                      );
                    })}
                </>
              )}
            </div>
          </div>
          {suspiciousRows.length > 0 && (
            <div>
              <SectionLabel>Failed / Suspicious</SectionLabel>
              <div style={{ display: 'grid', gap: 4 }}>
                {suspiciousRows.map((entry: any, index: number) => (
                  <div key={`${entry.agentName}-${index}`} style={{ fontSize: 12, color: '#fca5a5' }}>
                    {entry.agentName} → {entry.action}
                    {entry.target ? ` ${entry.target}` : ''}
                    {entry.outcomeNote ? ` · ${trimInline(entry.outcomeNote, 84)}` : ''}
                  </div>
                ))}
              </div>
            </div>
          )}

          {interruptRows.length > 0 && (
            <div>
              <SectionLabel>Interrupts / Replans</SectionLabel>
              <div style={{ display: 'grid', gap: 4 }}>
                {interruptRows.map((entry: any, index: number) => (
                  <div key={`${summary.tick}-interrupt-${index}`} style={{ fontSize: 12, color: '#d1d5db' }}>
                    {entry.agentName}: {entry.summary}
                  </div>
                ))}
              </div>
            </div>
          )}

          {offerRows.length > 0 && (
            <div>
              <SectionLabel>Offers</SectionLabel>
              <div style={{ display: 'grid', gap: 4 }}>
                {offerRows.map((entry: any, index: number) => (
                  <div key={`${summary.tick}-offer-${index}`} style={{ fontSize: 12, color: '#d1d5db' }}>
                    {entry.summary}
                  </div>
                ))}
              </div>
            </div>
          )}

          {deltaRows.length > 0 && (
            <div>
              <SectionLabel>World Deltas</SectionLabel>
              <div style={{ display: 'grid', gap: 4 }}>
                {deltaRows.map((entry: any, index: number) => (
                  <div key={`${summary.tick}-delta-${index}`} style={{ fontSize: 12, color: '#d1d5db' }}>
                    {entry.item}: {entry.price}c ({entry.changePct > 0 ? '+' : ''}{Number(entry.changePct).toFixed(entry.changePct % 1 === 0 ? 0 : 1)}%)
                  </div>
                ))}
              </div>
            </div>
          )}

          {sceneRows.length > 0 && (
            <div>
              <SectionLabel>Live Chat Scenes</SectionLabel>
              <div style={{ display: 'grid', gap: 8 }}>
                {sceneRows.map((scene: any) => (
                  <div key={scene.sceneId} style={{ border: '1px solid #1f2937', borderRadius: 6, padding: 10 }}>
                    <div style={{ fontSize: 12, color: '#f9fafb', fontWeight: 600 }}>
                      {scene.participants?.join(' <-> ') || 'Live scene'} @ {scene.locationLabel ?? 'unknown'}
                    </div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
                      next: {scene.nextSpeaker ?? 'n/a'} · last: {scene.lastSpeaker ?? 'n/a'} · stall: {scene.stallTurns ?? 0}
                    </div>
                    <div style={{ display: 'grid', gap: 4, marginTop: 6 }}>
                      {(scene.recentMessages ?? []).map((message: any, index: number) => (
                        <div key={`${scene.sceneId}-msg-${index}`} style={{ fontSize: 12, color: '#d1d5db' }}>
                          <span style={{ color: '#f3f4f6' }}>{message.fromAgent}:</span> {message.text}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function RunConsolePanel() {
  const runConsole = useQuery(api.rocklaw.god.getRunConsole);
  const dashboard = useQuery(api.rocklaw.god.getDashboard);
  const prepareRun = useAction(api.rocklaw.godNode.prepareRunConsole);
  const getRunAgentConfigs = useAction(api.rocklaw.godNode.getRunAgentConfigs);
  const startAutoRun = useMutation(api.rocklaw.god.startRunAuto);
  const stopAutoRun = useMutation(api.rocklaw.god.stopRunAuto);

  const [mode, setMode] = useState<RunMode>('fresh');
  const [profile, setProfile] = useState<RunProfile>('blank-self');
  const [selectedAgents, setSelectedAgents] = useState<string[]>(AGENT_OPTIONS.map((entry) => entry.slug));
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [runAgentConfigs, setRunAgentConfigs] = useState<Array<{
    slug: string;
    agentName: string;
    effectiveProvider: string;
    effectiveModel: string;
    providerSource: string;
    modelSource: string;
  }>>([]);

  useEffect(() => {
    if (!runConsole) return;
    setMode(runConsole.state.mode);
    setProfile(runConsole.state.profile);
    setSelectedAgents(runConsole.state.selectedAgentSlugs);
  }, [runConsole?.state.lastPreparedTick]);

  useEffect(() => {
    let cancelled = false;
    void getRunAgentConfigs({ selectedAgentSlugs: selectedAgents })
      .then((result) => {
        if (cancelled) return;
        setRunAgentConfigs(result);
      })
      .catch(() => {
        if (!cancelled) {
          setRunAgentConfigs([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [getRunAgentConfigs, selectedAgents]);

  const tickHistory = useMemo(() => runConsole?.tickHistory ?? [], [runConsole]);

  const draftConfig = useMemo(
    () => ({
      mode,
      profile,
      selectedAgentSlugs: [...selectedAgents].sort(),
    }),
    [mode, profile, selectedAgents],
  );

  const appliedConfig = useMemo(
    () => ({
      mode: runConsole?.state.mode,
      profile: runConsole?.state.profile,
      selectedAgentSlugs: [...(runConsole?.state.selectedAgentSlugs ?? [])].sort(),
    }),
    [runConsole],
  );

  const hasPreparedRun = runConsole?.state.lastPreparedTick !== undefined;
  const hasDraftChanges = hasPreparedRun && JSON.stringify(draftConfig) !== JSON.stringify(appliedConfig);

  const selectedAgentLabels = useMemo(
    () => AGENT_OPTIONS.filter((entry) => selectedAgents.includes(entry.slug)).map((entry) => entry.label),
    [selectedAgents],
  );

  const runBrief = useMemo(() => {
    const selected = selectedAgentLabels.length > 0 ? selectedAgentLabels.join(', ') : 'No agents selected';
    return {
      setup: runModeSummary(mode, profile),
      agents: `Agents in this run: ${selected}.`,
      models: providerSummary({ selectedAgentConfigs: runAgentConfigs }),
    };
  }, [mode, profile, runAgentConfigs, selectedAgentLabels]);

  const sessionCostUsd = runConsole?.state.sessionCostUsd ?? 0;
  const sessionTotalTokens = useMemo(() => {
    return (dashboard?.agents ?? []).reduce((sum: number, a: any) => {
      return sum + (a.lifetimeInputTokens ?? 0) + (a.lifetimeOutputTokens ?? 0);
    }, 0);
  }, [dashboard?.agents]);

  const primaryButtonLabel = useMemo(() => {
    if (busyAction === 'run') {
      return runConsole?.state.autoRunning ? 'Stopping and starting…' : 'Starting…';
    }
    if (runConsole?.state.autoRunning) {
      return 'Restart simulation with this setup';
    }
    return 'Run this simulation';
  }, [busyAction, runConsole?.state.autoRunning]);

  const handleRun = async () => {
    setBusyAction('run');
    try {
      if (runConsole?.state.autoRunning) {
        await stopAutoRun({});
      }
      await prepareRun({
        mode,
        profile,
        selectedAgentSlugs: selectedAgents,
        providerPreset: 'keep',
      });
      await startAutoRun({ stepBatchSize: 1 });
    } finally {
      setBusyAction(null);
    }
  };

  if (!runConsole) {
    return <div style={{ color: '#6b7280' }}>Loading run console...</div>;
  }

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {(sessionCostUsd > 0 || sessionTotalTokens > 0) && (
        <div style={{
          background: '#0f1923',
          border: '1px solid #1e3a2e',
          borderRadius: 6,
          padding: '6px 12px',
          fontSize: 12,
          color: '#6b7280',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <span style={{ color: '#4b5563' }}>Session</span>
          {sessionTotalTokens > 0 && (
            <span style={{ color: '#9ca3af' }}>{formatTokenCount(sessionTotalTokens)} tokens</span>
          )}
          {sessionCostUsd > 0 && (
            <span style={{ color: '#fde68a', fontWeight: 600 }}>{formatCostUsd(sessionCostUsd)}</span>
          )}
        </div>
      )}
      <div style={PANEL_STYLE}>
        <SectionLabel>New Run Setup</SectionLabel>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
          <div>
            <div style={FIELD_LABEL_STYLE}>World</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={() => setMode('fresh')} style={toggleButtonStyle(mode === 'fresh')}>Reset world</button>
              <button onClick={() => setMode('continue')} style={toggleButtonStyle(mode === 'continue')}>Keep current world</button>
            </div>
          </div>

          <div>
            <div style={FIELD_LABEL_STYLE}>Agent self-state</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={() => setProfile('blank-self')} style={toggleButtonStyle(profile === 'blank-self')}>Reset self-state</button>
              <button onClick={() => setProfile('seeded')} style={toggleButtonStyle(profile === 'seeded')}>Keep seeded self-state</button>
            </div>
          </div>

        </div>

        <div style={{ marginTop: 12 }}>
          <div style={FIELD_LABEL_STYLE}>Agents in this run</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {AGENT_OPTIONS.map((entry) => {
              const active = selectedAgents.includes(entry.slug);
              return (
                <button
                  key={entry.slug}
                  onClick={() =>
                    setSelectedAgents((current) =>
                      current.includes(entry.slug)
                        ? current.filter((value) => value !== entry.slug)
                        : [...current, entry.slug],
                    )
                  }
                  style={{
                    ...toggleButtonStyle(active),
                    borderRadius: 999,
                  }}
                >
                  {entry.label}
                </button>
              );
            })}
          </div>
        </div>

        <div style={SUMMARY_STYLE}>
          <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Next run</div>
          <div style={{ fontSize: 13, color: '#dbeafe', marginTop: 5 }}>{runBrief.setup}</div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 6 }}>{runBrief.agents}</div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>{runBrief.models}</div>
          <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
            {runAgentConfigs.length === 0 ? (
              <div style={{ fontSize: 12, color: '#64748b' }}>No selected agent configs available.</div>
            ) : (
              runAgentConfigs.map((entry) => (
                <div
                  key={entry.slug}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '96px minmax(0, 1fr)',
                    gap: 8,
                    fontSize: 12,
                    alignItems: 'baseline',
                  }}
                >
                  <div style={{ color: '#cbd5e1', fontWeight: 600 }}>{entry.agentName}</div>
                  <div style={{ color: '#94a3b8', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace' }}>
                    {entry.effectiveProvider} / {entry.effectiveModel}
                    <span style={{ color: '#64748b', fontFamily: 'inherit' }}>
                      {' '}({entry.providerSource === 'override' || entry.modelSource === 'override' ? 'override' : 'config'})
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 10 }}>
            Change provider/model in the Agents tab. Those settings apply immediately to the agent gateway and are also what the next run will use.
          </div>
          <div style={{ fontSize: 12, color: !hasPreparedRun ? '#64748b' : hasDraftChanges ? '#fdba74' : '#64748b', marginTop: 6 }}>
            {!hasPreparedRun
              ? 'No prepared run yet.'
              : hasDraftChanges
                ? 'Changed from the currently applied setup.'
                : 'Matches the currently applied setup.'}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
          <button onClick={handleRun} disabled={busyAction !== null} style={PRIMARY_BUTTON_STYLE}>
            {primaryButtonLabel}
          </button>
        </div>
      </div>

      <div style={LOG_PANEL_STYLE}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline', marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 12, color: '#cbd5e1', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Live Log
            </div>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 3 }}>
              Concise stream only. Use Overview when you want to inspect a tick more deeply.
            </div>
          </div>
        </div>

        <div style={LOG_STREAM_STYLE}>
          {tickHistory.length === 0 ? (
            <CompactLogLine text="No run logs yet. Start a run and the stream will appear here." subtle />
          ) : (
            tickHistory.flatMap((entry: any) => {
              const summary = entry.summary;
              const actionRows = Array.isArray(summary?.currentTickActions) ? summary.currentTickActions : [];
              const header = `Tick ${summary.tick} · Day ${summary.day} · ${summary.timeOfDay} · scenes ${summary.liveScenes?.length ?? 0} · offers ${summary.pendingOfferCount ?? 0} · shortages ${(summary.criticalShortages ?? []).join(', ') || 'none'}`;
              const lines = [
                <CompactLogLine key={`${entry._id}-header`} text={header} subtle />,
                ...actionRows.map((action: any, index: number) => (
                  <CompactLogLine
                    key={`${entry._id}-action-${index}`}
                    text={`${action.agentName} -> ${action.action}${action.target ? ` ${action.target}` : ''}${action.message ? ` "${trimInline(action.message, 200)}"` : ''}${action.outcomeNote ? ` · ${trimInline(action.outcomeNote, 200)}` : ''}`}
                  />
                )),
              ];
              return lines;
            })
          )}
        </div>
      </div>
    </div>
  );
}

const PANEL_STYLE: React.CSSProperties = {
  background: '#111827',
  border: '1px solid #374151',
  borderRadius: 10,
  padding: 14,
};

const LOG_PANEL_STYLE: React.CSSProperties = {
  background: '#020617',
  border: '1px solid #1f2937',
  borderRadius: 10,
  padding: 14,
};

const LOG_STREAM_STYLE: React.CSSProperties = {
  display: 'grid',
  gap: 2,
  maxHeight: '56vh',
  overflowY: 'auto',
  paddingRight: 4,
};

const SUMMARY_STYLE: React.CSSProperties = {
  marginTop: 14,
  background: '#08111f',
  border: '1px solid #1f2937',
  borderRadius: 8,
  padding: 12,
};

const FIELD_LABEL_STYLE: React.CSSProperties = {
  fontSize: 11,
  color: '#64748b',
  marginBottom: 6,
};

const PRIMARY_BUTTON_STYLE: React.CSSProperties = {
  background: '#2563eb',
  color: '#eff6ff',
  border: '1px solid #60a5fa',
  borderRadius: 8,
  padding: '10px 14px',
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
};

const MINI_BUTTON_STYLE: React.CSSProperties = {
  background: '#1f2937',
  color: '#d1d5db',
  border: '1px solid #374151',
  borderRadius: 6,
  padding: '5px 9px',
  fontSize: 11,
  cursor: 'pointer',
};

function toggleButtonStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? '#16365d' : '#1f2937',
    color: active ? '#dbeafe' : '#d1d5db',
    border: `1px solid ${active ? '#3b82f6' : '#374151'}`,
    borderRadius: 8,
    padding: '8px 12px',
    fontSize: 12,
    cursor: 'pointer',
  };
}
