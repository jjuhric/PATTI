import React from 'react';
import { MessageSquare, Plus, Edit2, X, Calendar, Settings, LogOut, Brain, Network, Send, Sliders, ShieldCheck } from 'lucide-react';

export default function Sidebar({
  user,
  chats,
  activeChatId,
  setActiveChatId,
  activeTab,
  setActiveTab,
  isMobileSidebarOpen,
  setIsMobileSidebarOpen,
  editingChatId,
  setEditingChatId,
  editingTitle,
  setEditingTitle,
  createChat,
  deleteChat,
  handleRenameChat,
  handleLogout,
  setIsSettingsOpen,
  setIsProfileOpen,
  setIsEsp32ModalOpen,
  appVersion
}) {
  return (
    <aside className={`sidebar ${isMobileSidebarOpen ? 'mobile-open' : ''}`}>
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <img 
            src="/logo.png" 
            alt="Logo" 
            className="sidebar-logo" 
            onError={(e) => e.target.src = 'https://placehold.co/100x100?text=AG'} 
          />
          <img 
            src="/patti_text.png" 
            alt="PATTI" 
            className="patti-logo-image sidebar-patti-logo" 
          />
        </div>
        <button 
          className="btn-icon" 
          onClick={() => setIsMobileSidebarOpen(false)} 
          style={{ display: isMobileSidebarOpen ? 'block' : 'none' }}
        >
          <X size={20} />
        </button>
      </div>

      <button className="btn-new-chat" onClick={createChat}>
        <Plus size={18} />
        <span>New Chat</span>
      </button>

      <nav className="chat-list">
        {chats.map(chat => (
          <div 
            key={chat.id} 
            className={`chat-item ${activeChatId === chat.id ? 'active' : ''}`}
            onClick={() => {
              if (editingChatId !== chat.id) {
                setActiveChatId(chat.id);
                setActiveTab('chat');
                setIsMobileSidebarOpen(false);
              }
            }}
          >
            <MessageSquare size={16} style={{ flexShrink: 0 }} />
            {editingChatId === chat.id ? (
              <input
                type="text"
                className="form-control"
                style={{
                  padding: '2px 8px',
                  fontSize: '0.9rem',
                  background: 'rgba(0,0,0,0.3)',
                  border: '1px solid var(--accent-primary)',
                  borderRadius: '6px',
                  color: '#fff',
                  margin: '0 4px',
                  width: '100%'
                }}
                value={editingTitle}
                onChange={e => setEditingTitle(e.target.value)}
                onBlur={() => handleRenameChat(chat.id, editingTitle)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleRenameChat(chat.id, editingTitle);
                  if (e.key === 'Escape') setEditingChatId(null);
                }}
                autoFocus
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginLeft: '6px' }}>
                  {chat.title}
                </span>
                <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingChatId(chat.id);
                      setEditingTitle(chat.title);
                    }}
                    style={{ padding: '2px' }}
                  >
                    <Edit2 size={12} />
                  </button>
                  <button 
                    onClick={(e) => deleteChat(chat.id, e)}
                    style={{ padding: '2px' }}
                  >
                    <X size={12} />
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <button 
          className={`btn-new-chat ${activeTab === 'calendar' ? 'active' : ''}`} 
          onClick={() => { setActiveTab('calendar'); setIsMobileSidebarOpen(false); }} 
          style={{ margin: 0 }}
        >
          <Calendar size={18} />
          <span>My Calendar</span>
        </button>

        <button 
          className={`btn-new-chat ${activeTab === 'personality-skills' ? 'active' : ''}`} 
          onClick={() => { setActiveTab('personality-skills'); setIsMobileSidebarOpen(false); }} 
          style={{ margin: 0 }}
        >
          <Sliders size={18} />
          <span>Persona & Skills</span>
        </button>

        <button 
          className={`btn-new-chat ${activeTab === 'memory' ? 'active' : ''}`} 
          onClick={() => { setActiveTab('memory'); setIsMobileSidebarOpen(false); }} 
          style={{ margin: 0 }}
        >
          <Brain size={18} />
          <span>AI Memory</span>
        </button>

        <button 
          className={`btn-new-chat ${activeTab === 'dashboard' ? 'active' : ''}`} 
          onClick={() => { setActiveTab('dashboard'); setIsMobileSidebarOpen(false); }} 
          style={{ margin: 0 }}
        >
          <Network size={18} />
          <span>Agent Dashboard</span>
        </button>

        <button
          className="btn-new-chat"
          onClick={() => { setIsEsp32ModalOpen(true); setIsMobileSidebarOpen(false); }}
          style={{ margin: 0 }}
        >
          <Send size={18} />
          <span>Device Messenger</span>
        </button>

        {user?.is_admin && (
          <button
            className={`btn-new-chat ${activeTab === 'admin' ? 'active' : ''}`}
            onClick={() => { setActiveTab('admin'); setIsMobileSidebarOpen(false); }}
            style={{ margin: 0 }}
          >
            <ShieldCheck size={18} />
            <span>Admin Dashboard</span>
          </button>
        )}

        <div className="user-profile">
          <span 
            onClick={() => setIsProfileOpen(true)}
            style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}
            title="View User Profile"
          >
            👤 {user?.username}
          </span>
          <div style={{ display: 'flex', gap: '4px' }}>
            <button className="btn-icon" onClick={() => setIsSettingsOpen(true)}>
              <Settings size={18} />
            </button>
            <button className="btn-icon" onClick={handleLogout}>
              <LogOut size={18} />
            </button>
          </div>
        </div>
        <div style={{
          fontSize: '0.75rem',
          textAlign: 'center',
          color: 'var(--text-secondary)',
          marginTop: '8px',
          opacity: 0.5
        }}>
          v{appVersion}
        </div>
      </div>
    </aside>
  );
}
