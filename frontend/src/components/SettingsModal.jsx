import React, { useEffect, useState } from 'react';
import { X, Eye, EyeOff } from 'lucide-react';

export default function SettingsModal({
  isSettingsOpen,
  setIsSettingsOpen,
  settings,
  setSettings,
  localModels,
  onlineModels,
  saveSettings,
  showLocalKey,
  setShowLocalKey,
  showOnlineKey,
  setShowOnlineKey,
  onFetchLocalModels,
  token
}) {
  const [isScanning, setIsScanning] = useState(false);
  const [scanResults, setScanResults] = useState([]);
  const [scanError, setScanError] = useState('');
  const [useOnline, setUseOnline] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  useEffect(() => {
    if (isSettingsOpen) {
      setUseOnline(settings.provider === 'gemini' || settings.provider === 'online');
    }
  }, [isSettingsOpen, settings]);

  const handleScanSpeakers = async () => {
    setIsScanning(true);
    setScanError('');
    try {
      const res = await fetch('/api/settings/google-home/scan', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setScanResults(data);
      } else {
        setScanError('Failed to scan for speakers.');
      }
    } catch (err) {
      setScanError(err.message);
    } finally {
      setIsScanning(false);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isSettingsOpen) {
        setIsSettingsOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSettingsOpen, setIsSettingsOpen]);

  if (!isSettingsOpen) return null;

  return (
    <div className="modal-overlay" onClick={() => setIsSettingsOpen(false)}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Assistant Settings</h3>
          <button className="btn-icon" onClick={() => setIsSettingsOpen(false)} aria-label="Close settings modal">
            <X size={20} />
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Local LLM Settings Section */}
          <div style={{ padding: '16px', background: 'rgba(255, 255, 255, 0.02)', borderRadius: '12px', border: '1px solid var(--border-glass)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <h4 style={{ margin: 0, fontSize: '0.95rem', color: 'var(--accent-primary)', fontWeight: 600 }}>Local LLM Settings (Mandatory)</h4>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                onClick={() => setSettings(prev => ({
                  ...prev,
                  local_url: 'http://192.168.1.42:8000/v1',
                  local_api_style: 'openai',
                  model_name: 'Qwen3-14B-int4-ov',
                  preferred_local_model: 'Qwen3-14B-int4-ov'
                }))}
                className="btn-secondary"
                style={{ flex: 1, fontSize: '0.8rem', padding: '6px 10px' }}
              >
                Switch to NoLlama (Arc GPU)
              </button>
              <button
                type="button"
                onClick={() => setSettings(prev => ({
                  ...prev,
                  local_url: 'http://192.168.1.42:1234/v1',
                  local_api_style: 'openai',
                  model_name: 'google/gemma-4-e4b',
                  preferred_local_model: 'google/gemma-4-e4b'
                }))}
                className="btn-secondary"
                style={{ flex: 1, fontSize: '0.8rem', padding: '6px 10px' }}
              >
                Switch to LM Studio
              </button>
            </div>
            <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              Fills in the fields below with each server's known address - click Save to apply. NoLlama runs as a background service and is always on; LM Studio must be open with the model loaded before switching to it.
            </p>

            <div className="form-group" style={{ margin: 0 }}>
              <label>Local API Style</label>
              <select
                className="form-control"
                value={settings.local_api_style || 'openai'}
                onChange={e => setSettings(prev => ({ ...prev, local_api_style: e.target.value }))}
              >
                <option value="openai">OpenAI-compatible</option>
                <option value="lm-studio">LM Studio API</option>
                <option value="anthropic">Anthropic-compatible</option>
                <option value="local-gemini">Gemini Local Style</option>
              </select>
            </div>

            <div className="form-group" style={{ margin: 0 }}>
              <label>Local LLM Base URL (Address)</label>
              <input
                type="text"
                className="form-control"
                placeholder="e.g. http://192.168.1.42:1234/v1"
                value={settings.local_url || ''}
                onChange={e => setSettings(prev => ({ ...prev, local_url: e.target.value }))}
                required
              />
            </div>

            <div className="form-group" style={{ margin: 0 }}>
              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                <span>Local Model Name</span>
                <button
                  type="button"
                  onClick={() => onFetchLocalModels(settings)}
                  style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', cursor: 'pointer', fontSize: '0.78rem', padding: 0 }}
                >
                  Rescan Models
                </button>
              </label>
              {localModels && localModels.length > 0 ? (
                <select
                  className="form-control"
                  value={settings.model_name || ''}
                  onChange={e => setSettings(prev => ({ ...prev, model_name: e.target.value }))}
                >
                  {settings.model_name && !localModels.includes(settings.model_name) && (
                    <option value={settings.model_name}>{settings.model_name} (current)</option>
                  )}
                  {localModels.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  className="form-control"
                  placeholder="e.g. qwen2.5-coder-7b-instruct"
                  value={settings.model_name || ''}
                  onChange={e => setSettings(prev => ({ ...prev, model_name: e.target.value }))}
                />
              )}
              <p style={{ margin: '6px 0 0 0', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                The model PATTI will request from your local LLM server. Click "Rescan Models" to pull the list currently loaded at the URL above.
              </p>
            </div>

            <div className="form-group" style={{ margin: 0 }}>
              <label>Local LLM API Key (Token)</label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showLocalKey ? 'text' : 'password'}
                  className="form-control"
                  style={{ paddingRight: '40px' }}
                  placeholder="Enter local API token if required"
                  value={settings.local_key || ''}
                  onChange={e => setSettings(prev => ({ ...prev, local_key: e.target.value }))}
                />
                <button
                  type="button"
                  onClick={() => setShowLocalKey(!showLocalKey)}
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
                  {showLocalKey ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>
          </div>

          {/* Checkbox for Online LLM */}
          <div style={{ padding: '0 8px' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer', gap: '8px', fontSize: '0.9rem', color: '#fff' }}>
              <input
                type="checkbox"
                checked={useOnline}
                onChange={e => setUseOnline(e.target.checked)}
                style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: 'var(--accent-primary)' }}
              />
              <strong>Use Online Model Fallback</strong>
            </label>
          </div>

          {useOnline && (
            <div style={{ padding: '16px', background: 'rgba(255, 255, 255, 0.02)', borderRadius: '12px', border: '1px solid var(--border-glass)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <h4 style={{ margin: 0, fontSize: '0.95rem', color: 'var(--accent-primary)', fontWeight: 600 }}>Online Model Settings</h4>
              
              <div className="form-group" style={{ margin: 0 }}>
                <label>Online Provider</label>
                <select
                  className="form-control"
                  value={settings.online_provider || 'gemini'}
                  onChange={e => {
                    const nextProvider = e.target.value;
                    let nextModel = 'gemini-2.0-flash';
                    if (nextProvider === 'openai') nextModel = 'gpt-4o-mini';
                    else if (nextProvider === 'anthropic') nextModel = 'claude-3-5-haiku-latest';
                    
                    setSettings(prev => ({
                      ...prev,
                      online_provider: nextProvider,
                      model_name: nextModel
                    }));
                  }}
                >
                  <option value="gemini">Google Gemini (Default: gemini-2.0-flash)</option>
                  <option value="openai">OpenAI (Default: gpt-4o-mini)</option>
                  <option value="anthropic">Anthropic (Default: claude-3-5-haiku-latest)</option>
                  <option value="custom">Custom API URL</option>
                </select>
              </div>

              {settings.online_provider !== 'gemini' && (
                <div className="form-group" style={{ margin: 0 }}>
                  <label>Online API Base URL</label>
                  <input
                    type="text"
                    className="form-control"
                    placeholder={settings.online_provider === 'anthropic' ? 'e.g. https://api.anthropic.com' : 'e.g. https://api.openai.com/v1'}
                    value={settings.online_url || ''}
                    onChange={e => setSettings(prev => ({ ...prev, online_url: e.target.value }))}
                  />
                </div>
              )}

              <div className="form-group" style={{ margin: 0 }}>
                <label>Online Model Name</label>
                <input
                  type="text"
                  className="form-control"
                  placeholder="Enter online model name (e.g. gemini-2.0-flash)"
                  value={settings.model_name || ''}
                  onChange={e => setSettings(prev => ({ ...prev, model_name: e.target.value }))}
                />
              </div>

              <div className="form-group" style={{ margin: 0 }}>
                <label>Online API Key</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showOnlineKey ? 'text' : 'password'}
                    className="form-control"
                    style={{ paddingRight: '40px' }}
                    placeholder="Enter provider API key"
                    value={settings.online_key || ''}
                    onChange={e => setSettings(prev => ({ ...prev, online_key: e.target.value }))}
                  />
                  <button
                    type="button"
                    onClick={() => setShowOnlineKey(!showOnlineKey)}
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
                    {showOnlineKey ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
                <p style={{ margin: '6px 0 0 0', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                  {settings.online_provider === 'anthropic' && 'Get an API key at console.anthropic.com (Settings → API Keys). Note: this is separate from a Claude.ai Pro/subscription plan — API usage is billed separately.'}
                  {settings.online_provider === 'openai' && 'Get an API key at platform.openai.com (API keys page). This is separate from a ChatGPT Plus subscription.'}
                  {settings.online_provider === 'gemini' && 'Get a free API key at aistudio.google.com/apikey.'}
                  {' '}This is entirely optional — PATTI defaults to your local LLM and only calls an online provider if you enable this fallback.
                </p>
              </div>
            </div>
          )}

          <div style={{ borderTop: '1px solid var(--border-glass)', padding: '16px 0 0 0', marginTop: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <h4 style={{ margin: 0, fontSize: '0.95rem' }}>Google Home Smart Speaker</h4>
              <label style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer', gap: '8px', fontSize: '0.85rem' }}>
                <input
                  type="checkbox"
                  checked={!!(settings.google_home_enabled === 1 || settings.google_home_enabled === true)}
                  onChange={e => setSettings(prev => ({ ...prev, google_home_enabled: e.target.checked ? 1 : 0 }))}
                  style={{ width: '16px', height: '16px', cursor: 'pointer', accentColor: 'var(--accent-primary)' }}
                />
                Enable Integration
              </label>
            </div>

            {(settings.google_home_enabled === 1 || settings.google_home_enabled === true) ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: 4 }}>Speaker Name</label>
                    <input
                      type="text"
                      className="form-control"
                      placeholder="e.g. Office Speaker"
                      value={settings.google_home_name || ''}
                      onChange={e => setSettings(prev => ({ ...prev, google_home_name: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: 4 }}>Speaker IP Address</label>
                    <input
                      type="text"
                      className="form-control"
                      placeholder="e.g. 192.168.1.60"
                      value={settings.google_home_ip || ''}
                      onChange={e => setSettings(prev => ({ ...prev, google_home_ip: e.target.value }))}
                    />
                  </div>
                </div>

                <button
                  type="button"
                  className="btn-primary"
                  style={{ width: '100%', height: '38px', margin: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onClick={handleScanSpeakers}
                  disabled={isScanning}
                >
                  {isScanning ? 'Scanning local network...' : 'Scan Local Network for Speakers'}
                </button>

                {scanError && <div style={{ color: 'var(--error)', fontSize: '0.8rem' }}>{scanError}</div>}

                {scanResults.length > 0 && (
                  <div className="form-group" style={{ margin: 0 }}>
                    <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: 4 }}>Discovered Speakers (Select to Apply)</label>
                    <select
                      className="form-control"
                      onChange={e => {
                        const selected = scanResults.find(d => d.ip === e.target.value);
                        if (selected) {
                          setSettings(prev => ({
                            ...prev,
                            google_home_name: selected.name,
                            google_home_ip: selected.ip
                          }));
                        }
                      }}
                      defaultValue=""
                    >
                      <option value="" disabled>-- Select a Speaker --</option>
                      {scanResults.map(device => (
                        <option key={device.ip} value={device.ip}>{device.name} ({device.ip})</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            ) : null}
          </div>

          <div style={{ borderTop: '1px solid var(--border-glass)', padding: '16px 0 0 0', marginTop: 8 }}>
            <h4 style={{ marginBottom: 12, fontSize: '0.95rem' }}>Workspace Configuration</h4>
            <div className="form-group" style={{ margin: 0 }}>
              <label>Working Directory</label>
              <input
                type="text"
                className="form-control"
                placeholder="Absolute path to workspace root"
                value={settings.working_directory || ''}
                onChange={e => setSettings(prev => ({ ...prev, working_directory: e.target.value }))}
              />
            </div>
          </div>

          <button
            className="btn-primary"
            style={{ marginTop: 8, width: '100%' }}
            onClick={() => {
              if (useOnline) {
                setShowConfirmModal(true);
              } else {
                const localModelName = settings.model_name || 'qwen2.5-coder-7b-instruct';
                saveSettings({
                  ...settings,
                  provider: 'local',
                  model_name: localModelName,
                  preferred_local_model: localModelName,
                  supervisor_model: localModelName
                });
              }
            }}
          >
            Save Configuration
          </button>
        </div>
      </div>

      {showConfirmModal && (
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
            maxWidth: '420px',
            width: '100%',
            padding: '24px',
            background: 'var(--bg-glass)',
            border: '1px solid var(--border-glass)',
            borderRadius: '20px',
            boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.4)',
            textAlign: 'center'
          }}>
            <h3 style={{ fontSize: '1.25rem', fontWeight: 650, marginBottom: '16px', color: '#fff' }}>
              Confirm Online Routing
            </h3>
            <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '24px', lineHeight: '1.5' }}>
              You are about to route your Private AI requests to an online provider:<br/>
              <strong>Provider:</strong> {settings.online_provider || 'gemini'}<br/>
              <strong>Model:</strong> {settings.model_name || 'gemini-2.0-flash'}<br/><br/>
              Do you wish to proceed?
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setShowConfirmModal(false);
                  saveSettings({
                    ...settings,
                    provider: 'online'
                  });
                }}
                style={{ padding: '8px 20px', fontSize: '0.9rem', margin: 0 }}
              >
                Confirm
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setShowConfirmModal(false)}
                style={{ padding: '8px 20px', fontSize: '0.9rem', margin: 0 }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
