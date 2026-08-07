import React, { useState, useEffect } from 'react';
import { Trash2, Save, Shield, ShieldOff, KeyRound, Database, Users, Network, Download, Trash, Pencil, X, UserPlus } from 'lucide-react';
import DataTable from './DataTable';
import { useApi } from '../hooks/useApi';

export default function AdminDashboard({ token, currentUserId, nodes = [], handleDeleteNode, onRefreshNodes, onRequestConfirm }) {
  const api = useApi(token);
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

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createUsername, setCreateUsername] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createIsAdmin, setCreateIsAdmin] = useState(false);
  const [createSaving, setCreateSaving] = useState(false);
  const [createError, setCreateError] = useState('');

  const fetchUsers = async () => {
    setUsersError('');
    const { ok, data, error } = await api.get('/api/admin/users');
    if (ok) {
      setUsers(data);
    } else {
      setUsersError(error || 'Failed to fetch users.');
    }
  };

  const fetchDbStats = async () => {
    const { ok, data, error } = await api.get('/api/admin/db/stats');
    if (ok) {
      setDbStats(data);
    } else {
      console.error('Failed to fetch DB stats:', error);
    }
  };

  useEffect(() => {
    if (section === 'users') fetchUsers();
    if (section === 'database') fetchDbStats();
  }, [section]);

  const handleUpdateQuota = async (userId, newQuota) => {
    setUsersError('');
    setUsersSuccess('');
    const { ok, error } = await api.put(`/api/admin/users/${userId}/quota`, { token_quota: parseInt(newQuota, 10) });
    if (ok) {
      setUsersSuccess('Quota updated successfully.');
      fetchUsers();
    } else {
      setUsersError(error || 'Failed to update quota.');
    }
  };

  const handleResetPassword = async (userId, username) => {
    const newPassword = window.prompt(`Enter a new password for "${username}" (min 4 characters):`);
    if (!newPassword) return;
    setUsersError('');
    setUsersSuccess('');
    const { ok, error } = await api.post(`/api/admin/users/${userId}/reset-password`, { newPassword });
    if (ok) {
      setUsersSuccess(`Password reset for ${username}.`);
    } else {
      setUsersError(error || 'Failed to reset password.');
    }
  };

  const handleToggleAdmin = async (userId, makeAdmin) => {
    setUsersError('');
    setUsersSuccess('');
    const { ok, data, error } = await api.put(`/api/admin/users/${userId}/admin`, { is_admin: makeAdmin });
    if (ok) {
      setUsersSuccess(data.message);
      fetchUsers();
    } else {
      setUsersError(error || 'Failed to update admin status.');
    }
  };

  // BUG-7 (docs/REVIEW_2026-08-03.md): standardized on the app's shared CustomAlertModal confirm
  // pattern instead of a native window.confirm, which looked jarringly out of place next to
  // every other confirm dialog in the app. Falls back to window.confirm if no handler was
  // passed in, so this still works standalone (e.g. in isolation/tests).
  const deleteUserNow = async (userId) => {
    setUsersError('');
    setUsersSuccess('');
    const { ok, data, error } = await api.delete(`/api/admin/users/${userId}`);
    if (ok) {
      setUsersSuccess(data.message);
      fetchUsers();
    } else {
      setUsersError(error || 'Failed to delete user.');
    }
  };

  const handleDeleteUser = (userId, username) => {
    const message = `Delete user "${username}"? This cannot be undone.`;
    if (onRequestConfirm) {
      onRequestConfirm({
        type: 'confirm',
        title: 'PATTI',
        message,
        onConfirm: () => deleteUserNow(userId)
      });
    } else {
      if (!window.confirm(message)) return;
      deleteUserNow(userId);
    }
  };

  // FEAT-3 (docs/REVIEW_2026-08-03.md): bulk delete, built on the same single-user DELETE
  // endpoint fired once per selected id rather than a new bulk backend route - simpler, and
  // reuses an already-tested endpoint. The requester's own row is never included even if
  // selected via "select all", matching the single-delete button's self-delete guard below.
  const handleBulkDeleteUsers = (selectedUsers, clearSelection) => {
    const targets = selectedUsers.filter((u) => u.id !== currentUserId);
    if (targets.length === 0) return;
    const label = `${targets.length} user${targets.length === 1 ? '' : 's'}`;
    const message = `Delete ${label}? This cannot be undone.`;
    const run = async () => {
      setUsersError('');
      setUsersSuccess('');
      const results = await Promise.all(targets.map((u) => api.delete(`/api/admin/users/${u.id}`)));
      const failed = results.filter((r) => !r.ok).length;
      if (failed > 0) {
        setUsersError(`Deleted ${targets.length - failed} of ${targets.length} users - ${failed} failed.`);
      } else {
        setUsersSuccess(`Deleted ${label}.`);
      }
      clearSelection();
      fetchUsers();
    };
    if (onRequestConfirm) {
      onRequestConfirm({ type: 'confirm', title: 'PATTI', message, onConfirm: run });
    } else {
      if (!window.confirm(message)) return;
      run();
    }
  };

  const handleBulkDeleteNodes = (selectedNodes, clearSelection) => {
    if (selectedNodes.length === 0) return;
    const label = `${selectedNodes.length} device${selectedNodes.length === 1 ? '' : 's'}`;
    const message = `Delete ${label}? This cannot be undone.`;
    const run = async () => {
      await Promise.all(selectedNodes.map((n) => api.delete(`/api/nodes/${n.id}`)));
      clearSelection();
      if (typeof onRefreshNodes === 'function') onRefreshNodes();
    };
    if (onRequestConfirm) {
      onRequestConfirm({ type: 'confirm', title: 'PATTI', message, onConfirm: run });
    } else {
      if (!window.confirm(message)) return;
      run();
    }
  };

  const openCreateModal = () => {
    setCreateUsername('');
    setCreatePassword('');
    setCreateIsAdmin(false);
    setCreateError('');
    setCreateModalOpen(true);
  };

  const closeCreateModal = () => {
    setCreateModalOpen(false);
  };

  const handleCreateUser = async () => {
    if (!createUsername.trim() || createPassword.length < 4) {
      setCreateError('Username and password (min 4 characters) are required.');
      return;
    }
    setCreateSaving(true);
    setCreateError('');
    const { ok, error } = await api.post('/api/admin/users', { username: createUsername.trim(), password: createPassword, is_admin: createIsAdmin });
    if (ok) {
      setCreateModalOpen(false);
      setUsersSuccess(`Created account "${createUsername.trim()}".`);
      fetchUsers();
    } else {
      setCreateError(error || 'Failed to create user.');
    }
    setCreateSaving(false);
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
    const { ok, data, error } = await api.put(`/api/nodes/${editModalNode.id}`, {
      node_name: editNameInput,
      device_type: editDeviceTypeInput,
      ip_address: editModalNode.ip_address,
      port: editModalNode.port,
      is_online: editModalNode.is_online,
      ssh_username: editModalNode.ssh_username,
      ssh_password: editModalNode.ssh_password,
      ssh_key: editModalNode.ssh_key
    });
    if (ok) {
      setEditModalNode(null);
      if (typeof onRefreshNodes === 'function') onRefreshNodes();
    } else {
      setEditError((data && data.error) || error || 'Failed to update device.');
    }
    setEditSaving(false);
  };

  const handleDbCleanup = async () => {
    setDbBusy(true);
    setDbMessage('');
    const { ok, data, error } = await api.post('/api/admin/db/cleanup-duplicate-nodes');
    if (ok) {
      setDbMessage(`Cleaned up ${data.duplicateNodesDeleted} duplicate node(s) and ${data.gatewayNodesDeleted} gateway entry(s).`);
      fetchDbStats();
      if (typeof onRefreshNodes === 'function') onRefreshNodes();
    } else {
      setDbMessage(error || 'Cleanup failed.');
    }
    setDbBusy(false);
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
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button
              className="btn btn-primary"
              onClick={openCreateModal}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderRadius: 8, fontSize: '0.85rem' }}
            >
              <UserPlus size={16} /> Create User
            </button>
          </div>
          {usersError && <div style={{ color: 'var(--error)', fontSize: '0.85rem', marginBottom: 12 }}>{usersError}</div>}
          {usersSuccess && <div style={{ color: 'var(--success)', fontSize: '0.85rem', marginBottom: 12 }}>{usersSuccess}</div>}
          {/* FEAT-1 (docs/REVIEW_2026-08-03.md): sort/filter/paginate via the shared DataTable
              instead of a bare unbounded <table>. */}
          <DataTable
            columns={[
              {
                key: 'username',
                label: 'Username',
                sortable: true,
                searchValue: (u) => `${u.username} ${u.name || ''}`,
                render: (u) => <>{u.username} {u.name ? `(${u.name})` : ''}</>
              },
              {
                key: 'is_admin',
                label: 'Admin',
                sortable: true,
                searchValue: (u) => (u.is_admin === 1 ? 'Yes' : 'No'),
                render: (u) => (u.is_admin === 1 ? 'Yes' : 'No')
              },
              {
                key: 'token_quota',
                label: 'Token Quota',
                sortable: true,
                render: (u) => (
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
                )
              },
              {
                key: 'total_used_24h',
                label: '24h Usage',
                sortable: true,
                // A render-only column with no searchValue is silently excluded from both
                // search and export (see DataTable.jsx's defaultSearchValue) - this one has a
                // real underlying number worth both, so give it one.
                searchValue: (u) => u.total_used_24h,
                render: (u) => `${u.total_used_24h.toLocaleString()} tokens`
              },
              {
                key: 'actions',
                label: 'Actions',
                searchable: false,
                render: (u) => (
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
                )
              }
            ]}
            data={users}
            getRowKey={(u) => u.id}
            getRowLabel={(u) => u.username}
            searchPlaceholder="Search users..."
            emptyMessage="No users found."
            pageSize={10}
            exportable
            exportFilename="patti-users"
            selectable
            bulkActions={(selectedUsers, clearSelection) => {
              const targets = selectedUsers.filter((u) => u.id !== currentUserId);
              if (targets.length === 0) {
                return <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>Your own account can't be bulk-deleted.</span>;
              }
              return (
                <button className="btn btn-sm text-error" onClick={() => handleBulkDeleteUsers(selectedUsers, clearSelection)}>
                  Delete {targets.length} user{targets.length === 1 ? '' : 's'}
                </button>
              );
            }}
          />
        </div>
      )}

      {section === 'devices' && (
        // FEAT-1: same DataTable treatment as the Users table above.
        <DataTable
          columns={[
            { key: 'node_name', label: 'Name', sortable: true },
            {
              key: 'node_role',
              label: 'Role',
              sortable: true,
              searchValue: (node) => (node.node_role === 'patti_client' ? 'PATTI Client' : 'Node'),
              render: (node) => (
                <span
                  className="badge"
                  style={node.node_role === 'patti_client'
                    ? { background: 'var(--accent-primary, #6366f1)', color: '#fff' }
                    : {}}
                  title={node.node_role === 'patti_client'
                    ? 'Full PATTI instance sharing this host\'s LLM'
                    : 'Lightweight sensor/actuator edge device'}
                >
                  {node.node_role === 'patti_client' ? 'PATTI Client' : 'Node'}
                </span>
              )
            },
            { key: 'device_type', label: 'Device Type', sortable: true },
            {
              key: 'ip_address',
              label: 'IP Address',
              sortable: true,
              searchValue: (node) => `${node.ip_address}:${node.port}`,
              render: (node) => `${node.ip_address}:${node.port}`
            },
            {
              key: 'is_online',
              label: 'Status',
              sortable: true,
              searchValue: (node) => (node.is_online ? 'Online' : 'Offline'),
              render: (node) => (node.is_online ? 'Online' : 'Offline')
            },
            {
              key: 'actions',
              label: 'Actions',
              searchable: false,
              render: (node) => (
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button className="btn btn-ghost btn-sm" title="Edit device" onClick={() => openEditModal(node)}>
                    <Pencil size={16} />
                  </button>
                  <button className="btn btn-ghost btn-sm text-error" title="Delete device" onClick={() => handleDeleteNode(node.id)}>
                    <Trash2 size={16} />
                  </button>
                </div>
              )
            }
          ]}
          data={nodes}
          getRowKey={(node) => node.id}
          getRowLabel={(node) => node.node_name}
          searchPlaceholder="Search devices..."
          emptyMessage="No devices found."
          pageSize={10}
          exportable
          exportFilename="patti-devices"
          selectable
          bulkActions={(selectedNodes, clearSelection) => (
            <button className="btn btn-sm text-error" onClick={() => handleBulkDeleteNodes(selectedNodes, clearSelection)}>
              Delete {selectedNodes.length} device{selectedNodes.length === 1 ? '' : 's'}
            </button>
          )}
        />
      )}

      {createModalOpen && (
        <div className="modal-overlay" onClick={closeCreateModal} style={{ zIndex: 1100 }}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '420px' }}>
            <div className="modal-header">
              <h3 style={{ margin: 0 }}>Create User</h3>
              <button className="btn-icon" onClick={closeCreateModal}>
                <X size={18} />
              </button>
            </div>
            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              {createError && <div style={{ color: 'var(--error)', fontSize: '0.85rem' }}>{createError}</div>}
              <div className="form-group" style={{ margin: 0 }}>
                <label htmlFor="create-user-username">Username</label>
                <input
                  id="create-user-username"
                  type="text"
                  className="form-control"
                  value={createUsername}
                  onChange={e => setCreateUsername(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label htmlFor="create-user-password">Password</label>
                <input
                  id="create-user-password"
                  type="password"
                  className="form-control"
                  value={createPassword}
                  onChange={e => setCreatePassword(e.target.value)}
                  placeholder="Min 4 characters"
                />
              </div>
              <label htmlFor="create-user-is-admin" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem', cursor: 'pointer' }}>
                <input
                  id="create-user-is-admin"
                  type="checkbox"
                  checked={createIsAdmin}
                  onChange={e => setCreateIsAdmin(e.target.checked)}
                />
                Grant admin access
              </label>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
                This bypasses the registration invite code - the account is ready to log in immediately.
              </p>
              <button
                className="btn btn-primary"
                disabled={createSaving}
                onClick={handleCreateUser}
                style={{ width: '100%', padding: '10px', borderRadius: 8, marginTop: 4 }}
              >
                {createSaving ? 'Creating...' : 'Create User'}
              </button>
            </div>
          </div>
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
