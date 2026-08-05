import React, { useState, useEffect, useRef } from 'react';
import { Menu, ExternalLink, Network } from 'lucide-react';
import Auth from './components/Auth';
import NotificationBell from './components/NotificationBell';
import Sidebar from './components/Sidebar';
import ChatPane from './components/ChatPane';
import CalendarPane from './components/CalendarPane';
import MemoryPane from './components/MemoryPane';
import SettingsModal from './components/SettingsModal';
import ProfileModal from './components/ProfileModal';
import AgentDashboard from './components/AgentDashboard';
import AdminDashboard from './components/AdminDashboard';
import PersonalitySkillsPane from './components/PersonalitySkillsPane';
import Toast from './components/Toast';
import SetupWizard from './components/SetupWizard';
import SudoModal from './components/SudoModal';
import PopoutWindow from './components/PopoutWindow';
import CustomAlertModal from './components/CustomAlertModal';
import Esp32MessageModal from './components/Esp32MessageModal';
import { useApi } from './hooks/useApi';



function App() {
  // Auth state
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const api = useApi(token);
  const [user, setUser] = useState(null);
  const [isLogin, setIsLogin] = useState(true);
  const [authError, setAuthError] = useState('');
  const [authForm, setAuthForm] = useState({ username: '', password: '' });
  const [toast, setToast] = useState({ message: '', type: 'info' });
  const [popupAlert, setPopupAlert] = useState(null);

  // Theme: null means "no explicit choice yet" - the CSS's own
  // prefers-color-scheme fallback decides, and PATTI stays dark by default
  // for anyone who hasn't touched the toggle, matching how it's always looked.
  const [theme, setTheme] = useState(() => {
    const stored = localStorage.getItem('patti-theme');
    return stored === 'light' || stored === 'dark' ? stored : null;
  });

  useEffect(() => {
    if (theme) {
      document.documentElement.dataset.theme = theme;
      localStorage.setItem('patti-theme', theme);
    } else {
      delete document.documentElement.dataset.theme;
    }
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => {
      if (prev === 'light') return 'dark';
      if (prev === 'dark') return 'light';
      const systemPrefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
      return systemPrefersLight ? 'dark' : 'light';
    });
  };
  const [popupConfirm, setPopupConfirm] = useState(null);
  const [popupChoices, setPopupChoices] = useState(null);

  const handleSelectChoice = (choice) => {
    setPopupChoices(null);
    if (choice.includes("Specify another") || choice.includes("Specify custom")) {
      const inputEl = document.querySelector('.input-box input');
      if (inputEl) inputEl.focus();
    } else {
      handleSendMessage(null, choice);
    }
  };

  // Ask once for permission to show real OS notification popups (e.g. "your project build
  // is ready") so long-running background jobs can notify the user even when they're not
  // looking at this tab. Browsers only honor requestPermission() from a user gesture in
  // some cases, but calling it here is harmless if it's a no-op - it just won't prompt.
  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  useEffect(() => {
    window.alert = (message) => {
      let type = 'info';
      if (message.toLowerCase().includes('fail') || message.toLowerCase().includes('error')) {
        type = 'error';
      } else if (message.toLowerCase().includes('warn')) {
        type = 'warning';
      }
      setPopupAlert({
        type,
        title: 'PATTI',
        message
      });
    };
  }, []);

  const showToast = (message, type = 'info') => {
    setToast({ message, type });
  };

  // Bumped whenever a persisted (notifyUser-originated) alert arrives over SSE, so
  // NotificationBell knows to refetch - see the alert.notificationId check below.
  const [notifRefreshTick, setNotifRefreshTick] = useState(0);

  // Navigation and panels
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [activeTab, setActiveTab] = useState('chat'); // 'chat' or 'calendar'
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [editingChatId, setEditingChatId] = useState(null);
  const [editingTitle, setEditingTitle] = useState('');

  const hasInitializedRef = useRef(false);
  const abortControllerRef = useRef(null);

  // Settings
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSetupComplete, setIsSetupComplete] = useState(true);
  const [isEsp32ModalOpen, setIsEsp32ModalOpen] = useState(false);
  const [hostIps, setHostIps] = useState([]);
  const [sessionTokens, setSessionTokens] = useState(0);
  const [searchUsage, setSearchUsage] = useState(null); // { configured, used, limit }
  const sessionStartRef = useRef(new Date().toISOString());
  const [sudoPrompt, setSudoPrompt] = useState(null); // { commandId, approved, editedCmd, commandText }
  const [settings, setSettings] = useState({
    provider: 'local',
    model_name: 'qwen2.5-coder-7b-instruct',
    local_key: '',
    local_url: 'http://192.168.1.42:1234/v1',
    local_api_style: 'openai',
    online_url: '',
    online_key: '',
    online_provider: 'gemini',
    is_main_host: false
  });
  const [localModels, setLocalModels] = useState([]);
  const [onlineModels, setOnlineModels] = useState([]);
  const [appVersion, setAppVersion] = useState('4.8.0');
  const [showAuthPassword, setShowAuthPassword] = useState(false);
  const [showLocalKey, setShowLocalKey] = useState(false);
  const [showOnlineKey, setShowOnlineKey] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [profile, setProfile] = useState({ name: '', zipcode: '', country: 'US', temp_unit: 'imperial', weather_api_key: '', interests: [] });
  const [liveModel, setLiveModel] = useState('');
  const [nodes, setNodes] = useState([]);

  // Calendar
  const [calendarEvents, setCalendarEvents] = useState([]);
  const [calendarForm, setCalendarForm] = useState({ title: '', start_time: '', end_time: '', description: '' });
  const [calendarDate, setCalendarDate] = useState(new Date().toISOString().split('T')[0]);

  // Input & Streaming state
  const [inputText, setInputText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isChatPoppedOut, setIsChatPoppedOut] = useState(false);
  const [activeAgent, setActiveAgent] = useState(null);
  const [streamThoughts, setStreamThoughts] = useState('');
  const [streamContent, setStreamContent] = useState('');
  const [toolLogs, setToolLogs] = useState([]); // array of active/past tool calls
  const [subtaskProgress, setSubtaskProgress] = useState([]); // [{label, status: 'done'|'error'}] - completed parts of a multi-part request, in order
  const [streamStatus, setStreamStatus] = useState('');
  const [llmBusy, setLlmBusy] = useState(false); // true only when this is a PATTI client and the host is busy
  const [backgroundJob, setBackgroundJob] = useState(null); // { agent, label } while a background job (e.g. dev_project) is running, else null

  const messagesEndRef = useRef(null);

  // Load user data & chats if token is present
  useEffect(() => {
    if (token) {
      hasInitializedRef.current = false;
      localStorage.setItem('token', token);
      fetchUserProfile();
      fetchChats();
      fetchSettings();
      fetchCalendarEvents();
      fetchProfile();
      fetchMemories();
      fetchNodes();
    } else {
      localStorage.removeItem('token');
      setUser(null);
    }
  }, [token]);

  const handleTabChange = (newTab) => {
    if (newTab === activeTab) return;
    setActiveTab(newTab);
  };

  // Sync active tab globally on startup/token load
  useEffect(() => {
    if (token) {
      api.post('/api/settings/active-tab', { tab: activeTab })
        .then(({ ok, error }) => { if (!ok) console.error('[Active Tab Startup Sync] Failed:', error); });
    }
  }, [token]);

  // Connect to Alert Broadcast SSE stream
  useEffect(() => {
    if (!token) return;

    let eventSource;
    let timeoutId;
    
    const connectAlertStream = () => {
      if (typeof EventSource === 'undefined') {
        console.warn('[Alert Stream] EventSource is not defined in this environment.');
        return;
      }
      const url = `/api/alerts/stream?token=${encodeURIComponent(token)}`;
      eventSource = new EventSource(url);

      eventSource.onmessage = (event) => {
        try {
          const alert = JSON.parse(event.data);

          // Live "a background job is in progress" signal (e.g. dev_project's build loop) -
          // separate from the toast/popup path below since it fires repeatedly as progress
          // updates, not as a one-off user-facing message. See ChatPane's backgroundJob prop
          // for how this locks chat input and shows a live status banner.
          if (alert.type === 'agent_status') {
            setBackgroundJob(alert.active ? { agent: alert.agent, label: alert.label } : null);
            return;
          }

          // Silent cross-tab sync signal (a read/read-all in another tab for this same
          // user) - no message text, no toast/popup, just a refetch so this tab's bell
          // badge doesn't keep showing a stale unread count until its own next alert.
          if (alert.type === 'notif_sync') {
            setNotifRefreshTick((t) => t + 1);
            return;
          }

          if (alert.type === 'error' || alert.type === 'warning') {
            setPopupAlert({
              type: alert.type,
              title: 'PATTI Alert',
              message: alert.message
            });
          }
          showToast(alert.message, alert.type || 'info');

          // A real, persisted notification (utils/notifications.js) - refresh the bell's
          // unread count/list rather than inferring it from `type`, which many other
          // (non-persisted) alerts also use.
          if (alert.notificationId) {
            setNotifRefreshTick((t) => t + 1);
          }

          // Real OS notification popup for a completed background job, only when the tab
          // isn't currently visible (avoids a redundant popup on top of the toast they're
          // already looking at).
          if (
            alert.type === 'info' &&
            typeof document !== 'undefined' && document.hidden &&
            typeof Notification !== 'undefined' && Notification.permission === 'granted'
          ) {
            new Notification('PATTI', { body: alert.message });
          }
        } catch (err) {
          console.error('[Alert Stream] Failed to parse message:', err);
        }
      };

      eventSource.onerror = (err) => {
        console.warn('[Alert Stream] Connection lost. Reconnecting in 5s...');
        eventSource.close();
        timeoutId = setTimeout(connectAlertStream, 5000);
      };
    };

    connectAlertStream();

    return () => {
      if (eventSource) eventSource.close();
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [token]);

  useEffect(() => {
    if (isSettingsOpen && token) {
      fetchLocalModels(settings);
      fetchOnlineModels();
    }
  }, [isSettingsOpen]);

  useEffect(() => {
    const fetchVersion = async () => {
      const { ok, data } = await api.get('/api/version');
      if (ok) {
        setAppVersion(data.version);
        if (Array.isArray(data.host_ips)) {
          setHostIps(data.host_ips);
        }
      }
    };
    fetchVersion();
  }, []);

  // Header stats: tokens used since this tab was opened, and Tavily web-search credit usage.
  // Polled rather than pushed over SSE since neither needs to update more than every ~60s -
  // Tavily's /usage endpoint rate-limits itself under too-frequent polling (observed a 429
  // in production with several tabs open), and the backend also caches it for 60s server-side.
  useEffect(() => {
    if (!token) return;

    const fetchHeaderStats = async () => {
      const { ok: tokenOk, data: tokenData, error: tokenErr } = await api.get(`/api/token-usage?since=${encodeURIComponent(sessionStartRef.current)}`);
      if (tokenOk) {
        setSessionTokens(tokenData.totalTokens || 0);
      } else {
        console.error('Failed to fetch session token usage:', tokenErr);
      }

      const { ok: searchOk, data: searchData, error: searchErr } = await api.get('/api/search-usage');
      if (searchOk) {
        setSearchUsage(searchData);
      } else {
        console.error('Failed to fetch search usage:', searchErr);
      }
    };

    fetchHeaderStats();
    const interval = setInterval(fetchHeaderStats, 60000);
    return () => clearInterval(interval);
  }, [token]);

  useEffect(() => {
    if (activeChatId) {
      fetchMessages(activeChatId);
    } else {
      setMessages([]);
    }
  }, [activeChatId]);

  // Poll whether the shared LLM is currently busy. A no-op (always reports not busy) unless
  // this is a PATTI client, so it's safe to run unconditionally - it just greys out the send
  // button while the host is active, per host-wins arbitration (see ai_queue.js).
  useEffect(() => {
    if (!token || isStreaming) return;
    let cancelled = false;
    const checkLlmStatus = async () => {
      // Fail open - don't block the UI if the status check itself fails.
      const { ok, data } = await api.get('/api/chat/llm-status');
      if (!ok || cancelled) return;
      setLlmBusy(!!data.busy);
    };
    checkLlmStatus();
    const interval = setInterval(checkLlmStatus, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [token, isStreaming]);


  // Auth operations
  const fetchUserProfile = async () => {
    const { ok, data } = await api.get('/api/auth/me');
    if (ok) {
      setUser(data.user);
    } else {
      handleLogout();
    }
  };

  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    setAuthError('');
    const endpoint = isLogin ? '/api/auth/login' : '/api/auth/register';
    const { ok, data, error } = await api.post(endpoint, authForm);
    if (!ok) {
      setAuthError(error || 'Authentication failed');
      return;
    }
    if (isLogin) {
      setToken(data.token);
    } else {
      setIsLogin(true);
      setAuthForm({ username: '', password: '' });
      alert('Registration successful! Please log in.');
    }
  };

  const handleLogout = () => {
    setToken('');
    localStorage.removeItem('token');
    setIsChatPoppedOut(false);
  };

  // SEC-5: revokes every currently-issued token for this account (this device included), then
  // logs this device out locally too - the right response to "I think my token leaked."
  const handleLogoutEverywhere = async () => {
    const { ok, error } = await api.post('/api/auth/logout-everywhere');
    if (!ok) console.error('Failed to revoke sessions:', error);
    handleLogout();
  };

  // Nodes operations
  const fetchNodes = async () => {
    const { ok, data, error } = await api.get('/api/nodes');
    if (ok) {
      setNodes(data);
    } else {
      console.error('Failed to fetch nodes:', error);
    }
  };

  // BUG-7: standardized confirmation - previously deleted immediately with no confirm at all.
  const handleDeleteNode = (id) => {
    setPopupConfirm({
      type: 'confirm',
      title: 'PATTI',
      message: 'Delete this device? This cannot be undone.',
      onConfirm: async () => {
        const { ok, error } = await api.delete(`/api/nodes/${id}`);
        if (ok) {
          showToast('Node deleted successfully', 'success');
          fetchNodes();
        } else {
          showToast(error || 'Failed to delete node', 'error');
        }
      }
    });
  };

  // Chats operations
  const createChat = async () => {
    const { ok, data } = await api.post('/api/chats', { title: `Chat ${new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}` });
    if (ok) {
      setChats(prev => [data, ...prev]);
      setActiveChatId(data.chatId);
      handleTabChange('chat');
      setIsMobileSidebarOpen(false);
    }
  };

  const fetchChats = async () => {
    const { ok, data } = await api.get('/api/chats');
    if (ok) {
      setChats(data);

      if (hasInitializedRef.current) return;
      hasInitializedRef.current = true;

      if (data.length > 0) {
        // Load the last active chat
        setActiveChatId(data[0].id);
        setActiveTab('chat');
      }
    }
  };

  const handleOpenNotificationChat = (chatId) => {
    // The results/briefing chat a notification points to may have been created by a
    // background job since the last fetchChats() call - refresh the list so Sidebar
    // actually shows/highlights it, not just loads its messages by id.
    fetchChats();
    setActiveChatId(chatId);
    handleTabChange('chat');
  };

  const deleteChat = (id, e) => {
    e.stopPropagation();
    setPopupConfirm({
      type: 'confirm',
      title: 'PATTI',
      message: 'Delete this chat room?',
      onConfirm: async () => {
        const { ok } = await api.delete(`/api/chats/${id}`);
        if (ok) {
          setChats(prev => prev.filter(c => c.id !== id));
          if (activeChatId === id) {
            setActiveChatId(null);
          }
        }
      }
    });
  };

  const handleRenameChat = async (id, newTitle) => {
    if (!newTitle.trim()) return;
    const { ok } = await api.put(`/api/chats/${id}`, { title: newTitle });
    if (ok) {
      setChats(prev => prev.map(c => c.id === id ? { ...c, title: newTitle } : c));
      setEditingChatId(null);
    }
  };

  const fetchMessages = async (chatId) => {
    const { ok, data } = await api.get(`/api/chats/${chatId}/messages`);
    if (ok) setMessages(data);
  };

  // Settings operations
  const fetchLocalModels = async (tempSettings) => {
    const targetSettings = tempSettings || settings;
    let url = '/api/settings/local-models';
    if (targetSettings && targetSettings.local_url) {
      url += `?localUrl=${encodeURIComponent(targetSettings.local_url)}&localApiKey=${encodeURIComponent(targetSettings.local_key || '')}&localApiStyle=${encodeURIComponent(targetSettings.local_api_style || '')}`;
    }
    const { ok, data, error } = await api.get(url);
    if (ok) {
      setLocalModels(data);
      if (data.length === 0) {
        showToast('No models are currently loaded in LM Studio/Ollama.', 'warning');
      } else {
        showToast('Local models scanned successfully.', 'success');
      }
    } else {
      showToast(`Failed to scan local models: ${error || 'Connection failed'}`, 'error');
    }
  };

  const fetchOnlineModels = async () => {
    const { ok, data } = await api.get('/api/settings/online-models');
    if (ok) setOnlineModels(data);
  };

  const fetchSettings = async () => {
    const { ok, data } = await api.get('/api/settings');
    if (ok) {
      const loadedSettings = {
        provider: data.provider || 'local',
        model_name: data.model_name || 'qwen2.5-coder-7b-instruct',
        gemini_key: data.gemini_key || '',
        local_key: data.local_key || '',
        local_url: data.local_url || 'http://192.168.1.42:1234/v1',
        local_api_style: data.local_api_style || 'openai',
        online_url: data.online_url || '',
        online_key: data.online_key || '',
        online_provider: data.online_provider || 'gemini',
        preferred_local_model: data.preferred_local_model || '',
        preferred_online_model: data.preferred_online_model || '',
        is_main_host: data.is_main_host === 1 || data.is_main_host === true || false
      };
      setSettings(loadedSettings);
      setIsSetupComplete(data.is_setup_complete !== false);

      const initialLiveModel = loadedSettings.provider === 'local'
        ? (loadedSettings.preferred_local_model || loadedSettings.model_name)
        : (loadedSettings.preferred_online_model || loadedSettings.model_name);
      setLiveModel(initialLiveModel);
    }
    fetchLocalModels();
    fetchOnlineModels();
  };

  const saveSettings = async (newSettings) => {
    const updatedSettings = {
      ...newSettings,
      preferred_local_model: newSettings.provider === 'local' ? newSettings.model_name : newSettings.preferred_local_model,
      preferred_online_model: newSettings.provider !== 'local' ? newSettings.model_name : newSettings.preferred_online_model
    };
    const { ok } = await api.put('/api/settings', updatedSettings);
    if (ok) {
      setSettings(updatedSettings);

      const nextLiveModel = updatedSettings.provider === 'local'
        ? (updatedSettings.preferred_local_model || updatedSettings.model_name)
        : (updatedSettings.preferred_online_model || updatedSettings.model_name);
      setLiveModel(nextLiveModel);

      setIsSettingsOpen(false);
      fetchLocalModels(updatedSettings);
      fetchOnlineModels();
    }
  };

  const fetchProfile = async () => {
    const { ok, data } = await api.get('/api/profile');
    if (ok) setProfile(data);
  };

  const saveProfile = async (newProfile) => {
    const { ok } = await api.put('/api/profile', newProfile);
    if (ok) {
      setProfile(newProfile);
      setIsProfileOpen(false);
    }
  };

  const [memories, setMemories] = useState([]);

  const fetchMemories = async () => {
    const { ok, data } = await api.get('/api/memories');
    if (ok) setMemories(data);
  };

  const handleAddMemory = async ({ content, level }) => {
    const { ok } = await api.post('/api/memories', { content, level });
    if (ok) fetchMemories();
  };

  // BUG-7 (docs/REVIEW_2026-08-03.md): standardized on the same CustomAlertModal confirm
  // pattern deleteChat already uses, instead of deleting immediately with no confirmation.
  const handleDeleteMemory = (id) => {
    setPopupConfirm({
      type: 'confirm',
      title: 'PATTI',
      message: 'Delete this memory? This cannot be undone.',
      onConfirm: async () => {
        const { ok } = await api.delete(`/api/memories/${id}`);
        if (ok) fetchMemories();
      }
    });
  };

  // Calendar operations
  const fetchCalendarEvents = async () => {
    const { ok, data } = await api.get(`/api/calendar?date=${calendarDate}`);
    if (ok) setCalendarEvents(data);
  };

  useEffect(() => {
    if (token) fetchCalendarEvents();
  }, [calendarDate]);

  const handleAddCalendarEvent = async (e) => {
    e.preventDefault();
    const { ok } = await api.post('/api/calendar', calendarForm);
    if (ok) {
      setCalendarForm({ title: '', start_time: '', end_time: '', description: '' });
      fetchCalendarEvents();
    }
  };

  // BUG-7: same standardization as handleDeleteMemory above.
  const handleDeleteCalendarEvent = (id) => {
    setPopupConfirm({
      type: 'confirm',
      title: 'PATTI',
      message: 'Delete this calendar event? This cannot be undone.',
      onConfirm: async () => {
        const { ok } = await api.delete(`/api/calendar/${id}`);
        if (ok) fetchCalendarEvents();
      }
    });
  };

  const handleResolveCommand = async (commandId, approved, editedCmd, password) => {
    const finalCmd = editedCmd !== undefined ? editedCmd : (document.getElementById(`cmd-input-${commandId}`)?.value || '');
    
    // Check if we need to show the sudo prompt first
    if (approved && finalCmd.includes('sudo') && !password) {
      setSudoPrompt({ commandId, approved, editedCmd: finalCmd, commandText: finalCmd });
      return;
    }

    setSudoPrompt(null);
    
    // Update local state to reflect approved or rejected status
    setToolLogs(prev => prev.map(log => 
      log.commandId === commandId 
        ? { ...log, status: approved ? 'approved' : 'rejected', command: approved ? finalCmd : log.command } 
        : log
    ));

    const { ok, error } = await api.post('/api/chat/approve-command', { commandId, approved, command: finalCmd, password });
    if (!ok) console.error('Failed to resolve command:', error);
  };

  // Chat Streaming Logic
  const handleSendMessage = async (e, directText = null, attachmentIds = []) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();

    const messageText = directText !== null ? directText : inputText;
    if (!messageText.trim() || !activeChatId || isStreaming) return;

    setInputText('');
    setMessages(prev => [...prev, { role: 'user', content: messageText }]);
    
    setIsStreaming(true);
    setActiveAgent('supervisor');
    setStreamThoughts('');
    setStreamContent('');
    setStreamStatus('');
    setToolLogs([]);
    setSubtaskProgress([]);

    let accumulatedRawContent = '';
    let coordinatorThoughts = '';

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      // FEAT-9: not migrated to useApi() - this needs the raw, unparsed Response to read its
      // body via getReader() below; useApi's wrapper always resolves the body as JSON.
      const response = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        signal: controller.signal,
        body: JSON.stringify({ chatId: activeChatId, message: messageText, attachmentIds })
      });

      if (!response.ok) {
        let errMsg = 'Streaming connection failed.';
        try {
          const errData = await response.json();
          if (errData && errData.error) {
            errMsg = errData.error;
          }
        } catch (e) {}
        throw new Error(errMsg);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop(); // keep last chunk

        for (const line of lines) {
          if (!line.trim()) continue;
          
          // Parse Server Sent Events format
          const matchEvent = line.match(/^event: (.+)$/m);
          const matchData = line.match(/^data: (.+)$/m);

          if (matchEvent && matchData) {
            const eventType = matchEvent[1];
            let dataValue = matchData[1];
            try {
              dataValue = JSON.parse(dataValue);
            } catch (e) {
              // text was not json
            }

            if (eventType === 'status') {
              setStreamStatus(dataValue);
            } else if (eventType === 'agent_status') {
              if (dataValue && dataValue.agent !== undefined) {
                setActiveAgent(dataValue.agent);
              }
            } else if (eventType === 'thought') {
              coordinatorThoughts += dataValue;
              setStreamThoughts(coordinatorThoughts);
            } else if (eventType === 'content') {
              setStreamStatus(''); // Wipe stream status once real content rendering starts
              accumulatedRawContent += dataValue;
              
              const startTagGemma = '<|channel>thought';
              const endTagGemma = '<channel|>';
              const startTagXml = '<think>';
              const endTagXml = '</think>';
              
              let currentStartTag = '';
              let currentEndTag = '';
              
              if (accumulatedRawContent.includes(startTagXml)) {
                currentStartTag = startTagXml;
                currentEndTag = endTagXml;
              } else if (accumulatedRawContent.includes(startTagGemma)) {
                currentStartTag = startTagGemma;
                currentEndTag = endTagGemma;
              }
              
              if (accumulatedRawContent.includes('INPUT_REQUIRED_CHOICES:')) {
                const startIdx = accumulatedRawContent.indexOf('INPUT_REQUIRED_CHOICES:');
                const payloadStr = accumulatedRawContent.substring(startIdx + 'INPUT_REQUIRED_CHOICES:'.length).trim();
                try {
                  const payload = JSON.parse(payloadStr);
                  setPopupChoices(payload);
                } catch (e) {
                  // Incremental chunk might not be fully parsed yet
                }
                setStreamContent('');
              } else if (currentStartTag) {
                const startIdx = accumulatedRawContent.indexOf(currentStartTag);
                const endIdx = accumulatedRawContent.indexOf(currentEndTag);
                
                if (endIdx !== -1) {
                  const extractedThoughts = accumulatedRawContent.substring(startIdx + currentStartTag.length, endIdx);
                  const mainContent = accumulatedRawContent.substring(endIdx + currentEndTag.length);
                  
                  setStreamThoughts(coordinatorThoughts + '\n' + extractedThoughts);
                  setStreamContent(mainContent);
                } else {
                  const extractedThoughts = accumulatedRawContent.substring(startIdx + currentStartTag.length);
                  setStreamThoughts(coordinatorThoughts + '\n' + extractedThoughts);
                  setStreamContent('');
                }
              } else {
                setStreamContent(accumulatedRawContent);
              }
            } else if (eventType === 'tool') {
              if (dataValue.status) {
                // Completion event (a part of a multi-part request just finished) -
                // build the live progress checklist, not the tool-call log (which
                // expects a dispatch-shaped {tool, action, params} entry).
                setSubtaskProgress(prev => [...prev, { label: dataValue.label || dataValue.tool, status: dataValue.status }]);
              } else {
                setToolLogs(prev => [...prev, dataValue]);
                if (dataValue.agent) {
                  setActiveAgent(dataValue.agent);
                } else if (dataValue.tool && dataValue.tool.startsWith('delegate_to_')) {
                  setActiveAgent(dataValue.tool.replace('delegate_to_', ''));
                }
              }
            } else if (eventType === 'command_approval_required') {
              setToolLogs(prev => [...prev, {
                type: 'command_approval',
                commandId: dataValue.commandId,
                command: dataValue.command,
                safety_analysis: dataValue.safety_analysis,
                status: 'pending'
              }]);
            } else if (eventType === 'model_used') {
              if (dataValue && dataValue.model) {
                setLiveModel(dataValue.model);
              }
            } else if (eventType === 'error') {
              console.error(dataValue);
              showToast(`Error: ${dataValue.message}`, 'error');
            } else if (eventType === 'interrupted') {
              // Host-wins arbitration preempted or blocked this PATTI client request -
              // the backend already saves a matching notice as the assistant's message.
              showToast(dataValue.message || 'Host interrupted your request. Please try again later.', 'error');
            }
          }
        }
      }

      // Finish streaming, sync messages list. Awaited specifically (unlike the
      // calendar/memory syncs below) so `finally`'s setIsStreaming(false) doesn't
      // fire - and unmount the live streaming bubble - before the real persisted
      // messages have actually replaced it, which used to cause a one-frame flash
      // of nothing between the stream ending and the fetched list rendering.
      await fetchMessages(activeChatId);
      // Sync calendar events in case the AI modified schedule
      fetchCalendarEvents();
      // Sync memories in case the AI learned something new
      fetchMemories();
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log('Stream aborted by user.');
        let finalThoughts = coordinatorThoughts;
        let finalContent = accumulatedRawContent;

        const startTagGemma = '<|channel>thought';
        const endTagGemma = '<channel|>';
        const startTagXml = '<think>';
        const endTagXml = '</think>';
        
        let currentStartTag = '';
        let currentEndTag = '';
        
        if (accumulatedRawContent.includes(startTagXml)) {
          currentStartTag = startTagXml;
          currentEndTag = endTagXml;
        } else if (accumulatedRawContent.includes(startTagGemma)) {
          currentStartTag = startTagGemma;
          currentEndTag = endTagGemma;
        }

        if (currentStartTag) {
          const startIdx = accumulatedRawContent.indexOf(currentStartTag);
          const endIdx = accumulatedRawContent.indexOf(currentEndTag);
          if (endIdx !== -1) {
            const extractedThoughts = accumulatedRawContent.substring(startIdx + currentStartTag.length, endIdx).trim();
            finalThoughts = (coordinatorThoughts + '\n' + extractedThoughts).trim();
            finalContent = accumulatedRawContent.substring(endIdx + currentEndTag.length).trim();
          } else {
            const extractedThoughts = accumulatedRawContent.substring(startIdx + currentStartTag.length).trim();
            finalThoughts = (coordinatorThoughts + '\n' + extractedThoughts).trim();
            finalContent = '';
          }
        }
        
        if (finalContent.trim()) {
          finalContent = finalContent.trim() + " \n\nInteraction stopped by user.";
        } else {
          finalContent = "Interaction stopped by user.";
        }

        setMessages(prev => [...prev, {
          id: 'aborted-' + Date.now(),
          role: 'assistant',
          content: finalContent,
          thoughts: finalThoughts
        }]);
      } else {
        console.error(err);
        const errNote = err.message || 'Communication failed. Is LM Studio or backend active?';
        showToast(errNote, 'error');

        // A toast alone disappears in a few seconds and leaves no trace in the
        // thread - if the backend never got far enough to persist anything (or
        // the request never reached it at all), the chat would otherwise look
        // like PATTI silently ignored the message. Always leave a visible,
        // honest bubble behind, same as the abort-handling branch above does.
        let errContent = accumulatedRawContent.trim();
        errContent = errContent ? `${errContent}\n\n⚠️ ${errNote}` : `⚠️ ${errNote}`;

        setMessages(prev => [...prev, {
          id: 'error-' + Date.now(),
          role: 'assistant',
          content: errContent,
          thoughts: coordinatorThoughts,
          isError: true
        }]);
      }
    } finally {
      setIsStreaming(false);
      setActiveAgent(null);
      abortControllerRef.current = null;
    }
  };

  const handleStop = async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const { ok, error } = await api.post('/api/lmstudio/eject-model');
    if (!ok) console.error('Failed to eject model:', error);
  };

  // Auth Screen Render
  if (!token) {
    return (
      <Auth
        authForm={authForm}
        setAuthForm={setAuthForm}
        isLogin={isLogin}
        setIsLogin={setIsLogin}
        authError={authError}
        setAuthError={setAuthError}
        handleAuthSubmit={handleAuthSubmit}
        showAuthPassword={showAuthPassword}
        setShowAuthPassword={setShowAuthPassword}
      />
    );
  }

  if (!isSetupComplete) {
    return (
      <SetupWizard
        token={token}
        onComplete={() => {
          fetchSettings();
          fetchProfile();
        }}
      />
    );
  }

  return (
    <div className="app-layout">
      {/* Sidebar Navigation */}
      <Sidebar
        user={user}
        chats={chats}
        activeChatId={activeChatId}
        setActiveChatId={setActiveChatId}
        activeTab={activeTab}
        setActiveTab={handleTabChange}
        isMobileSidebarOpen={isMobileSidebarOpen}
        setIsMobileSidebarOpen={setIsMobileSidebarOpen}
        editingChatId={editingChatId}
        setEditingChatId={setEditingChatId}
        editingTitle={editingTitle}
        setEditingTitle={setEditingTitle}
        createChat={createChat}
        deleteChat={deleteChat}
        handleRenameChat={handleRenameChat}
        handleLogout={handleLogout}
        setIsSettingsOpen={setIsSettingsOpen}
        setIsProfileOpen={setIsProfileOpen}
        setIsEsp32ModalOpen={setIsEsp32ModalOpen}
        appVersion={appVersion}
        theme={theme}
        toggleTheme={toggleTheme}
      />

      {isMobileSidebarOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setIsMobileSidebarOpen(false)}
        />
      )}

      {/* Main Panel */}
      <main className="main-panel">
        <header className="panel-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button 
              className="btn-icon mobile-menu-toggle" 
              onClick={() => setIsMobileSidebarOpen(true)} 
              style={{ transform: 'scale(1.2)' }}
            >
              <Menu size={22} />
            </button>
            <h2 
              style={{ fontSize: '1.2rem', fontWeight: 600, cursor: activeTab !== 'chat' ? 'pointer' : 'default' }}
              onClick={() => {
                if (activeTab !== 'chat') {
                  if (!activeChatId && chats.length > 0) setActiveChatId(chats[0].id);
                  handleTabChange('chat');
                }
              }}
              title={activeTab !== 'chat' ? "Return to Chat" : ""}
            >
               {activeTab === 'chat' ? (
                 <span className="patti-header-brand" style={{ display: 'inline-flex', alignItems: 'center' }}>
                   <span className="patti-fullname">
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
                   </span>
                 </span>
               ) : (activeTab === 'calendar' ? 'Schedule Manager' : (activeTab === 'academy' ? 'AI Coding Academy' : (activeTab === 'memory' ? 'AI Memory Vault' : (activeTab === 'personality-skills' ? 'Persona & Skills' : (activeTab === 'admin' ? 'Admin Dashboard' : 'Agent Dashboard')))))}
             </h2>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>

            <NotificationBell token={token} refreshSignal={notifRefreshTick} onOpenChat={handleOpenNotificationChat} />

            <div className="header-stats-group">
              <div className="header-stat-badge" title="Tokens used since this tab was opened">
                <span className="header-stat-label">Tokens</span>
                <span className="header-stat-value">{sessionTokens.toLocaleString()}</span>
              </div>
              <div
                className="header-stat-badge"
                title={searchUsage?.configured === false ? 'Tavily web search is not configured' : 'Web search credits used this billing period'}
              >
                <span className="header-stat-label">Search</span>
                <span className="header-stat-value">
                  {searchUsage && searchUsage.configured
                    ? `${searchUsage.used.toLocaleString()}/${searchUsage.limit.toLocaleString()}`
                    : '—'}
                </span>
              </div>
              <div className="header-stat-badge" title="This device's local network IP address">
                <span className="header-stat-label">IP</span>
                <span className="header-stat-value">{hostIps[0] || '—'}</span>
              </div>
            </div>

            <div className="model-config-badge">
              <span className={`connection-dot ${settings.provider === 'online' ? 'online' : 'local'}`}></span>
              <span className="model-config-text" style={{ fontSize: '0.85rem', fontWeight: 550 }}>
                {settings.provider === 'online'
                  ? `Online: ${{ gemini: 'Gemini', openai: 'OpenAI', anthropic: 'Claude', custom: 'Custom' }[settings.online_provider] || settings.online_provider}`
                  : 'Local AI'} ({liveModel ? liveModel.split('/').pop() : settings.model_name.split('/').pop()})
              </span>
            </div>
          </div>
        </header>

        {activeTab === 'chat' && !isChatPoppedOut && (
          <ChatPane
            token={token}
            settings={settings}
            messages={messages}
            activeChatId={activeChatId}
            isStreaming={isStreaming}
            streamThoughts={streamThoughts}
            streamContent={streamContent}
            toolLogs={toolLogs}
            subtaskProgress={subtaskProgress}
            inputText={inputText}
            setInputText={setInputText}
            handleSendMessage={handleSendMessage}
            handleStop={handleStop}
            messagesEndRef={messagesEndRef}
            handleResolveCommand={handleResolveCommand}
            streamStatus={streamStatus}
            llmBusy={llmBusy}
            backgroundJob={backgroundJob}
          />
        )}
        {activeTab === 'chat' && isChatPoppedOut && (
          <div className="chat-pane" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '16px', color: 'var(--text-secondary)' }}>
            <ExternalLink size={48} className="text-accent-primary" style={{ opacity: 0.6, animation: 'pulse 2s infinite alternate' }} />
            <h3>Chat is Popped Out</h3>
            <p style={{ fontSize: '0.9rem', maxWidth: '350px', textAlign: 'center', lineHeight: '1.5' }}>
              The chat has been opened in a separate window. You can browse the dashboard, calendar, or memories here while keeping the chat active.
            </p>
            <button 
              className="btn btn-primary" 
              onClick={() => setIsChatPoppedOut(false)}
              style={{ padding: '8px 18px', fontSize: '0.9rem' }}
            >
              Merge Chat Back
            </button>
          </div>
        )}
        {activeTab === 'calendar' && (
          <CalendarPane
            calendarEvents={calendarEvents}
            calendarForm={calendarForm}
            setCalendarForm={setCalendarForm}
            calendarDate={calendarDate}
            setCalendarDate={setCalendarDate}
            handleAddCalendarEvent={handleAddCalendarEvent}
            handleDeleteCalendarEvent={handleDeleteCalendarEvent}
          />
        )}
        {activeTab === 'personality-skills' && (
          <PersonalitySkillsPane token={token} />
        )}
        {activeTab === 'memory' && (
          <MemoryPane
            memories={memories}
            onAddMemory={handleAddMemory}
            onDeleteMemory={handleDeleteMemory}
          />
        )}
        {activeTab === 'dashboard' && (
          <AgentDashboard
            nodes={nodes}
            handleDeleteNode={handleDeleteNode}
            onRefresh={fetchNodes}
            token={token}
            toolLogs={toolLogs}
            activeAgent={activeAgent}
            isStreaming={isStreaming}
            settings={settings}
          />
        )}
        {activeTab === 'admin' && user?.is_admin && (
          <AdminDashboard
            token={token}
            currentUserId={user?.id}
            nodes={nodes}
            handleDeleteNode={handleDeleteNode}
            onRefreshNodes={fetchNodes}
            onRequestConfirm={setPopupConfirm}
          />
        )}
      </main>

      {/* Settings Modal */}
      <SettingsModal
        isSettingsOpen={isSettingsOpen}
        setIsSettingsOpen={setIsSettingsOpen}
        settings={settings}
        setSettings={setSettings}
        localModels={localModels}
        onlineModels={onlineModels}
        saveSettings={saveSettings}
        showLocalKey={showLocalKey}
        setShowLocalKey={setShowLocalKey}
        showOnlineKey={showOnlineKey}
        setShowOnlineKey={setShowOnlineKey}
        onFetchLocalModels={fetchLocalModels}
        token={token}
      />

      {/* Profile Modal */}
      <ProfileModal
        isProfileOpen={isProfileOpen}
        setIsProfileOpen={setIsProfileOpen}
        profile={profile}
        saveProfile={saveProfile}
        settings={settings}
        saveSettings={saveSettings}
        localModels={localModels}
        onlineModels={onlineModels}
        onLogoutEverywhere={handleLogoutEverywhere}
      />

      {/* Sudo Modal */}
      <SudoModal
        isOpen={!!sudoPrompt}
        onClose={() => setSudoPrompt(null)}
        onSubmit={(password) => handleResolveCommand(sudoPrompt.commandId, sudoPrompt.approved, sudoPrompt.editedCmd, password)}
        command={sudoPrompt?.commandText || ''}
      />

      {/* Toast Notifications */}
      <Toast
        message={toast.message}
        type={toast.type}
        onClose={() => setToast({ message: '', type: 'info' })}
      />

      {isChatPoppedOut && (
        <PopoutWindow onClose={() => setIsChatPoppedOut(false)}>
          <ChatPane
            token={token}
            settings={settings}
            messages={messages}
            activeChatId={activeChatId}
            isStreaming={isStreaming}
            streamThoughts={streamThoughts}
            streamContent={streamContent}
            toolLogs={toolLogs}
            subtaskProgress={subtaskProgress}
            inputText={inputText}
            setInputText={setInputText}
            handleSendMessage={handleSendMessage}
            handleStop={handleStop}
            messagesEndRef={messagesEndRef}
            handleResolveCommand={handleResolveCommand}
            streamStatus={streamStatus}
            llmBusy={llmBusy}
            backgroundJob={backgroundJob}
          />
        </PopoutWindow>
      )}

      <Esp32MessageModal
        isOpen={isEsp32ModalOpen}
        onClose={() => setIsEsp32ModalOpen(false)}
        token={token}
        hostIps={hostIps}
      />

      <CustomAlertModal
        alert={popupAlert}
        onClose={() => setPopupAlert(null)}
      />

      <CustomAlertModal
        alert={popupConfirm}
        onClose={() => setPopupConfirm(null)}
      />

      {popupChoices && Array.isArray(popupChoices.choices) && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(15, 23, 42, 0.75)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999,
          padding: '20px'
        }}>
          <div className="memory-card" style={{
            padding: '32px',
            maxWidth: '460px',
            width: '100%',
            textAlign: 'center',
            background: 'var(--bg-glass)',
            border: '1px solid var(--border-glass)',
            borderRadius: '24px',
            boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.4)'
          }}>
            <Network className="text-accent-primary" size={48} style={{ marginBottom: '20px', display: 'inline-block', filter: 'drop-shadow(0 0 8px var(--accent-primary))' }} />
            <h3 style={{ fontSize: '1.25rem', fontWeight: 650, marginBottom: '20px', color: '#fff', lineHeight: '1.4' }}>
              {popupChoices.question}
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%' }}>
              {popupChoices.choices.map((choice, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSelectChoice(choice)}
                  className="btn btn-secondary"
                  style={{
                    padding: '12px 20px',
                    fontSize: '0.9rem',
                    fontWeight: 550,
                    borderRadius: '12px',
                    textAlign: 'left',
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    color: '#e2e8f0',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'linear-gradient(135deg, rgba(139, 92, 246, 0.2), rgba(6, 182, 212, 0.2))';
                    e.currentTarget.style.borderColor = 'var(--accent-primary)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
                    e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                  }}
                >
                  <span>{choice}</span>
                  <span style={{ fontSize: '1.1rem', opacity: 0.8 }}>✨</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
