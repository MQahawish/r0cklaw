type ActionLike = {
  action?: string | null;
  item?: string | null;
  target?: string | null;
  location?: string | null;
};

export const ACTION_DURATIONS: Record<string, number> = {
  move: 1,
  chat: 1,
  leave_chat: 1,
  say: 1,
  eat: 1,
  pray: 1,
  play: 1,
  buy_place: 1,
  sell_place: 1,
  deliver_place: 1,
  check_field: 1,
  gather: 1,
  harvest: 2,
  plant: 2,
  water: 1,
  work: 2,
  brew: 2,
  rest: 1,
  sleep: 2,
};

export function getActionDuration(action: string | null | undefined): number {
  if (!action) return 1;
  return ACTION_DURATIONS[action] ?? 1;
}

export function describeActionForHumans(action: ActionLike | null | undefined): string {
  if (!action?.action) return 'working';
  switch (action.action) {
    case 'work':
    case 'brew':
    case 'eat':
      return action.item ? `${action.action} ${action.item}` : action.action;
    case 'move':
      return action.location ?? action.target ? `moving to ${action.location ?? action.target}` : 'moving';
    case 'chat':
      return action.target ? `chatting with ${action.target}` : 'chatting';
    case 'sleep':
      return 'sleeping';
    case 'rest':
      return 'resting';
    default:
      return action.action;
  }
}

export function describeBusyStatus(action: ActionLike | null | undefined, busyUntilTick: number | null | undefined): string {
  const actionLabel = describeActionForHumans(action);
  if (typeof busyUntilTick === 'number') {
    return `${actionLabel} until tick ${busyUntilTick}`;
  }
  return actionLabel;
}
