/**
 * Agent Config Panel -- god-mode per-agent configuration.
 *
 * Shows all 8 agents in a list. Clicking one opens the detail view:
 *   - Port (read-only), model override (editable), provider (editable)
 *   - Pause / Resume toggle
 *   - Reputation score + recent incidents
 *   - Last 20 actions log
 */

import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';

function repColour(score: number): string {
  if (score >= 70) return '#22c55e';
  if (score >= 40) return '#f97316';
  if (score < 20)  return '#ef4444';
  return '#fbbf24';
}

function RepBadge({ score }: { score: number | undefined }) {
  if (score === undefined) return <span style={{ fontSize: 11, color: '#4b5563' }}>— rep</span>;
  return (
    <span style={{
      fontSize: 11, fontWeight: 700,
      color: repColour(score),
      padding: '1px 6px',
      background: repColour(score) + '22',
      borderRadius: 3,
    }}>
      ★ {score}
    </span>
  );
}

function AgentRow({
  agent,
  repScore,
  selected,
  onClick,
}: {
  agent: any;
  repScore: number | undefined;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: '8px 10px',
        borderRadius: 5,
        cursor: 'pointer',
        background: selected ? '#1e3a5f' : '#1f2937',
        border: `1px solid ${selected ? '#3b82f6' : '#374151'}`,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <div>
        <span style={{ fontWeight: 600, fontSize: 13, color: '#f9fafb' }}>{agent.name}</span>
        <span style={{ fontSize: 11, color: '#6b7280', marginLeft: 6 }}>{agent.role}</span>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <RepBadge score={repScore} />
        {agent.paused && (
          <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: '#7c3aed22', color: '#a78bfa' }}>
            paused
          </span>
        )}
      </div>
    </div>
  );
}

function AgentDetail({ agentName, repByAgent }: { agentName: string; repByAgent: Record<string, number> }) {
  const detail = useQuery(api.rocklaw.god.getAgentDetail, { agentName });
  const pauseAgent = useMutation(api.rocklaw.god.pauseAgent);
  const resumeAgent = useMutation(api.rocklaw.god.resumeAgent);
  const setAgentModel = useMutation(api.rocklaw.god.setAgentModel);

  const [modelInput, setModelInput] = useState('');
  const [providerInput, setProviderInput] = useState('');
  const [saving, setSaving] = useState(false);

  if (!detail) {
    return <div style={{ color: '#6b7280', fontSize: 12 }}>Loading...</div>;
  }

  const { agent, rep, recentActions } = detail;
  const incidents: { tick: number; note: string }[] = rep
    ? JSON.parse(rep.recentIncidents)
    : [];

  const handleSaveModel = async () => {
    if (!modelInput.trim()) return;
    setSaving(true);
    try {
      await setAgentModel({
        agentName,
        modelOverride: modelInput.trim(),
        providerOverride: providerInput.trim() || undefined,
      });
      setModelInput('');
      setProviderInput('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <span style={{ fontSize: 15, fontWeight: 700, color: '#f9fafb' }}>{agent.name}</span>
          <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 8 }}>{agent.role}</span>
        </div>
        <button
          onClick={() => agent.paused ? resumeAgent({ agentName }) : pauseAgent({ agentName })}
          style={{
            fontSize: 12, padding: '4px 12px', borderRadius: 4, cursor: 'pointer', fontWeight: 600,
            background: agent.paused ? '#14532d' : '#7f1d1d',
            color: agent.paused ? '#86efac' : '#fca5a5',
            border: `1px solid ${agent.paused ? '#22c55e44' : '#ef444444'}`,
          }}
        >
          {agent.paused ? '▶ Resume' : '⏸ Pause'}
        </button>
      </div>

      {/* Config fields */}
      <div style={{ background: '#1f2937', borderRadius: 5, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', letterSpacing: '0.07em', textTransform: 'uppercase' }}>
          ZeroClaw Config
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: 4, fontSize: 12 }}>
          <span style={{ color: '#6b7280' }}>Port</span>
          <span style={{ color: '#93c5fd', fontFamily: 'monospace' }}>{agent.gatewayPort}</span>
          <span style={{ color: '#6b7280' }}>Model</span>
          <span style={{ color: '#e5e7eb', fontFamily: 'monospace' }}>{agent.modelOverride ?? <em style={{ color: '#4b5563' }}>default</em>}</span>
          <span style={{ color: '#6b7280' }}>Provider</span>
          <span style={{ color: '#e5e7eb', fontFamily: 'monospace' }}>{agent.providerOverride ?? <em style={{ color: '#4b5563' }}>default</em>}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <input
            value={modelInput}
            onChange={(e) => setModelInput(e.target.value)}
            placeholder="model (e.g. mistral:7b)"
            style={INPUT_STYLE}
          />
          <input
            value={providerInput}
            onChange={(e) => setProviderInput(e.target.value)}
            placeholder="provider"
            style={{ ...INPUT_STYLE, width: 90 }}
          />
          <button
            onClick={handleSaveModel}
            disabled={!modelInput.trim() || saving}
            style={{
              fontSize: 11, padding: '4px 10px', borderRadius: 4, cursor: modelInput.trim() ? 'pointer' : 'default',
              background: modelInput.trim() ? '#4f46e5' : '#1f2937',
              color: modelInput.trim() ? '#e0e7ff' : '#4b5563',
              border: 'none', flexShrink: 0,
            }}
          >
            {saving ? '...' : 'Save'}
          </button>
        </div>
      </div>

      {/* Reputation */}
      <div style={{ background: '#1f2937', borderRadius: 5, padding: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 8 }}>
          Reputation
        </div>
        {rep ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <div style={{ flex: 1, height: 8, background: '#374151', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{
                  width: `${rep.score}%`, height: '100%',
                  background: repColour(rep.score),
                  transition: 'width 0.4s',
                }} />
              </div>
              <span style={{ fontSize: 13, fontWeight: 700, color: repColour(rep.score), minWidth: 28 }}>{rep.score}</span>
            </div>
            {incidents.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 80, overflowY: 'auto' }}>
                {[...incidents].reverse().map((inc, i) => (
                  <div key={i} style={{ fontSize: 10, color: '#9ca3af' }}>
                    <span style={{ color: '#4b5563', marginRight: 4 }}>t{inc.tick}</span>
                    {inc.note}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 12, color: '#4b5563', fontStyle: 'italic' }}>No reputation data yet.</div>
        )}
      </div>

      {/* Recent actions */}
      <div style={{ background: '#1f2937', borderRadius: 5, padding: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 8 }}>
          Recent Actions
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 160, overflowY: 'auto' }}>
          {recentActions.length === 0 ? (
            <div style={{ fontSize: 12, color: '#4b5563', fontStyle: 'italic' }}>No actions yet.</div>
          ) : recentActions.map((a: any) => (
            <div key={a._id} style={{ fontSize: 11, color: '#9ca3af', borderBottom: '1px solid #111827', paddingBottom: 2 }}>
              <span style={{ color: '#6b7280', marginRight: 4 }}>D{a.day}</span>
              <span style={{ color: a.outcome === 'failed' ? '#f87171' : '#93c5fd' }}>{a.action}</span>
              {a.target && <span style={{ color: '#6b7280' }}> → {a.target}</span>}
              {a.outcomeNote && <span style={{ color: '#f97316' }}> · {a.outcomeNote.slice(0, 50)}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const INPUT_STYLE: React.CSSProperties = {
  flex: 1,
  background: '#111827',
  border: '1px solid #374151',
  borderRadius: 4,
  padding: '4px 8px',
  color: '#e5e7eb',
  fontSize: 12,
  fontFamily: 'ui-monospace, monospace',
  outline: 'none',
};

export default function AgentConfigPanel({ agents, repByAgent }: {
  agents: any[];
  repByAgent: Record<string, number>;
}) {
  const [selected, setSelected] = useState<string | null>(agents[0]?.name ?? null);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 16, minHeight: 480 }}>
      {/* Left: agent list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, overflowY: 'auto' }}>
        {agents.map((a: any) => (
          <AgentRow
            key={a._id}
            agent={a}
            repScore={repByAgent[a.name]}
            selected={selected === a.name}
            onClick={() => setSelected(a.name)}
          />
        ))}
      </div>

      {/* Right: detail */}
      <div style={{ overflowY: 'auto' }}>
        {selected ? (
          <AgentDetail agentName={selected} repByAgent={repByAgent} />
        ) : (
          <div style={{ color: '#4b5563', fontSize: 12, fontStyle: 'italic' }}>Select an agent.</div>
        )}
      </div>
    </div>
  );
}
