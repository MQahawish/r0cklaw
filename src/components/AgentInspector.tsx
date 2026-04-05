/**
 * Agent Inspector -- Phase 7
 * Click an agent, browse their workspace files live.
 */

import { useEffect, useState } from 'react';
import { useQuery, useAction } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { AgentFileEntry } from '../../convex/rocklaw/observeNode';

type AgentFiles = { files: AgentFileEntry[] };

export default function AgentInspector({
  selectedAgentName,
  onSelectAgent,
}: {
  selectedAgentName?: string | null;
  onSelectAgent?: (agentName: string) => void;
}) {
  const agents = useQuery(api.rocklaw.observe.getAgentWorkspacePaths) ?? [];
  const getAgentFiles = useAction(api.rocklaw.observeNode.getAgentFiles);

  const [internalSelectedAgent, setInternalSelectedAgent] = useState<string | null>(null);
  const [loadedFiles, setLoadedFiles] = useState<AgentFiles | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const selectedAgent = selectedAgentName ?? internalSelectedAgent;

  useEffect(() => {
    if (!selectedAgentName) return;
    if (internalSelectedAgent === selectedAgentName && loadedFiles) return;
    void handleSelectAgent(selectedAgentName);
  }, [selectedAgentName, internalSelectedAgent, loadedFiles]);

  const handleSelectAgent = async (name: string) => {
    if (internalSelectedAgent === name && loadedFiles) return;
    onSelectAgent?.(name);
    setInternalSelectedAgent(name);
    setSelectedFile(null);
    setLoadedFiles(null);
    setLoading(true);
    try {
      const result = await getAgentFiles({ agentName: name });
      setLoadedFiles(result);
      const hb = result.files.find((f) => f.label === 'Heartbeat');
      const firstExisting = result.files.find((f) => f.content !== null);
      if (hb?.content) {
        setSelectedFile(hb.file);
      } else if (firstExisting) {
        setSelectedFile(firstExisting.file);
      }
    } finally {
      setLoading(false);
    }
  };

  const currentContent = (() => {
    if (!loadedFiles || !selectedFile) return null;
    const reg = loadedFiles.files.find((f) => f.file === selectedFile);
    return reg?.content ?? null;
  })();

  const selectedFileMeta = loadedFiles?.files.find((f) => f.file === selectedFile) ?? null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: selectedAgentName ? '180px 1fr' : '180px 160px 1fr', gap: 12, height: 520 }}>

      {!selectedAgentName && (
        <div style={{ overflowY: 'auto' }}>
          <div style={SECTION_LABEL}>Agents</div>
          {agents.map((a: any) => (
            <div
              key={a.name}
              onClick={() => handleSelectAgent(a.name)}
              style={{
                padding: '6px 10px',
                cursor: 'pointer',
                borderRadius: 4,
                fontSize: 12,
                color: selectedAgent === a.name ? '#e0e7ff' : '#9ca3af',
                background: selectedAgent === a.name ? '#3730a3' : 'transparent',
                marginBottom: 2,
              }}
            >
              {a.name}
            </div>
          ))}
        </div>
      )}

      {/* File tree */}
      <div style={{ overflowY: 'auto', borderLeft: '1px solid #1f2937', paddingLeft: 10 }}>
        <div style={SECTION_LABEL}>{selectedAgent ? `${selectedAgent} files` : 'Files'}</div>
        <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 8 }}>
          You can't manually edit runtime-generated markdown files.
        </div>
        {!selectedAgent && <div style={MUTED}>Select an agent</div>}
        {loading && <div style={MUTED}>Loading…</div>}
        {loadedFiles && (
          <>
            {loadedFiles.files.map((f) => (
              <FileRow
                key={f.file}
                label={f.label}
                fileKey={f.file}
                exists={f.content !== null}
                runtimeGenerated={f.runtimeGenerated}
                editable={f.editable}
                selected={selectedFile === f.file}
                onClick={() => f.content !== null && setSelectedFile(f.file)}
              />
            ))}
            {loadedFiles.files.length === 0 && (
              <div style={MUTED}>No inspector files found for this agent yet.</div>
            )}
          </>
        )}
      </div>

      {/* File content */}
      <div style={{ borderLeft: '1px solid #1f2937', paddingLeft: 12, overflowY: 'auto' }}>
        {!selectedFile && <div style={MUTED}>Select a file</div>}
        {selectedFile && currentContent === null && (
          <div style={MUTED}>File doesn't exist yet — agent hasn't written it.</div>
        )}
        {selectedFileMeta && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 11, color: '#cbd5e1', fontWeight: 700 }}>{selectedFileMeta.label}</div>
            {selectedFileMeta.runtimeGenerated ? (
              <span style={RUNTIME_BADGE_STYLE}>runtime</span>
            ) : selectedFileMeta.editable ? (
              <span style={EDITABLE_BADGE_STYLE}>editable</span>
            ) : (
              null
            )}
          </div>
        )}
        {selectedFile && currentContent !== null && (
          <pre style={{
            fontSize: 11,
            color: '#d1d5db',
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            margin: 0,
            fontFamily: 'ui-monospace, monospace',
          }}>
            {currentContent}
          </pre>
        )}
      </div>
    </div>
  );
}

function FileRow({
  label, fileKey, exists, runtimeGenerated, editable, selected, onClick,
}: {
  label: string;
  fileKey: string;
  exists: boolean;
  runtimeGenerated: boolean;
  editable: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <div
      onClick={exists ? onClick : undefined}
      style={{
        padding: '4px 8px',
        cursor: exists ? 'pointer' : 'default',
        borderRadius: 3,
        fontSize: 11,
        color: selected ? '#e0e7ff' : exists ? '#9ca3af' : '#374151',
        background: selected ? '#3730a322' : 'transparent',
        marginBottom: 1,
        display: 'flex',
        alignItems: 'center',
        gap: 5,
      }}
      title={fileKey}
    >
      <span style={{ fontSize: 9, color: exists ? '#6b7280' : '#1f2937' }}>●</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        {runtimeGenerated && <span style={ROW_RUNTIME_BADGE_STYLE}>runtime</span>}
        {!exists && <span style={{ fontSize: 9, color: '#374151' }}>empty</span>}
      </div>
    </div>
  );
}

const SECTION_LABEL: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.08em',
  color: '#4b5563',
  textTransform: 'uppercase',
  marginBottom: 6,
};

const MUTED: React.CSSProperties = {
  fontSize: 11,
  color: '#4b5563',
  fontStyle: 'italic',
  padding: '4px 0',
};

const ROW_RUNTIME_BADGE_STYLE: React.CSSProperties = {
  fontSize: 9,
  color: '#fbbf24',
  border: '1px solid #92400e',
  background: '#451a03',
  borderRadius: 999,
  padding: '1px 5px',
  flexShrink: 0,
};

const ROW_EDIT_BADGE_STYLE: React.CSSProperties = {
  fontSize: 9,
  color: '#86efac',
  border: '1px solid #166534',
  background: '#052e16',
  borderRadius: 999,
  padding: '1px 5px',
  flexShrink: 0,
};

const RUNTIME_BADGE_STYLE: React.CSSProperties = {
  fontSize: 10,
  color: '#fbbf24',
  border: '1px solid #92400e',
  background: '#451a03',
  borderRadius: 999,
  padding: '2px 7px',
};

const EDITABLE_BADGE_STYLE: React.CSSProperties = {
  fontSize: 10,
  color: '#86efac',
  border: '1px solid #166534',
  background: '#052e16',
  borderRadius: 999,
  padding: '2px 7px',
};
