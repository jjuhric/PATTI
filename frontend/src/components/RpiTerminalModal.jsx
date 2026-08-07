import React, { useState, useEffect, useRef } from 'react';
import { X, Terminal as TerminalIcon, Settings, Play } from 'lucide-react';

export default function RpiTerminalModal({ isOpen, onClose, node, token, onNodeUpdated }) {
  const [activeTab, setActiveTab] = useState('terminal'); // 'terminal' or 'settings'
  const [sshUser, setSshUser] = useState('');
  const [sshPass, setSshPass] = useState('');
  const [sshKey, setSshKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  
  const terminalRef = useRef(null);
  const xtermInstance = useRef(null);
  const socketRef = useRef(null);
  const [scriptsLoaded, setScriptsLoaded] = useState(false);

  // Load RPi-specific node credentials when node changes
  useEffect(() => {
    if (node) {
      setSshUser(node.ssh_username || 'jeffery-uhrick');
      setSshPass(node.ssh_password || '');
      setSshKey(node.ssh_key || '');
      setError('');
      setSuccess('');
      
      // If credentials are completely empty, default to settings tab first
      if (!node.ssh_username && !node.ssh_password && !node.ssh_key) {
        setActiveTab('settings');
      } else {
        setActiveTab('terminal');
      }
    }
  }, [node]);

  // Load xterm.js from CDN dynamically
  useEffect(() => {
    if (!isOpen) return;

    const checkLoaded = () => {
      if (window.Terminal) {
        setScriptsLoaded(true);
      } else {
        setTimeout(checkLoaded, 100);
      }
    };

    // Load xterm CSS
    if (!document.getElementById('xterm-css')) {
      const link = document.createElement('link');
      link.id = 'xterm-css';
      link.rel = 'stylesheet';
      link.href = 'https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css';
      document.head.appendChild(link);
    }

    // Load xterm JS
    if (!document.getElementById('xterm-js')) {
      const script = document.createElement('script');
      script.id = 'xterm-js';
      script.src = 'https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js';
      script.onload = checkLoaded;
      document.head.appendChild(script);
    } else {
      checkLoaded();
    }
  }, [isOpen]);

  // Establish Terminal session
  useEffect(() => {
    if (!isOpen || !node || !scriptsLoaded || activeTab !== 'terminal') {
      // Clean up previous socket if moving away or closing
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
      if (xtermInstance.current) {
        xtermInstance.current.dispose();
        xtermInstance.current = null;
      }
      return;
    }

    // Double check terminal node ref exists
    if (!terminalRef.current) return;

    // Initialize xterm
    const term = new window.Terminal({
      cursorBlink: true,
      theme: {
        background: '#0f172a',
        foreground: '#f8fafc',
        cursor: '#22c55e',
        selection: 'rgba(34, 197, 94, 0.3)'
      },
      fontSize: 13,
      fontFamily: 'Consolas, "Liberation Mono", Menlo, Courier, monospace',
      rows: 22,
      cols: 80
    });

    term.open(terminalRef.current);
    term.focus();
    xtermInstance.current = term;

    // Connect to WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // SEC-5: no ?token= here - the httpOnly auth cookie set on login is sent automatically on
    // this same-origin WebSocket upgrade (see terminal_service.js's cookie-based auth).
    const wsUrl = `${protocol}//${window.location.host}/api/terminal?ip=${encodeURIComponent(node.ip_address)}`;
    
    const ws = new WebSocket(wsUrl);
    socketRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'data') {
          term.write(msg.data);
        } else if (msg.type === 'status') {
          term.write(`\r\n\x1b[1;32m[SYSTEM]: ${msg.message}\x1b[0m\r\n`);
        }
      } catch (err) {
        // Raw data format fallback
        term.write(event.data);
      }
    };

    ws.onclose = () => {
      term.write('\r\n\x1b[1;31m[SYSTEM]: Terminal socket connection closed.\x1b[0m\r\n');
    };

    ws.onerror = (err) => {
      term.write(`\r\n\x1b[1;31m[SYSTEM]: Connection error. See browser logs.\x1b[0m\r\n`);
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'data', data }));
      }
    });

    // Cleanup session on unmount/re-effect
    return () => {
      if (ws) ws.close();
      if (term) term.dispose();
      xtermInstance.current = null;
      socketRef.current = null;
    };
  }, [isOpen, node, scriptsLoaded, activeTab, token]);

  if (!isOpen) return null;

  const handleSaveCredentials = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');

    try {
      const res = await fetch(`/api/nodes/${node.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          node_name: node.node_name,
          device_type: node.device_type,
          ip_address: node.ip_address,
          port: node.port,
          is_online: node.is_online,
          ssh_username: sshUser,
          ssh_password: sshPass,
          ssh_key: sshKey
        })
      });

      if (res.ok) {
        setSuccess('SSH credentials saved successfully.');
        if (onNodeUpdated) {
          onNodeUpdated();
        }
        // Switch back to terminal view after brief delay
        setTimeout(() => {
          setActiveTab('terminal');
        }, 1000);
      } else {
        const errData = await res.json();
        setError(errData.error || 'Failed to save node credentials.');
      }
    } catch (err) {
      console.error(err);
      setError('Network error saving credentials.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 1200 }}>
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '680px', width: '100%' }}>
        <div className="modal-header" style={{ paddingBottom: '12px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <TerminalIcon size={22} style={{ color: 'var(--accent-primary)' }} />
            <div>
              <h3 style={{ margin: 0, color: 'var(--text-primary)', fontSize: '1.15rem', fontWeight: 600 }}>
                SSH Terminal - {node.node_name}
              </h3>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {node.ip_address} ({node.device_type})
              </span>
            </div>
          </div>
          <button className="btn-icon" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        {/* Tab navigation */}
        <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.05)', background: 'rgba(0,0,0,0.1)' }}>
          <button
            onClick={() => setActiveTab('terminal')}
            style={{
              flex: 1,
              padding: '12px',
              border: 'none',
              background: activeTab === 'terminal' ? 'rgba(255,255,255,0.05)' : 'transparent',
              color: activeTab === 'terminal' ? 'var(--accent-primary)' : 'var(--text-secondary)',
              cursor: 'pointer',
              fontWeight: activeTab === 'terminal' ? 600 : 400,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              borderBottom: activeTab === 'terminal' ? '2px solid var(--accent-primary)' : 'none'
            }}
          >
            <Play size={14} /> Terminal Console
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            style={{
              flex: 1,
              padding: '12px',
              border: 'none',
              background: activeTab === 'settings' ? 'rgba(255,255,255,0.05)' : 'transparent',
              color: activeTab === 'settings' ? 'var(--accent-primary)' : 'var(--text-secondary)',
              cursor: 'pointer',
              fontWeight: activeTab === 'settings' ? 600 : 400,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              borderBottom: activeTab === 'settings' ? '2px solid var(--accent-primary)' : 'none'
            }}
          >
            <Settings size={14} /> SSH Connection Details
          </button>
        </div>

        {/* Tab contents */}
        <div style={{ padding: '20px' }}>
          {activeTab === 'terminal' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div 
                ref={terminalRef} 
                style={{ 
                  width: '100%', 
                  background: '#0f172a', 
                  borderRadius: '10px', 
                  padding: '12px', 
                  border: '1px solid rgba(255,255,255,0.05)'
                }}
              />
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', justifyContent: 'space-between' }}>
                <span>Type directly in the shell. Use standard Linux commands.</span>
                <span>Port: 22</span>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSaveCredentials} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div className="form-group">
                <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                  SSH Username
                </label>
                <input
                  type="text"
                  className="form-control"
                  placeholder="e.g. pi or jeffery-uhrick"
                  value={sshUser}
                  onChange={e => setSshUser(e.target.value)}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-glass)', color: '#fff' }}
                  required
                />
              </div>

              <div className="form-group">
                <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                  SSH Password
                </label>
                <input
                  type="password"
                  className="form-control"
                  placeholder="••••••••"
                  value={sshPass}
                  onChange={e => setSshPass(e.target.value)}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-glass)', color: '#fff' }}
                />
              </div>

              <div className="form-group">
                <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                  Private Key (PEM Format - Optional)
                </label>
                <textarea
                  className="form-control"
                  rows={4}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
                  value={sshKey}
                  onChange={e => setSshKey(e.target.value)}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-glass)', color: '#fff', fontFamily: 'monospace', resize: 'vertical' }}
                />
              </div>

              {error && <div style={{ color: '#ef4444', fontSize: '0.85rem' }}>⚠️ {error}</div>}
              {success && <div style={{ color: '#34d399', fontSize: '0.85rem' }}>✓ {success}</div>}

              <button
                type="submit"
                className="btn btn-primary"
                disabled={saving}
                style={{
                  padding: '12px',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontWeight: 600,
                  background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
                  border: 'none',
                  color: '#fff'
                }}
              >
                {saving ? 'Saving...' : 'Save & Connect'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
