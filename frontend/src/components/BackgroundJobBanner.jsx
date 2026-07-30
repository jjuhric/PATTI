import React from 'react';
import { Loader2 } from 'lucide-react';

// Live "PATTI is working on something in the background" indicator - shown whenever a
// long-running job like dev_project's project builder is in progress, so the chat stays
// honest about why input is locked (see ChatPane's backgroundJob prop) instead of going
// silent between the "started" message and the eventual results-chat post.
function BackgroundJobBanner({ backgroundJob }) {
  if (!backgroundJob) return null;

  return (
    <div
      className="background-job-banner"
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '10px 16px',
        margin: '0 0 8px 0',
        borderRadius: '10px',
        background: 'rgba(139, 92, 246, 0.12)',
        border: '1px solid var(--border-glass, rgba(139, 92, 246, 0.35))',
        color: '#fff',
        fontSize: '0.85rem'
      }}
    >
      <Loader2 size={16} className="animate-spin" />
      <span style={{ fontWeight: 600 }}>{backgroundJob.agent || 'PATTI'}</span>
      <span style={{ opacity: 0.85 }}>{backgroundJob.label || 'Working...'}</span>
    </div>
  );
}

export default BackgroundJobBanner;
