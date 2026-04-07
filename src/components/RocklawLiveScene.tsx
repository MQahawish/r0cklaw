import { Container, Graphics, Sprite, Text, useApp } from '@pixi/react';
import * as PIXI from 'pixi.js';
import { useEffect, useMemo, useState } from 'react';
import { useElementSize } from 'usehooks-ts';
import { Stage } from '@pixi/react';
import PixiViewport from './PixiViewport.tsx';
import {
  RocklawAgentVisualState,
  RocklawLiveActionState,
  RocklawLiveSceneEntry,
  RocklawLiveSnapshot,
  RocklawLocationNode,
  ROCKLAW_ACTION_ICONS,
  ROCKLAW_AGENT_COLORS,
} from '../../convex/rocklaw/liveScene';
import exteriorsUrl from '../assets/rocklaw-live/exteriors/Modern_Exteriors_Complete_Tileset_32x32.png';
import interiorsUrl from '../assets/rocklaw-live/interiors/Room_Builder_32x32.png';
import officeUrl from '../assets/rocklaw-live/office/Room_Builder_Office_32x32.png';
import uiStyle1Url from '../assets/rocklaw-live/ui/Modern_UI_Style_1.png';
import uiStyle2Url from '../assets/rocklaw-live/ui/Modern_UI_Style_2.png';
import homeLayer1Url from '../assets/rocklaw-live/home/Generic_Home_1_Layer_1_32x32.png';
import homeLayer2Url from '../assets/rocklaw-live/home/Generic_Home_1_Layer_2_32x32.png';
import homePreviewUrl from '../assets/rocklaw-live/home/Generic_Home_1_preview_32x32.png';

const TILE_DIM = 44;
const WORLD_MARGIN = 120;

type AgentPlacement = {
  agent: RocklawAgentVisualState;
  point: { x: number; y: number };
  location: RocklawLocationNode;
};

export default function RocklawLiveScene({ snapshot }: { snapshot: RocklawLiveSnapshot }) {
  const [wrapperRef, { width, height }] = useElementSize();
  const [frameNow, setFrameNow] = useState(() => Date.now());
  const [tickObservedAt, setTickObservedAt] = useState(() => Date.now());
  const [observedTick, setObservedTick] = useState(snapshot.tick);
  const [focusedLocationId, setFocusedLocationId] = useState<string | null>(null);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setFrameNow(Date.now());
    }, 100);
    return () => {
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (snapshot.tick !== observedTick) {
      setObservedTick(snapshot.tick);
      setTickObservedAt(Date.now());
    }
  }, [observedTick, snapshot.tick]);

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
  const focusedLocation = focusedLocationId ? locationById.get(focusedLocationId) ?? null : null;

  const activeChats = snapshot.liveScenes.length;
  const busyAgents = snapshot.agents.filter((agent) => agent.busy).length;

  return (
    <div style={LIVE_FRAME_STYLE}>
      <div style={LIVE_FRAME_HEADER_STYLE}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={HEADER_LABEL_STYLE}>Live Simulation</span>
          <span style={HEADER_NOTE_STYLE}>
            {focusedLocation
              ? `Focused on ${focusedLocation.label}. Use Back To Map to return to the town graph.`
              : 'Rocklaw-native scene. Drag to pan, scroll to zoom, and click a location to inspect it full-screen.'}
          </span>
        </div>
        <div style={HEADER_CHIPS_STYLE}>
          {focusedLocation ? (
            <button style={BACK_BUTTON_STYLE} onClick={() => setFocusedLocationId(null)}>
              Back To Map
            </button>
          ) : null}
          <HeaderChip label="Tick" value={`${snapshot.day}.${snapshot.tick}`} />
          <HeaderChip label="Time" value={snapshot.timeOfDay} />
          <HeaderChip label="Busy" value={String(busyAgents)} />
          <HeaderChip label="Live scenes" value={String(activeChats)} />
        </div>
      </div>
      <div style={LIVE_STAGE_WRAPPER_STYLE} ref={wrapperRef}>
        {focusedLocation ? (
          <FocusedLocationView
            location={focusedLocation}
            placements={placements.filter((placement) => placement.location.id === focusedLocation.id)}
            liveScenes={snapshot.liveScenes.filter((scene) => scene.location === focusedLocation.id)}
          />
        ) : width > 0 && height > 0 ? (
          <div style={{ position: 'absolute', inset: 0 }}>
            <Stage width={width} height={height} options={{ backgroundColor: 0x0f172a, antialias: true }}>
              <RocklawLiveCanvas
                snapshot={snapshot}
                placements={placements}
                width={width}
                height={height}
                worldWidth={worldWidth}
                worldHeight={worldHeight}
                onSelectLocation={setFocusedLocationId}
              />
            </Stage>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RocklawLiveCanvas({
  snapshot,
  placements,
  width,
  height,
  worldWidth,
  worldHeight,
  onSelectLocation,
}: {
  snapshot: RocklawLiveSnapshot;
  placements: AgentPlacement[];
  width: number;
  height: number;
  worldWidth: number;
  worldHeight: number;
  onSelectLocation: (locationId: string) => void;
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
      <Backdrop worldWidth={worldWidth} worldHeight={worldHeight} />
      <RoadNetwork locations={snapshot.locations} />
      {snapshot.locations.map((location) => (
        <PlaceNode
          key={location.id}
          location={location}
          isActive={snapshot.liveScenes.some((scene) => scene.location === location.id)}
          onSelect={onSelectLocation}
        />
      ))}
      {snapshot.liveScenes.map((scene) => (
        <SceneLink key={scene.sceneId} scene={scene} locations={snapshot.locations} />
      ))}
      {placements.map((placement) => (
        <AgentMarker key={placement.agent.name} placement={placement} />
      ))}
    </PixiViewport>
  );
}

function Backdrop({ worldWidth, worldHeight }: { worldWidth: number; worldHeight: number }) {
  const texture = useMemo(() => PIXI.Texture.from(exteriorsUrl), []);
  return (
    <Container>
      <Graphics
        draw={(g) => {
          g.clear();
          g.beginFill(0x132235, 1);
          g.drawRect(0, 0, worldWidth, worldHeight);
          g.endFill();

          g.beginFill(0x17304a, 1);
          g.drawRoundedRect(36, 36, worldWidth - 72, worldHeight - 72, 28);
          g.endFill();

          g.lineStyle(1, 0x2d4966, 0.16);
          for (let x = 0; x < worldWidth; x += TILE_DIM) {
            g.moveTo(x, 0);
            g.lineTo(x, worldHeight);
          }
          for (let y = 0; y < worldHeight; y += TILE_DIM) {
            g.moveTo(0, y);
            g.lineTo(worldWidth, y);
          }
        }}
      />
      <Sprite texture={texture} x={60} y={44} width={worldWidth - 120} height={worldHeight - 88} alpha={0.08} tint={0x9fb9d1} />
    </Container>
  );
}

function RoadNetwork({ locations }: { locations: RocklawLocationNode[] }) {
  const edges = useMemo(() => {
    const seen = new Set<string>();
    const pairs: Array<{ a: RocklawLocationNode; b: RocklawLocationNode }> = [];
    const byId = new Map(locations.map((location) => [location.id, location]));
    for (const location of locations) {
      for (const neighborId of location.neighbors) {
        const neighbor = byId.get(neighborId);
        if (!neighbor) continue;
        const key = [location.id, neighbor.id].sort().join('::');
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({ a: location, b: neighbor });
      }
    }
    return pairs;
  }, [locations]);

  return (
    <Container>
      {edges.map((edge) => (
        <RoadEdge key={`${edge.a.id}-${edge.b.id}`} from={edge.a.center} to={edge.b.center} />
      ))}
    </Container>
  );
}

function RoadEdge({ from, to }: { from: { x: number; y: number }; to: { x: number; y: number } }) {
  const draw = (g: PIXI.Graphics) => {
    g.clear();
    g.lineStyle(18, 0x24384f, 0.9);
    g.moveTo(toPx(from.x), toPx(from.y));
    g.lineTo(toPx(to.x), toPx(to.y));
    g.lineStyle(4, 0xbfd6e8, 0.25);
    g.moveTo(toPx(from.x), toPx(from.y));
    g.lineTo(toPx(to.x), toPx(to.y));
  };
  return <Graphics draw={draw} />;
}

function PlaceNode({
  location,
  isActive,
  onSelect,
}: {
  location: RocklawLocationNode;
  isActive: boolean;
  onSelect: (locationId: string) => void;
}) {
  const art = getPlaceArt(location.spriteKey);
  const hitArea = new PIXI.Rectangle(
    location.region.x * TILE_DIM,
    location.region.y * TILE_DIM,
    location.region.width * TILE_DIM,
    location.region.height * TILE_DIM,
  );
  const draw = (g: PIXI.Graphics) => {
    const left = location.region.x * TILE_DIM;
    const top = location.region.y * TILE_DIM;
    const width = location.region.width * TILE_DIM;
    const height = location.region.height * TILE_DIM;

    g.clear();
    g.lineStyle(2, isActive ? 0xf8e6a8 : 0xffffff, isActive ? 0.35 : 0.14);
    g.beginFill(location.color, isActive ? 0.18 : 0.12);
    g.drawRoundedRect(left, top, width, height, 18);
    g.endFill();

    g.beginFill(lightenColor(location.color, 0.18), 0.95);
    g.drawRoundedRect(left + 18, top + 22, width - 36, height - 34, 12);
    g.endFill();

    g.beginFill(lightenColor(location.color, 0.3), 0.9);
    g.moveTo(left + 12, top + 34);
    g.lineTo(left + width / 2, top + 10);
    g.lineTo(left + width - 12, top + 34);
    g.lineTo(left + width - 18, top + 38);
    g.lineTo(left + 18, top + 38);
    g.endFill();

    g.beginFill(0x0f172a, 0.15);
    g.drawRoundedRect(left + width * 0.4, top + height * 0.45, width * 0.2, height * 0.28, 8);
    g.endFill();
  };

  return (
    <Container
      interactive
      cursor="pointer"
      pointertap={() => onSelect(location.id)}
      hitArea={hitArea}
    >
      <Graphics draw={draw} />
      {art.layers.map((layer, index) => (
        <Sprite
          key={`${location.id}-art-${index}`}
          texture={layer.texture}
          x={location.region.x * TILE_DIM + 14 + layer.offsetX}
          y={location.region.y * TILE_DIM + 18 + layer.offsetY}
          width={location.region.width * TILE_DIM - 28}
          height={location.region.height * TILE_DIM - 32}
          alpha={layer.alpha}
          tint={layer.tint}
        />
      ))}
      <Text
        x={toPx(location.center.x + location.labelOffset.x)}
        y={toPx(location.center.y + location.labelOffset.y)}
        anchor={{ x: 0.5, y: 0.5 }}
        text={location.label}
        style={
          new PIXI.TextStyle({
            fill: isActive ? '#fff7d0' : '#f8fafc',
            fontSize: 14,
            fontWeight: '700',
            letterSpacing: 0.7,
            stroke: '#0b1120',
            strokeThickness: 4,
          })
        }
      />
      <Text
        x={toPx(location.center.x)}
        y={toPx(location.center.y) + 6}
        anchor={{ x: 0.5, y: 0.5 }}
        text={location.type}
        style={
          new PIXI.TextStyle({
            fill: '#cbd5e1',
            fontSize: 10,
            fontStyle: 'italic',
            stroke: '#0b1120',
            strokeThickness: 3,
          })
        }
      />
    </Container>
  );
}

function FocusedLocationView({
  location,
  placements,
  liveScenes,
}: {
  location: RocklawLocationNode;
  placements: AgentPlacement[];
  liveScenes: RocklawLiveSceneEntry[];
}) {
  const artSources = getPlaceArtSources(location.spriteKey);
  const primaryScene = liveScenes[0] ?? null;
  return (
    <div style={FOCUSED_VIEW_STYLE}>
      <div style={FOCUSED_HERO_STYLE}>
        <div style={FOCUSED_ART_STACK_STYLE}>
          {artSources.map((layer, index) => (
            <img
              key={`${location.id}-focus-art-${index}`}
              src={layer.url}
              alt={location.label}
              style={{
                ...FOCUSED_ART_LAYER_STYLE,
                opacity: layer.alpha,
                filter: layer.tint ? `drop-shadow(0 0 10px rgba(15, 23, 42, 0.45))` : undefined,
                transform: `translate(${layer.offsetX}px, ${layer.offsetY}px)`,
              }}
            />
          ))}
        </div>
        <div style={FOCUSED_HERO_COPY_STYLE}>
          <div style={FOCUSED_LOCATION_KICKER_STYLE}>{location.type}</div>
          <div style={FOCUSED_LOCATION_TITLE_STYLE}>{location.label}</div>
          <div style={FOCUSED_LOCATION_META_STYLE}>
            {placements.length} agent{placements.length === 1 ? '' : 's'} present
            {primaryScene ? ` · live scene between ${primaryScene.left} and ${primaryScene.right}` : ''}
          </div>
        </div>
      </div>
      <div style={FOCUSED_GRID_STYLE}>
        <div style={FOCUSED_PANEL_STYLE}>
          <div style={FOCUSED_PANEL_TITLE_STYLE}>Agents Here</div>
          {placements.length === 0 ? (
            <div style={FOCUSED_EMPTY_STYLE}>No agents here right now.</div>
          ) : (
            <div style={FOCUSED_AGENT_LIST_STYLE}>
              {placements.map((placement) => (
                <div key={placement.agent.name} style={FOCUSED_AGENT_CARD_STYLE}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <div>
                      <div style={{ color: '#f8fafc', fontSize: 14, fontWeight: 700 }}>{placement.agent.name}</div>
                      <div style={{ color: '#94a3b8', fontSize: 12 }}>{placement.agent.role}</div>
                    </div>
                    <div style={{ color: '#cbd5e1', fontSize: 12, textAlign: 'right' }}>
                      {placement.agent.currentAction ? describeAction(placement.agent.currentAction) : placement.agent.busyLabel ?? 'idle'}
                    </div>
                  </div>
                  <div style={FOCUSED_AGENT_STATS_STYLE}>
                    <span>E {Math.round(placement.agent.energy)}</span>
                    <span>H {Math.round(placement.agent.health)}</span>
                    <span>U {Math.round(placement.agent.hunger)}</span>
                    <span>{placement.agent.coin}c</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={FOCUSED_PANEL_STYLE}>
          <div style={FOCUSED_PANEL_TITLE_STYLE}>Live Activity</div>
          {liveScenes.length === 0 ? (
            <div style={FOCUSED_EMPTY_STYLE}>No live scene in this location.</div>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {liveScenes.map((scene) => (
                <div key={scene.sceneId} style={FOCUSED_SCENE_CARD_STYLE}>
                  <div style={{ color: '#fef3c7', fontSize: 13, fontWeight: 700 }}>
                    {scene.left} and {scene.right}
                  </div>
                  <div style={{ color: '#94a3b8', fontSize: 12 }}>Next speaker: {scene.nextSpeaker}</div>
                  {scene.recentMessages.length > 0 ? (
                    <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                      {scene.recentMessages.map((message, index) => (
                        <div key={`${scene.sceneId}-msg-${index}`} style={FOCUSED_MESSAGE_STYLE}>
                          <span style={{ color: '#e2e8f0', fontWeight: 700 }}>{message.fromAgent}:</span>{' '}
                          <span style={{ color: '#cbd5e1' }}>{message.text}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={FOCUSED_EMPTY_STYLE}>No recent messages.</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SceneLink({
  scene,
  locations,
}: {
  scene: RocklawLiveSceneEntry;
  locations: RocklawLocationNode[];
}) {
  const location = locations.find((entry) => entry.id === scene.location);
  if (!location) return null;
  const [left, right] = location.sceneSlots;
  if (!left || !right) return null;

  const draw = (g: PIXI.Graphics) => {
    g.clear();
    g.lineStyle(3, 0xf8e6a8, 0.9);
    g.moveTo(toPx(left.x), toPx(left.y));
    g.lineTo(toPx(right.x), toPx(right.y));
  };

  return <Graphics draw={draw} />;
}

function AgentMarker({ placement }: { placement: AgentPlacement }) {
  const { agent, point, location } = placement;
  const color = ROCKLAW_AGENT_COLORS[agent.name] ?? location.color;
  const actionLabel = agent.currentAction ? describeAction(agent.currentAction) : null;
  const bubbleText = actionLabel ?? agent.busyLabel;

  const draw = (g: PIXI.Graphics) => {
    g.clear();
    g.beginFill(0x08101d, 0.25);
    g.drawEllipse(toPx(point.x), toPx(point.y) + 18, 18, 8);
    g.endFill();

    g.lineStyle(2, 0xf8fafc, 0.7);
    g.beginFill(color, 0.95);
    g.drawCircle(toPx(point.x), toPx(point.y), 14);
    g.endFill();

    if (agent.scenePartner) {
      g.lineStyle(3, 0xfacc15, 0.95);
      g.drawCircle(toPx(point.x), toPx(point.y), 18);
    } else if (agent.busy) {
      g.lineStyle(2, 0xa78bfa, 0.85);
      g.drawCircle(toPx(point.x), toPx(point.y), 18);
    }
  };

  return (
    <Container>
      <Graphics draw={draw} />
      <Text
        x={toPx(point.x)}
        y={toPx(point.y)}
        anchor={{ x: 0.5, y: 0.5 }}
        text={getInitials(agent.name)}
        style={
          new PIXI.TextStyle({
            fill: '#f8fafc',
            fontSize: 10,
            fontWeight: '700',
          })
        }
      />
      <Text
        x={toPx(point.x)}
        y={toPx(point.y) + 26}
        anchor={{ x: 0.5, y: 0.5 }}
        text={agent.name}
        style={
          new PIXI.TextStyle({
            fill: '#e2e8f0',
            fontSize: 11,
            stroke: '#0b1120',
            strokeThickness: 3,
          })
        }
      />
      {bubbleText ? (
        <ActionBubble x={toPx(point.x)} y={toPx(point.y) - 40} text={bubbleText} tone={agent.currentAction?.action === 'move' ? 'move' : agent.scenePartner ? 'chat' : 'busy'} />
      ) : null}
      <StatusPips x={toPx(point.x)} y={toPx(point.y) + 38} agent={agent} />
    </Container>
  );
}

function ActionBubble({
  x,
  y,
  text,
  tone,
}: {
  x: number;
  y: number;
  text: string;
  tone: 'move' | 'chat' | 'busy';
}) {
  const bubbleWidth = Math.max(72, Math.min(220, text.length * 6.5 + 24));
  const bubbleColor = tone === 'chat' ? 0x1d4ed8 : tone === 'move' ? 0x0369a1 : 0x5b21b6;

  const draw = (g: PIXI.Graphics) => {
    g.clear();
    g.lineStyle(1.5, 0xf8fafc, 0.45);
    g.beginFill(bubbleColor, 0.88);
    g.drawRoundedRect(x - bubbleWidth / 2, y - 16, bubbleWidth, 24, 10);
    g.endFill();
    g.beginFill(bubbleColor, 0.88);
    g.moveTo(x - 8, y + 8);
    g.lineTo(x, y + 18);
    g.lineTo(x + 8, y + 8);
    g.endFill();
  };

  return (
    <Container>
      <Graphics draw={draw} />
      <Text
        x={x}
        y={y - 4}
        anchor={{ x: 0.5, y: 0.5 }}
        text={text}
        style={
          new PIXI.TextStyle({
            fill: '#eff6ff',
            fontSize: 11,
            fontWeight: '600',
            wordWrap: false,
          })
        }
      />
    </Container>
  );
}

function StatusPips({ x, y, agent }: { x: number; y: number; agent: RocklawAgentVisualState }) {
  const pips = [
    {
      label: `E${Math.round(agent.energy)}`,
      color: agent.energy < 30 ? 0xef4444 : 0x22c55e,
    },
    {
      label: `H${Math.round(agent.health)}`,
      color: agent.health < 45 ? 0xef4444 : 0x38bdf8,
    },
    {
      label: `U${Math.round(agent.hunger)}`,
      color: agent.hunger > 70 ? 0xf97316 : 0xfacc15,
    },
  ];

  return (
    <Container>
      {pips.map((pip, index) => (
        <Container key={pip.label} x={x - 30 + index * 30} y={y}>
          <Graphics
            draw={(g) => {
              g.clear();
              g.beginFill(0x0b1120, 0.7);
              g.drawRoundedRect(-12, -8, 24, 16, 6);
              g.endFill();
              g.lineStyle(1, pip.color, 0.7);
              g.drawRoundedRect(-12, -8, 24, 16, 6);
            }}
          />
          <Text
            anchor={{ x: 0.5, y: 0.5 }}
            text={pip.label}
            style={
              new PIXI.TextStyle({
                fill: '#e2e8f0',
                fontSize: 8,
                fontWeight: '700',
              })
            }
          />
        </Container>
      ))}
    </Container>
  );
}

function HeaderChip({ label, value }: { label: string; value: string }) {
  return (
    <div style={HEADER_CHIP_STYLE}>
      <span style={{ color: '#94a3b8', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</span>
      <span style={{ color: '#f8fafc', fontSize: 13, fontWeight: 700 }}>{value}</span>
    </div>
  );
}

function buildAgentPlacements(
  snapshot: RocklawLiveSnapshot,
  locationById: Map<string, RocklawLocationNode>,
  frameNow: number,
  tickObservedAt: number,
): AgentPlacement[] {
  const sceneMembersByLocation = new Map<string, string[]>();
  for (const scene of snapshot.liveScenes) {
    const existing = sceneMembersByLocation.get(scene.location) ?? [];
    existing.push(scene.left, scene.right);
    sceneMembersByLocation.set(scene.location, existing);
  }

  return snapshot.agents.map((agent) => {
    const location = locationById.get(agent.locationId) ?? snapshot.locations[0];
    const sceneMembers = new Set(sceneMembersByLocation.get(location.id) ?? []);
    const colocated = snapshot.agents
      .filter((entry) => entry.locationId === location.id && !sceneMembers.has(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    let basePoint = location.center;
    if (sceneMembers.has(agent.name)) {
      const scene = snapshot.liveScenes.find(
        (entry) => entry.location === location.id && (entry.left === agent.name || entry.right === agent.name),
      );
      const sceneIndex = scene ? (scene.left === agent.name ? 0 : 1) : 0;
      basePoint = location.sceneSlots[sceneIndex] ?? location.center;
    } else {
      const slotIndex = Math.max(0, colocated.indexOf(agent.name));
      basePoint = location.standingSlots[slotIndex % location.standingSlots.length] ?? location.center;
    }

    const point = interpolatePoint(agent, basePoint, locationById, snapshot, frameNow, tickObservedAt);
    return { agent, point, location };
  });
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

function describeAction(action: RocklawLiveActionState) {
  const icon = ROCKLAW_ACTION_ICONS[action.action] ?? action.action;
  const subject = action.target ?? action.location ?? action.message ?? action.action;
  return `${icon} ${trimLabel(subject)}`;
}

function trimLabel(value: string | null) {
  if (!value) return '';
  return value.length > 26 ? `${value.slice(0, 23)}...` : value;
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

function lightenColor(color: number, amount: number) {
  const r = Math.min(255, ((color >> 16) & 0xff) + 255 * amount);
  const g = Math.min(255, ((color >> 8) & 0xff) + 255 * amount);
  const b = Math.min(255, (color & 0xff) + 255 * amount);
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

type PlaceArtLayer = {
  url: string;
  texture: PIXI.Texture;
  alpha: number;
  tint?: number;
  offsetX: number;
  offsetY: number;
};

function getPlaceArt(spriteKey: string): { layers: PlaceArtLayer[] } {
  return {
    layers: getPlaceArtSources(spriteKey).map((layer) => ({
      ...layer,
      texture: PIXI.Texture.from(layer.url),
    })),
  };
}

function getPlaceArtSources(spriteKey: string): Array<Omit<PlaceArtLayer, 'texture'>> {
  const make = (url: string, alpha: number, tint?: number, offsetX = 0, offsetY = 0) => ({
    url,
    alpha,
    tint,
    offsetX,
    offsetY,
  });

  switch (spriteKey) {
    case 'forge':
      return [make(officeUrl, 0.42, 0xffd699)];
    case 'market':
      return [make(exteriorsUrl, 0.28, 0xffefb0)];
    case 'inn':
      return [make(homePreviewUrl, 0.92), make(homeLayer2Url, 0.28, 0xfff4d0, 0, -4)];
    case 'farm':
      return [make(homeLayer1Url, 0.68, 0xd9f99d), make(homeLayer2Url, 0.34, 0xbbf7d0)];
    case 'shrine':
      return [make(uiStyle1Url, 0.18, 0xd8b4fe)];
    case 'gate':
      return [make(exteriorsUrl, 0.24, 0xdbeafe)];
    case 'square':
      return [make(uiStyle2Url, 0.18, 0xfef3c7)];
    case 'mine':
      return [make(exteriorsUrl, 0.22, 0xd1d5db)];
    case 'bakery':
      return [make(interiorsUrl, 0.24, 0xfdba74)];
    case 'warehouse':
      return [make(officeUrl, 0.28, 0xbfdbfe)];
    default:
      return [make(exteriorsUrl, 0.16, 0xe2e8f0)];
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
  alignItems: 'center',
  gap: 16,
  padding: '12px 14px',
  borderBottom: '1px solid #1f2937',
  background: '#0f172a',
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

const HEADER_CHIPS_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
};

const BACK_BUTTON_STYLE: React.CSSProperties = {
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid #334155',
  background: '#111827',
  color: '#f8fafc',
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
};

const HEADER_CHIP_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '6px 10px',
  borderRadius: 8,
  background: '#111827',
  border: '1px solid #1f2937',
  minWidth: 66,
};

const LIVE_STAGE_WRAPPER_STYLE: React.CSSProperties = {
  position: 'relative',
  overflow: 'hidden',
  background: '#0b1120',
  minHeight: 0,
};

const FOCUSED_VIEW_STYLE: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  overflow: 'auto',
  background: 'linear-gradient(180deg, #0b1120 0%, #111827 100%)',
  padding: 20,
  display: 'grid',
  gap: 18,
};

const FOCUSED_HERO_STYLE: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(280px, 420px) 1fr',
  gap: 20,
  alignItems: 'stretch',
};

const FOCUSED_ART_STACK_STYLE: React.CSSProperties = {
  position: 'relative',
  minHeight: 260,
  borderRadius: 16,
  overflow: 'hidden',
  border: '1px solid #334155',
  background: 'radial-gradient(circle at top, #1e293b 0%, #0f172a 70%)',
};

const FOCUSED_ART_LAYER_STYLE: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'contain',
};

const FOCUSED_HERO_COPY_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  gap: 8,
  padding: '12px 8px',
};

const FOCUSED_LOCATION_KICKER_STYLE: React.CSSProperties = {
  color: '#94a3b8',
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
};

const FOCUSED_LOCATION_TITLE_STYLE: React.CSSProperties = {
  color: '#f8fafc',
  fontSize: 36,
  fontWeight: 800,
  lineHeight: 1,
};

const FOCUSED_LOCATION_META_STYLE: React.CSSProperties = {
  color: '#cbd5e1',
  fontSize: 14,
};

const FOCUSED_GRID_STYLE: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 18,
};

const FOCUSED_PANEL_STYLE: React.CSSProperties = {
  borderRadius: 14,
  border: '1px solid #1f2937',
  background: '#0f172a',
  padding: 16,
  display: 'grid',
  gap: 12,
};

const FOCUSED_PANEL_TITLE_STYLE: React.CSSProperties = {
  color: '#f8fafc',
  fontSize: 14,
  fontWeight: 800,
  letterSpacing: '0.04em',
};

const FOCUSED_AGENT_LIST_STYLE: React.CSSProperties = {
  display: 'grid',
  gap: 10,
};

const FOCUSED_AGENT_CARD_STYLE: React.CSSProperties = {
  borderRadius: 12,
  border: '1px solid #334155',
  background: '#111827',
  padding: 12,
  display: 'grid',
  gap: 8,
};

const FOCUSED_AGENT_STATS_STYLE: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
  color: '#cbd5e1',
  fontSize: 12,
};

const FOCUSED_SCENE_CARD_STYLE: React.CSSProperties = {
  borderRadius: 12,
  border: '1px solid #334155',
  background: '#111827',
  padding: 12,
};

const FOCUSED_MESSAGE_STYLE: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.45,
};

const FOCUSED_EMPTY_STYLE: React.CSSProperties = {
  color: '#94a3b8',
  fontSize: 13,
};
