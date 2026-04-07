/**
 * Agent Config Panel -- god-mode per-agent configuration.
 *
 * Shows all 8 agents in a list. Clicking one opens the detail view:
 *   - Port (read-only), model override (editable), provider (editable)
 *   - Pause / Resume toggle
 *   - Reputation score + recent incidents
 *   - Last 20 actions log
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useAction } from 'convex/react';
import { api } from '../../convex/_generated/api';

const PROVIDER_OPTIONS = [
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'google', label: 'Google' },
  { value: 'custom', label: 'Custom provider' },
];

const MODEL_OPTIONS_BY_PROVIDER: Record<string, { value: string; label: string }[]> = {
  openrouter: [
    { value: 'qwen/qwen3.6-plus:free', label: 'Qwen 3.6 Plus Free' },
    { value: 'stepfun/step-3.5-flash:free', label: 'Step 3.5 Flash Free' },
    { value: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { value: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'minimax/minimax-m2.5', label: 'MiniMax M2.5' },
    { value: 'openai/gpt-4.1-mini', label: 'GPT-4.1 Mini' },
    { value: 'custom', label: 'Custom model id' },
  ],
  openai: [
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
    { value: 'gpt-4.1', label: 'GPT-4.1' },
    { value: 'custom', label: 'Custom model id' },
  ],
  anthropic: [
    { value: 'claude-opus-4-6',   label: 'Claude Opus 4.6'   },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { value: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5'  },
    { value: 'custom', label: 'Custom model id' },
  ],
  google: [
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'custom', label: 'Custom model id' },
  ],
  custom: [
    { value: 'custom', label: 'Custom model id' },
  ],
};

type ProviderModel = { id: string; name: string; contextLength: number; pricing?: { prompt: string; completion: string } };

function formatPricing(pricing: { prompt: string; completion: string }): string {
  const pIn = parseFloat(pricing.prompt);
  const pOut = parseFloat(pricing.completion);
  if (pIn === 0 && pOut === 0) return 'free';
  const fmt = (n: number) => n === 0 ? '$0' : `$${(n * 1_000_000).toFixed(2)}/M`;
  return `${fmt(pIn)} in · ${fmt(pOut)} out`;
}

function formatModelLabel(m: { id: string; name: string; contextLength: number; pricing?: { prompt: string; completion: string } }): string {
  const ctx = m.contextLength > 0 ? ` (${(m.contextLength / 1000).toFixed(0)}k ctx)` : '';
  const price = m.pricing ? ` · ${formatPricing(m.pricing)}` : '';
  return `${m.name}${ctx}${price}`;
}

function repColour(score: number): string {
  if (score >= 70) return '#22c55e';
  if (score >= 40) return '#f97316';
  if (score < 20)  return '#ef4444';
  return '#fbbf24';
}

function statColour(value: number, inverted = false): string {
  const bad = inverted ? value > 70 : value < 30;
  const mid = inverted ? value > 50 : value < 50;
  if (bad) return '#ef4444';
  if (mid) return '#f97316';
  return '#22c55e';
}

function MiniStatBar({
  value,
  inverted = false,
}: {
  value: number;
  inverted?: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <div style={{ width: 40, height: 6, background: '#374151', borderRadius: 3, overflow: 'hidden', flexShrink: 0 }}>
        <div
          style={{
            width: `${Math.min(100, value)}%`,
            height: '100%',
            background: statColour(value, inverted),
          }}
        />
      </div>
      <span style={{ fontSize: 11, color: '#9ca3af', minWidth: 22, textAlign: 'right' }}>{value}</span>
    </div>
  );
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
        transition: 'border-color 0.2s',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 13, color: '#f9fafb', lineHeight: 1.2 }}>{agent.name}</div>
          <div style={{ fontSize: 11, color: '#6b7280', lineHeight: 1.2, marginTop: 2 }}>{agent.role}</div>
        </div>
        <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <RepBadge score={repScore} />
          {agent.paused && (
            <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: '#7c3aed22', color: '#a78bfa' }}>
              excluded
            </span>
          )}
          <span
            style={{
              fontSize: 11,
              padding: '1px 6px',
              borderRadius: 3,
              background: agent.busy ? '#7c3aed22' : '#05966922',
              color: agent.busy ? '#a78bfa' : '#34d399',
            }}
          >
            {agent.busy ? 'busy' : agent.location}
          </span>
        </div>
      </div>

      <div style={{ marginTop: 6, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 2 }}>
        <div>
          <span style={{ fontSize: 10, color: '#6b7280' }}>⚡ </span>
          <MiniStatBar value={agent.energy ?? 0} />
        </div>
        <div>
          <span style={{ fontSize: 10, color: '#6b7280' }}>❤ </span>
          <MiniStatBar value={agent.health ?? 0} />
        </div>
        <div>
          <span style={{ fontSize: 10, color: '#6b7280' }}>🍞 </span>
          <MiniStatBar value={agent.hunger ?? 0} inverted />
        </div>
      </div>

      <div style={{ marginTop: 4, fontSize: 11, color: '#9ca3af' }}>
        {agent.coin ?? 0}c
        {agent.busy && agent.busyUntilTick && (
          <span style={{ marginLeft: 8, color: '#a78bfa' }}>busy until tick {agent.busyUntilTick}</span>
        )}
      </div>
    </div>
  );
}

function AgentDetail({
  agentName,
  repByAgent,
}: {
  agentName: string;
  repByAgent: Record<string, number>;
}) {
  const detail = useQuery(api.rocklaw.god.getAgentDetail, { agentName });
  const setAgentModel = useAction(api.rocklaw.godNode.setAgentModel);
  const getAgentConfigDefaults = useAction(api.rocklaw.godNode.getAgentConfigDefaults);
  const listProviderModels = useAction(api.rocklaw.godNode.listProviderModels);
  const testModel = useAction(api.rocklaw.godNode.testModel);

  const [providerInput, setProviderInput] = useState('openrouter');
  const [modelChoice, setModelChoice] = useState('');
  const [customProviderInput, setCustomProviderInput] = useState('');
  const [customModelInput, setCustomModelInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; reply?: string; latencyMs: number; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [configDefaults, setConfigDefaults] = useState<{ defaultProvider: string | null; defaultModel: string | null } | null>(null);
  const [allProviderModels, setAllProviderModels] = useState<Record<string, ProviderModel[]>>({});

  const modelOptions = useMemo(() => {
    const fetched = allProviderModels[providerInput] ?? [];
    if (fetched.length > 0) {
      return [
        ...fetched.map((m) => ({ value: m.id, label: formatModelLabel(m) })),
        { value: 'custom', label: 'Custom model id' },
      ];
    }
    return MODEL_OPTIONS_BY_PROVIDER[providerInput] ?? MODEL_OPTIONS_BY_PROVIDER.custom;
  }, [allProviderModels, providerInput]);

  useEffect(() => {
    let cancelled = false;
    void getAgentConfigDefaults({ agentName }).then((defaults) => {
      if (!cancelled) {
        setConfigDefaults(defaults);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [agentName, getAgentConfigDefaults]);

  useEffect(() => {
    let cancelled = false;
    const providers = ['openrouter', 'openai', 'google', 'anthropic'];
    void Promise.all(
      providers.map((p) =>
        listProviderModels({ provider: p })
          .then((res) => ({ provider: p, models: res.models }))
          .catch(() => ({ provider: p, models: [] as ProviderModel[] })),
      ),
    ).then((results) => {
      if (cancelled) return;
      const map: Record<string, ProviderModel[]> = {};
      for (const { provider, models } of results) {
        map[provider] = models;
      }
      setAllProviderModels(map);
    });
    return () => { cancelled = true; };
  }, [listProviderModels]);

  useEffect(() => {
    if (!detail) return;
    const { agent } = detail;
    const currentProvider = agent.providerOverride ?? configDefaults?.defaultProvider ?? 'openrouter';
    const providerOptionExists = PROVIDER_OPTIONS.some((option) => option.value === currentProvider);
    const nextProvider = providerOptionExists ? currentProvider : 'custom';
    const currentModel = agent.modelOverride ?? configDefaults?.defaultModel ?? '';
    const currentOptions =
      nextProvider === 'openrouter' && (allProviderModels.openrouter?.length ?? 0) > 0
        ? [
            ...(allProviderModels.openrouter ?? []).map((m: ProviderModel) => ({ value: m.id, label: formatModelLabel(m) })),
            { value: 'custom', label: 'Custom model id' },
          ]
        : MODEL_OPTIONS_BY_PROVIDER[nextProvider] ?? MODEL_OPTIONS_BY_PROVIDER.custom;
    const modelOptionExists = currentOptions.some((option) => option.value === currentModel);

    setProviderInput(nextProvider);
    setCustomProviderInput(providerOptionExists ? '' : currentProvider);
    if (!currentModel) {
      setModelChoice('');
      setCustomModelInput('');
      return;
    }
    if (modelOptionExists) {
      setModelChoice(currentModel);
      setCustomModelInput('');
    } else {
      setModelChoice('custom');
      setCustomModelInput(currentModel);
    }
  }, [detail, configDefaults, allProviderModels]);

  if (!detail) {
    return <div style={{ color: '#6b7280', fontSize: 12 }}>Loading...</div>;
  }

  const { agent, rep, recentActions } = detail;
  const incidents: { tick: number; note: string }[] = rep
    ? JSON.parse(rep.recentIncidents)
    : [];
  const effectiveProvider = agent.providerOverride ?? configDefaults?.defaultProvider ?? 'openrouter';
  const effectiveModel = agent.modelOverride ?? configDefaults?.defaultModel ?? 'unknown';
  const providerSource = agent.providerOverride ? 'override' : 'config';
  const modelSource = agent.modelOverride ? 'override' : 'config';

  const resolvedProvider = providerInput === 'custom' ? customProviderInput.trim() : providerInput;
  const resolvedModel = modelChoice === 'custom' ? customModelInput.trim() : modelChoice;

  const handleSaveModel = async () => {
    if (!resolvedModel) return;
    setSaving(true);
    try {
      await setAgentModel({
        agentName,
        modelOverride: resolvedModel,
        providerOverride: resolvedProvider || undefined,
      });
      setModelChoice('');
      setCustomModelInput('');
      setCustomProviderInput('');
      setProviderInput('openrouter');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!resolvedModel || !resolvedProvider) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testModel({ provider: resolvedProvider, modelId: resolvedModel });
      setTestResult(result);
    } finally {
      setTesting(false);
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
          <span style={{ color: '#e5e7eb', fontFamily: 'monospace' }}>
            {effectiveModel}
            <span style={{ color: '#6b7280', marginLeft: 6, fontFamily: 'inherit' }}>({modelSource})</span>
          </span>
          <span style={{ color: '#6b7280' }}>Provider</span>
          <span style={{ color: '#e5e7eb', fontFamily: 'monospace' }}>
            {effectiveProvider}
            <span style={{ color: '#6b7280', marginLeft: 6, fontFamily: 'inherit' }}>({providerSource})</span>
          </span>
        </div>
        <div style={{ display: 'grid', gap: 8, marginTop: 4 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '130px minmax(0, 1fr) auto auto', gap: 6 }}>
            <select
              value={providerInput}
              onChange={(e) => {
                setProviderInput(e.target.value);
                setModelChoice('');
                setCustomModelInput('');
                setTestResult(null);
              }}
              style={INPUT_STYLE}
            >
              {PROVIDER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <select
              value={modelChoice}
              onChange={(e) => {
                setModelChoice(e.target.value);
                setTestResult(null);
              }}
              style={INPUT_STYLE}
            >
              <option value="">Choose model</option>
              {modelOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <button
              onClick={handleSaveModel}
              disabled={!resolvedModel || saving}
              style={{
                fontSize: 11, padding: '4px 10px', borderRadius: 4, cursor: resolvedModel ? 'pointer' : 'default',
                background: resolvedModel ? '#4f46e5' : '#1f2937',
                color: resolvedModel ? '#e0e7ff' : '#4b5563',
                border: 'none', flexShrink: 0,
              }}
            >
              {saving ? '...' : 'Save'}
            </button>
            <button
              onClick={handleTest}
              disabled={!resolvedModel || testing}
              style={{
                fontSize: 11, padding: '4px 10px', borderRadius: 4,
                cursor: resolvedModel && !testing ? 'pointer' : 'default',
                background: resolvedModel && !testing ? '#065f46' : '#1f2937',
                color: resolvedModel && !testing ? '#6ee7b7' : '#4b5563',
                border: 'none', flexShrink: 0,
              }}
            >
              {testing ? '...' : 'Test'}
            </button>
          </div>
          {testResult && (
            <div style={{
              fontSize: 11,
              padding: '4px 8px',
              borderRadius: 4,
              background: testResult.ok ? '#052e1622' : '#2d0a0a',
              border: `1px solid ${testResult.ok ? '#065f46' : '#7f1d1d'}`,
              color: testResult.ok ? '#6ee7b7' : '#fca5a5',
              fontFamily: 'ui-monospace, monospace',
            }}>
              {testResult.ok
                ? `✓ "${testResult.reply}" · ${testResult.latencyMs}ms`
                : `✗ ${testResult.error} · ${testResult.latencyMs}ms`}
            </div>
          )}
          {providerInput === 'custom' && (
            <input
              value={customProviderInput}
              onChange={(e) => setCustomProviderInput(e.target.value)}
              placeholder="Custom provider id"
              style={INPUT_STYLE}
            />
          )}
          {modelChoice === 'custom' && (
            <input
              value={customModelInput}
              onChange={(e) => { setCustomModelInput(e.target.value); setTestResult(null); }}
              placeholder="Custom model id"
              style={INPUT_STYLE}
            />
          )}
          <div style={{ fontSize: 11, color: '#6b7280' }}>
            Pick a provider first, then pick one of its models. Use custom only when the model is not listed.
          </div>
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
  background: '#111827',
  border: '1px solid #374151',
  borderRadius: 4,
  padding: '4px 8px',
  color: '#e5e7eb',
  fontSize: 12,
  fontFamily: 'ui-monospace, monospace',
  outline: 'none',
};

export default function AgentConfigPanel({ agents, repByAgent, selectedAgentName, onSelectAgent }: {
  agents: any[];
  repByAgent: Record<string, number>;
  selectedAgentName?: string | null;
  onSelectAgent?: (agentName: string) => void;
}) {
  const [internalSelected, setInternalSelected] = useState<string | null>(agents[0]?.name ?? null);
  const selected = selectedAgentName ?? internalSelected;

  const handleSelect = (agentName: string) => {
    onSelectAgent?.(agentName);
    if (!onSelectAgent) {
      setInternalSelected(agentName);
    }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px minmax(0, 1fr)', gap: 24, minHeight: 480, minWidth: 0 }}>
      {/* Left: agent list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', minWidth: 0, paddingRight: 6 }}>
        {agents.map((a: any) => (
          <AgentRow
            key={a._id}
            agent={a}
            repScore={repByAgent[a.name]}
            selected={selected === a.name}
            onClick={() => handleSelect(a.name)}
          />
        ))}
      </div>

      {/* Right: detail */}
      <div style={{ overflowY: 'auto', minWidth: 0, paddingRight: 6 }}>
        {selected ? (
          <AgentDetail agentName={selected} repByAgent={repByAgent} />
        ) : (
          <div style={{ color: '#4b5563', fontSize: 12, fontStyle: 'italic' }}>Select an agent.</div>
        )}
      </div>
    </div>
  );
}
