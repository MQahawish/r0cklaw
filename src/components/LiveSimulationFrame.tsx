import { useState } from 'react';
import { useElementSize } from 'usehooks-ts';
import { Stage } from '@pixi/react';
import { ConvexProvider, useConvex, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useWorldHeartbeat } from '../hooks/useWorldHeartbeat.ts';
import { useHistoricalTime } from '../hooks/useHistoricalTime.ts';
import { DebugTimeManager } from './DebugTimeManager.tsx';
import { GameId } from '../../convex/aiTown/ids.ts';
import { useServerGame } from '../hooks/serverGame.ts';
import PixiGame from './PixiGame.tsx';
import { SHOW_DEBUG_UI } from './gameDebug.ts';

export default function LiveSimulationFrame() {
  const convex = useConvex();
  const [selectedElement, setSelectedElement] = useState<{
    kind: 'player';
    id: GameId<'players'>;
  }>();
  const [gameWrapperRef, { width, height }] = useElementSize();

  const worldStatus = useQuery(api.world.defaultWorldStatus);
  const worldId = worldStatus?.worldId;
  const engineId = worldStatus?.engineId;
  const game = useServerGame(worldId);

  useWorldHeartbeat();

  const worldState = useQuery(api.world.worldState, worldId ? { worldId } : 'skip');
  const { historicalTime, timeManager } = useHistoricalTime(worldState?.engine);

  if (!worldId || !engineId || !game) {
    return (
      <div style={LIVE_FRAME_LOADING_STYLE}>
        <span style={{ color: '#6b7280' }}>Loading live simulation...</span>
      </div>
    );
  }

  return (
    <>
      {SHOW_DEBUG_UI && <DebugTimeManager timeManager={timeManager} width={200} height={100} />}
      <div style={LIVE_FRAME_STYLE}>
        <div style={LIVE_FRAME_HEADER_STYLE}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#f9fafb', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Live Simulation
            </span>
            <span style={{ fontSize: 12, color: '#9ca3af' }}>
              Drag to pan, scroll to zoom, click a character to inspect the current town state.
            </span>
          </div>
        </div>
        <div style={LIVE_STAGE_WRAPPER_STYLE} ref={gameWrapperRef}>
          <div style={{ position: 'absolute', inset: 0 }}>
            <Stage width={width} height={height} options={{ backgroundColor: 0x7ab5ff }}>
              <ConvexProvider client={convex}>
                <PixiGame
                  game={game}
                  worldId={worldId}
                  engineId={engineId}
                  width={width}
                  height={height}
                  historicalTime={historicalTime}
                  setSelectedElement={setSelectedElement}
                  selectedPlayerId={selectedElement?.id}
                />
              </ConvexProvider>
            </Stage>
          </div>
        </div>
      </div>
    </>
  );
}

const LIVE_FRAME_STYLE: React.CSSProperties = {
  display: 'grid',
  gridTemplateRows: 'auto 1fr',
  minHeight: 620,
  height: 'calc(100vh - 220px)',
  background: '#111827',
  border: '1px solid #374151',
  borderRadius: 10,
  overflow: 'hidden',
};

const LIVE_FRAME_HEADER_STYLE: React.CSSProperties = {
  padding: '12px 14px',
  borderBottom: '1px solid #1f2937',
  background: '#0f172a',
};

const LIVE_STAGE_WRAPPER_STYLE: React.CSSProperties = {
  position: 'relative',
  overflow: 'hidden',
  background: '#3a2519',
  minHeight: 0,
};

const LIVE_FRAME_LOADING_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 620,
  height: 'calc(100vh - 220px)',
  background: '#111827',
  border: '1px solid #374151',
  borderRadius: 10,
};
