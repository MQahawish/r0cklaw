import { useRef, useState } from 'react';
import RocklawSidebar from './RocklawSidebar.tsx';
import { GameId } from '../../convex/aiTown/ids.ts';
import LiveSimulationFrame from './LiveSimulationFrame.tsx';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useServerGame } from '../hooks/serverGame.ts';

export default function Game() {
  const [selectedElement, setSelectedElement] = useState<{
    kind: 'player';
    id: GameId<'players'>;
  }>();
  const worldStatus = useQuery(api.world.defaultWorldStatus);
  const worldId = worldStatus?.worldId;
  const engineId = worldStatus?.engineId;
  const game = useServerGame(worldId);
  const scrollViewRef = useRef<HTMLDivElement>(null);

  if (!worldId || !engineId || !game) {
    return null;
  }
  return (
    <div className="mx-auto grid w-full min-h-[480px] max-w-[1400px] grid-rows-[240px_1fr] game-frame lg:grid-cols-[1fr_auto] lg:grid-rows-[1fr] lg:grow">
      <LiveSimulationFrame />
      <div
        className="flex shrink-0 flex-col overflow-y-auto border-t-8 border-brown-900 bg-brown-800 px-4 py-6 text-brown-100 sm:border-l-8 sm:border-t-0 sm:px-6 lg:w-96 xl:pr-6"
        ref={scrollViewRef}
      >
        <RocklawSidebar
          worldId={worldId}
          engineId={engineId}
          game={game}
          playerId={selectedElement?.id}
          setSelectedElement={setSelectedElement}
          scrollViewRef={scrollViewRef}
        />
      </div>
    </div>
  );
}
