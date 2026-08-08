import React, { useState, useEffect } from 'react';
import { MessageSquare, Plus, Edit2, X, Calendar, Settings, LogOut, Brain, Network, Send, Sliders, ShieldCheck, Sun, Moon, Search, CheckSquare, BarChart2 } from 'lucide-react';

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
  onBulkDeleteChats = () => {},
  handleRenameChat,
  handleLogout,
  setIsSettingsOpen,
  setIsProfileOpen,
  setIsEsp32ModalOpen,
  appVersion,
  theme,
  toggleTheme,
  chatSearchQuery = '',
  setChatSearchQuery = () => {},
  chatSearchResults = [],
  isSearchingChats = false,
  onOpenSearchResult = () => {}
}) {
  const isSearching = chatSearchQuery.trim().length >= 2;
  const isLight = theme === 'light' || (!theme && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);

  // FEAT-3 (docs/REVIEW_2026-08-03.md): bulk delete for chats, behind a "Select" mode toggle -
  // the list is too narrow to show a permanent checkbox column without crowding the existing
  // rename/delete icons, so it's opt-in instead of always-on like the AdminDashboard tables.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedChatIds, setSelectedChatIds] = useState(() => new Set());
  useEffect(() => {
    setSelectedChatIds((prev) => {
      if (prev.size === 0) return prev;
      const validIds = new Set(chats.map((c) => c.id));
      const next = new Set([...prev].filter((id) => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [chats]);
  const toggleSelectChat = (id) => {
    setSelectedChatIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedChatIds(new Set());
  };

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

      <div className="sidebar-search">
        <Search size={14} className="sidebar-search-icon" />
        <input
          type="text"
          className="form-control"
          placeholder="Search chats..."
          value={chatSearchQuery}
          onChange={(e) => setChatSearchQuery(e.target.value)}
          aria-label="Search chat history"
        />
        {chatSearchQuery && (
          <button
            className="sidebar-search-clear"
            onClick={() => setChatSearchQuery('')}
            aria-label="Clear search"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {!isSearching && chats.length > 0 && (
        <div className="sidebar-select-bar">
          {selectMode ? (
            <>
              <span className="sidebar-select-count">{selectedChatIds.size} selected</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm text-error"
                disabled={selectedChatIds.size === 0}
                onClick={() => onBulkDeleteChats([...selectedChatIds], () => setSelectedChatIds(new Set()))}
              >
                Delete
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={exitSelectMode}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className="sidebar-select-toggle" onClick={() => setSelectMode(true)}>
              <CheckSquare size={13} /> Select chats
            </button>
          )}
        </div>
      )}

      <nav className="chat-list">
        {isSearching ? (
          isSearchingChats ? (
            <div className="sidebar-search-status">Searching…</div>
          ) : chatSearchResults.length === 0 ? (
            <div className="sidebar-search-status">No chats found for "{chatSearchQuery.trim()}".</div>
          ) : (
            chatSearchResults.map((result) => (
              <div
                key={result.chatId}
                className="chat-item chat-search-result"
                role="button"
                tabIndex={0}
                aria-label={`Open chat "${result.title}"`}
                onClick={() => onOpenSearchResult(result.chatId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpenSearchResult(result.chatId);
                  }
                }}
              >
                <MessageSquare size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
                <div style={{ flex: 1, overflow: 'hidden', marginLeft: '6px' }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{result.title}</div>
                  {result.snippet && (
                    <div className="chat-search-snippet">{result.snippet}</div>
                  )}
                </div>
              </div>
            ))
          )
        ) : (
        chats.map(chat => (
          <div
            key={chat.id}
            className={`chat-item ${activeChatId === chat.id ? 'active' : ''}`}
            role="button"
            tabIndex={0}
            aria-current={activeChatId === chat.id ? 'true' : undefined}
            aria-label={`Open chat "${chat.title}"`}
            onClick={() => {
              if (editingChatId === chat.id) return;
              if (selectMode) {
                toggleSelectChat(chat.id);
                return;
              }
              setActiveChatId(chat.id);
              setActiveTab('chat');
              setIsMobileSidebarOpen(false);
            }}
            onKeyDown={(e) => {
              if (editingChatId === chat.id || !(e.key === 'Enter' || e.key === ' ')) return;
              e.preventDefault();
              if (selectMode) {
                toggleSelectChat(chat.id);
                return;
              }
              setActiveChatId(chat.id);
              setActiveTab('chat');
              setIsMobileSidebarOpen(false);
            }}
          >
            {selectMode && (
              <input
                type="checkbox"
                checked={selectedChatIds.has(chat.id)}
                onChange={() => toggleSelectChat(chat.id)}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Select chat "${chat.title}"`}
                style={{ flexShrink: 0, marginRight: '8px' }}
              />
            )}
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
                {!selectMode && (
                  <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingChatId(chat.id);
                        setEditingTitle(chat.title);
                      }}
                      style={{ padding: '2px' }}
                      aria-label={`Rename chat "${chat.title}"`}
                    >
                      <Edit2 size={12} />
                    </button>
                    <button
                      onClick={(e) => deleteChat(chat.id, e)}
                      style={{ padding: '2px' }}
                      aria-label={`Delete chat "${chat.title}"`}
                    >
                      <X size={12} />
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        ))
        )}
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
          className={`btn-new-chat ${activeTab === 'usage' ? 'active' : ''}`}
          onClick={() => { setActiveTab('usage'); setIsMobileSidebarOpen(false); }}
          style={{ margin: 0 }}
        >
          <BarChart2 size={18} />
          <span>My Usage</span>
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
          <button
            className="btn-icon"
            onClick={() => setIsProfileOpen(true)}
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            aria-label={`View profile for ${user?.username || 'current user'}`}
          >
            👤 {user?.username}
          </button>
          <div style={{ display: 'flex', gap: '4px' }}>
            <button
              className="btn-icon"
              onClick={toggleTheme}
              aria-label={isLight ? 'Switch to dark theme' : 'Switch to light theme'}
              title={isLight ? 'Switch to dark theme' : 'Switch to light theme'}
            >
              {isLight ? <Moon size={18} /> : <Sun size={18} />}
            </button>
            <button className="btn-icon" onClick={() => setIsSettingsOpen(true)} aria-label="Open settings">
              <Settings size={18} />
            </button>
            <button className="btn-icon" onClick={handleLogout} aria-label="Log out">
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
