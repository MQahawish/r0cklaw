import RocklawLiveScene from './RocklawLiveScene.tsx';
import { useRocklawLiveSnapshot } from '../lib/rocklawSimulationClient.ts';

export default function LiveSimulationFrame({
  mode = 'full',
  isExpanded = false,
  onToggleExpanded,
}: {
  mode?: 'compact' | 'full';
  isExpanded?: boolean;
  onToggleExpanded?: () => void;
}) {
  const snapshot = useRocklawLiveSnapshot();

  if (!snapshot) {
    return (
      <div
        style={{
          ...LIVE_FRAME_LOADING_STYLE,
          minHeight: mode === 'compact' && !isExpanded ? 420 : LIVE_FRAME_LOADING_STYLE.minHeight,
          height: mode === 'compact' && !isExpanded ? 420 : LIVE_FRAME_LOADING_STYLE.height,
        }}
      >
        <span style={{ color: '#6b7280' }}>Loading Rocklaw live scene...</span>
      </div>
    );
  }

  return (
    <RocklawLiveScene
      snapshot={snapshot}
      mode={mode}
      isExpanded={isExpanded}
      onToggleExpanded={onToggleExpanded}
    />
  );
}

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
