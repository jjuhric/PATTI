import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Bell, Info, AlertCircle, AlertTriangle, Circle } from 'lucide-react';

// FEAT-7 (docs/REVIEW_2026-08-03.md): the status dot used to be color-only (an empty span
// styled by CSS class), which conveys nothing to a color-blind user or a screen reader. Each
// type now gets a distinct shape/icon in addition to its color, plus an accessible label.
const NOTIFICATION_TYPE_ICONS = {
  info: Info,
  error: AlertCircle,
  warning: AlertTriangle
};

function timeAgo(dateStr) {
  const diffMs = Date.now() - new Date(dateStr + 'Z').getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function NotificationBell({ token, refreshSignal, onOpenChat }) {
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef(null);

  const fetchNotifications = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/notifications', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) return;
      const data = await res.json();
      setNotifications(data.notifications || []);
      setUnreadCount(data.unreadCount || 0);
    } catch (err) {
      console.error('[NotificationBell] Failed to fetch notifications:', err);
    }
  }, [token]);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications, refreshSignal]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const markRead = async (id) => {
    try {
      await fetch(`/api/notifications/${id}/read`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    } catch (err) {
      console.error('[NotificationBell] Failed to mark notification read:', err);
    }
  };

  const handleItemClick = (notif) => {
    if (!notif.is_read) {
      setNotifications(prev => prev.map(n => (n.id === notif.id ? { ...n, is_read: 1 } : n)));
      setUnreadCount(prev => Math.max(0, prev - 1));
      markRead(notif.id);
    }
    if (notif.chat_id) {
      onOpenChat(notif.chat_id);
      setIsOpen(false);
    }
  };

  const handleMarkAllRead = async () => {
    setNotifications(prev => prev.map(n => ({ ...n, is_read: 1 })));
    setUnreadCount(0);
    try {
      await fetch('/api/notifications/read-all', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    } catch (err) {
      console.error('[NotificationBell] Failed to mark all notifications read:', err);
    }
  };

  return (
    <div className="notification-bell-wrapper" ref={wrapperRef}>
      <button
        className="btn-icon notification-bell-btn"
        onClick={() => setIsOpen(o => !o)}
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        <Bell size={18} />
        {unreadCount > 0 && (
          <span className="notification-bell-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>
        )}
      </button>
      {isOpen && (
        <div className="notification-dropdown" role="menu">
          <div className="notification-dropdown-header">
            <span>Notifications</span>
            {unreadCount > 0 && (
              <button className="notification-mark-all-btn" onClick={handleMarkAllRead}>
                Mark all read
              </button>
            )}
          </div>
          {notifications.length === 0 ? (
            <div className="notification-empty">No notifications yet.</div>
          ) : (
            <ul className="notification-list">
              {notifications.map((notif) => (
                <li
                  key={notif.id}
                  className={`notification-item ${notif.is_read ? '' : 'unread'} ${notif.chat_id ? 'clickable' : ''}`}
                  onClick={() => handleItemClick(notif)}
                  role="menuitem"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') handleItemClick(notif);
                  }}
                >
                  {(() => {
                    const TypeIcon = NOTIFICATION_TYPE_ICONS[notif.type] || Circle;
                    return (
                      <TypeIcon
                        size={14}
                        className={`notification-dot ${notif.type}`}
                        role="img"
                        aria-label={`${notif.type || 'general'} notification`}
                        style={{ marginTop: '3px' }}
                      />
                    );
                  })()}
                  <div className="notification-item-body">
                    <span className="notification-item-message">{notif.message}</span>
                    <span className="notification-item-time">{timeAgo(notif.created_at)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default NotificationBell;
