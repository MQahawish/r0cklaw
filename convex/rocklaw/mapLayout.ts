export type RocklawPlaceLayout = {
  key: string;
  label: string;
  center: { x: number; y: number };
  region: { x: number; y: number; width: number; height: number };
  standingSlots: Array<{ x: number; y: number }>;
  sceneSlots: Array<{ x: number; y: number }>;
  labelOffset: { x: number; y: number };
  color: number;
};

export const ROCKLAW_MAP_LAYOUT: Record<string, RocklawPlaceLayout> = {
  forge: {
    key: 'forge',
    label: 'Forge',
    center: { x: 8, y: 6 },
    region: { x: 5, y: 3, width: 7, height: 6 },
    standingSlots: [{ x: 8, y: 6 }, { x: 9, y: 6 }, { x: 7, y: 6 }, { x: 8, y: 7 }],
    sceneSlots: [{ x: 7, y: 6 }, { x: 9, y: 6 }, { x: 8, y: 7 }],
    labelOffset: { x: 0, y: -2 },
    color: 0xc9804b,
  },
  market: {
    key: 'market',
    label: 'Market',
    center: { x: 18, y: 14 },
    region: { x: 14, y: 11, width: 8, height: 6 },
    standingSlots: [{ x: 18, y: 14 }, { x: 17, y: 14 }, { x: 19, y: 14 }, { x: 18, y: 15 }, { x: 16, y: 14 }],
    sceneSlots: [{ x: 17, y: 14 }, { x: 19, y: 14 }, { x: 18, y: 15 }],
    labelOffset: { x: 0, y: -2 },
    color: 0xe1b756,
  },
  inn: {
    key: 'inn',
    label: 'Inn',
    center: { x: 32, y: 8 },
    region: { x: 29, y: 5, width: 7, height: 6 },
    standingSlots: [{ x: 32, y: 8 }, { x: 31, y: 8 }, { x: 33, y: 8 }, { x: 32, y: 9 }],
    sceneSlots: [{ x: 31, y: 8 }, { x: 33, y: 8 }, { x: 32, y: 9 }],
    labelOffset: { x: 0, y: -2 },
    color: 0xb86e45,
  },
  farm: {
    key: 'farm',
    label: 'Farm',
    center: { x: 38, y: 20 },
    region: { x: 34, y: 17, width: 8, height: 7 },
    standingSlots: [{ x: 38, y: 20 }, { x: 37, y: 20 }, { x: 39, y: 20 }, { x: 38, y: 21 }],
    sceneSlots: [{ x: 37, y: 20 }, { x: 39, y: 20 }],
    labelOffset: { x: 0, y: -2 },
    color: 0x7daf56,
  },
  shrine: {
    key: 'shrine',
    label: 'Shrine',
    center: { x: 8, y: 24 },
    region: { x: 5, y: 21, width: 7, height: 6 },
    standingSlots: [{ x: 8, y: 24 }, { x: 7, y: 24 }, { x: 9, y: 24 }, { x: 8, y: 25 }],
    sceneSlots: [{ x: 7, y: 24 }, { x: 9, y: 24 }],
    labelOffset: { x: 0, y: -2 },
    color: 0x8d9fe8,
  },
  gate: {
    key: 'gate',
    label: 'Gate',
    center: { x: 22, y: 28 },
    region: { x: 19, y: 25, width: 6, height: 5 },
    standingSlots: [{ x: 22, y: 28 }, { x: 21, y: 28 }, { x: 23, y: 28 }],
    sceneSlots: [{ x: 21, y: 28 }, { x: 23, y: 28 }],
    labelOffset: { x: 0, y: -2 },
    color: 0x89b2c9,
  },
  square: {
    key: 'square',
    label: 'Square',
    center: { x: 22, y: 13 },
    region: { x: 20, y: 11, width: 5, height: 5 },
    standingSlots: [{ x: 22, y: 13 }, { x: 21, y: 13 }, { x: 23, y: 13 }, { x: 22, y: 14 }],
    sceneSlots: [{ x: 21, y: 13 }, { x: 23, y: 13 }],
    labelOffset: { x: 0, y: -2 },
    color: 0xc4ab85,
  },
  mine: {
    key: 'mine',
    label: 'Mine',
    center: { x: 40, y: 28 },
    region: { x: 37, y: 25, width: 7, height: 5 },
    standingSlots: [{ x: 40, y: 28 }, { x: 39, y: 28 }, { x: 41, y: 28 }],
    sceneSlots: [{ x: 39, y: 28 }, { x: 41, y: 28 }],
    labelOffset: { x: 0, y: -2 },
    color: 0x7c7f8d,
  },
  bakery: {
    key: 'bakery',
    label: 'Bakery',
    center: { x: 28, y: 14 },
    region: { x: 26, y: 12, width: 5, height: 5 },
    standingSlots: [{ x: 28, y: 14 }, { x: 27, y: 14 }, { x: 29, y: 14 }],
    sceneSlots: [{ x: 27, y: 14 }, { x: 29, y: 14 }],
    labelOffset: { x: 0, y: -2 },
    color: 0xd59f4a,
  },
  warehouse: {
    key: 'warehouse',
    label: 'Warehouse',
    center: { x: 25, y: 18 },
    region: { x: 22, y: 16, width: 7, height: 5 },
    standingSlots: [{ x: 25, y: 18 }, { x: 24, y: 18 }, { x: 26, y: 18 }, { x: 25, y: 19 }],
    sceneSlots: [{ x: 24, y: 18 }, { x: 26, y: 18 }],
    labelOffset: { x: 0, y: -2 },
    color: 0x6aa4a1,
  },
};

export function getPlaceLayout(placeName: string): RocklawPlaceLayout {
  return ROCKLAW_MAP_LAYOUT[placeName] ?? {
    key: placeName,
    label: placeName,
    center: { x: 22, y: 13 },
    region: { x: 20, y: 11, width: 5, height: 5 },
    standingSlots: [{ x: 22, y: 13 }],
    sceneSlots: [{ x: 22, y: 13 }, { x: 23, y: 13 }],
    labelOffset: { x: 0, y: -2 },
    color: 0xc4ab85,
  };
}

export const ROCKLAW_PLACE_LIST = Object.values(ROCKLAW_MAP_LAYOUT);
