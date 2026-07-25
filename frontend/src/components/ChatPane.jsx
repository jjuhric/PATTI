import React, { useState, useEffect, useRef } from 'react';
import { Calendar, Search, Send, Square, Cpu, CloudSun, Newspaper, FileText, Volume2, VolumeX, Paperclip, X, Image as ImageIcon } from 'lucide-react';
import { marked } from 'marked';
import ExpandableThoughts from './ExpandableThoughts';

// Configure marked to open all links in a new tab
marked.use({
  renderer: {
    link(token) {
      let href, title, text;
      if (typeof token === 'object' && token !== null && 'href' in token) {
        href = token.href;
        title = token.title;
        text = token.text;
      } else {
        href = arguments[0];
        title = arguments[1];
        text = arguments[2];
      }
      const cleanHref = href ? href.replace(/"/g, '&quot;') : '';
      const cleanTitle = title ? ` title="${title.replace(/"/g, '&quot;')}"` : '';
      return `<a href="${cleanHref}"${cleanTitle} target="_blank" rel="noopener noreferrer">${text}</a>`;
    }
  }
});

export default function ChatPane({
  token,
  settings,
  messages,
  activeChatId,
  isStreaming,
  streamThoughts,
  streamContent,
  toolLogs,
  inputText,
  setInputText,
  handleSendMessage,
  handleStop,
  messagesEndRef,
  handleResolveCommand,
  streamStatus
}) {
  const [editedCommands, setEditedCommands] = useState({});
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [isUploading, setIsUploading] = useState(false);
  const scrollerRef = useRef(null);
  const isAtBottomRef = useRef(true);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  const handleFilesSelected = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0 || !activeChatId) return;

    setIsUploading(true);
    for (const file of files) {
      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('chatId', activeChatId);

        const res = await fetch('/api/attachments/upload', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          body: formData
        });
        const data = await res.json();
        if (!res.ok) {
          console.error('Attachment upload failed:', data.error);
          continue;
        }
        setPendingAttachments(prev => [...prev, data]);
      } catch (err) {
        console.error('Attachment upload failed:', err);
      }
    }
    setIsUploading(false);
  };

  const handleRemoveAttachment = async (id) => {
    setPendingAttachments(prev => prev.filter(a => a.id !== id));
    try {
      await fetch(`/api/attachments/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    } catch (err) {
      console.error('Failed to delete attachment:', err);
    }
  };

  const handleSubmitWithAttachments = (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    const ids = pendingAttachments.map(a => a.id);
    setPendingAttachments([]);
    handleSendMessage(e, null, ids);
  };

  // Auto-grow textarea height
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [inputText]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (inputText.trim() && activeChatId && !isStreaming) {
        handleSubmitWithAttachments(e);
      }
    }
  };

  const [voiceEnabled, setVoiceEnabled] = useState(() => {
    try {
      if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
        return localStorage.getItem('private_ai_voice_enabled') === 'true';
      }
    } catch (e) {}
    return false;
  });
  const [wasStreaming, setWasStreaming] = useState(false);
  const audioRef = useRef(null);

  useEffect(() => {
    try {
      if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
        localStorage.setItem('private_ai_voice_enabled', voiceEnabled);
      }
    } catch (e) {}
  }, [voiceEnabled]);

  // Clean up audio on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  // Stop audio if user toggles voice off
  useEffect(() => {
    if (!voiceEnabled && audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
  }, [voiceEnabled]);

  // Stop audio if a new message is added by the user (meaning they started a new turn)
  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    if (lastMessage && lastMessage.role === 'user') {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    }
  }, [messages]);

  // Speak assistant message when streaming completes
  useEffect(() => {
    if (isStreaming) {
      setWasStreaming(true);
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    } else if (wasStreaming && !isStreaming) {
      setWasStreaming(false);
      if (voiceEnabled && streamContent && streamContent.trim() !== '') {
        speakText(streamContent);
      }
    }
  }, [isStreaming, streamContent, voiceEnabled, wasStreaming]);

  // Speak the last message if user manually enables voice
  const prevVoiceEnabled = useRef(voiceEnabled);
  useEffect(() => {
    if (voiceEnabled && !prevVoiceEnabled.current) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage && lastMessage.role === 'assistant' && lastMessage.content) {
        if (!lastMessage.content.includes('INPUT_REQUIRED_CHOICES')) {
          speakText(lastMessage.content);
        }
      }
    }
    prevVoiceEnabled.current = voiceEnabled;
  }, [voiceEnabled, messages]);

  const speakText = async (text) => {
    try {
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      if (!response.ok) {
        throw new Error(`TTS API returned status ${response.status}`);
      }
      const data = await response.json();
      if (data.audioUrl) {
        if (audioRef.current) {
          audioRef.current.pause();
        }
        const audio = new Audio(data.audioUrl);
        audioRef.current = audio;
        audio.play().catch(err => {
          console.warn('Audio playback was blocked or failed:', err);
        });
      }
    } catch (err) {
      console.error('Failed to speak response:', err);
    }
  };

  const scrollToBottom = (behavior = 'smooth') => {
    if (messagesEndRef && messagesEndRef.current && typeof messagesEndRef.current.scrollIntoView === 'function') {
      messagesEndRef.current.scrollIntoView({ behavior });
    } else if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  };

  // Scroll to bottom on mount (tab switch / back to chat)
  useEffect(() => {
    scrollToBottom('auto');
    isAtBottomRef.current = true;
  }, []);

  // Monitor scroll events to see if user manually scrolled up
  const handleScroll = () => {
    if (!scrollerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollerRef.current;
    // If we are within 120px of the bottom, we consider ourselves at the bottom
    const atBottom = scrollHeight - scrollTop - clientHeight <= 120;
    isAtBottomRef.current = atBottom;
  };

  // Scroll to bottom on updates if we are at the bottom or it was a user message
  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    const isUserMsg = lastMessage && lastMessage.role === 'user';
    if (isUserMsg || isAtBottomRef.current) {
      scrollToBottom('smooth');
    }
  }, [messages, streamContent, streamThoughts, toolLogs]);

  const starterPrompts = [
    { icon: <Cpu size={16} color="#a78bfa" />, text: "Check host CPU temperature & RAM specs", query: "Can you inspect my computer specifications, thermal temperature, and battery telemetry?" },
    { icon: <CloudSun size={16} color="#38bdf8" />, text: "Check local weather forecast", query: "What is the weather forecast for my location?" },
    { icon: <Newspaper size={16} color="#34d399" />, text: "Summarize recent AI technology news", query: "Search for the latest artificial intelligence news articles and summarize them." },
    { icon: <FileText size={16} color="#f472b6" />, text: "Search Document Vault notes", query: "Query my document vault for relevant notes and information." }
  ];

  const handleCommandChange = (commandId, value) => {
    setEditedCommands(prev => ({ ...prev, [commandId]: value }));
  };

  return (
    <div className="chat-pane">
      {activeChatId && (
        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          padding: '10px 20px',
          borderBottom: '1px solid var(--border-glass)',
          background: 'var(--bg-glass)',
          backdropFilter: 'blur(10px)',
          zIndex: 10
        }}>
          <button
            onClick={() => setVoiceEnabled(!voiceEnabled)}
            className="btn-icon"
            title={voiceEnabled ? "Mute Voice Response" : "Unmute Voice Response"}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              padding: '6px 12px',
              fontSize: '0.85rem',
              fontWeight: 600,
              borderRadius: '8px',
              border: '1px solid var(--border-glass)',
              background: 'rgba(255,255,255,0.02)',
              color: voiceEnabled ? 'var(--accent-primary)' : 'var(--text-secondary)',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              filter: voiceEnabled ? 'drop-shadow(0 0 6px rgba(139, 92, 246, 0.4))' : 'none'
            }}
          >
            {voiceEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
            <span>{voiceEnabled ? "Voice: Enabled" : "Voice: Muted"}</span>
          </button>
        </div>
      )}
      <div className="messages-scroller" ref={scrollerRef} onScroll={handleScroll}>
        {!activeChatId ? (
          <div style={{ textAlign: 'center', color: 'var(--text-secondary)', marginTop: '20vh' }}>
            <img 
              src="/logo.png" 
              alt="Logo" 
              style={{ width: 80, height: 80, opacity: 0.5, marginBottom: 16 }} 
              onError={(e) => e.target.src = 'https://placehold.co/100x100?text=AG'} 
            />
            <h3>No Active Chat</h3>
            <p style={{ fontSize: '0.9rem', marginTop: 8 }}>
              Please click <strong>New Chat</strong> in the sidebar to start a new chat.
            </p>
          </div>
        ) : (
          messages.length === 0 && !isStreaming && (
            <div className="starter-container">
              <img 
                src="/logo.png" 
                alt="Logo" 
                style={{ width: 72, height: 72, marginBottom: 16 }} 
                onError={(e) => e.target.src = 'https://placehold.co/100x100?text=AG'} 
              />
              <h3 className="starter-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                Welcome to&nbsp;
                <img 
                  src="/patti_text.png" 
                  alt="PATTI" 
                  className="patti-logo-image chat-patti-logo" 
                />
              </h3>
              <p className="starter-subtitle" style={{ fontSize: '1.1rem', letterSpacing: '0.5px', opacity: 0.9 }}>
                <span className="special-letter">P</span>
                <span className="normal-text">rofessional&nbsp;</span>
                <span className="special-letter">A</span>
                <span className="normal-text">rtificial&nbsp;</span>
                <span className="special-letter">T</span>
                <span className="normal-text">ext&nbsp;</span>
                <span className="normal-text">and&nbsp;</span>
                <span className="special-letter">T</span>
                <span className="normal-text">ype&nbsp;</span>
                <span className="special-letter">I</span>
                <span className="normal-text">ntelligence</span>
              </p>
              <div className="starter-chips-grid">
                {starterPrompts.map((chip, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="starter-chip"
                    onClick={() => setInputText(chip.query)}
                  >
                    {chip.icon}
                    <span>{chip.text}</span>
                  </button>
                ))}
              </div>
            </div>
          )
        )}
        
        {messages.map(msg => (
          <div key={msg.id} className={`message-bubble-wrapper ${msg.role}`}>
            {msg.thoughts && <ExpandableThoughts thoughts={msg.thoughts} />}
            {msg.attachments && msg.attachments.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', margin: '4px 0' }}>
                {msg.attachments.map(att => (
                  att.kind === 'image' ? (
                    <img
                      key={att.id}
                      src={`/api/attachments/${att.id}/file?token=${token}`}
                      alt={att.filename}
                      style={{ maxWidth: 160, maxHeight: 160, borderRadius: 8, border: '1px solid var(--border-glass)' }}
                    />
                  ) : (
                    <span
                      key={att.id}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '6px 10px', borderRadius: 8, background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-glass)', fontSize: '0.8rem' }}
                    >
                      <FileText size={14} /> {att.filename}
                    </span>
                  )
                ))}
              </div>
            )}
            {msg.content && msg.content.trim() !== '' && (
              <div
                className="message-bubble"
                dangerouslySetInnerHTML={{ __html: marked.parse(msg.content) }}
              />
            )}
          </div>
        ))}

        {/* Streaming Content indicators */}
        {isStreaming && (
          <div className="message-bubble-wrapper assistant">
            {streamThoughts && <ExpandableThoughts thoughts={streamThoughts} defaultExpanded={true} />}
            {toolLogs.map((log, idx) => {
              if (log.type === 'command_approval') {
                const currentCmd = editedCommands[log.commandId] !== undefined ? editedCommands[log.commandId] : log.command;
                const sa = log.safety_analysis;
                const riskColors = {
                  low: '#51cf66',
                  medium: '#fcc419',
                  high: '#ff6b6b'
                };
                const riskColor = sa && sa.risk_level ? riskColors[sa.risk_level.toLowerCase()] || '#ff6b6b' : '#ff6b6b';
                const riskLabel = sa && sa.risk_level ? sa.risk_level.toUpperCase() : 'UNKNOWN';

                return (
                  <div key={idx} className="memory-card" style={{ 
                    margin: '10px 0', 
                    padding: '16px', 
                    background: 'rgba(230, 80, 80, 0.1)', 
                    border: '1px solid rgba(230, 80, 80, 0.3)',
                    borderRadius: '12px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px', color: '#ff6b6b', margin: 0 }}>
                        🛡️ Host Script Execution Request
                        {(settings?.is_main_host === 1 || settings?.is_main_host === true) && (
                          <span style={{ fontSize: '0.75rem', background: '#ff4444', color: '#fff', padding: '2px 6px', borderRadius: '4px', marginLeft: '8px' }}>
                            WINDOWS STRICT MODE
                          </span>
                        )}
                      </div>
                      <span style={{ 
                        fontSize: '0.75rem', 
                        fontWeight: 'bold', 
                        color: riskColor, 
                        border: `1px solid ${riskColor}`, 
                        padding: '2px 8px', 
                        borderRadius: '12px',
                        background: 'rgba(0,0,0,0.2)'
                      }}>
                        {riskLabel} RISK
                      </span>
                    </div>
                    {sa && (
                      <div style={{ fontSize: '0.8rem', color: '#eee', display: 'flex', flexDirection: 'column', gap: '6px', background: 'rgba(0,0,0,0.15)', padding: '10px', borderRadius: '8px' }}>
                        {sa.reason && <div><strong>What it does:</strong> {sa.reason}</div>}
                        {sa.potential_harm && <div><strong>Potential Harm:</strong> {sa.potential_harm}</div>}
                        {sa.recommendation && <div><strong>Recommendation:</strong> <span style={{ color: riskColor }}>{sa.recommendation.replace(/_/g, ' ').toUpperCase()}</span></div>}
                      </div>
                    )}
                    <p style={{ fontSize: '0.85rem', margin: 0, color: 'var(--text-secondary)' }}>
                      {(settings?.is_main_host === 1 || settings?.is_main_host === true)
                        ? "⚠️ STRICT MODE: The AI wants to execute a terminal command on the Main Host. Because Windows runs the LLM, any system changes here are inherently risky. Please review carefully."
                        : "The AI wants to execute a terminal command. You can review, edit, or reject this request."
                      }
                    </p>
                    
                    {log.status === 'pending' ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <input 
                          type="text" 
                          className="form-control" 
                          value={currentCmd}
                          onChange={(e) => handleCommandChange(log.commandId, e.target.value)}
                          style={{ 
                            fontFamily: 'monospace', 
                            fontSize: '0.85rem', 
                            background: 'rgba(0,0,0,0.3)', 
                            border: '1px solid var(--accent-primary)',
                            color: '#fff',
                            padding: '8px 12px',
                            borderRadius: '6px',
                            width: '100%'
                          }}
                        />
                        <div style={{ display: 'flex', gap: '10px' }}>
                          <button 
                            type="button"
                            className="btn btn-primary"
                            onClick={() => handleResolveCommand(log.commandId, true, currentCmd)}
                            style={{ padding: '6px 16px', fontSize: '0.85rem' }}
                          >
                            Approve
                          </button>
                          <button 
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => handleResolveCommand(log.commandId, false, currentCmd)}
                            style={{ padding: '6px 16px', fontSize: '0.85rem', border: '1px solid rgba(255,255,255,0.1)' }}
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ fontSize: '0.85rem', color: '#fff', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <div>Command: <code style={{ background: 'rgba(0,0,0,0.3)', padding: '2px 6px', borderRadius: '4px' }}>{log.command}</code></div>
                        <div style={{ fontWeight: 600, color: log.status === 'approved' ? '#51cf66' : '#ff6b6b' }}>
                          Status: {log.status.toUpperCase()}
                        </div>
                      </div>
                    )}
                  </div>
                );
              }

              return (
                <div key={idx} className="tool-call-log">
                  {log.tool === 'calendar' ? (
                    <Calendar size={14} />
                  ) : (
                    <Search size={14} />
                  )}
                  <span>Running tool action: {log.action} ({JSON.stringify(log.params)})</span>
                </div>
              );
            })}
            {(streamContent || isStreaming) && (
              <div className={`message-bubble ${!streamContent ? 'typing-cursor' : ''}`}>
                {!streamContent && streamStatus ? (
                  <div className="flex items-center gap-2 text-sm italic text-secondary animate-pulse" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span className="loading loading-spinner loading-xs" style={{ display: 'inline-block', width: '12px', height: '12px', border: '2px solid currentColor', borderRightColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></span>
                    {streamStatus}
                  </div>
                ) : (
                  <div dangerouslySetInnerHTML={{ __html: marked.parse(streamContent || 'Thinking...') }} />
                )}
              </div>
            )}
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>

      {pendingAttachments.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', padding: '8px 20px 0' }}>
          {pendingAttachments.map(att => (
            <div
              key={att.id}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '6px 10px', borderRadius: 8, background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-glass)', fontSize: '0.8rem' }}
            >
              {att.kind === 'image' ? <ImageIcon size={14} /> : <FileText size={14} />}
              <span>{att.filename}</span>
              <button
                type="button"
                onClick={() => handleRemoveAttachment(att.id)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex', padding: 0 }}
                title="Remove attachment"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={handleSubmitWithAttachments} className="input-pane">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,.pdf,.docx,.txt,.md"
          style={{ display: 'none' }}
          onChange={handleFilesSelected}
        />
        <button
          type="button"
          className="btn-icon"
          onClick={() => fileInputRef.current && fileInputRef.current.click()}
          disabled={!activeChatId || isStreaming || isUploading}
          title="Attach image or document"
        >
          <Paperclip size={18} />
        </button>
        <div className="input-box">
          <textarea
            ref={textareaRef}
            rows={1}
            placeholder={activeChatId ? (isStreaming ? "AI is thinking..." : "Send a message...") : "Select or create a chat to begin"}
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!activeChatId || isStreaming}
          />
        </div>
        {isStreaming ? (
          <button type="button" className="btn-stop" onClick={handleStop} title="Stop generating">
            <Square size={18} fill="currentColor" />
          </button>
        ) : (
          <button type="submit" className="btn-send" disabled={!activeChatId || !inputText.trim()}>
            <Send size={18} />
          </button>
        )}
      </form>
    </div>
  );
}

