/**
 * Systems Panel -- Phase 8
 *
 * God-mode tab for live system configuration.
 *   - Knob sliders for each system parameter
 *   - Preset scenario buttons
 *   - Reset to defaults
 *   - Shows which knobs are non-default (orange dot)
 */

import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { PRESETS } from '../../convex/rocklaw/systems';
import type { SystemKnob } from '../../convex/rocklaw/systems';

// Group knobs by systemName
function groupKnobs(knobs: SystemKnob[]): Record<string, SystemKnob[]> {
  const out: Record<string, SystemKnob[]> = {};
  for (const k of knobs) {
    (out[k.systemName] ??= []).push(k);
  }
  return out;
}

const SYSTEM_LABEL: Record<string, string> = {
  engine:    'Engine',
  agents:    'Agents',
  economy:   'Economy',
  narrative: 'Narrative',
};

export default function SystemsPanel() {
  const knobs = useQuery(api.rocklaw.systems.getSystems) ?? [];
  const setVal = useMutation(api.rocklaw.systems.setSystemValue);
  const applyPreset = useMutation(api.rocklaw.systems.applyPreset);
  const resetAll = useMutation(api.rocklaw.systems.resetToDefaults);

  // Local draft: key = "systemName.key", value = number
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [applying, setApplying] = useState<string | null>(null);

  const effectiveValue = (k: SystemKnob) =>
    draft[`${k.systemName}.${k.key}`] ?? k.currentValue;

  const handleSlider = (k: SystemKnob, val: number) => {
    setDraft((d) => ({ ...d, [`${k.systemName}.${k.key}`]: val }));
  };

  const handleCommit = async (k: SystemKnob) => {
    const val = effectiveValue(k);
    if (val === k.currentValue) return;
    await setVal({ systemName: k.systemName, key: k.key, value: val });
    setDraft((d) => {
      const n = { ...d };
      delete n[`${k.systemName}.${k.key}`];
      return n;
    });
  };

  const handlePreset = async (presetId: string) => {
    setApplying(presetId);
    try {
      await applyPreset({ presetId });
      setDraft({});
    } finally {
      setApplying(null);
    }
  };

  const handleReset = async () => {
    await resetAll({});
    setDraft({});
  };

  const grouped = groupKnobs(knobs);
  const nonDefaultCount = knobs.filter((k) => !k.isDefault).length;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 240px', gap: 24, height: 520, overflowY: 'auto' }}>

      {/* Left: knob groups */}
      <div style={{ overflowY: 'auto' }}>
        {Object.entries(grouped).map(([sysName, sysKnobs]) => (
          <div key={sysName} style={{ marginBottom: 20 }}>
            <div style={SECTION_LABEL}>{SYSTEM_LABEL[sysName] ?? sysName}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {sysKnobs.map((k) => {
                const val = effectiveValue(k);
                const dirty = draft[`${k.systemName}.${k.key}`] !== undefined;
                const nonDefault = !k.isDefault || dirty;
                return (
                  <div key={k.key}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      {nonDefault && (
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#f97316', flexShrink: 0, display: 'inline-block' }} />
                      )}
                      {!nonDefault && (
                        <span style={{ width: 6, height: 6, flexShrink: 0, display: 'inline-block' }} />
                      )}
                      <span style={{ fontSize: 12, color: '#e5e7eb', fontWeight: 500 }}>{k.label}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 12, color: nonDefault ? '#f97316' : '#9ca3af', fontWeight: 600, minWidth: 60, textAlign: 'right' }}>
                        {Number.isInteger(k.step) ? val : val.toFixed(2)} {k.unit}
                      </span>
                      {dirty && (
                        <button
                          onClick={() => handleCommit(k)}
                          style={{
                            fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: 'pointer',
                            background: '#4f46e5', color: '#e0e7ff', border: 'none', fontFamily: 'inherit',
                            fontWeight: 600,
                          }}
                        >
                          Apply
                        </button>
                      )}
                    </div>
                    <input
                      type="range"
                      min={k.min}
                      max={k.max}
                      step={k.step}
                      value={val}
                      onChange={(e) => handleSlider(k, parseFloat(e.target.value))}
                      onMouseUp={() => handleCommit(k)}
                      onTouchEnd={() => handleCommit(k)}
                      style={{ width: '100%', accentColor: nonDefault ? '#f97316' : '#4f46e5' }}
                    />
                    <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>{k.description}</div>
                    {!k.isDefault && (
                      <div style={{ fontSize: 10, color: '#4b5563', marginTop: 1 }}>
                        Default: {k.defaultValue} {k.unit}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Right: presets + status */}
      <div style={{ borderLeft: '1px solid #1f2937', paddingLeft: 16 }}>
        <div style={SECTION_LABEL}>Scenario Presets</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 20 }}>
          {Object.entries(PRESETS).map(([id, preset]) => (
            <button
              key={id}
              onClick={() => handlePreset(id)}
              disabled={applying !== null}
              style={{
                padding: '8px 12px',
                textAlign: 'left',
                cursor: applying ? 'default' : 'pointer',
                background: applying === id ? '#3730a3' : '#111827',
                border: '1px solid #1f2937',
                borderRadius: 5,
                opacity: applying && applying !== id ? 0.5 : 1,
              }}
            >
              <div style={{ fontSize: 12, color: '#e5e7eb', fontWeight: 600, marginBottom: 2 }}>
                {applying === id ? '⟳ Applying…' : preset.label}
              </div>
              <div style={{ fontSize: 10, color: '#6b7280', lineHeight: 1.4 }}>
                {preset.description}
              </div>
            </button>
          ))}
        </div>

        <div style={{ borderTop: '1px solid #1f2937', paddingTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 11, color: nonDefaultCount > 0 ? '#f97316' : '#6b7280' }}>
              {nonDefaultCount > 0
                ? `${nonDefaultCount} knob${nonDefaultCount > 1 ? 's' : ''} overridden`
                : 'All defaults'}
            </span>
            {nonDefaultCount > 0 && (
              <button
                onClick={handleReset}
                style={{
                  fontSize: 10, padding: '3px 10px', borderRadius: 3,
                  cursor: 'pointer', background: 'transparent',
                  border: '1px solid #374151', color: '#9ca3af',
                  fontFamily: 'inherit', marginLeft: 'auto',
                }}
              >
                Reset all
              </button>
            )}
          </div>

          <div style={SECTION_LABEL}>Legend</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <LegendRow dot="#f97316" label="Knob is non-default" />
            <LegendRow dot="#4f46e5" label="Knob at default" />
          </div>

          <div style={{ marginTop: 16, fontSize: 10, color: '#374151', lineHeight: 1.6 }}>
            Changes take effect on the next engine tick — no restart needed.
          </div>
        </div>
      </div>
    </div>
  );
}

function LegendRow({ dot, label }: { dot: string; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot, flexShrink: 0, display: 'inline-block' }} />
      <span style={{ color: '#9ca3af' }}>{label}</span>
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
