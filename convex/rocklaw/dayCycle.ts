export const DAY_PERIODS = [
  'dawn',
  'morning',
  'midday',
  'afternoon',
  'evening',
  'night',
] as const;

export type DayPeriod = typeof DAY_PERIODS[number];

export function timeOfDayForTick(tick: number): DayPeriod {
  const index = ((tick % DAY_PERIODS.length) + DAY_PERIODS.length) % DAY_PERIODS.length;
  return DAY_PERIODS[index];
}

export function nextDayPeriod(current: DayPeriod): { nextTime: DayPeriod; dayDelta: number } {
  const idx = DAY_PERIODS.indexOf(current);
  const safeIdx = idx >= 0 ? idx : 0;
  const nextIdx = (safeIdx + 1) % DAY_PERIODS.length;
  return {
    nextTime: DAY_PERIODS[nextIdx],
    dayDelta: nextIdx === 0 ? 1 : 0,
  };
}

export function isSleepPeriod(timeOfDay: DayPeriod): boolean {
  return timeOfDay === 'evening' || timeOfDay === 'night';
}
