import React, { useState, useEffect } from 'react';
import { Brain, Trash2, Clock, PlusCircle, Download } from 'lucide-react';
import { exportAsCSV, exportAsJSON } from '../utils/export';

const MEMORY_EXPORT_COLUMNS = [
  { key: 'content', label: 'Content' },
  { key: 'level', label: 'Retention' },
  { key: 'expires_at', label: 'Expires At' },
  { key: 'created_at', label: 'Created At' }
];

export default function MemoryPane({ memories, onAddMemory, onDeleteMemory, onBulkDeleteMemories = () => {} }) {
  const [newContent, setNewContent] = useState('');
  const [newLevel, setNewLevel] = useState('long-term');
  const [customDate, setCustomDate] = useState('');

  // FEAT-3 (docs/REVIEW_2026-08-03.md): bulk delete across both the long-term and short-term
  // lists - a single selection set shared by both, since "delete memory" doesn't need to
  // distinguish which card a memory happened to be sorted into.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const validIds = new Set(memories.map((m) => m.id));
      const next = new Set([...prev].filter((id) => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [memories]);
  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!newContent.trim()) return;

    let level = 'long-term';
    let days = undefined;
    let expiresAt = undefined;

    if (newLevel.startsWith('short-term')) {
      level = 'short-term';
      if (newLevel === 'short-term-30') days = 30;
      else if (newLevel === 'short-term-1') days = 1;
      else if (newLevel === 'short-term-7') days = 7;
      else if (newLevel === 'short-term-14') days = 14;
      else if (newLevel === 'short-term-90') days = 90;
      else if (newLevel === 'short-term-custom' && customDate) {
        expiresAt = new Date(customDate).toISOString();
      }
    }

    onAddMemory({ content: newContent, level, expiresAt, days });
    setNewContent('');
    setCustomDate('');
  };

  const longTermMemories = memories.filter(m => m.level === 'long-term');
  const shortTermMemories = memories.filter(m => m.level === 'short-term');

  const formatExpiration = (dateStr) => {
    if (!dateStr) return '';
    const expiry = new Date(dateStr);
    const now = new Date();
    const diffMs = expiry - now;
    if (diffMs <= 0) return 'Expired';

    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays === 1) return 'Expires tomorrow';
    return `Expires in ${diffDays} days`;
  };

  // FEAT-4 (docs/REVIEW_2026-08-03.md): export every memory (long-term + short-term together).
  const handleExportCSV = () => exportAsCSV('patti-memories.csv', memories, MEMORY_EXPORT_COLUMNS);
  const handleExportJSON = () => exportAsJSON('patti-memories.json', memories);

  return (
    <div className="chat-pane" style={{ overflowY: 'auto' }}>
      <div style={{ padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', marginBottom: '28px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div style={{
              background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.2), rgba(6, 182, 212, 0.2))',
              padding: '12px',
              borderRadius: '16px',
              border: '1px solid var(--border-glass)'
            }}>
              <Brain size={32} style={{ color: 'var(--accent-secondary)' }} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: '1.6rem', fontWeight: 650 }}>AI Memory Vault</h3>
              <p style={{ margin: '4px 0 0 0', color: 'var(--text-secondary)', fontSize: '0.92rem' }}>
                These are facts and preferences the AI has retained about you.
              </p>
            </div>
          </div>
          {memories.length > 0 && (
            <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={handleExportCSV} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                <Download size={13} /> CSV
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={handleExportJSON} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                <Download size={13} /> JSON
              </button>
            </div>
          )}
        </div>

        {selectedIds.size > 0 && (
          <div className="memory-bulk-toolbar">
            <span className="memory-bulk-count">{selectedIds.size} selected</span>
            <button
              type="button"
              className="btn btn-sm text-error"
              onClick={() => onBulkDeleteMemories([...selectedIds], clearSelection)}
            >
              Delete {selectedIds.size} memor{selectedIds.size === 1 ? 'y' : 'ies'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={clearSelection}>
              Clear selection
            </button>
          </div>
        )}

        {/* FEAT-8 (docs/REVIEW_2026-08-03.md): the .memory-layout CSS class already defines a
            responsive 768px breakpoint (index.css) - this used to also carry a duplicate inline
            style with the same fixed-width values, which fought the CSS class and forced it to
            resort to !important to win on narrow viewports. Removed; the class alone is
            sufficient. */}
        <div className="memory-layout">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {/* Long-term Memories */}
            <div style={{
              background: 'var(--bg-secondary)',
              backdropFilter: 'blur(8px)',
              border: '1px solid var(--border-glass)',
              borderRadius: '16px',
              padding: '24px'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', borderBottom: '1px solid var(--border-glass)', paddingBottom: '12px' }}>
                <h4 style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '1.1rem', fontWeight: 650 }}>
                  <span>♾️</span> Long-term Memories
                </h4>
                <span className="badge" style={{
                  background: 'rgba(16, 185, 129, 0.15)',
                  color: 'var(--accent-green)',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  padding: '4px 10px',
                  borderRadius: '20px',
                  border: '1px solid rgba(16, 185, 129, 0.25)'
                }}>
                  Remembered Forever
                </span>
              </div>

              {longTermMemories.length === 0 ? (
                <p style={{ color: 'var(--text-secondary)', fontStyle: 'italic', margin: 0, fontSize: '0.95rem' }}>
                  No long-term memories stored yet. Converse with the AI to teach it facts about you.
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {longTermMemories.map(mem => (
                    <div key={mem.id} style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '14px 16px',
                      background: 'rgba(255, 255, 255, 0.02)',
                      borderRadius: '12px',
                      border: '1px solid var(--border-glass)',
                      borderLeft: '4px solid var(--accent-green)',
                      transition: 'transform 0.2s'
                    }}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(mem.id)}
                        onChange={() => toggleSelect(mem.id)}
                        aria-label={`Select memory: ${mem.content}`}
                        style={{ marginRight: '12px', flexShrink: 0 }}
                      />
                      <div style={{ flex: 1, marginRight: '16px' }}>
                        <span style={{ fontSize: '0.98rem', color: 'var(--text-primary)', lineHeight: 1.4 }}>{mem.content}</span>
                      </div>
                      <button 
                        onClick={() => onDeleteMemory(mem.id)} 
                        className="btn-icon" 
                        style={{
                          color: 'var(--error)',
                          padding: '8px',
                          background: 'rgba(239, 68, 68, 0.08)',
                          borderRadius: '8px',
                          border: 'none',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}
                        title="Forget this memory"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Short-term Memories */}
            <div style={{
              background: 'var(--bg-secondary)',
              backdropFilter: 'blur(8px)',
              border: '1px solid var(--border-glass)',
              borderRadius: '16px',
              padding: '24px'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', borderBottom: '1px solid var(--border-glass)', paddingBottom: '12px' }}>
                <h4 style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '1.1rem', fontWeight: 650 }}>
                  <Clock size={18} style={{ color: '#eab308' }} /> Short-term Memories
                </h4>
                <span className="badge" style={{
                  background: 'rgba(234, 179, 8, 0.15)',
                  color: '#fbbf24',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  padding: '4px 10px',
                  borderRadius: '20px',
                  border: '1px solid rgba(234, 179, 8, 0.25)'
                }}>
                  Temporary (Dynamic TTL)
                </span>
              </div>

              {shortTermMemories.length === 0 ? (
                <p style={{ color: 'var(--text-secondary)', fontStyle: 'italic', margin: 0, fontSize: '0.95rem' }}>
                  No short-term memories stored yet. Temporary plans or details go here.
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {shortTermMemories.map(mem => (
                    <div key={mem.id} style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '14px 16px',
                      background: 'rgba(255, 255, 255, 0.02)',
                      borderRadius: '12px',
                      border: '1px solid var(--border-glass)',
                      borderLeft: '4px solid #eab308',
                      transition: 'transform 0.2s'
                    }}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(mem.id)}
                        onChange={() => toggleSelect(mem.id)}
                        aria-label={`Select memory: ${mem.content}`}
                        style={{ marginRight: '12px', flexShrink: 0 }}
                      />
                      <div style={{ flex: 1, marginRight: '16px' }}>
                        <div style={{ fontSize: '0.98rem', color: 'var(--text-primary)', lineHeight: 1.4, marginBottom: '6px' }}>{mem.content}</div>
                        <div style={{
                          color: 'var(--text-secondary)',
                          fontSize: '0.78rem',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px'
                        }}>
                          <Clock size={12} /> {formatExpiration(mem.expires_at)}
                        </div>
                      </div>
                      <button 
                        onClick={() => onDeleteMemory(mem.id)} 
                        className="btn-icon" 
                        style={{
                          color: 'var(--error)',
                          padding: '8px',
                          background: 'rgba(239, 68, 68, 0.08)',
                          borderRadius: '8px',
                          border: 'none',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}
                        title="Forget this memory"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Teach Assistant Card */}
          <div style={{
            background: 'var(--bg-secondary)',
            backdropFilter: 'blur(8px)',
            border: '1px solid var(--border-glass)',
            borderRadius: '16px',
            padding: '24px',
            position: 'sticky',
            top: '24px'
          }}>
            <h4 style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '1.1rem', fontWeight: 650, marginBottom: '20px', borderBottom: '1px solid var(--border-glass)', paddingBottom: '12px' }}>
              <PlusCircle size={18} style={{ color: 'var(--accent-primary)' }} /> Teach Assistant
            </h4>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '8px', display: 'block', fontWeight: 550 }}>Fact / Preference</label>
                <textarea 
                  className="form-control" 
                  placeholder="e.g. I prefer dark mode, or I have a dog named Rusty."
                  style={{ resize: 'vertical', minHeight: '90px', lineHeight: 1.4 }}
                  value={newContent}
                  onChange={e => setNewContent(e.target.value)}
                  required
                />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '8px', display: 'block', fontWeight: 550 }}>Retention Level</label>
                <select 
                  className="form-control"
                  value={newLevel}
                  onChange={e => setNewLevel(e.target.value)}
                  style={{ cursor: 'pointer' }}
                >
                  <option value="long-term">Long-term (Remember Forever)</option>
                  <option value="short-term-30">Short-term (Default 30 Days)</option>
                  <option value="short-term-1">Short-term (Keep for 1 Day)</option>
                  <option value="short-term-7">Short-term (Keep for 7 Days)</option>
                  <option value="short-term-14">Short-term (Keep for 14 Days)</option>
                  <option value="short-term-90">Short-term (Keep for 90 Days)</option>
                  <option value="short-term-custom">Short-term (Custom Expiration Date...)</option>
                </select>
              </div>
              {newLevel === 'short-term-custom' && (
                <div className="form-group" style={{ margin: '16px 0 0 0' }}>
                  <label htmlFor="expiration-date" style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '8px', display: 'block', fontWeight: 550 }}>Expiration Date</label>
                  <input 
                    type="date" 
                    id="expiration-date"
                    className="form-control"
                    value={customDate}
                    onChange={e => setCustomDate(e.target.value)}
                    required
                  />
                </div>
              )}
              <button type="submit" className="btn-primary" style={{ width: '100%', marginTop: '8px' }}>
                Save Memory
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
