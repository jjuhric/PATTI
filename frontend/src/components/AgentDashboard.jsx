import React, { useState, useEffect } from 'react';
import { Trash2, ExternalLink, RefreshCw } from 'lucide-react';

export default function AgentDashboard({ nodes = [], token, handleDeleteNode, onRefresh, activeSubTab = 'nodes' }) {
  const [scanning, setScanning] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleScan = async () => {
    setScanning(true);
    try {
      const res = await fetch('/api/nodes/scan', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (res.ok) {
        if (typeof onRefresh === 'function') {
          await onRefresh();
        }
        setRefreshKey(prev => prev + 1);
      } else {
        alert('Network scan failed.');
      }
    } catch (err) {
      alert('Error during scan: ' + err.message);
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    if (activeSubTab === 'nodes') {
      const interval = setInterval(() => {
        if (typeof onRefresh === 'function') {
          onRefresh();
        }
      }, 15 * 60 * 1000); // 15-minute polling interval
      
      return () => clearInterval(interval);
    }
  }, [activeSubTab, refreshKey]);

  return (
    <div className="chat-pane" style={{ overflowY: 'auto', padding: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0, color: '#fff' }}>Agent Dashboard</h2>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '4px 0 0 0' }}>
            Monitor and manage active network nodes.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <button
            onClick={handleScan}
            disabled={scanning}
            className="btn btn-secondary"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              padding: '10px 20px',
              fontSize: '0.9rem',
              borderRadius: '10px',
              color: '#fff',
              fontWeight: 600,
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid var(--border-glass)',
              cursor: 'pointer'
            }}
          >
            <RefreshCw size={16} className={scanning ? 'animate-spin' : ''} />
            {scanning ? 'Scanning Subnet...' : 'Scan Network'}
          </button>
          <a
            href={`/monitor/?token=${encodeURIComponent(token)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              padding: '10px 20px',
              fontSize: '0.9rem',
              textDecoration: 'none',
              background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
              borderRadius: '10px',
              color: '#fff',
              fontWeight: 600,
              boxShadow: '0 4px 15px rgba(139, 92, 246, 0.25)'
            }}
          >
            <ExternalLink size={16} /> Launch Standalone Monitor
          </a>
        </div>
      </div>
      {activeSubTab === 'nodes' && (
        <div className="overflow-x-auto w-full">
          <table className="table table-zebra w-full text-sm">
            <thead>
              <tr className="border-b border-base-300 text-left text-neutral-content">
                <th>Status</th>
                <th>Node Name</th>
                <th>Device Signature</th>
                <th>Network IP Address</th>
                <th>Health Status</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const uniqueNodes = [];
                const ipMap = new Map();

                // Sort nodes to prioritize google_home devices over Google Assistant duplicates
                const sortedNodes = [...nodes].sort((a, b) => {
                  if (a.device_type === 'google_home' && b.device_type !== 'google_home') return -1;
                  if (b.device_type === 'google_home' && a.device_type !== 'google_home') return 1;
                  return 0;
                });

                for (const node of sortedNodes) {
                  // Hide gateway/subnet IP 192.168.1.1
                  if (node.ip_address === '192.168.1.1') {
                    continue;
                  }
                  // Hide duplicate IPs (keeps first match, which prefers google_home due to sorting)
                  if (!ipMap.has(node.ip_address)) {
                    ipMap.set(node.ip_address, node);
                    uniqueNodes.push(node);
                  }
                }

                return uniqueNodes
                  .filter(node => node.is_online === 1 || node.is_online === true)
                  .map(node => {
                    return (
                      <tr key={node.id} className="border-b border-base-300">
                        <td>
                          <div className="w-3 h-3 rounded-full bg-success shadow-lg" />
                        </td>
                        <td className="font-bold">{node.node_name}</td>
                        <td>{node.device_type}</td>
                        <td>{node.ip_address}:{node.port}</td>
                        <td>
                          <span className="px-2 py-1 rounded text-white font-semibold bg-success">
                            Healthy
                          </span>
                        </td>
                        <td className="text-right">
                          <button className="btn btn-ghost btn-sm text-error" onClick={() => handleDeleteNode(node.id)} aria-label={`Delete node ${node.node_name}`}>
                            <Trash2 size={16} />
                          </button>
                        </td>
                      </tr>
                    );
                  });
              })()}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
