import React, { useState, useEffect } from 'react';
import { Sliders, Download, Upload, Trash2, CheckCircle, HelpCircle, Loader2, Edit, Wand2 } from 'lucide-react';
import SkillWizardModal from './SkillWizardModal';
import { useApi } from '../hooks/useApi';

export default function PersonalitySkillsPane({ token }) {
  const api = useApi(token);
  const [activeTab, setActiveTab] = useState('personalities');
  const [personalities, setPersonalities] = useState([]);
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  
  // URL Pull State
  const [urlInput, setUrlInput] = useState('');
  const [fetchingUrl, setFetchingUrl] = useState(false);
  
  // Preview Modal State
  const [previewContent, setPreviewContent] = useState('');
  const [previewType, setPreviewType] = useState('personality'); // 'personality' or 'skill'
  const [overrideName, setOverrideName] = useState('');
  const [overrideDesc, setOverrideDesc] = useState('');
  const [showPreviewModal, setShowPreviewModal] = useState(false);

  // Edit Modal State
  const [editItem, setEditItem] = useState(null); // { id, name, description, body, type: 'personality' | 'skill' }
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editBody, setEditBody] = useState('');
  const [showEditModal, setShowEditModal] = useState(false);

  // Creation Wizard State
  const [showWizard, setShowWizard] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    setError('');
    const { ok, data, error: err } = await api.get('/api/personalities-skills');
    if (ok) {
      setPersonalities(data.personalities || []);
      setSkills(data.skills || []);
    } else {
      setError(err || 'Failed to fetch profiles.');
    }
    setLoading(false);
  };

  const handleActivatePersonality = async (id) => {
    const { ok, error } = await api.post('/api/personalities-skills/personalities/activate', { id });
    if (ok) {
      fetchData();
    } else {
      alert(error || 'Failed to set default personality.');
    }
  };

  const handleToggleSkill = async (id, currentActive) => {
    const { ok, error } = await api.post('/api/personalities-skills/skills/toggle', { id, is_active: !currentActive });
    if (ok) {
      fetchData();
    } else {
      alert(error || 'Failed to toggle skill.');
    }
  };

  const handleDeleteItem = async (type, id) => {
    if (!window.confirm(`Are you sure you want to delete this ${type}?`)) return;
    const { ok, error } = await api.delete(`/api/personalities-skills/${type === 'personality' ? 'personalities' : 'skills'}/${id}`);
    if (ok) {
      fetchData();
    } else {
      alert(error || 'Failed to delete item.');
    }
  };

  // Upload local .md file
  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      setPreviewContent(event.target.result);
      setPreviewType(activeTab === 'personalities' ? 'personality' : 'skill');
      setOverrideName('');
      setOverrideDesc('');
      setShowPreviewModal(true);
    };
    reader.readAsText(file);
    e.target.value = null; // Reset file input
  };

  // Download raw markdown from URL
  const handleFetchUrl = async () => {
    if (!urlInput.trim()) return;
    setFetchingUrl(true);
    const { ok, data, error } = await api.post('/api/personalities-skills/fetch-url', { url: urlInput });
    if (ok) {
      setPreviewContent(data.rawContent);
      setPreviewType(activeTab === 'personalities' ? 'personality' : 'skill');
      setOverrideName('');
      setOverrideDesc('');
      setShowPreviewModal(true);
    } else {
      alert(error || 'Failed to fetch content from URL.');
    }
    setFetchingUrl(false);
  };

  const handleConfirmImport = async () => {
    const { ok, error } = await api.post('/api/personalities-skills/import', {
      type: previewType,
      content: previewContent,
      overrideName: overrideName.trim() || undefined,
      overrideDesc: overrideDesc.trim() || undefined
    });
    if (ok) {
      setShowPreviewModal(false);
      setUrlInput('');
      fetchData();
    } else {
      alert(error || 'Failed to import profile.');
    }
  };

  const handleSaveEdit = async () => {
    if (!editName.trim() || !editBody.trim()) {
      alert('Name and details are required.');
      return;
    }
    const type = editItem.type;
    const bodyKey = type === 'personality' ? 'system_prompt' : 'instructions';
    const { ok, error } = await api.put(`/api/personalities-skills/${type === 'personality' ? 'personalities' : 'skills'}/${editItem.id}`, {
      name: editName.trim(),
      description: editDesc.trim(),
      [bodyKey]: editBody
    });
    if (ok) {
      setShowEditModal(false);
      setEditItem(null);
      fetchData();
    } else {
      alert(error || 'Failed to update profile.');
    }
  };

  return (
    <div className="chat-pane" style={{ padding: '24px', overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <h2 style={{ fontSize: '1.75rem', fontWeight: 700, color: '#fff', display: 'flex', alignItems: 'center', gap: '10px', margin: 0 }}>
            <Sliders className="text-accent-primary" size={28} /> Custom Personalities & Skills
          </h2>
          <p style={{ color: 'var(--text-secondary)', margin: '4px 0 0 0', fontSize: '0.9rem' }}>
            Import and toggle agent profiles dynamically from raw Markdown files.
          </p>
        </div>

        {/* Tab Selection */}
        <div style={{ display: 'flex', background: 'rgba(0,0,0,0.2)', borderRadius: '12px', padding: '4px', border: '1px solid var(--border-glass)' }}>
          <button
            onClick={() => setActiveTab('personalities')}
            className={`btn`}
            style={{
              padding: '6px 16px',
              fontSize: '0.85rem',
              borderRadius: '8px',
              background: activeTab === 'personalities' ? 'var(--accent-primary)' : 'transparent',
              color: activeTab === 'personalities' ? '#fff' : 'var(--text-secondary)',
              border: 'none',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
          >
            Personalities
          </button>
          <button
            onClick={() => setActiveTab('skills')}
            className={`btn`}
            style={{
              padding: '6px 16px',
              fontSize: '0.85rem',
              borderRadius: '8px',
              background: activeTab === 'skills' ? 'var(--accent-primary)' : 'transparent',
              color: activeTab === 'skills' ? '#fff' : 'var(--text-secondary)',
              border: 'none',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
          >
            Skills
          </button>
        </div>
      </div>

      {error && <div style={{ color: 'var(--error)', background: 'rgba(239, 68, 68, 0.1)', padding: '12px', borderRadius: '8px', marginBottom: '20px' }}>{error}</div>}

      {/* Import Section */}
      <div style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-glass)', borderRadius: '16px', padding: '20px', marginBottom: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '10px' }}>
          <h3 style={{ margin: 0, fontSize: '1rem', color: '#fff', fontWeight: 600 }}>Import from Markdown (.md)</h3>
          <button
            className="btn btn-primary"
            onClick={() => setShowWizard(true)}
            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', fontSize: '0.85rem' }}
          >
            <Wand2 size={16} /> Create with Wizard
          </button>
        </div>
        <div className="grid-2col-responsive" style={{ gap: '20px' }}>
          
          {/* Upload Box */}
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', border: '2px dashed var(--border-glass)', borderRadius: '12px', padding: '20px', cursor: 'pointer', background: 'rgba(255,255,255,0.01)', position: 'relative' }}>
            <Upload size={24} className="text-accent-primary" style={{ marginBottom: '8px' }} />
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Upload Local Markdown File</span>
            <input
              type="file"
              accept=".md"
              onChange={handleFileUpload}
              style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0, cursor: 'pointer' }}
            />
          </div>

          {/* Paste URL Box */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Download from Raw GitHub or web URL</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              <input
                type="text"
                className="form-control"
                placeholder="https://raw.githubusercontent.com/.../profile.md"
                value={urlInput}
                onChange={e => setUrlInput(e.target.value)}
                style={{ flex: '1 1 160px', width: 'auto', minWidth: 0, margin: 0 }}
              />
              <button
                className="btn btn-primary"
                onClick={handleFetchUrl}
                disabled={fetchingUrl || !urlInput.trim()}
                style={{ margin: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', flex: '1 1 auto', whiteSpace: 'nowrap' }}
              >
                {fetchingUrl ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                Fetch & Preview
              </button>
            </div>
          </div>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '40px' }}>
          <Loader2 size={36} className="animate-spin text-accent-primary" />
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px' }}>
          {activeTab === 'personalities' ? (
            personalities.map(p => (
              <div key={p.id} style={{
                background: 'var(--bg-glass)',
                border: p.is_active ? '1px solid var(--accent-primary)' : '1px solid var(--border-glass)',
                borderRadius: '16px',
                padding: '16px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: '12px',
                boxShadow: p.is_active ? '0 0 16px rgba(139, 92, 246, 0.15)' : 'none'
              }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h4 style={{ margin: 0, color: '#fff', fontSize: '1rem', fontWeight: 600 }}>{p.name}</h4>
                    {p.is_active ? (
                      <span style={{ fontSize: '0.75rem', background: 'rgba(16, 185, 129, 0.15)', color: '#10b981', padding: '2px 8px', borderRadius: '9999px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <span style={{ width: '6px', height: '6px', background: '#10b981', borderRadius: '50%' }}></span>
                        Default
                      </span>
                    ) : null}
                  </div>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '8px 0 0 0', minHeight: '36px', overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                    {p.description || 'No description provided.'}
                  </p>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-glass)', paddingTop: '12px', marginTop: '4px' }}>
                  {!p.is_active ? (
                    <button
                      className="btn btn-primary"
                      onClick={() => handleActivatePersonality(p.id)}
                      style={{ margin: 0, padding: '4px 12px', fontSize: '0.8rem' }}
                    >
                      Set Default
                    </button>
                  ) : (
                    <span style={{ fontSize: '0.8rem', color: '#10b981', fontWeight: 550 }}>Default Persona</span>
                  )}
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <button
                      className="btn-icon"
                      onClick={() => {
                        setEditItem({ ...p, type: 'personality' });
                        setEditName(p.name);
                        setEditDesc(p.description || '');
                        setEditBody(p.system_prompt || '');
                        setShowEditModal(true);
                      }}
                      style={{ color: 'var(--text-secondary)', background: 'transparent', padding: '4px', cursor: 'pointer' }}
                      title="Edit personality"
                    >
                      <Edit size={16} />
                    </button>
                    {p.name !== 'Friendly Secretary' && (
                      <button
                        className="btn-icon"
                        onClick={() => handleDeleteItem('personality', p.id)}
                        style={{ color: 'var(--error)', background: 'transparent', padding: '4px' }}
                        title="Delete profile"
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))
          ) : (
            skills.map(s => (
              <div key={s.id} style={{
                background: 'var(--bg-glass)',
                border: s.is_active ? '1px solid var(--accent-primary)' : '1px solid var(--border-glass)',
                borderRadius: '16px',
                padding: '16px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: '12px'
              }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h4 style={{ margin: 0, color: '#fff', fontSize: '1rem', fontWeight: 600 }}>{s.name}</h4>
                    <label style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer', gap: '6px' }}>
                      <input
                        type="checkbox"
                        checked={!!s.is_active}
                        onChange={() => handleToggleSkill(s.id, s.is_active)}
                        style={{ width: '16px', height: '16px', cursor: 'pointer', accentColor: 'var(--accent-primary)' }}
                      />
                      <span style={{ fontSize: '0.75rem', color: s.is_active ? '#fff' : 'var(--text-secondary)', fontWeight: 550 }}>
                        {s.is_active ? 'Default' : 'Inactive'}
                      </span>
                    </label>
                  </div>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '8px 0 0 0', minHeight: '36px', overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                    {s.description || 'No description provided.'}
                  </p>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '8px', borderTop: '1px solid var(--border-glass)', paddingTop: '12px', marginTop: '4px' }}>
                  <button
                    className="btn-icon"
                    onClick={() => {
                      setEditItem({ ...s, type: 'skill' });
                      setEditName(s.name);
                      setEditDesc(s.description || '');
                      setEditBody(s.instructions || '');
                      setShowEditModal(true);
                    }}
                    style={{ color: 'var(--text-secondary)', background: 'transparent', padding: '4px', cursor: 'pointer' }}
                    title="Edit skill"
                  >
                    <Edit size={16} />
                  </button>
                  {s.name !== 'Smart Home Helper' && (
                    <button
                      className="btn-icon"
                      onClick={() => handleDeleteItem('skill', s.id)}
                      style={{ color: 'var(--error)', background: 'transparent', padding: '4px' }}
                      title="Delete skill"
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Safety Confirmation Preview Modal */}
      {showPreviewModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(15, 23, 42, 0.85)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 99999,
          padding: '20px'
        }}>
          <div className="modal-content" style={{
            maxWidth: '640px',
            width: '100%',
            padding: '24px',
            background: 'var(--bg-glass)',
            border: '1px solid var(--border-glass)',
            borderRadius: '24px',
            boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.4)',
            maxHeight: '90vh',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px'
          }}>
            <h3 style={{ fontSize: '1.25rem', fontWeight: 650, color: '#fff', margin: 0 }}>
              Verify Raw Markdown Safety
            </h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0 }}>
              Please review the raw Markdown contents below. Make sure you trust the source before importing this profile.
            </p>

            <div className="grid-2col-responsive" style={{ gap: '12px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>Override Profile Name</label>
                <input
                  type="text"
                  className="form-control"
                  placeholder="e.g. Smart Coder Helper"
                  value={overrideName}
                  onChange={e => setOverrideName(e.target.value)}
                  style={{ margin: 0 }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>Override Description</label>
                <input
                  type="text"
                  className="form-control"
                  placeholder="e.g. Advanced code generation rules"
                  value={overrideDesc}
                  onChange={e => setOverrideDesc(e.target.value)}
                  style={{ margin: 0 }}
                />
              </div>
            </div>

            <div style={{
              flex: 1,
              overflowY: 'auto',
              background: 'rgba(0,0,0,0.4)',
              border: '1px solid var(--border-glass)',
              borderRadius: '12px',
              padding: '16px',
              fontSize: '0.85rem',
              fontFamily: 'monospace',
              color: '#34d399',
              whiteSpace: 'pre-wrap',
              maxHeight: '350px'
            }}>
              {previewContent}
            </div>

            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button
                className="btn btn-secondary"
                onClick={() => setShowPreviewModal(false)}
                style={{ margin: 0, padding: '8px 20px', fontSize: '0.9rem' }}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleConfirmImport}
                style={{ margin: 0, padding: '8px 24px', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                <CheckCircle size={16} /> Confirm & Import
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Profile Modal */}
      {showEditModal && editItem && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(15, 23, 42, 0.85)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 99999,
          padding: '20px'
        }}>
          <div className="modal-content" style={{
            maxWidth: '640px',
            width: '100%',
            padding: '24px',
            background: 'var(--bg-glass)',
            border: '1px solid var(--border-glass)',
            borderRadius: '24px',
            boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.4)',
            maxHeight: '90vh',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px'
          }}>
            <h3 style={{ fontSize: '1.25rem', fontWeight: 650, color: '#fff', margin: 0 }}>
              Edit {editItem.type === 'personality' ? 'Personality' : 'Skill'}
            </h3>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>Name</label>
                <input
                  type="text"
                  className="form-control"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  style={{ margin: 0 }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>Description</label>
                <input
                  type="text"
                  className="form-control"
                  value={editDesc}
                  onChange={e => setEditDesc(e.target.value)}
                  style={{ margin: 0 }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  {editItem.type === 'personality' ? 'System Prompt' : 'Instructions'}
                </label>
                <textarea
                  className="form-control"
                  rows={8}
                  value={editBody}
                  onChange={e => setEditBody(e.target.value)}
                  style={{
                    margin: 0,
                    fontFamily: 'monospace',
                    fontSize: '0.85rem',
                    resize: 'vertical',
                    background: 'rgba(0,0,0,0.4)',
                    color: '#f3f4f6'
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '8px' }}>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setShowEditModal(false);
                  setEditItem(null);
                }}
                style={{ margin: 0, padding: '8px 20px', fontSize: '0.9rem' }}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSaveEdit}
                style={{ margin: 0, padding: '8px 24px', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                <CheckCircle size={16} /> Save Changes
              </button>
            </div>
          </div>
        </div>
      )}

      <SkillWizardModal
        isOpen={showWizard}
        onClose={() => setShowWizard(false)}
        token={token}
        onSaved={fetchData}
        initialType={activeTab === 'personalities' ? 'personality' : 'skill'}
      />
    </div>
  );
}
