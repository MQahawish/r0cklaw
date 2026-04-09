import { Container, Graphics, Text, useApp } from '@pixi/react';
import { Stage } from '@pixi/react';
import {
  Background,
  BaseEdge,
  Controls,
  Edge,
  EdgeProps,
  Handle,
  Node,
  NodeProps,
  Position,
  ReactFlow,
  getSmoothStepPath,
} from '@xyflow/react';
import * as PIXI from 'pixi.js';
import { useEffect, useMemo, useState } from 'react';
import { useElementSize } from 'usehooks-ts';
import PixiViewport from './PixiViewport.tsx';
import { ROCKLAW_OVERVIEW_PRIMARY_LANES } from '../../convex/rocklaw/mapLayout';
import {
  RocklawAgentVisualState,
  RocklawLiveActionState,
  RocklawLiveSceneEntry,
  RocklawLiveSnapshot,
  RocklawLocationNode,
  ROCKLAW_ACTION_ICONS,
  ROCKLAW_AGENT_COLORS,
} from '../../convex/rocklaw/liveScene';
import '@xyflow/react/dist/style.css';

const TILE_DIM = 44;
const WORLD_MARGIN = 120;
const PANEL_WIDTH = 360;

type Facing = 'left' | 'up' | 'right' | 'down';

type AgentPlacement = {
  agent: RocklawAgentVisualState;
  point: { x: number; y: number };
  location: RocklawLocationNode;
  facing: Facing;
  moving: boolean;
};

type NodeSummary = {
  location: RocklawLocationNode;
  agentCount: number;
  busyCount: number;
  liveSceneCount: number;
  movingInCount: number;
  active: boolean;
  presentAgents: string[];
  travelingAgents: string[];
  agentDetails: { name: string; status: string; action: string }[];
  recentActivity: string[];
};

type EdgeUsage = {
  key: string;
  a: RocklawLocationNode;
  b: RocklawLocationNode;
  activeCount: number;
};

type RecentMoveGlow = {
  edgeKey: string;
  startedAt: number;
};

type CompactGraphNodeData = {
  summary: NodeSummary;
};

type CompactGraphEdgeData = {
  activeCount: number;
  recentGlowStrength: number;
};

export default function RocklawLiveScene({
  snapshot,
  mode = 'full',
  isExpanded = false,
}: {
  snapshot: RocklawLiveSnapshot;
  mode?: 'compact' | 'full';
  isExpanded?: boolean;
}) {
  const [wrapperRef, { width, height }] = useElementSize();
  const [frameNow, setFrameNow] = useState(() => Date.now());
  const [tickObservedAt, setTickObservedAt] = useState(() => Date.now());
  const [observedTick, setObservedTick] = useState(snapshot.tick);
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [showBusy, setShowBusy] = useState(true);
  const [showTravel, setShowTravel] = useState(true);
  const [showScenes, setShowScenes] = useState(true);
  const [recentMoveGlows, setRecentMoveGlows] = useState<Record<string, RecentMoveGlow>>({});

  useEffect(() => {
    const interval = window.setInterval(() => {
      setFrameNow(Date.now());
    }, 100);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (snapshot.tick !== observedTick) {
      setObservedTick(snapshot.tick);
      setTickObservedAt(Date.now());
    }
  }, [observedTick, snapshot.tick]);

  const recentMoveActionKeys = useMemo(
    () =>
      snapshot.recentActions
        .filter((action) =>
          action.action === 'move'
          && action.outcome === 'success'
          && typeof action.agentName === 'string'
          && typeof action.fromLocationId === 'string'
          && typeof action.toLocationId === 'string')
        .map((action) => ({
          key: [
            action.agentName,
            action.tick ?? 'na',
            action.fromLocationId,
            action.toLocationId,
          ].join('::'),
          edgeKey: [action.fromLocationId!, action.toLocationId!].sort().join('::'),
        })),
    [snapshot.recentActions],
  );

  useEffect(() => {
    const now = Date.now();
    setRecentMoveGlows((prev) => {
      const next: Record<string, RecentMoveGlow> = {};
      for (const [key, glow] of Object.entries(prev)) {
        if (now - glow.startedAt < snapshot.tickIntervalMs) {
          next[key] = glow;
        }
      }
      for (const action of recentMoveActionKeys) {
        if (!next[action.key]) {
          next[action.key] = {
            edgeKey: action.edgeKey,
            startedAt: now,
          };
        }
      }
      return next;
    });
  }, [recentMoveActionKeys, snapshot.tickIntervalMs]);

  const locationById = useMemo(
    () => new Map(snapshot.locations.map((location) => [location.id, location])),
    [snapshot.locations],
  );

  const worldWidth = useMemo(
    () =>
      Math.max(
        ...snapshot.locations.map((location) => (location.region.x + location.region.width) * TILE_DIM),
        0,
      ) + WORLD_MARGIN,
    [snapshot.locations],
  );
  const worldHeight = useMemo(
    () =>
      Math.max(
        ...snapshot.locations.map((location) => (location.region.y + location.region.height) * TILE_DIM),
        0,
      ) + WORLD_MARGIN,
    [snapshot.locations],
  );

  const placements = useMemo(
    () => buildAgentPlacements(snapshot, locationById, frameNow, tickObservedAt),
    [frameNow, locationById, snapshot, tickObservedAt],
  );

  const nodeSummaries = useMemo(
    () => buildNodeSummaries(snapshot, placements),
    [placements, snapshot],
  );
  const compact = mode === 'compact';
  const edges = useMemo(
    () => buildEdgeUsage(snapshot, locationById, compact && !isExpanded),
    [compact, isExpanded, locationById, snapshot],
  );

  const selectedLocation = selectedLocationId ? locationById.get(selectedLocationId) ?? null : null;
  const selectedAgents = selectedLocation
    ? placements.filter((placement) => placement.location.id === selectedLocation.id)
    : [];
  const selectedScenes = selectedLocation
    ? snapshot.liveScenes.filter((scene) => scene.location === selectedLocation.id)
    : [];
  const selectedRecentActions = selectedLocation
    ? snapshot.recentActions.filter((action) => matchesLocationAction(action, selectedLocation))
    : [];

  const activeChats = snapshot.liveScenes.length;
  const busyAgents = snapshot.agents.filter((agent) => agent.busy).length;
  const movingAgents = snapshot.agents.filter((agent) => agent.moveState).length;
  const visiblePlacements = placements.filter((placement) => {
    if (placement.moving) return showTravel;
    if (placement.agent.scenePartner) return showScenes;
    if (placement.agent.busy) return showBusy;
    return true;
  });
  const visibleEdgeCounts = buildVisibleEdgeCounts(visiblePlacements);
  const recentMoveGlowByEdge = useMemo(
    () => buildRecentMoveGlowByEdge(recentMoveGlows, frameNow, snapshot.tickIntervalMs),
    [frameNow, recentMoveGlows, snapshot.tickIntervalMs],
  );
  const compactGraphNodes = useMemo(
    () => (compact && !isExpanded ? buildCompactGraphNodes(nodeSummaries) : []),
    [compact, isExpanded, nodeSummaries],
  );
  const compactGraphEdges = useMemo(
    () => (compact && !isExpanded
      ? buildCompactGraphEdges(edges, recentMoveGlowByEdge, visibleEdgeCounts)
      : []),
    [compact, edges, isExpanded, recentMoveGlowByEdge, visibleEdgeCounts],
  );
  const frameStyle: React.CSSProperties = {
    ...LIVE_FRAME_STYLE,
    minHeight: compact && !isExpanded ? 360 : LIVE_FRAME_STYLE.minHeight,
    height: compact && !isExpanded ? 360 : LIVE_FRAME_STYLE.height,
  };
  const contentStyle: React.CSSProperties = {
    ...LIVE_CONTENT_STYLE,
    gridTemplateColumns: compact && !isExpanded ? 'minmax(0, 1fr)' : LIVE_CONTENT_STYLE.gridTemplateColumns,
  };
  const graphStyle: React.CSSProperties = {
    ...LIVE_GRAPH_STYLE,
    minHeight: compact && !isExpanded ? 284 : LIVE_GRAPH_STYLE.minHeight,
  };
  const panelStyle: React.CSSProperties = {
    ...LIVE_PANEL_STYLE,
    maxHeight: compact && !isExpanded ? 360 : undefined,
  };
  const summaryText = `${snapshot.day}.${snapshot.tick} · ${snapshot.timeOfDay} · ${busyAgents} busy · ${movingAgents} traveling · ${activeChats} scenes`;

  return (
    <div style={frameStyle}>
      <div
        style={{
          ...LIVE_FRAME_HEADER_STYLE,
          padding: compact && !isExpanded ? '10px 12px' : LIVE_FRAME_HEADER_STYLE.padding,
        }}
      >
        <div style={HEADER_TITLE_GROUP_STYLE}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: compact && !isExpanded ? 0 : 2 }}>
            <span style={HEADER_LABEL_STYLE}>Live Simulation</span>
            {compact && !isExpanded ? (
              <span style={HEADER_SUMMARY_STYLE}>{summaryText}</span>
            ) : (
              <span style={HEADER_NOTE_STYLE}>
                Full-map graph view. Click a location node to inspect exactly what is happening there.
              </span>
            )}
          </div>
          <div style={HEADER_TOGGLES_STYLE}>
            {(!compact || isExpanded) && (
              <>
                <ToggleChip label="Busy" active={showBusy} onClick={() => setShowBusy((value) => !value)} />
                <ToggleChip
                  label="Travel"
                  active={showTravel}
                  onClick={() => setShowTravel((value) => !value)}
                />
                <ToggleChip
                  label="Scenes"
                  active={showScenes}
                  onClick={() => setShowScenes((value) => !value)}
                />
              </>
            )}
          </div>
        </div>
        {(!compact || isExpanded) && (
          <div style={HEADER_CHIPS_STYLE}>
            <HeaderChip label="Tick" value={`${snapshot.day}.${snapshot.tick}`} />
            <HeaderChip label="Time" value={snapshot.timeOfDay} />
            <HeaderChip label="Busy" value={String(busyAgents)} />
            <HeaderChip label="Traveling" value={String(movingAgents)} />
            <HeaderChip label="Live scenes" value={String(activeChats)} />
          </div>
        )}
      </div>
      <div style={contentStyle}>
        <div style={graphStyle} ref={wrapperRef}>
          {(!compact || isExpanded) && (
            <div style={LEGEND_STYLE}>
              <LegendItem color="#38bdf8" label="Travel route" />
              <LegendItem color="#f59e0b" label="Live scene node" />
              <LegendItem color="#94a3b8" label="Idle route" />
              <LegendItem color="#f8fafc" label="Selected node" />
            </div>
          )}
          {compact && !isExpanded ? (
            <div style={{ position: 'absolute', inset: 0 }}>
              <CompactOverviewGraph
                nodes={compactGraphNodes}
                edges={compactGraphEdges}
                selectedLocationId={selectedLocationId}
                onSelectLocation={setSelectedLocationId}
              />
            </div>
          ) : width > 0 && height > 0 ? (
            <div style={{ position: 'absolute', inset: 0 }}>
              <Stage width={width} height={height} options={{ backgroundColor: 0x0f172a, antialias: true }}>
                <RocklawGraphCanvas
                  snapshot={snapshot}
                  width={width}
                  height={height}
                  worldWidth={worldWidth}
                  worldHeight={worldHeight}
                  frameNow={frameNow}
                  placements={visiblePlacements}
                  nodeSummaries={nodeSummaries}
                  edges={edges}
                  visibleEdgeCounts={visibleEdgeCounts}
                  recentMoveGlowByEdge={recentMoveGlowByEdge}
                  selectedLocationId={selectedLocationId}
                  onSelectLocation={setSelectedLocationId}
                  compact={compact && !isExpanded}
                />
              </Stage>
            </div>
          ) : null}
        </div>
        {(!compact || isExpanded) && (
          <div style={panelStyle}>
            <LocationPanel
              location={selectedLocation}
              agents={selectedAgents}
              scenes={selectedScenes}
              recentActions={selectedRecentActions}
              compact={compact && !isExpanded}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function CompactOverviewGraph({
  nodes,
  edges,
  selectedLocationId,
  onSelectLocation,
}: {
  nodes: Node<CompactGraphNodeData>[];
  edges: Edge<CompactGraphEdgeData>[];
  selectedLocationId: string | null;
  onSelectLocation: (locationId: string) => void;
}) {
  const selectedNodes = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        selected: node.id === selectedLocationId,
      })),
    [nodes, selectedLocationId],
  );

  return (
    <ReactFlow
      nodes={selectedNodes}
      edges={edges}
      nodeTypes={COMPACT_NODE_TYPES}
      edgeTypes={COMPACT_EDGE_TYPES}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      fitView
      fitViewOptions={{ padding: 0.24 }}
      minZoom={0.2}
      maxZoom={1.5}
      panOnDrag
      panOnScroll
      zoomOnScroll
      zoomOnPinch
      zoomOnDoubleClick={false}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, node) => onSelectLocation(node.id)}
      style={{ background: '#0b1120' }}
    >
      <Background color="#203047" gap={TILE_DIM} size={1} />
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  );
}

function CompactLocationNode({ data, selected }: NodeProps) {
  const { summary } = data as CompactGraphNodeData;
  const compactMeta = buildCompactNodeMeta(summary);

  return (
    <div
      style={{
        width: 214,
        minHeight: 110,
        borderRadius: 18,
        border: `2px solid ${selected ? '#f8fafc' : summary.active ? '#93c5fd' : '#64748b'}`,
        background: selected ? '#1e293b' : '#0f172a',
        boxShadow: summary.active
          ? `0 0 0 6px ${summary.liveSceneCount > 0 ? 'rgba(245, 158, 11, 0.18)' : 'rgba(56, 189, 248, 0.14)'}`
          : 'none',
        padding: '12px 14px',
        color: '#e2e8f0',
      }}
    >
      {FLOW_HANDLE_SPECS.map((spec) => (
        <Handle
          key={`target-${spec.id}`}
          id={spec.id}
          type="target"
          position={spec.position}
          style={{ ...FLOW_HANDLE_STYLE, ...spec.style }}
        />
      ))}
      {FLOW_HANDLE_SPECS.map((spec) => (
        <Handle
          key={`source-${spec.id}`}
          id={`${spec.id}-source`}
          type="source"
          position={spec.position}
          style={{ ...FLOW_HANDLE_STYLE, ...spec.style }}
        />
      ))}

      <div style={{ fontSize: 15, fontWeight: 800, textAlign: 'center', color: '#f8fafc' }}>
        {summary.location.label}
      </div>
      <div style={{ marginTop: 6, fontSize: 11, textAlign: 'center', color: '#94a3b8' }}>
        {buildNodeCaption(summary)}
      </div>
      <div
        style={{
          marginTop: 10,
          fontSize: 10,
          lineHeight: 1.35,
          color: '#cbd5e1',
          whiteSpace: 'pre-wrap',
        }}
      >
        {compactMeta}
      </div>
    </div>
  );
}

function CompactLaneEdge(props: EdgeProps) {
  const [edgePath] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    borderRadius: 22,
    offset: 18,
  });
  const activeCount = (props.data as CompactGraphEdgeData | undefined)?.activeCount ?? 0;
  const recentGlowStrength = (props.data as CompactGraphEdgeData | undefined)?.recentGlowStrength ?? 0;

  return (
    <>
      <BaseEdge path={edgePath} style={{ stroke: '#0f1b2d', strokeWidth: 14, opacity: 0.96 }} />
      <BaseEdge
        path={edgePath}
        style={{
          stroke: activeCount > 0 ? '#7dd3fc' : '#64748b',
          strokeWidth: activeCount > 0 ? 5 : 3,
          opacity: activeCount > 0 ? 0.9 : 0.64,
        }}
      />
      {recentGlowStrength > 0 ? (
        <>
          <BaseEdge
            path={edgePath}
            style={{ stroke: '#67e8f9', strokeWidth: 10, opacity: Math.min(0.22, recentGlowStrength * 0.22) }}
          />
          <BaseEdge
            path={edgePath}
            style={{ stroke: '#e0f2fe', strokeWidth: 5, opacity: Math.min(0.82, recentGlowStrength * 0.82) }}
          />
        </>
      ) : null}
    </>
  );
}

const COMPACT_NODE_TYPES: Record<string, React.ComponentType<any>> = {
  locationCard: CompactLocationNode,
};

const COMPACT_EDGE_TYPES: Record<string, React.ComponentType<any>> = {
  lane: CompactLaneEdge,
};

const FLOW_HANDLE_STYLE = {
  width: 8,
  height: 8,
  borderRadius: 999,
  background: '#e2e8f0',
  border: '2px solid #0f172a',
  opacity: 0,
};

const FLOW_HANDLE_SPECS: Array<{
  id: string;
  position: Position;
  style: React.CSSProperties;
}> = [
  { id: 'top-left', position: Position.Top, style: { left: '28%' } },
  { id: 'top-center', position: Position.Top, style: { left: '50%' } },
  { id: 'top-right', position: Position.Top, style: { left: '72%' } },
  { id: 'right-top', position: Position.Right, style: { top: '30%' } },
  { id: 'right-center', position: Position.Right, style: { top: '50%' } },
  { id: 'right-bottom', position: Position.Right, style: { top: '70%' } },
  { id: 'bottom-left', position: Position.Bottom, style: { left: '28%' } },
  { id: 'bottom-center', position: Position.Bottom, style: { left: '50%' } },
  { id: 'bottom-right', position: Position.Bottom, style: { left: '72%' } },
  { id: 'left-top', position: Position.Left, style: { top: '30%' } },
  { id: 'left-center', position: Position.Left, style: { top: '50%' } },
  { id: 'left-bottom', position: Position.Left, style: { top: '70%' } },
];

function RocklawGraphCanvas({
  snapshot,
  width,
  height,
  worldWidth,
  worldHeight,
  frameNow,
  placements,
  nodeSummaries,
  edges,
  visibleEdgeCounts,
  recentMoveGlowByEdge,
  selectedLocationId,
  onSelectLocation,
  compact = false,
}: {
  snapshot: RocklawLiveSnapshot;
  width: number;
  height: number;
  worldWidth: number;
  worldHeight: number;
  frameNow: number;
  placements: AgentPlacement[];
  nodeSummaries: NodeSummary[];
  edges: EdgeUsage[];
  visibleEdgeCounts: Map<string, number>;
  recentMoveGlowByEdge: Map<string, number>;
  selectedLocationId: string | null;
  onSelectLocation: (locationId: string) => void;
  compact?: boolean;
}) {
  const app = useApp();

  return (
    <PixiViewport
      app={app}
      screenWidth={width}
      screenHeight={height}
      worldWidth={worldWidth}
      worldHeight={worldHeight}
    >
      <GraphBackdrop worldWidth={worldWidth} worldHeight={worldHeight} timeOfDay={snapshot.timeOfDay} />
      {edges.map((edge) => (
        <GraphEdge
          key={edge.key}
          edge={edge}
          frameNow={frameNow}
          visibleActiveCount={visibleEdgeCounts.get(edge.key) ?? 0}
          recentGlowStrength={recentMoveGlowByEdge.get(edge.key) ?? 0}
        />
      ))}
      {nodeSummaries.map((summary) => (
        <LocationNode
          key={summary.location.id}
          summary={summary}
          selected={summary.location.id === selectedLocationId}
          onSelect={onSelectLocation}
          compact={compact}
        />
      ))}
      {!compact && placements.map((placement) => (
        <AgentMarker key={placement.agent.name} placement={placement} frameNow={frameNow} />
      ))}
    </PixiViewport>
  );
}

function GraphBackdrop({
  worldWidth,
  worldHeight,
  timeOfDay,
}: {
  worldWidth: number;
  worldHeight: number;
  timeOfDay: string;
}) {
  const { tint, alpha } = getTimePalette(timeOfDay);
  return (
    <Container>
      <Graphics
        draw={(g) => {
          g.clear();
          g.beginFill(0x0b1120, 1);
          g.drawRect(0, 0, worldWidth, worldHeight);
          g.endFill();

          g.beginFill(0x101a2b, 1);
          g.drawRoundedRect(24, 24, worldWidth - 48, worldHeight - 48, 20);
          g.endFill();

          g.lineStyle(1, 0x203047, 0.3);
          for (let x = 0; x < worldWidth; x += TILE_DIM) {
            g.moveTo(x, 0);
            g.lineTo(x, worldHeight);
          }
          for (let y = 0; y < worldHeight; y += TILE_DIM) {
            g.moveTo(0, y);
            g.lineTo(worldWidth, y);
          }

          g.beginFill(tint, alpha);
          g.drawRect(0, 0, worldWidth, worldHeight);
          g.endFill();
        }}
      />
    </Container>
  );
}

function GraphEdge({
  edge,
  frameNow,
  visibleActiveCount,
  recentGlowStrength,
}: {
  edge: EdgeUsage;
  frameNow: number;
  visibleActiveCount: number;
  recentGlowStrength: number;
}) {
  const activeCount = visibleActiveCount;
  const pulse = activeCount > 0 ? 0.55 + Math.sin(frameNow / 260) * 0.18 : 0.18;
  const path = buildEdgePath(edge);

  return (
    <Graphics
      draw={(g) => {
        g.clear();
        drawEdgePolyline(g, path, 14, 0x0f1b2d, 0.96);
        drawEdgePolyline(g, path, activeCount > 0 ? 5 : 3, activeCount > 0 ? 0x7dd3fc : 0x64748b, activeCount > 0 ? Math.max(0.62, pulse) : 0.58);

        if (recentGlowStrength > 0) {
          drawEdgePolyline(g, path, 10, 0x67e8f9, Math.min(0.22, recentGlowStrength * 0.22));
          drawEdgePolyline(g, path, 5, 0xe0f2fe, Math.min(0.82, recentGlowStrength * 0.82));
        }

        if (activeCount > 1) {
          const midpoint = path[Math.floor(path.length / 2)];
          g.beginFill(0x7dd3fc, 0.96);
          g.drawCircle(midpoint.x, midpoint.y, 8);
          g.endFill();
        }
      }}
    />
  );
}

function drawEdgePolyline(
  g: PIXI.Graphics,
  points: Array<{ x: number; y: number }>,
  width: number,
  color: number,
  alpha: number,
) {
  if (points.length < 2) return;
  g.lineStyle(width, color, alpha, 0.5, true);
  g.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) {
    g.lineTo(points[i].x, points[i].y);
  }
}

function buildEdgePath(edge: EdgeUsage) {
  const start = getEdgePort(edge.a, edge.b);
  const end = getEdgePort(edge.b, edge.a);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const horizontalBias = Math.abs(dx) >= Math.abs(dy);

  if (Math.abs(dx) < 6 || Math.abs(dy) < 6) {
    return [start, end];
  }

  if (horizontalBias) {
    const midX = start.x + dx * 0.5;
    return [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end];
  }

  const midY = start.y + dy * 0.5;
  return [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end];
}

function getEdgePort(source: RocklawLocationNode, target: RocklawLocationNode) {
  const x = toPx(source.center.x);
  const y = toPx(source.center.y);
  const dx = target.center.x - source.center.x;
  const dy = target.center.y - source.center.y;
  const xOffset = Math.max(18, ((source.region.width * TILE_DIM) / 2) - 18);
  const yOffset = Math.max(14, ((source.region.height * TILE_DIM) / 2) - 18);

  if (Math.abs(dx) >= Math.abs(dy)) {
    return {
      x: x + Math.sign(dx || 1) * xOffset,
      y,
    };
  }

  return {
    x,
    y: y + Math.sign(dy || 1) * yOffset,
  };
}

function LocationNode({
  summary,
  selected,
  onSelect,
  compact = false,
}: {
  summary: NodeSummary;
  selected: boolean;
  onSelect: (locationId: string) => void;
  compact?: boolean;
}) {
  const { location } = summary;
  const x = toPx(location.center.x);
  const y = toPx(location.center.y);
  const activePulse = summary.active ? 0.5 + 0.2 * Math.sin(Date.now() / 400) : 0;
  const nodeWidth = compact ? 214 : 156;
  const nodeHeight = compact ? 110 : 88;
  const hitArea = new PIXI.Rectangle(x - nodeWidth / 2, y - nodeHeight / 2, nodeWidth, nodeHeight);
  const compactMeta = buildCompactNodeMeta(summary);

  return (
    <Container interactive cursor="pointer" pointertap={() => onSelect(location.id)} hitArea={hitArea}>
      <Graphics
        draw={(g) => {
          g.clear();
          if (summary.active) {
            g.lineStyle(0);
            g.beginFill(summary.liveSceneCount > 0 ? 0xf59e0b : 0x38bdf8, 0.18 + activePulse * 0.18);
            g.drawRoundedRect(x - nodeWidth / 2 - 6, y - nodeHeight / 2 - 6, nodeWidth + 12, nodeHeight + 12, 24);
            g.endFill();
          }

          if (selected) {
            g.lineStyle(0);
            g.beginFill(0xf8fafc, 0.12);
            g.drawRoundedRect(x - nodeWidth / 2 - 10, y - nodeHeight / 2 - 10, nodeWidth + 20, nodeHeight + 20, 28);
            g.endFill();
          }

          g.lineStyle(selected ? 3 : 2, selected ? 0xf8fafc : summary.active ? 0xf8e6a8 : 0x64748b, selected ? 0.95 : 0.55);
          g.beginFill(selected ? 0x1e293b : 0x0f172a, 0.96);
          g.drawRoundedRect(x - nodeWidth / 2, y - nodeHeight / 2, nodeWidth, nodeHeight, 18);
          g.endFill();
        }}
      />
      <Text
        x={x}
        y={compact ? y - 34 : y - 18}
        anchor={{ x: 0.5, y: 0.5 }}
        text={location.label}
        style={
          new PIXI.TextStyle({
            fill: selected ? '#ffffff' : '#e2e8f0',
            fontSize: selected ? 14 : 13,
            fontWeight: '700',
            align: 'center',
            wordWrap: true,
                wordWrapWidth: compact ? 176 : 132,
          })
        }
      />
      {compact ? (
        <>
          <Text
            x={x}
            y={y - 12}
            anchor={{ x: 0.5, y: 0.5 }}
            text={buildNodeCaption(summary)}
            style={
              new PIXI.TextStyle({
                fill: '#94a3b8',
                fontSize: 10,
                align: 'center',
              })
            }
          />
          <Text
            x={x - 90}
            y={y + 14}
            anchor={{ x: 0, y: 0.5 }}
            text={compactMeta}
            style={
              new PIXI.TextStyle({
                fill: '#cbd5e1',
                fontSize: 9,
                lineHeight: 13,
                wordWrap: true,
                wordWrapWidth: 180,
              })
            }
          />
        </>
      ) : (
        <Text
          x={x}
          y={y + 26}
          anchor={{ x: 0.5, y: 0.5 }}
          text={buildNodeCaption(summary)}
          style={
            new PIXI.TextStyle({
              fill: '#94a3b8',
              fontSize: 9,
              align: 'center',
            })
          }
        />
      )}
    </Container>
  );
}

function AgentMarker({ placement, frameNow }: { placement: AgentPlacement; frameNow: number }) {
  const x = toPx(placement.point.x);
  const y = toPx(placement.point.y);
  const color = ROCKLAW_AGENT_COLORS[placement.agent.name] ?? placement.location.color;
  const initials = getInitials(placement.agent.name);
  const movingPulse = placement.moving ? 0.72 + Math.sin(frameNow / 180) * 0.12 : 0;

  return (
    <Container>
      <Graphics
        draw={(g) => {
          g.clear();
          if (placement.moving) {
            g.beginFill(color, movingPulse);
            g.drawCircle(x, y, 11);
            g.endFill();
          }
          g.lineStyle(2, 0xf8fafc, 0.8);
          g.beginFill(color, 0.96);
          g.drawCircle(x, y, 8);
          g.endFill();
        }}
      />
      <Text
        x={x}
        y={y}
        anchor={{ x: 0.5, y: 0.5 }}
        text={initials}
        style={
          new PIXI.TextStyle({
            fill: '#f8fafc',
            fontSize: 8,
            fontWeight: '800',
          })
        }
      />
    </Container>
  );
}

function LocationPanel({
  location,
  agents,
  scenes,
  recentActions,
  compact = false,
}: {
  location: RocklawLocationNode | null;
  agents: AgentPlacement[];
  scenes: RocklawLiveSceneEntry[];
  recentActions: RocklawLiveActionState[];
  compact?: boolean;
}) {
  if (!location) {
    return (
      <div style={{ ...PANEL_PLACEHOLDER_STYLE, gap: compact ? 10 : 16 }}>
        <div style={PANEL_TITLE_STYLE}>Location Detail</div>
        <div style={PANEL_PLACEHOLDER_TEXT_STYLE}>
          Select a node to inspect that location.
        </div>
      </div>
    );
  }

  return (
    <div style={PANEL_STYLE}>
      <div style={PANEL_SECTION_STYLE}>
        <div style={PANEL_KICKER_STYLE}>{location.type}</div>
        <div style={PANEL_TITLE_STYLE}>{location.label}</div>
        <div style={PANEL_META_STYLE}>
          {agents.length} agent{agents.length === 1 ? '' : 's'} here · {scenes.length} live scene{scenes.length === 1 ? '' : 's'}
        </div>
      </div>

      <div style={PANEL_SECTION_STYLE}>
        <div style={PANEL_SECTION_TITLE_STYLE}>Agents Here</div>
        {agents.length === 0 ? (
          <div style={PANEL_EMPTY_STYLE}>No agents are in this location right now.</div>
        ) : (
          <div style={PANEL_LIST_STYLE}>
            {agents.map(({ agent, moving }) => (
              <div key={agent.name} style={PANEL_CARD_STYLE}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <div>
                    <div style={PANEL_CARD_TITLE_STYLE}>{agent.name}</div>
                    <div style={PANEL_CARD_SUBTITLE_STYLE}>{agent.role}</div>
                  </div>
                  <div style={PANEL_BADGE_STYLE}>{moving ? 'traveling' : deriveStatusLabel(agent)}</div>
                </div>
                <div style={PANEL_CARD_BODY_STYLE}>
                  {agent.currentAction ? describeAction(agent.currentAction) : agent.busyLabel ?? 'idle'}
                </div>
                <div style={PANEL_STATS_STYLE}>
                  <span>E {Math.round(agent.energy)}</span>
                  <span>H {Math.round(agent.health)}</span>
                  <span>U {Math.round(agent.hunger)}</span>
                  <span>{agent.coin}c</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={PANEL_SECTION_STYLE}>
        <div style={PANEL_SECTION_TITLE_STYLE}>Live Scenes</div>
        {scenes.length === 0 ? (
          <div style={PANEL_EMPTY_STYLE}>No live conversation is active here.</div>
        ) : (
          <div style={PANEL_LIST_STYLE}>
            {scenes.map((scene) => (
              <div key={scene.sceneId} style={PANEL_CARD_STYLE}>
                <div style={PANEL_CARD_TITLE_STYLE}>
                  {scene.left} and {scene.right}
                </div>
                <div style={PANEL_CARD_SUBTITLE_STYLE}>Next speaker: {scene.nextSpeaker}</div>
                {scene.recentMessages.length > 0 ? (
                  <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
                    {scene.recentMessages.map((message, index) => (
                      <div key={`${scene.sceneId}-${index}`} style={PANEL_MESSAGE_STYLE}>
                        <span style={{ color: '#e2e8f0', fontWeight: 700 }}>{message.fromAgent}:</span>{' '}
                        <span style={{ color: '#cbd5e1' }}>{message.text}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={PANEL_EMPTY_STYLE}>No recent messages.</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={PANEL_SECTION_STYLE}>
        <div style={PANEL_SECTION_TITLE_STYLE}>Recent Activity</div>
        {recentActions.length === 0 ? (
          <div style={PANEL_EMPTY_STYLE}>No recent actions were attributed to this location.</div>
        ) : (
          <div style={PANEL_LIST_STYLE}>
            {recentActions.slice(0, 6).map((action, index) => (
              <div key={`${action.action}-${index}`} style={PANEL_CARD_STYLE}>
                <div style={PANEL_CARD_TITLE_STYLE}>{describeAction(action)}</div>
                <div style={PANEL_CARD_BODY_STYLE}>
                  {action.outcomeNote ?? action.outcome ?? action.message ?? 'Action completed without a note.'}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div style={LEGEND_ITEM_STYLE}>
      <span style={{ ...LEGEND_SWATCH_STYLE, background: color }} />
      <span>{label}</span>
    </div>
  );
}

function HeaderChip({ label, value }: { label: string; value: string }) {
  return (
    <div style={HEADER_CHIP_STYLE}>
      <span style={HEADER_CHIP_LABEL_STYLE}>{label}</span>
      <span style={HEADER_CHIP_VALUE_STYLE}>{value}</span>
    </div>
  );
}

function ToggleChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...TOGGLE_CHIP_STYLE,
        ...(active ? TOGGLE_CHIP_ACTIVE_STYLE : TOGGLE_CHIP_INACTIVE_STYLE),
      }}
    >
      {label}
    </button>
  );
}

function buildNodeSummaries(snapshot: RocklawLiveSnapshot, placements: AgentPlacement[]): NodeSummary[] {
  return snapshot.locations.map((location) => {
    const here = placements.filter((placement) => placement.location.id === location.id);
    const liveSceneCount = snapshot.liveScenes.filter((scene) => scene.location === location.id).length;
    const busyCount = here.filter((placement) => placement.agent.busy).length;
    const movingInCount = here.filter((placement) => placement.moving).length;
    const presentAgents = here.map((placement) => getInitials(placement.agent.name)).slice(0, 3);
    const travelingAgents = here
      .filter((placement) => placement.moving)
      .map((placement) => placement.agent.name);
    const agentDetails = here.slice(0, 2).map((placement) => ({
      name: placement.agent.name,
      status: placement.moving ? 'traveling' : deriveStatusLabel(placement.agent),
      action: placement.agent.currentAction ? describeAction(placement.agent.currentAction) : placement.agent.busyLabel ?? 'idle',
    }));
    const recentActivity = snapshot.recentActions
      .filter((action) => matchesLocationAction(action, location))
      .slice(0, 1)
      .map((action) => trimLabel(action.outcomeNote ?? action.outcome ?? action.message ?? describeAction(action)));
    return {
      location,
      agentCount: here.length,
      busyCount,
      liveSceneCount,
      movingInCount,
      active: liveSceneCount > 0 || busyCount > 0 || movingInCount > 0,
      presentAgents,
      travelingAgents,
      agentDetails,
      recentActivity,
    };
  });
}

function buildCompactGraphNodes(nodeSummaries: NodeSummary[]): Node<CompactGraphNodeData>[] {
  return nodeSummaries.map((summary) => ({
    id: summary.location.id,
    type: 'locationCard',
    position: {
      x: toPx(summary.location.center.x) - 107,
      y: toPx(summary.location.center.y) - 55,
    },
    data: { summary },
  }));
}

function buildCompactGraphEdges(
  edges: EdgeUsage[],
  recentMoveGlowByEdge: Map<string, number>,
  visibleEdgeCounts: Map<string, number>,
): Edge<CompactGraphEdgeData>[] {
  const edgeByKey = new Map(edges.map((edge) => [edge.key, edge]));
  return ROCKLAW_OVERVIEW_PRIMARY_LANES.flatMap((lane) => {
    const key = [lane.source, lane.target].sort().join('::');
    const edge = edgeByKey.get(key);
    if (!edge) return [];
    return [{
      id: edge.key,
      source: lane.source,
      target: lane.target,
      sourceHandle: `${lane.sourceHandle}-source`,
      targetHandle: lane.targetHandle,
      type: 'lane',
      selectable: false,
      data: {
        activeCount: visibleEdgeCounts.get(edge.key) ?? 0,
        recentGlowStrength: recentMoveGlowByEdge.get(edge.key) ?? 0,
      },
    }];
  });
}

function buildEdgeUsage(
  snapshot: RocklawLiveSnapshot,
  locationById: Map<string, RocklawLocationNode>,
  compactPrimaryOnly = false,
): EdgeUsage[] {
  const activeCounts = new Map<string, number>();
  for (const agent of snapshot.agents) {
    if (!agent.moveState) continue;
    const key = [agent.moveState.fromLocationId, agent.moveState.toLocationId].sort().join('::');
    activeCounts.set(key, (activeCounts.get(key) ?? 0) + 1);
  }

  const edges: EdgeUsage[] = [];
  const edgePairs = compactPrimaryOnly
    ? ROCKLAW_OVERVIEW_PRIMARY_LANES.map((lane) => [lane.source, lane.target] as [string, string])
    : snapshot.locations.flatMap((location) =>
        location.neighbors.map((neighborId) => [location.id, neighborId] as [string, string]));

  const seen = new Set<string>();
  for (const [leftId, rightId] of edgePairs) {
    const left = locationById.get(leftId);
    const right = locationById.get(rightId);
    if (!left || !right) continue;
    const key = [left.id, right.id].sort().join('::');
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      key,
      a: left,
      b: right,
      activeCount: activeCounts.get(key) ?? 0,
    });
  }
  return edges;
}

function buildVisibleEdgeCounts(placements: AgentPlacement[]) {
  const counts = new Map<string, number>();
  for (const placement of placements) {
    const moveState = placement.agent.moveState;
    if (!moveState) continue;
    const key = [moveState.fromLocationId, moveState.toLocationId].sort().join('::');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function buildRecentMoveGlowByEdge(
  glows: Record<string, RecentMoveGlow>,
  frameNow: number,
  tickDurationMs: number,
) {
  const counts = new Map<string, number>();
  for (const glow of Object.values(glows)) {
    const elapsed = Math.max(0, frameNow - glow.startedAt);
    const remaining = Math.max(0, 1 - elapsed / Math.max(1, tickDurationMs));
    if (remaining <= 0) continue;
    counts.set(glow.edgeKey, Math.max(counts.get(glow.edgeKey) ?? 0, remaining));
  }
  return counts;
}

function buildAgentPlacements(
  snapshot: RocklawLiveSnapshot,
  locationById: Map<string, RocklawLocationNode>,
  frameNow: number,
  tickObservedAt: number,
): AgentPlacement[] {
  const sceneMembersByLocation = new Map<string, string[]>();
  for (const scene of snapshot.liveScenes) {
    const members = sceneMembersByLocation.get(scene.location) ?? [];
    members.push(scene.left, scene.right);
    sceneMembersByLocation.set(scene.location, members);
  }

  return snapshot.agents.map((agent) => {
    const location = locationById.get(agent.locationId) ?? snapshot.locations[0];
    const sceneMembers = new Set(sceneMembersByLocation.get(location.id) ?? []);
    const colocated = snapshot.agents
      .filter((entry) => entry.locationId === location.id && !sceneMembers.has(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    let basePoint = location.center;
    let facing: Facing = 'down';
    if (sceneMembers.has(agent.name)) {
      const scene = snapshot.liveScenes.find(
        (entry) => entry.location === location.id && (entry.left === agent.name || entry.right === agent.name),
      );
      const sceneIndex = scene ? (scene.left === agent.name ? 0 : 1) : 0;
      basePoint = getGraphSceneSlot(location, sceneIndex);
      facing = sceneIndex === 0 ? 'right' : 'left';
    } else {
      const slotIndex = Math.max(0, colocated.indexOf(agent.name));
      basePoint = getGraphStandingSlot(location, slotIndex);
    }

    return {
      agent,
      point: interpolatePoint(agent, basePoint, locationById, snapshot, frameNow, tickObservedAt),
      location,
      facing: deriveFacing(agent, facing, locationById),
      moving: Boolean(agent.moveState),
    };
  });
}

function getGraphStandingSlot(location: RocklawLocationNode, slotIndex: number) {
  const offsets = [
    { x: -0.56, y: 0.02 },
    { x: -0.28, y: 0.02 },
    { x: 0, y: 0.02 },
    { x: 0.28, y: 0.02 },
    { x: 0.56, y: 0.02 },
  ];
  const offset = offsets[slotIndex % offsets.length] ?? offsets[0];
  return {
    x: location.center.x + offset.x,
    y: location.center.y + offset.y,
  };
}

function getGraphSceneSlot(location: RocklawLocationNode, slotIndex: number) {
  const offsets = [
    { x: -0.34, y: 0.02 },
    { x: 0.34, y: 0.02 },
    { x: 0, y: 0.18 },
  ];
  const offset = offsets[slotIndex % offsets.length] ?? offsets[0];
  return {
    x: location.center.x + offset.x,
    y: location.center.y + offset.y,
  };
}

function interpolatePoint(
  agent: RocklawAgentVisualState,
  basePoint: { x: number; y: number },
  locationById: Map<string, RocklawLocationNode>,
  snapshot: RocklawLiveSnapshot,
  frameNow: number,
  tickObservedAt: number,
) {
  if (!agent.moveState) return basePoint;
  const from = locationById.get(agent.moveState.fromLocationId);
  const to = locationById.get(agent.moveState.toLocationId);
  if (!from || !to) return basePoint;

  const totalTicks = Math.max(1, agent.moveState.endsTick - agent.moveState.startedTick);
  const completedTicksAtSnapshot = Math.max(0, Math.min(totalTicks, snapshot.tick - agent.moveState.startedTick));
  const elapsedMs = Math.max(0, frameNow - tickObservedAt);
  const interpolatedTicks = completedTicksAtSnapshot + elapsedMs / snapshot.tickIntervalMs;
  const progress = Math.max(0, Math.min(1, interpolatedTicks / totalTicks));

  return {
    x: from.center.x + (to.center.x - from.center.x) * progress,
    y: from.center.y + (to.center.y - from.center.y) * progress,
  };
}

function deriveFacing(
  agent: RocklawAgentVisualState,
  fallback: Facing,
  locationById: Map<string, RocklawLocationNode>,
): Facing {
  if (!agent.moveState) return fallback;
  const from = locationById.get(agent.moveState.fromLocationId);
  const to = locationById.get(agent.moveState.toLocationId);
  if (!from || !to) return fallback;
  const dx = to.center.x - from.center.x;
  const dy = to.center.y - from.center.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'down' : 'up';
}

function describeAction(action: RocklawLiveActionState) {
  const icon = ROCKLAW_ACTION_ICONS[action.action] ?? action.action;
  const subject = action.target ?? action.location ?? action.message ?? action.action;
  return `${icon} ${trimLabel(subject)}`;
}

function deriveStatusLabel(agent: RocklawAgentVisualState) {
  if (agent.scenePartner) return 'in scene';
  if (agent.busy) return 'busy';
  return 'idle';
}

function matchesLocationAction(action: RocklawLiveActionState, location: RocklawLocationNode) {
  if (action.location === location.id) return true;
  if (action.location?.toLowerCase() === location.label.toLowerCase()) return true;
  if (action.target?.toLowerCase() === location.label.toLowerCase()) return true;
  return false;
}

function buildNodeCaption(summary: NodeSummary) {
  const parts: string[] = [];
  parts.push(`${summary.agentCount} here`);
  if (summary.liveSceneCount > 0) parts.push(`${summary.liveSceneCount} live`);
  if (summary.busyCount > 0) parts.push(`${summary.busyCount} busy`);
  if (summary.movingInCount > 0) parts.push(`${summary.movingInCount} moving`);
  return parts.join(' · ');
}

function buildCompactNodeMeta(summary: NodeSummary) {
  const lines: string[] = [];
  if (summary.agentDetails[0]) {
    const detail = summary.agentDetails[0];
    lines.push(detail.name);
    lines.push(`${detail.status} · ${trimLabel(detail.action)}`);
  }
  if (summary.agentDetails.length > 1) {
    lines.push(`+${summary.agentDetails.length - 1} more here`);
  }
  if (summary.recentActivity[0]?.trim()) {
    lines.push(`Last: ${summary.recentActivity[0]}`);
  }
  return lines.slice(0, 3).join('\n');
}

function trimLabel(value: string | null) {
  if (!value) return '';
  return value.length > 48 ? `${value.slice(0, 45)}...` : value;
}

function getInitials(name: string) {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function toPx(value: number) {
  return value * TILE_DIM;
}

function getTimePalette(timeOfDay: string) {
  switch (timeOfDay) {
    case 'morning':
      return { tint: 0xfde68a, alpha: 0.08 };
    case 'afternoon':
      return { tint: 0xffffff, alpha: 0.02 };
    case 'evening':
      return { tint: 0xfb923c, alpha: 0.1 };
    case 'night':
      return { tint: 0x1e293b, alpha: 0.22 };
    default:
      return { tint: 0xffffff, alpha: 0.04 };
  }
}

const LIVE_FRAME_STYLE: React.CSSProperties = {
  display: 'grid',
  gridTemplateRows: 'auto 1fr',
  minHeight: 620,
  height: 'calc(100vh - 220px)',
  background: '#111827',
  border: '1px solid #334155',
  borderRadius: 10,
  overflow: 'hidden',
};

const LIVE_FRAME_HEADER_STYLE: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 16,
  padding: '12px 14px',
  borderBottom: '1px solid #1f2937',
  background: '#0f172a',
};

const HEADER_TITLE_GROUP_STYLE: React.CSSProperties = {
  display: 'grid',
  gap: 10,
};

const HEADER_LABEL_STYLE: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: '#f9fafb',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
};

const HEADER_NOTE_STYLE: React.CSSProperties = {
  fontSize: 12,
  color: '#9ca3af',
};

const HEADER_SUMMARY_STYLE: React.CSSProperties = {
  fontSize: 11,
  color: '#94a3b8',
};

const HEADER_TOGGLES_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
};

const HEADER_CHIPS_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
};

const HEADER_CHIP_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '6px 10px',
  borderRadius: 8,
  background: '#111827',
  border: '1px solid #1f2937',
  minWidth: 76,
};

const TOGGLE_CHIP_STYLE: React.CSSProperties = {
  appearance: 'none',
  borderRadius: 999,
  padding: '6px 10px',
  fontSize: 12,
  fontWeight: 700,
  border: '1px solid #334155',
  cursor: 'pointer',
  transition: 'background 120ms ease, border-color 120ms ease, color 120ms ease',
};

const TOGGLE_CHIP_ACTIVE_STYLE: React.CSSProperties = {
  background: '#132236',
  borderColor: '#38bdf8',
  color: '#e0f2fe',
};

const TOGGLE_CHIP_INACTIVE_STYLE: React.CSSProperties = {
  background: '#111827',
  borderColor: '#1f2937',
  color: '#94a3b8',
};

const HEADER_CHIP_LABEL_STYLE: React.CSSProperties = {
  color: '#94a3b8',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
};

const HEADER_CHIP_VALUE_STYLE: React.CSSProperties = {
  color: '#f8fafc',
  fontSize: 13,
  fontWeight: 700,
};

const LIVE_CONTENT_STYLE: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: `minmax(0, 1fr) ${PANEL_WIDTH}px`,
  minHeight: 0,
};

const LIVE_GRAPH_STYLE: React.CSSProperties = {
  position: 'relative',
  overflow: 'hidden',
  minHeight: 0,
  background: '#0b1120',
  borderRight: '1px solid #1f2937',
};

const LEGEND_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  left: 12,
  zIndex: 2,
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  padding: '8px 10px',
  borderRadius: 10,
  background: 'rgba(15, 23, 42, 0.82)',
  border: '1px solid #1f2937',
  color: '#cbd5e1',
  fontSize: 11,
  backdropFilter: 'blur(8px)',
};

const LEGEND_ITEM_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

const LEGEND_SWATCH_STYLE: React.CSSProperties = {
  display: 'inline-block',
  width: 10,
  height: 10,
  borderRadius: 999,
};

const LIVE_PANEL_STYLE: React.CSSProperties = {
  overflow: 'auto',
  background: '#0f172a',
};

const PANEL_STYLE: React.CSSProperties = {
  padding: 16,
  display: 'grid',
  gap: 18,
};

const PANEL_PLACEHOLDER_STYLE: React.CSSProperties = {
  padding: 16,
  display: 'grid',
  gap: 16,
};

const PANEL_PLACEHOLDER_TEXT_STYLE: React.CSSProperties = {
  color: '#cbd5e1',
  fontSize: 14,
  lineHeight: 1.5,
};

const PANEL_SECTION_STYLE: React.CSSProperties = {
  display: 'grid',
  gap: 10,
};

const PANEL_KICKER_STYLE: React.CSSProperties = {
  color: '#94a3b8',
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
};

const PANEL_TITLE_STYLE: React.CSSProperties = {
  color: '#f8fafc',
  fontSize: 22,
  fontWeight: 800,
  lineHeight: 1.1,
};

const PANEL_META_STYLE: React.CSSProperties = {
  color: '#cbd5e1',
  fontSize: 13,
};

const PANEL_SECTION_TITLE_STYLE: React.CSSProperties = {
  color: '#f8fafc',
  fontSize: 13,
  fontWeight: 800,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
};

const PANEL_LIST_STYLE: React.CSSProperties = {
  display: 'grid',
  gap: 10,
};

const PANEL_CARD_STYLE: React.CSSProperties = {
  padding: 12,
  borderRadius: 12,
  border: '1px solid #334155',
  background: '#111827',
  display: 'grid',
  gap: 8,
};

const PANEL_CARD_TITLE_STYLE: React.CSSProperties = {
  color: '#f8fafc',
  fontSize: 14,
  fontWeight: 700,
};

const PANEL_CARD_SUBTITLE_STYLE: React.CSSProperties = {
  color: '#94a3b8',
  fontSize: 12,
};

const PANEL_CARD_BODY_STYLE: React.CSSProperties = {
  color: '#cbd5e1',
  fontSize: 12,
  lineHeight: 1.45,
};

const PANEL_BADGE_STYLE: React.CSSProperties = {
  padding: '4px 8px',
  borderRadius: 999,
  background: '#1e293b',
  border: '1px solid #334155',
  color: '#e2e8f0',
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
};

const PANEL_STATS_STYLE: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
  color: '#cbd5e1',
  fontSize: 12,
};

const PANEL_MESSAGE_STYLE: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
};

const PANEL_EMPTY_STYLE: React.CSSProperties = {
  color: '#94a3b8',
  fontSize: 12,
};
