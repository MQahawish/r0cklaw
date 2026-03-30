import { useMemo } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import { GameId } from '../../convex/aiTown/ids';
import { ServerGame } from '../hooks/serverGame';
import { SelectElement } from './Player';
import PlayerDetails from './PlayerDetails';

const ROCKLAW_TOKEN_PREFIX = 'rocklaw:';

function formatActionLine(entry: {
  agentName?: string;
  action: string;
  target?: string | null;
  location?: string | null;
  outcome: string;
  outcomeNote?: string | null;
}) {
  const targetPart = entry.target ? ` -> ${entry.target}` : entry.location ? ` @ ${entry.location}` : '';
  const notePart = entry.outcomeNote ? ` | ${entry.outcomeNote}` : '';
  return `${entry.agentName ? `${entry.agentName}: ` : ''}${entry.action}${targetPart} | ${entry.outcome}${notePart}`;
}

function sidebarCard(title: string, body: React.ReactNode, subtitle?: string) {
  return (
    <section className="rounded-2xl border border-brown-500/70 bg-[#231913] shadow-[0_12px_30px_rgba(0,0,0,0.24)]">
      <div className="border-b border-brown-500/60 bg-[linear-gradient(135deg,#5b3b27,#362117)] px-4 py-3">
        <div className="font-display text-lg tracking-[0.12em] text-[#f7ead4] uppercase">{title}</div>
        {subtitle && <div className="mt-1 text-xs tracking-wide text-brown-100/80">{subtitle}</div>}
      </div>
      <div className="px-4 py-4 text-sm leading-relaxed text-[#f3ead7]">{body}</div>
    </section>
  );
}

function toneClasses(tone: 'busy' | 'scene' | 'idle') {
  if (tone === 'busy') return 'border-lime-300/40 bg-lime-200/10 text-lime-50';
  if (tone === 'scene') return 'border-sky-300/40 bg-sky-200/10 text-sky-50';
  return 'border-brown-300/30 bg-brown-100/10 text-brown-50';
}

function RocklawAgentDirectory({
  selectedAgent,
  onSelectAgent,
  onClearSelection,
}: {
  selectedAgent?: string | null;
  onSelectAgent: (agentName: string) => void;
  onClearSelection?: () => void;
}) {
  const world = useQuery(api.rocklaw.observe.getFrontendWorld);

  if (!world) {
    return sidebarCard('Agents', <div>Loading agents...</div>);
  }

  return sidebarCard(
    'Agents',
    <div className="space-y-3">
      {onClearSelection && (
        <button
          type="button"
          onClick={onClearSelection}
          className="w-full rounded-2xl border border-brown-300/25 bg-brown-100/10 px-3 py-2 text-left text-sm text-[#fff4dd] hover:border-[#f4cc7a] hover:bg-brown-100/15"
        >
          Free navigation mode
        </button>
      )}
      <div className="grid gap-2">
        {world.agents.map((agent) => {
        const tone = agent.currentScene ? 'scene' : agent.busy ? 'busy' : 'idle';
        return (
          <button
            key={agent.name}
            type="button"
            onClick={() => selectedAgent === agent.name ? onClearSelection?.() : onSelectAgent(agent.name)}
            className={`rounded-2xl border px-3 py-3 text-left transition hover:-translate-y-[1px] hover:border-[#f4cc7a] ${toneClasses(tone)} ${
              selectedAgent === agent.name ? 'ring-2 ring-[#f4cc7a]' : ''
            }`}
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-display text-base tracking-wide text-[#fff5e6]">{agent.name}</div>
                <div className="text-xs uppercase tracking-[0.16em] text-brown-100/70">{agent.role}</div>
              </div>
              <div className="rounded-full bg-black/20 px-2 py-1 text-xs">{agent.coin}c</div>
            </div>
            <div className="mt-2 text-xs text-brown-50/80">
              {agent.location}
              {agent.currentScene ? ` | with ${agent.currentScene.partner}` : ''}
            </div>
            <div className="mt-2 text-sm text-[#fff6e1]">
              {agent.currentScene?.recentMessages.at(-1)?.text ?? agent.busyLabel ?? agent.latestAction?.message ?? 'Ready'}
            </div>
          </button>
        );
        })}
      </div>
    </div>,
    `Day ${world.day}, tick ${world.tick}, ${world.timeOfDay}`,
  );
}

function RocklawWorldOverview({
  onSelectAgent,
}: {
  onSelectAgent: (agentName: string) => void;
}) {
  const world = useQuery(api.rocklaw.observe.getFrontendWorld);

  if (!world) {
    return <div className="h-full text-xl flex text-center items-center p-4">Loading Rocklaw...</div>;
  }

  return (
    <div className="space-y-4">
      <RocklawAgentDirectory onSelectAgent={onSelectAgent} />
      {sidebarCard(
        'Live Scenes',
        world.liveScenes.length > 0 ? (
          <div className="space-y-3">
            {world.liveScenes.map((scene) => (
              <button
                key={scene.sceneId}
                type="button"
                onClick={() => onSelectAgent(scene.left)}
                className="w-full rounded-2xl border border-sky-300/30 bg-sky-200/10 px-3 py-3 text-left hover:border-sky-200/60"
              >
                <div className="font-medium text-sky-50">
                  {scene.left} ↔ {scene.right}
                </div>
                <div className="mt-1 text-xs uppercase tracking-[0.16em] text-sky-100/70">{scene.location}</div>
                {scene.recentMessages.length > 0 && (
                  <div className="mt-2 text-sm text-[#f2f7fb]">
                    {scene.recentMessages[scene.recentMessages.length - 1].fromAgent}: {scene.recentMessages[scene.recentMessages.length - 1].text}
                  </div>
                )}
              </button>
            ))}
          </div>
        ) : (
          <div className="text-brown-50/80">No live chat scenes.</div>
        ),
      )}
      {sidebarCard(
        'Recent Actions',
        <div className="space-y-2">
          {world.recentActions.slice(0, 8).map((entry, idx) => (
            <div key={`${entry.agentName}-${entry.tick}-${idx}`} className="rounded-xl bg-black/15 px-3 py-2">
              {formatActionLine(entry)}
            </div>
          ))}
        </div>,
      )}
      {sidebarCard(
        'Recent Trades',
        world.recentTransactions.length > 0 ? (
          <div className="space-y-2">
            {world.recentTransactions.map((txn) => (
              <div key={txn.txnId} className="rounded-xl border border-amber-200/20 bg-amber-100/10 px-3 py-2">
                <div className="font-medium text-amber-50">{txn.kind}</div>
                <div>{txn.fromAgent} → {txn.toAgent}</div>
                <div className="text-xs uppercase tracking-[0.14em] text-amber-100/70">{txn.status}</div>
                {txn.outcomeNote && <div className="mt-1 text-sm text-[#fff7dc]">{txn.outcomeNote}</div>}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-brown-50/80">No settled trades yet.</div>
        ),
      )}
    </div>
  );
}

function RocklawAgentDetails({
  agentName,
  onSelectAgent,
}: {
  agentName: string;
  onSelectAgent: (agentName: string) => void;
}) {
  const details = useQuery(api.rocklaw.observe.getFrontendAgentDetails, { agentName });

  if (!details) {
    return <div className="h-full text-xl flex text-center items-center p-4">Loading {agentName}...</div>;
  }

  return (
    <div className="space-y-4">
      <RocklawAgentDirectory selectedAgent={agentName} onSelectAgent={onSelectAgent} onClearSelection={() => onSelectAgent('')} />
      {sidebarCard(
        details.name,
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl bg-black/15 px-3 py-3">
            <div className="text-xs uppercase tracking-[0.14em] text-brown-100/70">Role</div>
            <div className="mt-1 text-base">{details.role}</div>
          </div>
          <div className="rounded-xl bg-black/15 px-3 py-3">
            <div className="text-xs uppercase tracking-[0.14em] text-brown-100/70">Location</div>
            <div className="mt-1 text-base">{details.location}</div>
          </div>
          <div className="rounded-xl bg-black/15 px-3 py-3">
            <div className="text-xs uppercase tracking-[0.14em] text-brown-100/70">Status</div>
            <div className="mt-1 text-base">{details.busy && details.busyLabel ? details.busyLabel : 'Idle and available'}</div>
          </div>
          <div className="rounded-xl bg-black/15 px-3 py-3">
            <div className="text-xs uppercase tracking-[0.14em] text-brown-100/70">Coin</div>
            <div className="mt-1 text-base">{details.coin}c</div>
          </div>
        </div>,
      )}
      {sidebarCard(
        'Vitals',
        <div className="grid grid-cols-2 gap-3">
          {[
            ['Energy', details.energy],
            ['Health', details.health],
            ['Hunger', details.hunger],
            ['Reputation', details.reputation],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-brown-300/20 bg-black/15 px-3 py-3">
              <div className="text-xs uppercase tracking-[0.14em] text-brown-100/70">{label}</div>
              <div className="mt-1 text-lg">{value}</div>
            </div>
          ))}
        </div>,
      )}
      {sidebarCard(
        'Inventory',
        <div className="flex flex-wrap gap-2">
          {details.inventory.length > 0 ? details.inventory.map((entry) => (
            <div key={entry.item} className="rounded-full border border-amber-200/30 bg-amber-100/10 px-3 py-1.5 text-sm">
              {entry.item} x{entry.quantity}
            </div>
          )) : <div className="text-brown-50/80">No inventory.</div>}
        </div>,
      )}
      {sidebarCard(
        'Current Activity',
        details.latestAction ? (
          <div className="space-y-2">
            <div className="rounded-xl bg-black/15 px-3 py-3">{formatActionLine(details.latestAction)}</div>
            {details.latestAction.message && (
              <div className="rounded-xl border border-brown-300/20 bg-brown-100/10 px-3 py-3 text-[#fff4dd]">
                “{details.latestAction.message}”
              </div>
            )}
            <div className="text-xs uppercase tracking-[0.14em] text-brown-100/70">
              Day {details.latestAction.day}, tick {details.latestAction.tick}
            </div>
          </div>
        ) : (
          <div className="text-brown-50/80">No actions yet.</div>
        ),
      )}
      {sidebarCard(
        'Live Chat',
        details.currentScene ? (
          <div className="space-y-2">
            <div className="text-sm text-sky-50">With {details.currentScene.partner} at {details.currentScene.location}</div>
            {details.currentScene.recentMessages.map((msg: { fromAgent: string; text: string; sentTick: number }, idx: number) => (
              <div key={`${msg.sentTick}-${idx}`} className="rounded-xl border border-sky-200/25 bg-sky-100/10 px-3 py-2">
                <strong>{msg.fromAgent}:</strong> {msg.text}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-brown-50/80">No active live chat.</div>
        ),
      )}
      {sidebarCard(
        'Offers',
        <div className="grid gap-3">
          <div className="rounded-xl border border-brown-300/20 bg-black/15 px-3 py-3">
            <div className="mb-2 text-xs uppercase tracking-[0.14em] text-brown-100/70">Incoming</div>
            {details.incomingOffers.length > 0 ? details.incomingOffers.map((offer) => (
              <div key={offer.txnId} className="mb-2 last:mb-0 rounded-lg bg-brown-100/10 px-3 py-2">
                {offer.kind} from {offer.fromAgent}
                {offer.message && <div className="mt-1 text-sm text-[#fff4dd]">{offer.message}</div>}
              </div>
            )) : <div className="text-brown-50/80">None</div>}
          </div>
          <div className="rounded-xl border border-brown-300/20 bg-black/15 px-3 py-3">
            <div className="mb-2 text-xs uppercase tracking-[0.14em] text-brown-100/70">Outgoing</div>
            {details.outgoingOffers.length > 0 ? details.outgoingOffers.map((offer) => (
              <div key={offer.txnId} className="mb-2 last:mb-0 rounded-lg bg-brown-100/10 px-3 py-2">
                {offer.kind} to {offer.toAgent}
                {offer.message && <div className="mt-1 text-sm text-[#fff4dd]">{offer.message}</div>}
              </div>
            )) : <div className="text-brown-50/80">None</div>}
          </div>
        </div>,
      )}
      {sidebarCard(
        'Recent Actions',
        <div className="space-y-2">
          {details.recentActions.map((entry, idx) => (
            <div key={`${entry.tick}-${entry.action}-${idx}`} className="rounded-xl bg-black/15 px-3 py-2">
              {formatActionLine(entry)}
            </div>
          ))}
        </div>,
      )}
    </div>
  );
}

export default function RocklawSidebar({
  worldId,
  engineId,
  game,
  playerId,
  setSelectedElement,
  scrollViewRef,
}: {
  worldId: Id<'worlds'>;
  engineId: Id<'engines'>;
  game: ServerGame;
  playerId?: GameId<'players'>;
  setSelectedElement: SelectElement;
  scrollViewRef: React.RefObject<HTMLDivElement>;
}) {
  const selectedPlayer = playerId ? game.world.players.get(playerId) : undefined;
  const selectedRocklawAgent = useMemo(() => {
    const token = selectedPlayer?.human;
    return token?.startsWith(ROCKLAW_TOKEN_PREFIX) ? token.slice(ROCKLAW_TOKEN_PREFIX.length) : null;
  }, [selectedPlayer]);

  const selectRocklawAgent = (agentName: string) => {
    if (!agentName) {
      setSelectedElement(undefined);
      scrollViewRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const token = `${ROCKLAW_TOKEN_PREFIX}${agentName}`;
    const player = [...game.world.players.values()].find((entry) => entry.human === token);
    if (player) {
      setSelectedElement({ kind: 'player', id: player.id });
      scrollViewRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  if (!playerId) {
    return <RocklawWorldOverview onSelectAgent={selectRocklawAgent} />;
  }

  if (selectedRocklawAgent) {
    return <RocklawAgentDetails agentName={selectedRocklawAgent} onSelectAgent={selectRocklawAgent} />;
  }

  return (
    <PlayerDetails
      worldId={worldId}
      engineId={engineId}
      game={game}
      playerId={playerId}
      setSelectedElement={setSelectedElement}
      scrollViewRef={scrollViewRef}
    />
  );
}
