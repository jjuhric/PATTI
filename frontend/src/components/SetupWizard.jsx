import React, { useState, useEffect } from 'react';
import { Eye, EyeOff, Check, AlertCircle, Cpu, Globe, Settings, User, Monitor, Server } from 'lucide-react';

export default function SetupWizard({ token, onComplete }) {
  const [step, setStep] = useState(1);
  
  // Step 1: Device Selection
  const [deviceForm, setDeviceForm] = useState({
    device_type: 'windows',
    is_main_host: 1
  });

  // Step 2: Profile Data
  const [profileForm, setProfileForm] = useState({
    name: '',
    zipcode: '',
    country: 'US',
    temp_unit: 'imperial',
    weather_api_key: ''
  });

  // Step 2: Settings Data
  const [llmForm, setLlmForm] = useState({
    provider: 'local', // 'local' or 'gemini'
    local_url: 'http://192.168.1.42:1234/v1',
    local_api_style: 'openai',
    local_key: '',
    online_provider: 'gemini',
    online_url: '',
    online_key: '',
    model_name: ''
  });

  const [localModels, setLocalModels] = useState([]);
  const [onlineModels, setOnlineModels] = useState(['gemini-2.0-flash', 'gemini-1.5-pro', 'gpt-4o', 'claude-3-5-sonnet-latest']);
  const [showLocalKey, setShowLocalKey] = useState(false);
  const [showOnlineKey, setShowOnlineKey] = useState(false);
  const [showWeatherKey, setShowWeatherKey] = useState(false);
  const [useOnline, setUseOnline] = useState(false);
  const [showOnlineConfirm, setShowOnlineConfirm] = useState(false);

  // Connection testing states
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // { success: boolean, message: string }

  // Sync model dropdowns if provider changes
  useEffect(() => {
    if (llmForm.provider === 'local') {
      setLlmForm(prev => ({
        ...prev,
        model_name: localModels[0] || 'qwen2.5-coder-7b-instruct'
      }));
    } else {
      const currentProvider = llmForm.online_provider;
      let defaultModel = 'gemini-2.0-flash';
      if (currentProvider === 'openai') defaultModel = 'gpt-4o';
      else if (currentProvider === 'anthropic') defaultModel = 'claude-3-5-sonnet-latest';
      setLlmForm(prev => ({
        ...prev,
        model_name: defaultModel
      }));
    }
  }, [llmForm.provider, llmForm.online_provider, localModels]);

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/settings/test-connection', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          provider: llmForm.provider,
          localUrl: llmForm.local_url,
          localApiKey: llmForm.local_key,
          onlineKey: llmForm.online_key,
          onlineProvider: llmForm.online_provider,
          onlineUrl: llmForm.online_url
        })
      });
      const data = await res.json();
      if (res.ok) {
        setTestResult({ success: true, message: data.message || 'Connection test passed!' });
        // Fetch local models if testing local successfully
        if (llmForm.provider === 'local') {
          fetchLocalModels();
        }
      } else {
        setTestResult({ success: false, message: data.error || 'Connection failed.' });
      }
    } catch (err) {
      setTestResult({ success: false, message: err.message });
    } finally {
      setTesting(false);
    }
  };

  const fetchLocalModels = async () => {
    try {
      const url = `/api/settings/local-models?localUrl=${encodeURIComponent(llmForm.local_url)}&localApiKey=${encodeURIComponent(llmForm.local_key || '')}&localApiStyle=${encodeURIComponent(llmForm.local_api_style || '')}`;
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.length > 0) {
          setLocalModels(data);
          setLlmForm(prev => ({ ...prev, model_name: data[0] }));
        } else {
          alert('No models found on the local LLM server. Please load a model in LM Studio/Ollama first.');
        }
      } else {
        const errData = await res.json();
        alert(`Failed to fetch local models: ${errData.error || 'Connection failed'}`);
      }
    } catch (err) {
      console.error('Failed to fetch local models:', err);
      alert('Failed to fetch local models: Connection failed');
    }
  };

  const handleSave = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    try {
      // 1. Save Profile
      const profileRes = await fetch('/api/profile', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(profileForm)
      });
      if (!profileRes.ok) {
        const errData = await profileRes.json();
        throw new Error(errData.error || 'Failed to save user profile');
      }

      // 2. Save Settings
      const savedProvider = useOnline ? 'online' : 'local';
      const savedModelName = useOnline ? (llmForm.model_name || 'gemini-2.0-flash') : 'qwen2.5-coder-7b-instruct';

      const settingsRes = await fetch('/api/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          provider: savedProvider,
          model_name: savedModelName,
          local_url: llmForm.local_url,
          local_api_style: llmForm.local_api_style,
          local_key: llmForm.local_key,
          online_provider: llmForm.online_provider,
          online_url: llmForm.online_url,
          online_key: llmForm.online_key,
          device_type: deviceForm.device_type,
          is_main_host: deviceForm.is_main_host,
          preferred_local_model: 'qwen2.5-coder-7b-instruct',
          preferred_online_model: savedModelName
        })
      });
      if (!settingsRes.ok) {
        const errData = await settingsRes.json();
        throw new Error(errData.error || 'Failed to save settings');
      }

      onComplete();
    } catch (err) {
      alert(`Error saving setup configuration: ${err.message}`);
    }
  };

  const isStep3Valid = () => {
    if (deviceForm.is_main_host) {
      if (!llmForm.local_url || !llmForm.local_url.startsWith('http')) return false;
    }
    if (useOnline) {
      if (!llmForm.online_key || llmForm.online_key.length < 5) return false;
    }
    return true;
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      background: 'radial-gradient(circle at center, #1b263b 0%, #0d1b2a 100%)',
      color: '#fff',
      padding: '20px'
    }}>
      <div style={{
        width: '100%',
        maxWidth: '560px',
        background: 'rgba(255, 255, 255, 0.03)',
        backdropFilter: 'blur(16px)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: '24px',
        padding: '32px',
        boxShadow: '0 20px 40px rgba(0, 0, 0, 0.4)'
      }}>
        {/* Step Progress Indicators */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '32px', position: 'relative' }}>
          <div style={{
            position: 'absolute',
            top: '50%',
            left: 0,
            right: 0,
            height: '2px',
            background: 'rgba(255,255,255,0.1)',
            transform: 'translateY(-50%)',
            zIndex: 1
          }}>
            <div style={{
              height: '100%',
              width: step === 1 ? '0%' : step === 2 ? '33%' : step === 3 ? '66%' : '100%',
              background: 'var(--accent-primary)',
              transition: 'width 0.3s ease'
            }} />
          </div>
          
          {[1, 2, 3, 4].map(s => (
            <div key={s} style={{
              width: '40px',
              height: '40px',
              borderRadius: '50%',
              background: step > s ? 'var(--accent-primary)' : step === s ? '#1e293b' : '#0f172a',
              border: `2px solid ${step >= s ? 'var(--accent-primary)' : 'rgba(255,255,255,0.1)'}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 'bold',
              fontSize: '0.9rem',
              color: step >= s ? '#fff' : 'rgba(255,255,255,0.4)',
              zIndex: 2,
              transition: 'all 0.3s ease'
            }}>
              {step > s ? <Check size={18} /> : s}
            </div>
          ))}
        </div>

        {/* Form Body */}
        {step === 1 && (
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 600, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Monitor className="text-accent-primary" size={24} /> Device Selection
            </h2>
            <p style={{ fontSize: '0.9rem', color: 'rgba(255,255,255,0.6)', marginBottom: '24px' }}>
              Select the hardware type for this node. The Main Host runs the LLM, while Field Nodes execute commands remotely.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div 
                onClick={() => {
                  setDeviceForm({ device_type: 'windows', is_main_host: 1 });
                  setLlmForm(prev => ({ ...prev, local_url: 'http://127.0.0.1:1234/v1' }));
                }}
                style={{ 
                  padding: '16px', borderRadius: '12px', border: `2px solid ${deviceForm.device_type === 'windows' ? 'var(--accent-primary)' : 'rgba(255,255,255,0.1)'}`, 
                  background: 'rgba(0,0,0,0.2)', cursor: 'pointer', transition: 'all 0.2s' 
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
                  <Monitor size={20} /> <span style={{ fontWeight: 600 }}>Windows (Main Host)</span>
                </div>
                <p style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.6)', margin: 0 }}>
                  This device will run the LLM. ⚠️ All system commands require explicit approval.
                </p>
              </div>

              <div 
                onClick={() => {
                  setDeviceForm({ device_type: 'rpi-5-8gb', is_main_host: 0 });
                  setLlmForm(prev => ({ ...prev, local_url: 'http://192.168.1.42:1234/v1' }));
                }}
                style={{ 
                  padding: '16px', borderRadius: '12px', border: `2px solid ${deviceForm.device_type.startsWith('rpi') ? 'var(--accent-primary)' : 'rgba(255,255,255,0.1)'}`, 
                  background: 'rgba(0,0,0,0.2)', cursor: 'pointer', transition: 'all 0.2s' 
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
                  <Server size={20} /> <span style={{ fontWeight: 600 }}>Raspberry Pi (Field Node)</span>
                </div>
                <select 
                  className="form-control" 
                  value={deviceForm.device_type.startsWith('rpi') ? deviceForm.device_type : 'rpi-5-8gb'}
                  onChange={e => setDeviceForm({ device_type: e.target.value, is_main_host: 0 })}
                  onClick={e => e.stopPropagation()}
                  style={{ marginBottom: '8px', padding: '8px' }}
                >
                  <option value="rpi-zero-2w">Raspberry Pi Zero 2W</option>
                  <option value="rpi-3b">Raspberry Pi 3B / 3B+</option>
                  <option value="rpi-4b-2gb">Raspberry Pi 4B (2GB/4GB/8GB)</option>
                  <option value="rpi-5-8gb">Raspberry Pi 5 (8GB)</option>
                  <option value="rpi-5-16gb">Raspberry Pi 5 (16GB)</option>
                </select>
                <p style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.6)', margin: 0 }}>
                  Executes GPIO, sensors, and scripts. Receives commands from the Main Host.
                </p>
              </div>

              <div 
                onClick={() => {
                  setDeviceForm({ device_type: 'esp32-s3', is_main_host: 0 });
                  setLlmForm(prev => ({ ...prev, local_url: 'http://192.168.1.42:1234/v1' }));
                }}
                style={{ 
                  padding: '16px', borderRadius: '12px', border: `2px solid ${deviceForm.device_type.startsWith('esp32') ? 'var(--accent-primary)' : 'rgba(255,255,255,0.1)'}`, 
                  background: 'rgba(0,0,0,0.2)', cursor: 'pointer', transition: 'all 0.2s' 
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
                  <Cpu size={20} /> <span style={{ fontWeight: 600 }}>ESP32 WiFi (MicroPython)</span>
                </div>
                <select 
                  className="form-control" 
                  value={deviceForm.device_type.startsWith('esp32') ? deviceForm.device_type : 'esp32-s3'}
                  onChange={e => setDeviceForm({ device_type: e.target.value, is_main_host: 0 })}
                  onClick={e => e.stopPropagation()}
                  style={{ marginBottom: '8px', padding: '8px' }}
                >
                  <option value="esp32">ESP32</option>
                  <option value="esp32-s2">ESP32-S2</option>
                  <option value="esp32-s3">ESP32-S3</option>
                  <option value="esp32-c3">ESP32-C3</option>
                  <option value="esp32-c6">ESP32-C6</option>
                </select>
                <p style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.6)', margin: 0 }}>
                  Minimal REST Node.
                </p>
              </div>
            </div>
            
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '32px' }}>
              <button className="btn btn-primary" onClick={() => setStep(2)} style={{ padding: '10px 24px' }}>
                Continue
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 600, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <User className="text-accent-primary" size={24} /> Personal Profile Details
            </h2>
            <p style={{ fontSize: '0.9rem', color: 'rgba(255,255,255,0.6)', marginBottom: '24px' }}>
              Let's customize your AI assistant. Tell us a bit about yourself so the weather and local tools work perfectly.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.7)', display: 'block', marginBottom: '6px' }}>First / Preferred Name</label>
                <input 
                  type="text" 
                  className="form-control"
                  placeholder="Jeffery"
                  value={profileForm.name}
                  onChange={e => setProfileForm(prev => ({ ...prev, name: e.target.value }))}
                  required
                />
              </div>

              <div style={{ display: 'flex', gap: '16px' }}>
                <div className="form-group" style={{ flex: 1, margin: 0 }}>
                  <label style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.7)', display: 'block', marginBottom: '6px' }}>Zipcode</label>
                  <input 
                    type="text" 
                    className="form-control"
                    placeholder="32421"
                    value={profileForm.zipcode}
                    onChange={e => setProfileForm(prev => ({ ...prev, zipcode: e.target.value }))}
                  />
                </div>
                <div className="form-group" style={{ flex: 1, margin: 0 }}>
                  <label style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.7)', display: 'block', marginBottom: '6px' }}>Country Code</label>
                  <input 
                    type="text" 
                    className="form-control"
                    placeholder="US"
                    maxLength={3}
                    value={profileForm.country}
                    onChange={e => setProfileForm(prev => ({ ...prev, country: e.target.value.toUpperCase().trim() }))}
                  />
                </div>
              </div>

              <div className="form-group" style={{ margin: 0 }}>
                <label style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.7)', display: 'block', marginBottom: '6px' }}>Temperature Units</label>
                <select 
                  className="form-control"
                  value={profileForm.temp_unit}
                  onChange={e => setProfileForm(prev => ({ ...prev, temp_unit: e.target.value }))}
                >
                  <option value="imperial">Imperial (°F, mph)</option>
                  <option value="metric">Metric (°C, m/s)</option>
                </select>
              </div>

              <div className="form-group" style={{ margin: 0 }}>
                <label style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.7)', display: 'block', marginBottom: '6px' }}>OpenWeatherMap API Key (Optional)</label>
                <div style={{ position: 'relative' }}>
                  <input 
                    type={showWeatherKey ? 'text' : 'password'} 
                    className="form-control"
                    placeholder="Enter weather api key"
                    value={profileForm.weather_api_key}
                    onChange={e => setProfileForm(prev => ({ ...prev, weather_api_key: e.target.value }))}
                  />
                  <button
                    type="button"
                    onClick={() => setShowWeatherKey(!showWeatherKey)}
                    style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#888', cursor: 'pointer' }}
                  >
                    {showWeatherKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '32px' }}>
              <button 
                type="button" 
                className="btn btn-secondary"
                onClick={() => setStep(1)}
                style={{ padding: '10px 24px', border: '1px solid rgba(255,255,255,0.1)' }}
              >
                Back
              </button>
              <button 
                type="button" 
                className="btn btn-primary"
                disabled={!profileForm.name.trim()}
                onClick={() => setStep(3)}
                style={{ padding: '10px 24px' }}
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 600, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Cpu className="text-accent-primary" size={24} /> LLM Configuration
            </h2>
            <p style={{ fontSize: '0.9rem', color: 'rgba(255,255,255,0.6)', marginBottom: '24px' }}>
              Configure your primary language model. The Local model is mandatory. Optionally enable Online model fallback.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* Mandatory Local LLM Settings */}
              <div style={{ padding: '16px', background: 'rgba(255, 255, 255, 0.02)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <h4 style={{ margin: 0, fontSize: '0.9rem', color: 'var(--accent-primary)', fontWeight: 600 }}>Local LLM Settings (Mandatory)</h4>
                
                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.7)', display: 'block', marginBottom: '6px' }}>Local LLM Base URL</label>
                  <input 
                    type="text" 
                    className="form-control"
                    value={llmForm.local_url}
                    onChange={e => setLlmForm(prev => ({ ...prev, local_url: e.target.value }))}
                    placeholder="e.g. http://192.168.1.42:1234/v1"
                    required
                  />
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.7)', display: 'block', marginBottom: '6px' }}>API Style</label>
                  <select
                    className="form-control"
                    value={llmForm.local_api_style}
                    onChange={e => setLlmForm(prev => ({ ...prev, local_api_style: e.target.value }))}
                  >
                    <option value="openai">OpenAI-compatible</option>
                    <option value="lm-studio">LM Studio API</option>
                    <option value="anthropic">Anthropic-compatible</option>
                    <option value="local-gemini">Gemini Local Style</option>
                  </select>
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.7)', display: 'block', marginBottom: '6px' }}>Local Key/Token (Optional)</label>
                  <div style={{ position: 'relative' }}>
                    <input 
                      type={showLocalKey ? 'text' : 'password'} 
                      className="form-control"
                      value={llmForm.local_key}
                      onChange={e => setLlmForm(prev => ({ ...prev, local_key: e.target.value }))}
                      placeholder="Token if required"
                    />
                    <button
                      type="button"
                      onClick={() => setShowLocalKey(!showLocalKey)}
                      style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#888', cursor: 'pointer' }}
                    >
                      {showLocalKey ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.7)', display: 'block', marginBottom: '6px' }}>Local Model Name</label>
                  <input 
                    type="text" 
                    className="form-control"
                    value="qwen2.5-coder-7b-instruct"
                    disabled
                    readOnly
                  />
                </div>
              </div>

              {/* Online Checkbox Toggle */}
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

              {/* Optional Online LLM Settings */}
              {useOnline && (
                <div style={{ padding: '16px', background: 'rgba(255, 255, 255, 0.02)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <h4 style={{ margin: 0, fontSize: '0.9rem', color: 'var(--accent-primary)', fontWeight: 600 }}>Online Model Settings</h4>
                  
                  <div className="form-group" style={{ margin: 0 }}>
                    <label style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.7)', display: 'block', marginBottom: '6px' }}>Online Provider</label>
                    <select
                      className="form-control"
                      value={llmForm.online_provider}
                      onChange={e => {
                        const nextProvider = e.target.value;
                        let nextModel = 'gemini-2.0-flash';
                        if (nextProvider === 'openai') nextModel = 'gpt-4o-mini';
                        else if (nextProvider === 'anthropic') nextModel = 'claude-3-5-haiku-latest';
                        
                        setLlmForm(prev => ({
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
                  {llmForm.online_provider !== 'gemini' && (
                    <div className="form-group" style={{ margin: 0 }}>
                      <label style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.7)', display: 'block', marginBottom: '6px' }}>Online API Base URL</label>
                      <input
                        type="text"
                        className="form-control"
                        placeholder={llmForm.online_provider === 'anthropic' ? 'e.g. https://api.anthropic.com' : 'e.g. https://api.openai.com/v1'}
                        value={llmForm.online_url || ''}
                        onChange={e => setLlmForm(prev => ({ ...prev, online_url: e.target.value }))}
                      />
                    </div>
                  )}
                  <div className="form-group" style={{ margin: 0 }}>
                    <label style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.7)', display: 'block', marginBottom: '6px' }}>Online Model Name</label>
                    <input 
                      type="text" 
                      className="form-control"
                      placeholder="Enter online model name (e.g. gemini-2.0-flash)"
                      value={llmForm.model_name || ''}
                      onChange={e => setLlmForm(prev => ({ ...prev, model_name: e.target.value }))}
                    />
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.7)', display: 'block', marginBottom: '6px' }}>API Key</label>
                    <div style={{ position: 'relative' }}>
                      <input 
                        type={showOnlineKey ? 'text' : 'password'} 
                        className="form-control"
                        value={llmForm.online_key}
                        onChange={e => setLlmForm(prev => ({ ...prev, online_key: e.target.value }))}
                        placeholder="Enter API Key"
                      />
                      <button
                        type="button"
                        onClick={() => setShowOnlineKey(!showOnlineKey)}
                        style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#888', cursor: 'pointer' }}
                      >
                        {showOnlineKey ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Test Connection Button */}
              <div style={{ marginTop: '8px' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleTestConnection}
                  disabled={testing || !isStep3Valid()}
                  style={{ width: '100%', padding: '10px 0', border: '1px solid rgba(255,255,255,0.1)' }}
                >
                  {testing ? 'Testing connection...' : '⚡ Test Connection'}
                </button>
              </div>

              {testResult && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '10px 12px',
                  borderRadius: '8px',
                  fontSize: '0.85rem',
                  background: testResult.success ? 'rgba(81, 207, 102, 0.15)' : 'rgba(255, 107, 107, 0.15)',
                  border: `1px solid ${testResult.success ? 'rgba(81, 207, 102, 0.3)' : 'rgba(255, 107, 107, 0.3)'}`,
                  color: testResult.success ? '#51cf66' : '#ff6b6b'
                }}>
                  {testResult.success ? <Check size={16} /> : <AlertCircle size={16} />}
                  <span>{testResult.message}</span>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginTop: '32px' }}>
              <button 
                type="button" 
                className="btn btn-secondary"
                onClick={() => setStep(2)}
                style={{ flex: 1, padding: '10px 0', border: '1px solid rgba(255,255,255,0.1)' }}
              >
                Back
              </button>
              <button 
                type="button" 
                className="btn btn-primary"
                disabled={!isStep3Valid()}
                onClick={() => setStep(4)}
                style={{ flex: 1, padding: '10px 0' }}
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 600, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Settings className="text-accent-primary" size={24} /> Configuration Summary
            </h2>
            <p style={{ fontSize: '0.9rem', color: 'rgba(255,255,255,0.6)', marginBottom: '24px' }}>
              Verify your setup preferences before launching.
            </p>

            <div style={{
              background: 'rgba(0,0,0,0.2)',
              borderRadius: '12px',
              padding: '16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              fontSize: '0.9rem',
              color: '#eee',
              border: '1px solid rgba(255,255,255,0.05)'
            }}>
              <div><strong>Device:</strong> {deviceForm.device_type}</div>
              <div><strong>Name:</strong> {profileForm.name}</div>
              <div><strong>Location:</strong> {profileForm.zipcode || 'N/A'} ({profileForm.country})</div>
              <div><strong>Units:</strong> {profileForm.temp_unit.toUpperCase()}</div>
              <div><strong>Active Provider:</strong> {useOnline ? 'ONLINE' : 'LOCAL'} ({useOnline ? llmForm.online_provider : llmForm.local_api_style})</div>
              <div><strong>Model:</strong> {useOnline ? (llmForm.model_name || 'gemini-2.0-flash') : 'qwen2.5-coder-7b-instruct'}</div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginTop: '32px' }}>
              <button 
                type="button" 
                className="btn btn-secondary"
                onClick={() => setStep(3)}
                style={{ flex: 1, padding: '10px 0', border: '1px solid rgba(255,255,255,0.1)' }}
              >
                Back
              </button>
              <button 
                type="button" 
                className="btn btn-primary"
                onClick={(e) => {
                  if (useOnline) {
                    setShowOnlineConfirm(true);
                  } else {
                    handleSave(e);
                  }
                }}
                style={{ flex: 1, padding: '10px 0' }}
              >
                Launch PATTI 🚀
              </button>
            </div>
          </div>
        )}
      </div>

      {showOnlineConfirm && (
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
            <p style={{ fontSize: '0.9rem', color: 'rgba(255,255,255,0.7)', marginBottom: '24px', lineHeight: '1.5' }}>
              You are about to route your Private AI requests to an online provider during setup:<br/>
              <strong>Provider:</strong> {llmForm.online_provider || 'gemini'}<br/>
              <strong>Model:</strong> {llmForm.model_name || 'gemini-2.0-flash'}<br/><br/>
              Do you wish to proceed?
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setShowOnlineConfirm(false);
                  handleSave();
                }}
                style={{ padding: '8px 20px', fontSize: '0.9rem', margin: 0 }}
              >
                Confirm
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setShowOnlineConfirm(false)}
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
