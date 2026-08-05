import React, { useState, useEffect, useRef } from 'react';
import { X } from 'lucide-react';

// BUG-6 (docs/REVIEW_2026-08-03.md): a long-lived SSE connection must never let logs grow
// unbounded - applied uniformly to every setLogs call, not just the main stream handler.
const MAX_LOG_LINES = 400;

export default function LMStudioLogsView({ token }) {
  const [logs, setLogs] = useState([]);
  const [status, setStatus] = useState('connecting');
  const [filter, setFilter] = useState('all'); // 'all', 'server', 'model'
  const [modalConfig, setModalConfig] = useState(null); // { question: '', choices: [], onSelect: () => {} }
  const eventSourceRef = useRef(null);

  const handleClearLogs = () => {
    setModalConfig({
      question: "Wipe all local LM Studio logs from the active log file on disk?",
      choices: [
        { label: "Cancel", value: "cancel", className: "btn-secondary" },
        { label: "Yes, Clear Logs", value: "clear", className: "btn-primary" }
      ],
      onSelect: (val) => {
        if (val === 'clear') triggerClearLogs();
      }
    });
  };

  const handleStopStream = () => {
    setModalConfig({
      question: "Are you sure you want to terminate the active log collection stream? Live captured CLI logs will stop.",
      choices: [
        { label: "Cancel", value: "cancel", className: "btn-secondary" },
        { label: "Yes, Stop Stream", value: "stop", className: "btn-primary" }
      ],
      onSelect: (val) => {
        if (val === 'stop') {
          if (eventSourceRef.current) {
            eventSourceRef.current.close();
            eventSourceRef.current = null;
          }
          setStatus('disconnected');
          setLogs(prev => [...prev, { time: new Date().toLocaleTimeString(), type: 'system', text: 'Live log stream stopped by user request.' }].slice(-MAX_LOG_LINES));
        }
      }
    });
  };

  const handleEjectModel = () => {
    setModalConfig({
      question: "Eject the currently loaded local model from memory to free up system resources?",
      choices: [
        { label: "Cancel", value: "cancel", className: "btn-secondary" },
        { label: "Yes, Eject Model", value: "eject", className: "btn-primary" }
      ],
      onSelect: (val) => {
        if (val === 'eject') triggerEjectModel();
      }
    });
  };

  const triggerClearLogs = async () => {
    try {
      const res = await fetch('/api/lmstudio/clear-logs', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        setLogs([]);
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to clear logs.');
      }
    } catch (err) {
      alert(`Error clearing logs: ${err.message}`);
    }
  };

  const triggerEjectModel = async () => {
    try {
      const res = await fetch('/api/lmstudio/eject-model', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setLogs(prev => [...prev, { time: new Date().toLocaleTimeString(), type: 'system', text: `Success: ${data.message || 'Model ejected.'}` }].slice(-MAX_LOG_LINES));
        alert(data.message || 'Model ejected successfully.');
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to eject model.');
      }
    } catch (err) {
      alert(`Error ejecting model: ${err.message}`);
    }
  };

  useEffect(() => {
    let url = `/api/lmstudio/log-stream?token=${encodeURIComponent(token)}`;
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setStatus('connected');
      setLogs(prev => [...prev, { time: new Date().toLocaleTimeString(), type: 'system', text: 'Live log stream connection established.' }].slice(-MAX_LOG_LINES));
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        let logText = data.message;
        let logType = data.type; // 'log', 'stderr', 'error'
        let parsedMessage = null;

        try {
          parsedMessage = JSON.parse(logText);
        } catch (e) {
          // message is raw text
        }

        setLogs(prev => {
          const newLogs = [...prev, {
            time: new Date().toLocaleTimeString(),
            type: logType,
            rawText: logText,
            parsed: parsedMessage
          }];
          return newLogs.slice(-MAX_LOG_LINES);
        });
      } catch (err) {
        console.error('Failed to parse SSE message:', err);
      }
    };

    eventSource.onerror = () => {
      if (!eventSourceRef.current) return;
      setStatus('disconnected');
      setLogs(prev => [...prev, { time: new Date().toLocaleTimeString(), type: 'error', text: 'Connection lost. Reconnecting...' }].slice(-MAX_LOG_LINES));
    };

    return () => {
      eventSource.close();
      eventSourceRef.current = null;
    };
  }, [token]);

  // Filter logs
  const filteredLogs = logs.filter(log => {
    if (filter === 'all') return true;
    if (log.parsed) {
      return log.parsed.source === filter;
    }
    return false;
  });

  // Automatically scroll to bottom of logs
  const terminalEndRef = useRef(null);
  useEffect(() => {
    if (terminalEndRef.current && typeof terminalEndRef.current.scrollIntoView === 'function') {
      terminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [filteredLogs]);

  return (
    <div className="card" style={{ background: 'rgba(10, 15, 30, 0.7)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '24px', display: 'flex', flexDirection: 'column', height: '600px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: '1.2rem', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: status === 'connected' ? '#10b981' : '#f59e0b', display: 'inline-block' }}></span>
            LM Studio Log Stream
          </h3>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            Status: {status} (CLI output captures)
          </span>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {['all', 'server', 'model'].map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                background: filter === f ? 'var(--accent-primary)' : 'rgba(255,255,255,0.05)',
                border: 'none',
                color: '#fff',
                fontSize: '0.75rem',
                padding: '4px 10px',
                borderRadius: '6px',
                cursor: 'pointer'
              }}
            >
              {f.toUpperCase()}
            </button>
          ))}
          <button
            onClick={handleClearLogs}
            style={{
              background: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid rgba(239, 68, 68, 0.35)',
              color: '#fca5a5',
              fontSize: '0.75rem',
              padding: '4px 10px',
              borderRadius: '6px',
              cursor: 'pointer',
              marginLeft: '8px'
            }}
          >
            Clear Logs
          </button>
          <button
            onClick={handleStopStream}
            disabled={status !== 'connected'}
            style={{
              background: 'rgba(245, 158, 11, 0.15)',
              border: '1px solid rgba(245, 158, 11, 0.35)',
              color: '#fcd34d',
              fontSize: '0.75rem',
              padding: '4px 10px',
              borderRadius: '6px',
              cursor: status === 'connected' ? 'pointer' : 'not-allowed',
              opacity: status === 'connected' ? 1 : 0.5,
              marginLeft: '8px'
            }}
          >
            Stop
          </button>
          <button
            onClick={handleEjectModel}
            style={{
              background: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid rgba(239, 68, 68, 0.35)',
              color: '#fca5a5',
              fontSize: '0.75rem',
              padding: '4px 10px',
              borderRadius: '6px',
              cursor: 'pointer',
              marginLeft: '8px'
            }}
          >
            Eject
          </button>
        </div>
      </div>

      <div style={{
        flexGrow: 1,
        background: 'rgba(0,0,0,0.4)',
        border: '1px solid rgba(255,255,255,0.05)',
        borderRadius: '8px',
        padding: '16px',
        fontFamily: 'monospace',
        fontSize: '0.85rem',
        overflowY: 'auto',
        whiteSpace: 'pre-wrap',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px'
      }}>
        {filteredLogs.map((log, idx) => {
          if (log.type === 'system') {
            return (
              <div key={idx} style={{ color: '#60a5fa' }}>
                [{log.time}] SYSTEM: {log.text}
              </div>
            );
          }
          if (log.type === 'error') {
            return (
              <div key={idx} style={{ color: '#f87171' }}>
                [{log.time}] ERROR: {log.text || log.rawText}
              </div>
            );
          }
          if (log.type === 'stderr') {
            return (
              <div key={idx} style={{ color: '#fb923c' }}>
                [{log.time}] STDERR: {log.rawText}
              </div>
            );
          }

          // Parse and render formatted json log from lms
          if (log.parsed) {
            const p = log.parsed;
            const levelColor = p.level === 'error' ? '#f87171' : p.level === 'warning' ? '#fb923c' : '#34d399';
            const sourceColor = p.source === 'model' ? '#a78bfa' : '#60a5fa';
            return (
              <div key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.02)', paddingBottom: '2px' }}>
                <span style={{ color: '#6b7280' }}>[{log.time}]</span>{' '}
                <span style={{ color: sourceColor }}>[{p.source || 'server'}]</span>{' '}
                <span style={{ color: levelColor }}>{p.level?.toUpperCase() || 'INFO'}:</span>{' '}
                <span style={{ color: '#e2e8f0' }}>{p.message}</span>
                {p.stats && (
                  <span style={{ color: '#a7f3d0', marginLeft: '8px', fontSize: '0.75rem' }}>
                    ({JSON.stringify(p.stats)})
                  </span>
                )}
              </div>
            );
          }

          return (
            <div key={idx}>
              <span style={{ color: '#6b7280' }}>[{log.time}]</span> {log.rawText}
            </div>
          );
        })}
        <div ref={terminalEndRef} />
      </div>

      {modalConfig && (
        <div className="modal-overlay" onClick={() => setModalConfig(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '440px' }}>
            <div className="modal-header">
              <h3 style={{ margin: 0, color: '#fff' }}>Emergency Interaction Required</h3>
              <button className="btn-icon" onClick={() => setModalConfig(null)}>
                <X size={20} />
              </button>
            </div>
            <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <p style={{ fontSize: '0.9rem', color: '#fff', fontWeight: '500', margin: 0 }}>
                {modalConfig.question}
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {modalConfig.choices.map((choice, idx) => (
                  <button 
                    key={idx}
                    className={`btn ${choice.className || 'btn-secondary'}`}
                    onClick={() => {
                      setModalConfig(null);
                      modalConfig.onSelect(choice.value);
                    }}
                    style={{ width: '100%', padding: '10px', textAlign: 'center' }}
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
