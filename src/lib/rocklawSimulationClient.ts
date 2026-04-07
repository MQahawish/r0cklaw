import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';

export function useRocklawLiveSnapshot() {
  return useQuery(api.rocklaw.observe.getLiveSnapshot);
}
