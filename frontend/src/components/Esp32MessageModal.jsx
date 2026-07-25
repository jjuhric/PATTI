import React, { useState, useEffect } from 'react';
import { X, Send, Cpu, MonitorX } from 'lucide-react';

export default function Esp32MessageModal({ isOpen, onClose, token, hostIps = [] }) {
  const [devices, setDevices] = useState([]);
  const [selectedIp, setSelectedIp] = useState('');
  const [deviceType, setDeviceType] = useState('ESP32');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [togglingScreen, setTogglingScreen] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleIpChange = (ip) => {
    setSelectedIp(ip);
    const dev = devices.find(d => d.ip_address === ip);
    if (dev) {
      setDeviceType(dev.device_type);
    }
  };

  useEffect(() => {
    if (!isOpen || !token) return;
    
    setMessage('');
    setError('');
    setSuccess('');
    setLoading(false);
    setSelectedIp('');

    const loadDevices = async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/nodes', {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });
        
        const filterHostIp = (ip) => {
          return hostIps.includes(ip) || ip === '127.0.0.1' || ip === 'localhost' || ip === '192.168.1.1' || ip.endsWith('.1');
        };

        if (res.ok) {
          const list = await res.json();
          const filtered = (list || []).filter(node => !filterHostIp(node.ip_address) && node.is_online === 1);
          setDevices(filtered);

          const firstOnline = filtered.find(d => d.is_online === 1);
          if (firstOnline) {
            setSelectedIp(firstOnline.ip_address);
            setDeviceType(firstOnline.device_type);
          } else if (filtered.length > 0) {
            setSelectedIp(filtered[0].ip_address);
            setDeviceType(filtered[0].device_type);
          }
        }
      } catch (err) {
        console.error('Failed to load network nodes:', err);
      } finally {
        setLoading(false);
      }
    };

    loadDevices();
  }, [isOpen, token, hostIps]);

  const triggerScan = async () => {
    setScanning(true);
    setError('');
    setSuccess('');
    try {
      const res = await fetch('/api/nodes/sync', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      const filterHostIp = (ip) => {
        return hostIps.includes(ip) || ip === '127.0.0.1' || ip === 'localhost' || ip === '192.168.1.1' || ip.endsWith('.1');
      };

      if (res.ok) {
        const data = await res.json();
        const list = (data.nodes || []).filter(node => !filterHostIp(node.ip_address) && node.is_online === 1);
        setDevices(list);
        setSuccess('Network scan completed and devices updated successfully.');

        const firstOnline = list.find(d => d.is_online === 1);
        if (firstOnline) {
          setSelectedIp(firstOnline.ip_address);
          setDeviceType(firstOnline.device_type);
        } else if (list.length > 0) {
          setSelectedIp(list[0].ip_address);
          setDeviceType(list[0].device_type);
        }
      } else {
        setError('Failed to scan and synchronize network devices.');
      }
    } catch (err) {
      console.error('Failed to sync network nodes:', err);
      setError('Network error while scanning for local devices.');
    } finally {
      setScanning(false);
    }
  };

  if (!isOpen) return null;

  const isEsp32OrRpiFamily = (type) => {
    if (!type) return false;
    const t = type.toLowerCase();
    return t.includes('esp32') || t.includes('rpi') || t.includes('raspberry');
  };

  const isHostIp = (ip) => {
    return hostIps.includes(ip) || ip === '127.0.0.1' || ip === 'localhost';
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!selectedIp) {
      setError("Please select a valid device IP Address.");
      return;
    }

    if (isHostIp(selectedIp)) {
      setError("Cannot send messages to the host's own IP address.");
      return;
    }

    if (message.length > 240) {
      const diff = message.length - 240;
      setError(`message exceeds max length 240 by ${diff} characters`);
      return;
    }

    setLoading(true);

    try {
      const res = await fetch('/api/nodes/send-message', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          ip_address: selectedIp,
          device_type: deviceType,
          message
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to send message');
      }

      setSuccess('Message sent successfully!');
      setMessage('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleScreen = async () => {
    setError('');
    setSuccess('');

    if (!selectedIp) {
      setError("Please select a valid device IP Address.");
      return;
    }

    if (isHostIp(selectedIp)) {
      setError("Cannot send commands to the host's own IP address.");
      return;
    }

    setTogglingScreen(true);

    try {
      const res = await fetch('/api/nodes/toggle-screen', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ ip_address: selectedIp })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to toggle screen');
      }

      setSuccess('Screen toggled successfully!');
    } catch (err) {
      setError(err.message);
    } finally {
      setTogglingScreen(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 1100 }}>
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '450px' }}>
        <div className="modal-header">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: 0, color: 'var(--accent-primary)' }}>
            <Cpu size={22} />
            <span>Send Device Message</span>
          </h3>
          <button className="btn-icon" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '16px' }}>
          <div className="form-group">
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              <span>Select Device IP Address</span>
              {scanning ? (
                <span style={{ fontSize: '0.8rem', color: 'var(--accent-secondary)' }}>
                  Scanning Network...
                </span>
              ) : (
                <button
                  type="button"
                  onClick={triggerScan}
                  disabled={loading}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--accent-primary)',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                    padding: 0,
                    fontWeight: 600
                  }}
                >
                  {loading ? 'Loading...' : '[Scan Network]'}
                </button>
              )}
            </label>
            <select
              className="form-control"
              value={selectedIp}
              onChange={e => handleIpChange(e.target.value)}
              disabled={scanning}
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: '8px',
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid var(--border-glass)',
                color: '#fff',
                outline: 'none',
                opacity: scanning ? 0.6 : 1
              }}
            >
              {scanning ? (
                <option value="" disabled>Scanning local subnet for active devices...</option>
              ) : devices.length === 0 ? (
                <option value="" disabled>No devices found on the network</option>
              ) : (
                devices.map(dev => {
                  const isOnline = dev.is_online === 1;
                  const statusLabel = isOnline ? ' [Online]' : ' [Offline]';
                  const label = `${dev.node_name} (${dev.ip_address}) - ${dev.device_type}${statusLabel}`;

                  return (
                    <option 
                      key={dev.id || dev.ip_address} 
                      value={dev.ip_address} 
                      disabled={!isOnline}
                      style={{ 
                        background: '#0f172a',
                        color: isOnline ? '#fff' : '#6b7280'
                      }}
                    >
                      {label}
                    </option>
                  );
                })
              )}
            </select>
          </div>

          <div className="form-group">
            <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              Device Type
            </label>
            <select
              className="form-control"
              value={deviceType}
              onChange={e => setDeviceType(e.target.value)}
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: '8px',
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid var(--border-glass)',
                color: '#fff',
                outline: 'none'
              }}
            >
              <option value="ESP32" style={{ background: '#0f172a' }}>ESP32</option>
              <option value="RPi" style={{ background: '#0f172a' }}>RPi</option>
              <option value="Windows" style={{ background: '#0f172a' }}>Windows</option>
              <option value="Google Assistant" style={{ background: '#0f172a' }}>Google Assistant</option>
            </select>
          </div>

          <div className="form-group">
            <label style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              <span>Enter Message</span>
              <span style={{ color: message.length > 240 ? '#ef4444' : 'var(--text-secondary)' }}>
                {message.length} / 240
              </span>
            </label>
            <textarea
              className="form-control"
              rows={4}
              placeholder="Type your message here..."
              value={message}
              onChange={e => setMessage(e.target.value)}
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: '8px',
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid var(--border-glass)',
                color: '#fff',
                resize: 'vertical',
                outline: 'none'
              }}
              required
            />
          </div>

          {error && (
            <div style={{
              color: '#ef4444',
              fontSize: '0.85rem',
              background: 'rgba(239, 68, 68, 0.1)',
              padding: '10px 12px',
              borderRadius: '8px',
              border: '1px solid rgba(239, 68, 68, 0.2)',
              overflowWrap: 'break-word',
              wordBreak: 'break-word'
            }}>
              ⚠️ {error}
            </div>
          )}

          {success && (
            <div style={{
              color: '#34d399',
              fontSize: '0.85rem',
              background: 'rgba(52, 211, 153, 0.1)',
              padding: '10px 12px',
              borderRadius: '8px',
              border: '1px solid rgba(52, 211, 153, 0.2)'
            }}>
              ✓ {success}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px' }}>
            <div>
              {isEsp32OrRpiFamily(deviceType) && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleToggleScreen}
                  disabled={togglingScreen}
                  style={{
                    padding: '10px 16px',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px'
                  }}
                >
                  <MonitorX size={16} />
                  <span>{togglingScreen ? 'Toggling...' : 'Toggle Screen'}</span>
                </button>
              )}
            </div>

            <div style={{ display: 'flex', gap: '12px' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onClose}
                style={{ padding: '10px 16px', borderRadius: '8px', cursor: 'pointer' }}
              >
                Close
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading || !message.trim()}
                style={{
                  padding: '10px 16px',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px'
                }}
              >
                <Send size={16} />
                <span>{loading ? 'Sending...' : 'Send Message'}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
