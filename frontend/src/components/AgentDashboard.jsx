import React, { useState, useEffect } from 'react';
import { Trash2, ExternalLink, RefreshCw } from 'lucide-react';
import DataTable from './DataTable';
import { useApi } from '../hooks/useApi';

export default function AgentDashboard({ nodes = [], token, handleDeleteNode, onRefresh, activeSubTab = 'nodes', onRequestConfirm }) {
  const api = useApi(token);
  const [scanning, setScanning] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // FEAT-3 (docs/REVIEW_2026-08-03.md): bulk delete, firing the same per-node DELETE endpoint
  // the single-delete button (handleDeleteNode, owned by App.jsx) eventually calls.
  const handleBulkDeleteNodes = (selectedNodes, clearSelection) => {
    if (selectedNodes.length === 0) return;
    const label = `${selectedNodes.length} node${selectedNodes.length === 1 ? '' : 's'}`;
    const message = `Delete ${label}? This cannot be undone.`;
    const run = async () => {
      await Promise.all(selectedNodes.map((n) => api.delete(`/api/nodes/${n.id}`)));
      clearSelection();
      if (typeof onRefresh === 'function') onRefresh();
    };
    if (onRequestConfirm) {
      onRequestConfirm({ type: 'confirm', title: 'PATTI', message, onConfirm: run });
    } else {
      if (!window.confirm(message)) return;
      run();
    }
  };

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
      {activeSubTab === 'nodes' && (() => {
        // FEAT-10 (docs/REVIEW_2026-08-03.md): this dedup/filter step works around apparent
        // duplicate/stale rows and a hardcoded gateway IP coming back from the backend - left
        // in place as-is here (fixing the root cause is a separate backend investigation), but
        // now feeds a real DataTable (FEAT-1) instead of a hand-rolled unbounded table.
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

        const onlineNodes = uniqueNodes.filter(node => node.is_online === 1 || node.is_online === true);

        return (
          <DataTable
            columns={[
              {
                key: 'status',
                label: 'Status',
                searchable: false,
                render: () => <div className="bg-success" style={{ width: 12, height: 12, borderRadius: '50%' }} />
              },
              { key: 'node_name', label: 'Node Name', sortable: true },
              { key: 'device_type', label: 'Device Signature', sortable: true },
              {
                key: 'ip_address',
                label: 'Network IP Address',
                sortable: true,
                searchValue: (node) => `${node.ip_address}:${node.port}`,
                render: (node) => `${node.ip_address}:${node.port}`
              },
              {
                key: 'health',
                label: 'Health Status',
                searchable: false,
                render: () => (
                  <span className="bg-success" style={{ padding: '2px 8px', borderRadius: 4, color: '#fff', fontWeight: 600 }}>
                    Healthy
                  </span>
                )
              },
              {
                key: 'actions',
                label: 'Actions',
                searchable: false,
                render: (node) => (
                  <button className="btn btn-ghost btn-sm text-error" onClick={() => handleDeleteNode(node.id)} aria-label={`Delete node ${node.node_name}`}>
                    <Trash2 size={16} />
                  </button>
                )
              }
            ]}
            data={onlineNodes}
            getRowKey={(node) => node.id}
            getRowLabel={(node) => node.node_name}
            searchPlaceholder="Search nodes..."
            emptyMessage="No online nodes found."
            pageSize={10}
            exportable
            exportFilename="patti-nodes"
            selectable
            bulkActions={(selectedNodes, clearSelection) => (
              <button className="btn btn-sm text-error" onClick={() => handleBulkDeleteNodes(selectedNodes, clearSelection)}>
                Delete {selectedNodes.length} node{selectedNodes.length === 1 ? '' : 's'}
              </button>
            )}
          />
        );
      })()}
    </div>
  );
}
