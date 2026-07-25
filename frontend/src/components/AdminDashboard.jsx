import React, { useState, useEffect } from 'react';
import { Trash2, Save, Shield, ShieldOff, KeyRound, Database, Users, Network, Download, Trash, Pencil, X } from 'lucide-react';

export default function AdminDashboard({ token, currentUserId, nodes = [], handleDeleteNode, onRefreshNodes }) {
  const [section, setSection] = useState('users');

  const [users, setUsers] = useState([]);
  const [usersError, setUsersError] = useState('');
  const [usersSuccess, setUsersSuccess] = useState('');

  const [dbStats, setDbStats] = useState(null);
  const [dbBusy, setDbBusy] = useState(false);
  const [dbMessage, setDbMessage] = useState('');

  const [editModalNode, setEditModalNode] = useState(null);
  const [editNameInput, setEditNameInput] = useState('');
  const [editDeviceTypeInput, setEditDeviceTypeInput] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  const fetchUsers = async () => {
    setUsersError('');
    try {
      const res = await fetch('/api/admin/users', { headers: authHeaders });
      const data = await res.json();
      if (res.ok) {
        setUsers(data);
      } else {
        setUsersError(data.error || 'Failed to fetch users.');
      }
    } catch (err) {
      setUsersError(err.message);
    }
  };

  const fetchDbStats = async () => {
    try {
      const res = await fetch('/api/admin/db/stats', { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setDbStats(data);
    } catch (err) {
      console.error('Failed to fetch DB stats:', err);
    }
  };

  useEffect(() => {
    if (section === 'users') fetchUsers();
    if (section === 'database') fetchDbStats();
  }, [section]);

  const handleUpdateQuota = async (userId, newQuota) => {
    setUsersError('');
    setUsersSuccess('');
    try {
      const res = await fetch(`/api/admin/users/${userId}/quota`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ token_quota: parseInt(newQuota, 10) })
      });
      const data = await res.json();
      if (res.ok) {
        setUsersSuccess('Quota updated successfully.');
        fetchUsers();
      } else {
        setUsersError(data.error || 'Failed to update quota.');
      }
    } catch (err) {
      setUsersError(err.message);
    }
  };

  const handleResetPassword = async (userId, username) => {
    const newPassword = window.prompt(`Enter a new password for "${username}" (min 4 characters):`);
    if (!newPassword) return;
    setUsersError('');
    setUsersSuccess('');
    try {
      const res = await fetch(`/api/admin/users/${userId}/reset-password`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ newPassword })
      });
      const data = await res.json();
      if (res.ok) {
        setUsersSuccess(`Password reset for ${username}.`);
      } else {
        setUsersError(data.error || 'Failed to reset password.');
      }
    } catch (err) {
      setUsersError(err.message);
    }
  };

  const handleToggleAdmin = async (userId, makeAdmin) => {
    setUsersError('');
    setUsersSuccess('');
    try {
      const res = await fetch(`/api/admin/users/${userId}/admin`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ is_admin: makeAdmin })
      });
      const data = await res.json();
      if (res.ok) {
        setUsersSuccess(data.message);
        fetchUsers();
      } else {
        setUsersError(data.error || 'Failed to update admin status.');
      }
    } catch (err) {
      setUsersError(err.message);
    }
  };

  const handleDeleteUser = async (userId, username) => {
    if (!window.confirm(`Delete user "${username}"? This cannot be undone.`)) return;
    setUsersError('');
    setUsersSuccess('');
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'DELETE',
        headers: authHeaders
      });
      const data = await res.json();
      if (res.ok) {
        setUsersSuccess(data.message);
        fetchUsers();
      } else {
        setUsersError(data.error || 'Failed to delete user.');
      }
    } catch (err) {
      setUsersError(err.message);
    }
  };

  const openEditModal = (node) => {
    setEditModalNode(node);
    setEditNameInput(node.node_name);
    setEditDeviceTypeInput(node.device_type);
    setEditError('');
  };

  const closeEditModal = () => {
    setEditModalNode(null);
  };

  const saveEditModal = async () => {
    if (!editModalNode) return;
    setEditSaving(true);
    setEditError('');
    try {
      const res = await fetch(`/api/nodes/${editModalNode.id}`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({
          node_name: editNameInput,
          device_type: editDeviceTypeInput,
          ip_address: editModalNode.ip_address,
          port: editModalNode.port,
          is_online: editModalNode.is_online,
          ssh_username: editModalNode.ssh_username,
          ssh_password: editModalNode.ssh_password,
          ssh_key: editModalNode.ssh_key
        })
      });
      if (res.ok) {
        setEditModalNode(null);
        if (typeof onRefreshNodes === 'function') onRefreshNodes();
      } else {
        const data = await res.json();
        setEditError(data.error || 'Failed to update device.');
      }
    } catch (err) {
      setEditError(err.message);
    } finally {
      setEditSaving(false);
    }
  };

  const handleDbCleanup = async () => {
    setDbBusy(true);
    setDbMessage('');
    try {
      const res = await fetch('/api/admin/db/cleanup-duplicate-nodes', {
        method: 'POST',
        headers: authHeaders
      });
      const data = await res.json();
      if (res.ok) {
        setDbMessage(`Cleaned up ${data.duplicateNodesDeleted} duplicate node(s) and ${data.gatewayNodesDeleted} gateway entry(s).`);
        fetchDbStats();
        if (typeof onRefreshNodes === 'function') onRefreshNodes();
      } else {
        setDbMessage(data.error || 'Cleanup failed.');
      }
    } catch (err) {
      setDbMessage(err.message);
    } finally {
      setDbBusy(false);
    }
  };

  const handleDbBackup = () => {
    window.open(`/api/admin/db/backup?token=${encodeURIComponent(token)}`, '_blank');
  };

  const navItems = [
    { key: 'users', label: 'Users', icon: <Users size={16} /> },
    { key: 'devices', label: 'Network Devices', icon: <Network size={16} /> },
    { key: 'database', label: 'Database', icon: <Database size={16} /> }
  ];

  return (
    <div className="chat-pane" style={{ overflowY: 'auto', padding: '24px' }}>
      <div style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0, color: '#fff' }}>Admin Dashboard</h2>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '4px 0 0 0' }}>
          Manage users, network devices, and the database.
        </p>
      </div>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '20px', borderBottom: '1px solid var(--border-glass)', paddingBottom: '12px' }}>
        {navItems.map(item => (
          <button
            key={item.key}
            onClick={() => setSection(item.key)}
            className="btn btn-secondary"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 16px',
              fontSize: '0.85rem',
              borderRadius: '8px',
              fontWeight: 600,
              background: section === item.key ? 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))' : 'rgba(255,255,255,0.05)',
              border: '1px solid var(--border-glass)',
              color: '#fff',
              cursor: 'pointer'
            }}
          >
            {item.icon} {item.label}
          </button>
        ))}
      </div>

      {section === 'users' && (
        <div>
          {usersError && <div style={{ color: 'var(--error)', fontSize: '0.85rem', marginBottom: 12 }}>{usersError}</div>}
          {usersSuccess && <div style={{ color: 'var(--success)', fontSize: '0.85rem', marginBottom: 12 }}>{usersSuccess}</div>}
          <div className="overflow-x-auto w-full">
            <table className="table table-zebra w-full text-sm">
              <thead>
                <tr className="border-b border-base-300 text-left text-neutral-content">
                  <th>Username</th>
                  <th>Admin</th>
                  <th>Token Quota</th>
                  <th>24h Usage</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} className="border-b border-base-300">
                    <td className="font-bold">{u.username} {u.name ? `(${u.name})` : ''}</td>
                    <td>{u.is_admin === 1 ? 'Yes' : 'No'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input
                          type="number"
                          className="form-control"
                          style={{ width: '110px', margin: 0, padding: '4px 8px', fontSize: '0.85rem', height: '32px' }}
                          defaultValue={u.token_quota}
                          id={`admin-quota-input-${u.id}`}
                        />
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            const input = document.getElementById(`admin-quota-input-${u.id}`);
                            if (input) handleUpdateQuota(u.id, input.value);
                          }}
                        >
                          <Save size={14} />
                        </button>
                      </div>
                    </td>
                    <td>{u.total_used_24h.toLocaleString()} tokens</td>
                    <td className="text-right">
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button
                          className="btn btn-ghost btn-sm"
                          title="Reset password"
                          onClick={() => handleResetPassword(u.id, u.username)}
                        >
                          <KeyRound size={16} />
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          title={u.is_admin === 1 ? 'Remove admin access' : 'Grant admin access'}
                          onClick={() => handleToggleAdmin(u.id, u.is_admin !== 1)}
                        >
                          {u.is_admin === 1 ? <ShieldOff size={16} /> : <Shield size={16} />}
                        </button>
                        {u.id !== currentUserId && (
                          <button
                            className="btn btn-ghost btn-sm text-error"
                            title="Delete user"
                            onClick={() => handleDeleteUser(u.id, u.username)}
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {section === 'devices' && (
        <div className="overflow-x-auto w-full">
          <table className="table table-zebra w-full text-sm">
            <thead>
              <tr className="border-b border-base-300 text-left text-neutral-content">
                <th>Name</th>
                <th>Device Type</th>
                <th>IP Address</th>
                <th>Status</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map(node => (
                <tr key={node.id} className="border-b border-base-300">
                  <td className="font-bold">{node.node_name}</td>
                  <td>{node.device_type}</td>
                  <td>{node.ip_address}:{node.port}</td>
                  <td>{node.is_online ? 'Online' : 'Offline'}</td>
                  <td className="text-right">
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button className="btn btn-ghost btn-sm" title="Edit device" onClick={() => openEditModal(node)}>
                        <Pencil size={16} />
                      </button>
                      <button className="btn btn-ghost btn-sm text-error" title="Delete device" onClick={() => handleDeleteNode(node.id)}>
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editModalNode && (
        <div className="modal-overlay" onClick={closeEditModal} style={{ zIndex: 1100 }}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '420px' }}>
            <div className="modal-header">
              <h3 style={{ margin: 0 }}>Edit Device</h3>
              <button className="btn-icon" onClick={closeEditModal}>
                <X size={18} />
              </button>
            </div>
            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              {editError && <div style={{ color: 'var(--error)', fontSize: '0.85rem' }}>{editError}</div>}
              <div className="form-group" style={{ margin: 0 }}>
                <label>Preferred Name</label>
                <input
                  type="text"
                  className="form-control"
                  value={editNameInput}
                  onChange={e => setEditNameInput(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label>Device Type</label>
                <input
                  type="text"
                  className="form-control"
                  value={editDeviceTypeInput}
                  onChange={e => setEditDeviceTypeInput(e.target.value)}
                  placeholder="e.g. ESP32, RPi, Windows"
                />
              </div>
              <button
                className="btn btn-primary"
                disabled={editSaving}
                onClick={saveEditModal}
                style={{ width: '100%', padding: '10px', borderRadius: 8, marginTop: 4 }}
              >
                {editSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {section === 'database' && (
        <div>
          {dbMessage && <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 12 }}>{dbMessage}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
            {dbStats && Object.entries(dbStats).map(([table, count]) => (
              <div key={table} style={{ background: 'rgba(255,255,255,0.03)', padding: '12px', borderRadius: 8, border: '1px solid var(--border-glass)' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{table}</div>
                <div style={{ fontSize: '1.3rem', fontWeight: 700, color: '#fff' }}>{count}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" disabled={dbBusy} onClick={handleDbCleanup} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 20px', borderRadius: 10 }}>
              <Trash size={16} /> Clean up duplicate nodes
            </button>
            <button className="btn btn-primary" onClick={handleDbBackup} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 20px', borderRadius: 10 }}>
              <Download size={16} /> Download backup
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
