import React from 'react';
import { AlertCircle, AlertTriangle, Info, X } from 'lucide-react';

export default function CustomAlertModal({ alert, onClose }) {
  if (!alert) return null;

  const logoUrl = window.location.pathname.startsWith('/monitor') ? '/monitor/favicon.png' : '/favicon.png';
  const pattiTextUrl = window.location.pathname.startsWith('/monitor') ? '/monitor/patti_text.png' : '/patti_text.png';

  const getTypeStyles = () => {
    switch (alert.type) {
      case 'error':
        return {
          icon: <AlertCircle size={32} style={{ color: '#ef4444' }} />,
          borderColor: '#ef4444',
          badgeBg: 'rgba(239, 68, 68, 0.1)',
          badgeText: 'Error',
          badgeTextColor: '#ef4444'
        };
      case 'warning':
        return {
          icon: <AlertTriangle size={32} style={{ color: '#f59e0b' }} />,
          borderColor: '#f59e0b',
          badgeBg: 'rgba(245, 158, 11, 0.1)',
          badgeText: 'Warning',
          badgeTextColor: '#f59e0b'
        };
      case 'confirm':
        return {
          icon: <AlertTriangle size={32} style={{ color: '#f59e0b' }} />,
          borderColor: '#f59e0b',
          badgeBg: 'rgba(245, 158, 11, 0.1)',
          badgeText: 'Confirm',
          badgeTextColor: '#f59e0b'
        };
      default:
        return {
          icon: <Info size={32} style={{ color: '#8b5cf6' }} />,
          borderColor: '#8b5cf6',
          badgeBg: 'rgba(139, 92, 246, 0.1)',
          badgeText: 'Info',
          badgeTextColor: '#8b5cf6'
        };
    }
  };

  const styles = getTypeStyles();

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(15, 23, 42, 0.85)',
      backdropFilter: 'blur(8px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 99999,
      padding: '20px',
      animation: 'fadeIn 0.2s ease-out'
    }}>
      <div style={{
        backgroundColor: 'var(--bg-glass, rgba(30, 41, 59, 0.7))',
        border: `1px solid ${styles.borderColor}66`,
        backdropFilter: 'blur(20px)',
        borderRadius: '20px',
        width: '100%',
        maxWidth: '480px',
        boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.4)',
        overflow: 'hidden',
        animation: 'slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)'
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 20px',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          background: 'rgba(0, 0, 0, 0.2)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <img src={logoUrl} alt="PATTI" style={{ width: '22px', height: '22px', objectFit: 'contain' }} />
            <img 
              src={pattiTextUrl} 
              alt="PATTI" 
              className="patti-logo-image modal-patti-logo" 
            />
          </div>
          <button 
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#94a3b8',
              padding: '4px',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.2s'
            }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.08)'; e.currentTarget.style.color = '#f8fafc'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = '#94a3b8'; }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Content Body */}
        <div style={{ padding: '24px 20px', textAlign: 'center' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
            {styles.icon}
          </div>
          
          <div style={{ display: 'inline-block', padding: '4px 12px', borderRadius: '9999px', backgroundColor: styles.badgeBg, color: styles.badgeTextColor, fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', marginBottom: '12px', letterSpacing: '0.5px' }}>
            {styles.badgeText}
          </div>

          <p style={{ color: '#f1f5f9', fontSize: '0.95rem', lineHeight: 1.5, margin: 0, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
            {alert.message}
          </p>
        </div>

        {/* Action Footer */}
        <div style={{
          padding: '16px 20px',
          borderTop: '1px solid rgba(255, 255, 255, 0.08)',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '12px',
          background: 'rgba(0, 0, 0, 0.15)'
        }}>
          {alert.type === 'confirm' ? (
            <>
              <button 
                onClick={onClose}
                style={{
                  padding: '8px 20px',
                  borderRadius: '8px',
                  border: '1px solid rgba(255, 255, 255, 0.15)',
                  background: 'transparent',
                  color: '#e2e8f0',
                  fontWeight: 600,
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                  transition: 'background-color 0.2s'
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.05)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              >
                Cancel
              </button>
              <button 
                onClick={() => {
                  if (alert.onConfirm) alert.onConfirm();
                  onClose();
                }}
                style={{
                  padding: '8px 24px',
                  borderRadius: '8px',
                  border: 'none',
                  background: `linear-gradient(135deg, ${styles.borderColor}, ${styles.borderColor}cc)`,
                  color: '#ffffff',
                  fontWeight: 650,
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                  boxShadow: `0 4px 12px ${styles.borderColor}33`,
                  transition: 'opacity 0.2s'
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.9'; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
              >
                Confirm
              </button>
            </>
          ) : (
            <button 
              onClick={onClose}
              style={{
                padding: '8px 24px',
                borderRadius: '8px',
                border: 'none',
                background: `linear-gradient(135deg, ${styles.borderColor}, ${styles.borderColor}cc)`,
                color: '#ffffff',
                fontWeight: 600,
                fontSize: '0.85rem',
                cursor: 'pointer',
                boxShadow: `0 4px 12px ${styles.borderColor}33`,
                transition: 'transform 0.1s, opacity 0.2s'
              }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.9'; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
            >
              Acknowledge
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
