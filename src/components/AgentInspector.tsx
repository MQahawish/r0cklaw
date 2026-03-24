/**
 * Agent Inspector -- Phase 7
 * Click an agent, browse their workspace files live.
 */

import { useState } from 'react';
import { useQuery, useAction } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { AgentFileEntry, SocialFileEntry } from '../../convex/rocklaw/observe';

type AgentFiles = { files: AgentFileEntry[]; social: SocialFileEntry[] };

export default function AgentInspector() {
  const agents = useQuery(api.rocklaw.observe.getAgentWorkspacePaths) ?? [];
  const getAgentFiles = useAction(api.rocklaw.observe.getAgentFiles);

  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [loadedFiles, setLoadedFiles] = useState<AgentFiles | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const handleSelectAgent = async (name: string) => {
    if (selectedAgent === name) return;
    setSelectedAgent(name);
    setSelectedFile(null);
    setLoadedFiles(null);
    setLoading(true);
    try {
      const result = await getAgentFiles({ agentName: name });
      setLoadedFiles(result);
      // Auto-select Heartbeat as the first view
      const hb = result.files.find((f) => f.label === 'Heartbeat');
      if (hb?.content) setSelectedFile(hb.file);
    } finally {
      setLoading(false);
    }
  };

  const currentContent = (() => {
    if (!loadedFiles || !selectedFile) return null;
    const reg = loadedFiles.files.find((f) => f.file === selectedFile);
    if (reg) return reg.content;
    const soc = loadedFiles.social.find((s) => `social/${s.otherAgent}` === selectedFile);
    return soc?.content ?? null;
  })();

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '180px 160px 1fr', gap: 12, height: 520 }}>

      {/* Agent list */}
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

      {/* File tree */}
      <div style={{ overflowY: 'auto', borderLeft: '1px solid #1f2937', paddingLeft: 10 }}>
        <div style={SECTION_LABEL}>Files</div>
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
                selected={selectedFile === f.file}
                onClick={() => f.content !== null && setSelectedFile(f.file)}
              />
            ))}
            {loadedFiles.social.length > 0 && (
              <>
                <div style={{ ...SECTION_LABEL, marginTop: 10 }}>Relationships</div>
                {loadedFiles.social.map((s) => (
                  <FileRow
                    key={s.otherAgent}
                    label={s.otherAgent}
                    fileKey={`social/${s.otherAgent}`}
                    exists
                    selected={selectedFile === `social/${s.otherAgent}`}
                    onClick={() => setSelectedFile(`social/${s.otherAgent}`)}
                  />
                ))}
              </>
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
  label, fileKey, exists, selected, onClick,
}: {
  label: string; fileKey: string; exists: boolean; selected: boolean; onClick: () => void;
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
    >
      <span style={{ fontSize: 9, color: exists ? '#6b7280' : '#1f2937' }}>●</span>
      {label}
      {!exists && <span style={{ fontSize: 9, color: '#374151', marginLeft: 'auto' }}>empty</span>}
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
