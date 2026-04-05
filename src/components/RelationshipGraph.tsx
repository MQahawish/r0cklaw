/**
 * Relationship Graph -- Phase 7
 * SVG circular graph. Nodes = agents, edges = interaction history.
 * Edge thickness = interaction volume. Edge colour = cooperative (green) vs transactional (amber) vs neutral (gray).
 */

import { useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';

const SVG_SIZE = 400;
const CENTER = SVG_SIZE / 2;
const RADIUS = 150;
const NODE_R = 20;

function agentPos(index: number, total: number) {
  const angle = (index / total) * 2 * Math.PI - Math.PI / 2;
  return {
    x: CENTER + RADIUS * Math.cos(angle),
    y: CENTER + RADIUS * Math.sin(angle),
  };
}

function edgeColour(cooperative: number, transactional: number, total: number) {
  if (total === 0) return '#374151';
  const coopRatio = cooperative / total;
  const transRatio = transactional / total;
  if (coopRatio > 0.4) return '#22c55e';       // green: cooperative
  if (transRatio > 0.5) return '#f59e0b';       // amber: mostly trade
  return '#6b7280';                              // gray: neutral / talking
}

export default function RelationshipGraph({ focusAgent }: { focusAgent?: string | null }) {
  const data = useQuery(api.rocklaw.observe.getRelationships);
  const [hovered, setHovered] = useState<string | null>(null);

  if (!data) return <div style={MUTED}>Loading relationships…</div>;
  if (data.agents.length === 0) return <div style={MUTED}>No agents in simulation yet.</div>;
  if (data.edges.length === 0) return <div style={MUTED}>No interactions recorded yet. Run the simulation to see relationships form.</div>;

  const focusedEdges = focusAgent
    ? data.edges.filter((edge) => edge.from === focusAgent || edge.to === focusAgent)
    : data.edges;
  const focusedAgents = focusAgent
    ? data.agents.filter((agent) => agent === focusAgent || focusedEdges.some((edge) => edge.from === agent || edge.to === agent))
    : data.agents;

  if (focusAgent && focusedEdges.length === 0) {
    return <div style={MUTED}>No recorded relationships for {focusAgent} yet.</div>;
  }

  const agents = focusedAgents;
  const edges = focusedEdges;
  const maxCount = Math.max(...edges.map((e) => e.count), 1);

  // Short names for display inside nodes
  const shortName = (name: string) => name.split(' ')[0];

  return (
    <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
      <svg width={SVG_SIZE} height={SVG_SIZE} style={{ flexShrink: 0 }}>
        {/* Edges */}
        {edges.map((edge, i) => {
          const fromIdx = agents.indexOf(edge.from);
          const toIdx = agents.indexOf(edge.to);
          if (fromIdx === -1 || toIdx === -1) return null;

          const from = agentPos(fromIdx, agents.length);
          const to = agentPos(toIdx, agents.length);
          const strokeWidth = 1 + (edge.count / maxCount) * 5;
          const colour = edgeColour(edge.cooperative, edge.transactional, edge.count);
          const isHighlighted = hovered === edge.from || hovered === edge.to;
          const isHovered = hovered && !isHighlighted;

          return (
            <line
              key={i}
              x1={from.x} y1={from.y}
              x2={to.x} y2={to.y}
              stroke={colour}
              strokeWidth={strokeWidth}
              opacity={isHovered ? 0.1 : isHighlighted ? 1 : 0.5}
              strokeLinecap="round"
            />
          );
        })}

        {/* Nodes */}
        {agents.map((name, i) => {
          const { x, y } = agentPos(i, agents.length);
          const isHovered = hovered === name;
          const isFaded = hovered && !isHovered;

          return (
            <g
              key={name}
              onMouseEnter={() => setHovered(name)}
              onMouseLeave={() => setHovered(null)}
              style={{ cursor: 'pointer' }}
            >
              <circle
                cx={x} cy={y} r={NODE_R}
                fill={isHovered ? '#4f46e5' : '#1f2937'}
                stroke={isHovered ? '#818cf8' : '#374151'}
                strokeWidth={isHovered ? 2 : 1}
                opacity={isFaded ? 0.3 : 1}
              />
              <text
                x={x} y={y + 1}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={9}
                fill={isFaded ? '#374151' : '#e5e7eb'}
                fontFamily="ui-monospace, monospace"
              >
                {shortName(name)}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Legend + interaction table */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={SECTION_LABEL}>Legend</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 16 }}>
          <LegendRow colour="#22c55e" label="Cooperative (give, trade, heal, counsel)" />
          <LegendRow colour="#f59e0b" label="Transactional (buy, sell, negotiate)" />
          <LegendRow colour="#6b7280" label="Neutral (talk, observe)" />
        </div>
        <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 6 }}>Edge thickness = interaction volume</div>

        {hovered && (
          <>
            <div style={SECTION_LABEL}>{hovered}'s interactions</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {edges
                .filter((e) => e.from === hovered || e.to === hovered)
                .sort((a, b) => b.count - a.count)
                .map((e, i) => {
                  const other = e.from === hovered ? e.to : e.from;
                  const colour = edgeColour(e.cooperative, e.transactional, e.count);
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: colour, flexShrink: 0, display: 'inline-block' }} />
                      <span style={{ color: '#d1d5db', flex: 1 }}>{other}</span>
                      <span style={{ color: '#6b7280' }}>{e.count} interactions</span>
                    </div>
                  );
                })}
            </div>
          </>
        )}

        {!hovered && (
          <>
            <div style={SECTION_LABEL}>{focusAgent ? `${focusAgent}'s strongest links` : 'Most active pairs'}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {[...edges].sort((a, b) => b.count - a.count).slice(0, 8).map((e, i) => {
                const colour = edgeColour(e.cooperative, e.transactional, e.count);
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: colour, flexShrink: 0, display: 'inline-block' }} />
                    <span style={{ color: '#d1d5db', flex: 1 }}>{e.from.split(' ')[0]} ↔ {e.to.split(' ')[0]}</span>
                    <span style={{ color: '#6b7280' }}>{e.count}×</span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function LegendRow({ colour, label }: { colour: string; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
      <div style={{ width: 24, height: 3, background: colour, borderRadius: 2, flexShrink: 0 }} />
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
  marginBottom: 6,
};

const MUTED: React.CSSProperties = {
  fontSize: 12,
  color: '#4b5563',
  fontStyle: 'italic',
  padding: '20px 0',
};
