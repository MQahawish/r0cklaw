import RocklawLiveScene from './RocklawLiveScene.tsx';
import { useRocklawLiveSnapshot } from '../lib/rocklawSimulationClient.ts';

export default function LiveSimulationFrame() {
  const snapshot = useRocklawLiveSnapshot();

  if (!snapshot) {
    return (
      <div style={LIVE_FRAME_LOADING_STYLE}>
        <span style={{ color: '#6b7280' }}>Loading Rocklaw live scene...</span>
      </div>
    );
  }

  return <RocklawLiveScene snapshot={snapshot} />;
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
