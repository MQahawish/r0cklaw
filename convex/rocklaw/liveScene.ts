export type RocklawPlaceType =
  | 'residence'
  | 'industry'
  | 'trade'
  | 'hospitality'
  | 'agriculture'
  | 'spiritual'
  | 'civic'
  | 'resource'
  | 'logistics';

export type RocklawPoint = {
  x: number;
  y: number;
};

export type RocklawLocationNode = {
  id: string;
  key: string;
  label: string;
  type: RocklawPlaceType;
  center: RocklawPoint;
  region: { x: number; y: number; width: number; height: number };
  standingSlots: RocklawPoint[];
  sceneSlots: RocklawPoint[];
  labelOffset: RocklawPoint;
  color: number;
  neighbors: string[];
  spriteKey: string;
};

export type RocklawLiveSceneEntry = {
  sceneId: string;
  left: string;
  right: string;
  location: string;
  nextSpeaker: string;
  recentMessages: Array<{ fromAgent: string; text: string; sentDay: number; sentTick: number }>;
};

export type RocklawLiveMoveState = {
  fromLocationId: string;
  toLocationId: string;
  startedTick: number;
  endsTick: number;
};

export type RocklawLiveActionState = {
  agentName?: string | null;
  action: string;
  target: string | null;
  location: string | null;
  fromLocationId?: string | null;
  toLocationId?: string | null;
  message: string | null;
  tick?: number | null;
  outcome: string | null;
  outcomeNote: string | null;
};

export type RocklawAgentVisualState = {
  name: string;
  role: string;
  locationId: string;
  busy: boolean;
  busyLabel: string | null;
  coin: number;
  energy: number;
  health: number;
  hunger: number;
  spriteKey: string;
  currentAction: RocklawLiveActionState | null;
  moveState: RocklawLiveMoveState | null;
  scenePartner: string | null;
};

export type RocklawLiveSnapshot = {
  tick: number;
  day: number;
  timeOfDay: string;
  tickIntervalMs: number;
  locations: RocklawLocationNode[];
  agents: RocklawAgentVisualState[];
  liveScenes: RocklawLiveSceneEntry[];
  recentActions: RocklawLiveActionState[];
};

export const ROCKLAW_LIVE_TICK_INTERVAL_MS = 30_000;

export const ROCKLAW_AGENT_SPRITES: Record<string, string> = {
  'Elena Voss': 'blacksmith',
  'Marcus Hale': 'merchant',
  Finn: 'farmer',
  'Lena Marsh': 'healer',
  Sera: 'priest',
};

export const ROCKLAW_AGENT_COLORS: Record<string, number> = {
  'Elena Voss': 0xf59e0b,
  'Marcus Hale': 0x38bdf8,
  Finn: 0x84cc16,
  'Lena Marsh': 0xf472b6,
  Sera: 0xa78bfa,
};

export const ROCKLAW_ACTION_ICONS: Record<string, string> = {
  move: '->',
  chat: '...',
  say: '...',
  work: 'wrk',
  craft: 'mk',
  harvest: 'har',
  plant: 'plt',
  water: 'h2o',
  gather: 'get',
  brew: 'mix',
  buy_place: '$',
  sell_place: '$',
  deliver_place: 'box',
  trade: '<>',
  buy: '$',
  sell: '$',
  give: 'gift',
  pray: 'pray',
  rest: 'rest',
  sleep: 'zzz',
  eat: 'eat',
  use: 'use',
};
