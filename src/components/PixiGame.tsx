import * as PIXI from 'pixi.js';
import { useApp } from '@pixi/react';
import { Player, SelectElement } from './Player.tsx';
import { useEffect, useRef, useState } from 'react';
import { PixiStaticMap } from './PixiStaticMap.tsx';
import PixiViewport from './PixiViewport.tsx';
import { Viewport } from 'pixi-viewport';
import { Id } from '../../convex/_generated/dataModel';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api.js';
import { GameId } from '../../convex/aiTown/ids.ts';
import { useSendInput } from '../hooks/sendInput.ts';
import { toastOnError } from '../toasts.ts';
import { DebugPath } from './DebugPath.tsx';
import { PositionIndicator } from './PositionIndicator.tsx';
import { SHOW_DEBUG_UI } from './gameDebug.ts';
import { ServerGame } from '../hooks/serverGame.ts';
import { RocklawMapOverlay } from './RocklawMapOverlay.tsx';

const ACTION_EMOJI: Record<string, string> = {
  chat: '💬',
  say: '📣',
  move: '🚶',
  craft: '⚒️',
  brew: '⚗️',
  gather: '🌿',
  harvest: '🌾',
  plant: '🌱',
  water: '💧',
  buy_place: '🛒',
  sell_place: '📦',
  trade: '🤝',
  sleep: '😴',
  rest: '😌',
};

export const PixiGame = (props: {
  worldId: Id<'worlds'>;
  engineId: Id<'engines'>;
  game: ServerGame;
  historicalTime: number | undefined;
  width: number;
  height: number;
  setSelectedElement: SelectElement;
  selectedPlayerId?: GameId<'players'>;
}) => {
  // PIXI setup.
  const pixiApp = useApp();
  const viewportRef = useRef<Viewport | undefined>();

  const humanTokenIdentifier = useQuery(api.world.userStatus, { worldId: props.worldId }) ?? null;
  const rocklawWorld = useQuery(api.rocklaw.observe.getFrontendWorld);
  const humanPlayerId = [...props.game.world.players.values()].find(
    (p) => p.human === humanTokenIdentifier,
  )?.id;

  const moveTo = useSendInput(props.engineId, 'moveTo');

  // Interaction for clicking on the world to navigate.
  const dragStart = useRef<{ screenX: number; screenY: number } | null>(null);
  const onMapPointerDown = (e: any) => {
    // https://pixijs.download/dev/docs/PIXI.FederatedPointerEvent.html
    dragStart.current = { screenX: e.screenX, screenY: e.screenY };
  };

  const [lastDestination, setLastDestination] = useState<{
    x: number;
    y: number;
    t: number;
  } | null>(null);
  const onMapPointerUp = async (e: any) => {
    props.setSelectedElement(undefined);
    if (dragStart.current) {
      const { screenX, screenY } = dragStart.current;
      dragStart.current = null;
      const [dx, dy] = [screenX - e.screenX, screenY - e.screenY];
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 10) {
        console.log(`Skipping navigation on drag event (${dist}px)`);
        return;
      }
    }
    if (!humanPlayerId) {
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const gameSpacePx = viewport.toWorld(e.screenX, e.screenY);
    const tileDim = props.game.worldMap.tileDim;
    const gameSpaceTiles = {
      x: gameSpacePx.x / tileDim,
      y: gameSpacePx.y / tileDim,
    };
    setLastDestination({ t: Date.now(), ...gameSpaceTiles });
    const roundedTiles = {
      x: Math.floor(gameSpaceTiles.x),
      y: Math.floor(gameSpaceTiles.y),
    };
    console.log(`Moving to ${JSON.stringify(roundedTiles)}`);
    await toastOnError(moveTo({ playerId: humanPlayerId, destination: roundedTiles }));
  };
  const { width, height, tileDim } = props.game.worldMap;
  const players = [...props.game.world.players.values()];
  const rocklawVisualState = new Map<string, {
    overlayText?: string;
    overlayTone?: 'neutral' | 'chat' | 'busy' | 'trade' | 'warning';
    isSpeaking?: boolean;
  }>();
  if (rocklawWorld) {
    for (const agent of rocklawWorld.agents) {
      const liveScene = agent.currentScene;
      const lastSceneMessage = liveScene?.recentMessages?.[liveScene.recentMessages.length - 1];
      if (lastSceneMessage) {
        const partnerLabel =
          lastSceneMessage.fromAgent === agent.name
            ? `💬 ${lastSceneMessage.text}`
            : `💬 with ${liveScene?.partner}`;
        rocklawVisualState.set(agent.name, {
          overlayText: partnerLabel,
          overlayTone: 'chat',
          isSpeaking: true,
        });
        continue;
      }

      if (agent.busy && agent.busyLabel) {
        rocklawVisualState.set(agent.name, {
          overlayText: `⏳ ${agent.busyLabel}`,
          overlayTone: 'busy',
          isSpeaking: false,
        });
        continue;
      }

      if (agent.latestAction?.message) {
        const actionEmoji = ACTION_EMOJI[agent.latestAction.action] ?? '•';
        rocklawVisualState.set(agent.name, {
          overlayText: `${actionEmoji} ${agent.latestAction.message}`,
          overlayTone:
            agent.latestAction.action === 'trade' ||
            agent.latestAction.action === 'buy_place' ||
            agent.latestAction.action === 'sell_place'
              ? 'trade'
              : agent.latestAction.outcome === 'failed'
                ? 'warning'
                : 'neutral',
          isSpeaking: agent.latestAction.action === 'chat' || agent.latestAction.action === 'say',
        });
      }
    }
  }

  // Zoom on the user’s avatar when it is created
  useEffect(() => {
    if (!viewportRef.current || humanPlayerId === undefined) return;

    const humanPlayer = props.game.world.players.get(humanPlayerId)!;
    viewportRef.current.animate({
      position: new PIXI.Point(humanPlayer.position.x * tileDim, humanPlayer.position.y * tileDim),
      scale: 1.5,
    });
  }, [humanPlayerId]);

  useEffect(() => {
    if (!viewportRef.current || props.selectedPlayerId === undefined) return;
    const selectedPlayer = props.game.world.players.get(props.selectedPlayerId);
    if (!selectedPlayer) return;
    viewportRef.current.animate({
      position: new PIXI.Point(selectedPlayer.position.x * tileDim, selectedPlayer.position.y * tileDim),
      scale: 1.8,
      time: 450,
      ease: 'easeInOutSine',
    });
  }, [props.game.world.players, props.selectedPlayerId, tileDim]);

  useEffect(() => {
    if (!viewportRef.current || props.selectedPlayerId !== undefined || humanPlayerId !== undefined) return;
    viewportRef.current.animate({
      position: new PIXI.Point((width * tileDim) / 2, (height * tileDim) / 2),
      scale: 1.28,
      time: 350,
      ease: 'easeInOutSine',
    });
  }, [height, humanPlayerId, props.selectedPlayerId, tileDim, width]);

  return (
    <PixiViewport
      app={pixiApp}
      screenWidth={props.width}
      screenHeight={props.height}
      worldWidth={width * tileDim}
      worldHeight={height * tileDim}
      viewportRef={viewportRef}
    >
      <PixiStaticMap
        map={props.game.worldMap}
        onpointerup={onMapPointerUp}
        onpointerdown={onMapPointerDown}
      />
      {rocklawWorld && <RocklawMapOverlay tileDim={tileDim} liveScenes={rocklawWorld.liveScenes} />}
      {players.map(
        (p) =>
          // Only show the path for the human player in non-debug mode.
          (SHOW_DEBUG_UI || p.id === humanPlayerId) && (
            <DebugPath key={`path-${p.id}`} player={p} tileDim={tileDim} />
          ),
      )}
      {lastDestination && <PositionIndicator destination={lastDestination} tileDim={tileDim} />}
      {players.map((p) => {
        const rocklawName = p.human?.startsWith('rocklaw:') ? p.human.slice('rocklaw:'.length) : null;
        const visual = rocklawName ? rocklawVisualState.get(rocklawName) : undefined;
        return (
        <Player
          key={`player-${p.id}`}
          game={props.game}
          player={p}
          isViewer={p.id === humanPlayerId}
          onClick={props.setSelectedElement}
          historicalTime={props.historicalTime}
          overlayText={visual?.overlayText}
          overlayTone={visual?.overlayTone}
          isRocklawSpeaking={visual?.isSpeaking}
        />
        );
      })}
    </PixiViewport>
  );
};
export default PixiGame;
