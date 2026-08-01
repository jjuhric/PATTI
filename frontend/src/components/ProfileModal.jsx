import React, { useState, useEffect } from 'react';
import { X, Eye, EyeOff, Plus } from 'lucide-react';

export default function ProfileModal({
  isProfileOpen,
  setIsProfileOpen,
  profile,
  saveProfile,
  settings,
  saveSettings,
  localModels = [],
  onlineModels = []
}) {
  const [activeTab, setActiveTab] = useState('general'); // 'general', 'models', 'personal'
  const [formData, setFormData] = useState({
    name: '',
    zipcode: '',
    country: 'US',
    temp_unit: 'imperial',
    weather_api_key: '',
    interests: [],
    favorite_teams: []
  });
  const [formSettings, setFormSettings] = useState({
    preferred_local_model: '',
    preferred_online_model: ''
  });
  const [showApiKey, setShowApiKey] = useState(false);
  const [newInterest, setNewInterest] = useState('');
  const [newTeam, setNewTeam] = useState('');

  useEffect(() => {
    if (profile) {
      setFormData({
        name: profile.name || '',
        zipcode: profile.zipcode || '',
        country: profile.country || 'US',
        temp_unit: profile.temp_unit || 'imperial',
        weather_api_key: profile.weather_api_key || '',
        interests: Array.isArray(profile.interests) ? profile.interests : [],
        favorite_teams: Array.isArray(profile.favorite_teams) ? profile.favorite_teams : []
      });
    }
    if (settings) {
      setFormSettings({
        preferred_local_model: settings.preferred_local_model || '',
        preferred_online_model: settings.preferred_online_model || ''
      });
    }

    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isProfileOpen) {
        setIsProfileOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [profile, settings, isProfileOpen, setIsProfileOpen]);

  if (!isProfileOpen) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    saveProfile(formData);
    if (saveSettings && settings) {
      saveSettings({
        ...settings,
        preferred_local_model: formSettings.preferred_local_model,
        preferred_online_model: formSettings.preferred_online_model
      });
    }
  };

  const handleAddInterest = (e) => {
    e.preventDefault();
    if (!newInterest.trim()) return;
    if (formData.interests.includes(newInterest.trim())) {
      setNewInterest('');
      return;
    }
    setFormData(prev => ({
      ...prev,
      interests: [...prev.interests, newInterest.trim()]
    }));
    setNewInterest('');
  };

  const handleRemoveInterest = (interestToRemove) => {
    setFormData(prev => ({
      ...prev,
      interests: prev.interests.filter(item => item !== interestToRemove)
    }));
  };

  const handleAddTeam = (e) => {
    e.preventDefault();
    if (!newTeam.trim()) return;
    if (formData.favorite_teams.includes(newTeam.trim())) {
      setNewTeam('');
      return;
    }
    setFormData(prev => ({
      ...prev,
      favorite_teams: [...prev.favorite_teams, newTeam.trim()]
    }));
    setNewTeam('');
  };

  const handleRemoveTeam = (teamToRemove) => {
    setFormData(prev => ({
      ...prev,
      favorite_teams: prev.favorite_teams.filter(item => item !== teamToRemove)
    }));
  };

  return (
    <div className="modal-overlay" onClick={() => setIsProfileOpen(false)}>
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '520px', width: '90%' }}>
        <div className="modal-header" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '12px' }}>
          <h3 style={{ margin: 0, fontSize: '1.2rem', color: '#fff' }}>User Profile Settings</h3>
          <button className="btn-icon" onClick={() => setIsProfileOpen(false)}>
            <X size={20} />
          </button>
        </div>

        {/* Tab Selection */}
        <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.08)', marginBottom: '16px' }}>
          <button 
            type="button"
            onClick={() => setActiveTab('general')}
            style={{
              padding: '10px 16px',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === 'general' ? '2px solid var(--accent-primary)' : '2px solid transparent',
              color: activeTab === 'general' ? '#fff' : 'var(--text-secondary)',
              fontWeight: activeTab === 'general' ? 600 : 400,
              cursor: 'pointer',
              fontSize: '0.85rem'
            }}
          >
            General
          </button>
          <button 
            type="button"
            onClick={() => setActiveTab('models')}
            style={{
              padding: '10px 16px',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === 'models' ? '2px solid var(--accent-primary)' : '2px solid transparent',
              color: activeTab === 'models' ? '#fff' : 'var(--text-secondary)',
              fontWeight: activeTab === 'models' ? 600 : 400,
              cursor: 'pointer',
              fontSize: '0.85rem'
            }}
          >
            AI Models
          </button>
          <button 
            type="button"
            onClick={() => setActiveTab('personal')}
            style={{
              padding: '10px 16px',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === 'personal' ? '2px solid var(--accent-primary)' : '2px solid transparent',
              color: activeTab === 'personal' ? '#fff' : 'var(--text-secondary)',
              fontWeight: activeTab === 'personal' ? 600 : 400,
              cursor: 'pointer',
              fontSize: '0.85rem'
            }}
          >
            Personalization
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {activeTab === 'general' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label>Name</label>
                <input 
                  type="text" 
                  className="form-control" 
                  placeholder="Your preferred name"
                  value={formData.name}
                  onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                />
              </div>

              <div className="form-group" style={{ margin: 0 }}>
                <label>Zipcode</label>
                <input 
                  type="text" 
                  className="form-control" 
                  placeholder="e.g. 32421"
                  value={formData.zipcode}
                  onChange={e => setFormData(prev => ({ ...prev, zipcode: e.target.value }))}
                />
              </div>

              <div className="form-group" style={{ margin: 0 }}>
                <label>Country Code (e.g. US, GB, CA, IT)</label>
                <input 
                  type="text" 
                  className="form-control" 
                  placeholder="US"
                  maxLength={3}
                  value={formData.country}
                  onChange={e => setFormData(prev => ({ ...prev, country: e.target.value.toUpperCase().trim() }))}
                />
              </div>

              <div className="form-group" style={{ margin: 0 }}>
                <label>Temperature Units</label>
                <select 
                  className="form-control"
                  value={formData.temp_unit}
                  onChange={e => setFormData(prev => ({ ...prev, temp_unit: e.target.value }))}
                >
                  <option value="imperial">Imperial (°F, mph)</option>
                  <option value="metric">Metric (°C, m/s)</option>
                  <option value="standard">Standard (Kelvin, m/s)</option>
                </select>
              </div>

              <div className="form-group" style={{ margin: 0 }}>
                <label>OpenWeatherMap API Key</label>
                <div style={{ position: 'relative' }}>
                  <input 
                    type={showApiKey ? 'text' : 'password'} 
                    className="form-control" 
                    style={{ paddingRight: '40px' }}
                    placeholder="Enter OpenWeatherMap API key"
                    value={formData.weather_api_key}
                    onChange={e => setFormData(prev => ({ ...prev, weather_api_key: e.target.value.trim() }))}
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey(!showApiKey)}
                    style={{
                      position: 'absolute',
                      right: '10px',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      background: 'none',
                      border: 'none',
                      color: 'var(--text-secondary)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      padding: 0
                    }}
                  >
                    {showApiKey ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
                <small style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginTop: '4px', display: 'block' }}>
                  Used to query weather for your local area. Get a key at <a href="https://openweathermap.org" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-primary)' }}>openweathermap.org</a>.
                </small>
              </div>
            </div>
          )}

          {activeTab === 'models' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {settings?.local_url && (
                <div className="form-group" style={{ margin: 0 }}>
                  <label>Preferred Local Model</label>
                  <input
                    type="text"
                    className="form-control"
                    value="qwen2.5-coder-7b-instruct"
                    disabled
                    readOnly
                  />
                </div>
              )}

              {settings?.online_key && (
                <div className="form-group" style={{ margin: 0 }}>
                  <label>Preferred Online Model</label>
                  <select
                    className="form-control"
                    value={formSettings.preferred_online_model}
                    onChange={e => setFormSettings(prev => ({ ...prev, preferred_online_model: e.target.value }))}
                  >
                    <option value="">(Default Active Model)</option>
                    {(onlineModels.length > 0 ? onlineModels : ['gemini-2.0-flash', 'gemini-2.0-pro', 'gpt-4o', 'claude-3-5-sonnet-latest']).map(model => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {activeTab === 'personal' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label>Interests List</label>
                <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                  <input 
                    type="text" 
                    className="form-control" 
                    placeholder="Add an interest (e.g. AI News, Cycling)"
                    value={newInterest}
                    onChange={e => setNewInterest(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleAddInterest(e)}
                  />
                  <button type="button" className="btn btn-primary" onClick={handleAddInterest} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 12px' }}>
                    <Plus size={18} />
                  </button>
                </div>
                
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' }}>
                  {formData.interests.length > 0 ? (
                    formData.interests.map((interest, idx) => (
                      <span 
                        key={idx} 
                        style={{
                          background: 'rgba(255,255,255,0.1)',
                          border: '1px solid rgba(255,255,255,0.15)',
                          borderRadius: '16px',
                          padding: '4px 10px',
                          fontSize: '0.8rem',
                          color: '#fff',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px'
                        }}
                      >
                        {interest}
                        <button 
                          type="button" 
                          onClick={() => handleRemoveInterest(interest)}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--text-secondary)',
                            cursor: 'pointer',
                            padding: 0,
                            display: 'flex',
                            alignItems: 'center',
                            fontSize: '0.9rem',
                            lineHeight: 1
                          }}
                        >
                          &times;
                        </button>
                      </span>
                    ))
                  ) : (
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', fontStyle: 'italic' }}>
                      No interests added yet. Add some to get personalized news digests!
                    </span>
                  )}
                </div>
              </div>

              <div className="form-group" style={{ margin: 0 }}>
                <label>Favorite Sports Teams</label>
                <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                  <input
                    type="text"
                    className="form-control"
                    placeholder="Add a team (e.g. Dallas Cowboys)"
                    value={newTeam}
                    onChange={e => setNewTeam(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleAddTeam(e)}
                  />
                  <button type="button" className="btn btn-primary" onClick={handleAddTeam} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 12px' }}>
                    <Plus size={18} />
                  </button>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' }}>
                  {formData.favorite_teams.length > 0 ? (
                    formData.favorite_teams.map((team, idx) => (
                      <span
                        key={idx}
                        style={{
                          background: 'rgba(255,255,255,0.1)',
                          border: '1px solid rgba(255,255,255,0.15)',
                          borderRadius: '16px',
                          padding: '4px 10px',
                          fontSize: '0.8rem',
                          color: '#fff',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px'
                        }}
                      >
                        {team}
                        <button
                          type="button"
                          onClick={() => handleRemoveTeam(team)}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--text-secondary)',
                            cursor: 'pointer',
                            padding: 0,
                            display: 'flex',
                            alignItems: 'center',
                            fontSize: '0.9rem',
                            lineHeight: 1
                          }}
                        >
                          &times;
                        </button>
                      </span>
                    ))
                  ) : (
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', fontStyle: 'italic' }}>
                      No favorite teams yet. Add teams so PATTI can track their schedules, news, and live games for you!
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '12px', marginTop: '8px' }}>
            <button type="submit" className="btn btn-primary" style={{ padding: '8px 20px' }}>
              Save Profile
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
