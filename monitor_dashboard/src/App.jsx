import React, { useState, useEffect } from 'react';
import { Network, FileText, Upload, Trash2, Cpu, Eye, CheckCircle, RefreshCw, Layers, Plus, Server, Monitor, Search, BookOpen, X, BarChart2, Cloud, Code, Shield, Wrench, UserPlus, Calendar, ChevronLeft, ChevronRight, Trophy, Newspaper, Clapperboard, Microscope, Telescope, GraduationCap, FilePlus, FileEdit, Bot, Clock, Palette } from 'lucide-react';
import TokenCountView from './TokenCountView';
import RpiTerminalModal from './RpiTerminalModal';
import LMStudioLogsView from './LMStudioLogsView';
import CustomAlertModal from './CustomAlertModal';
import { useApi } from './useApi';

// BUG-4 (docs/REVIEW_2026-08-03.md): the agent roster used to be a hand-maintained array here,
// which already went stale once (six agents silently missing until added by hand) and had
// drifted again by the time this was rewritten (automation_handler and graphics_engineer were
// both missing). The roster itself now comes from GET /api/agents (FEAT-5), backed by the real
// agent prompt files on disk - this map only supplies presentation (icon + description) for
// agents this dashboard knows about, keyed by the same canonical name the backend uses. Any
// agent not in this map still renders correctly with DEFAULT_AGENT_ICON and a generic
// description, so a newly added backend agent needs zero frontend changes to show up.
const AGENT_PRESENTATION = {
  communication_specialist: { name: 'Communication Specialist', icon: RefreshCw, desc: 'Primary contact for the user. Bubbly, warm, and welcomes the user. Translates requests into project ideas and formats final reports beautifully.' },
  supervisor: { name: 'Supervisor Agent', icon: Network, desc: 'Master orchestrator. Reads the full agent capability registry and routes every task to the best-suited specialist agent.' },
  weather_expert: { name: 'Weather Expert', icon: Cloud, desc: 'Fetches current conditions, hourly forecasts, and daily weather data using your zipcode.' },
  system_specialist: { name: 'System Agent', icon: Cpu, desc: 'Queries local host: CPU, RAM, disk, temperature, processes, services, security scans, and scripting on the current machine only.' },
  node_agent: { name: 'Node Agent', icon: Server, desc: 'Routes commands and queries to remote RPi or ESP32 field nodes. Cannot query Main Host from a remote context.' },
  memory_agent: { name: 'Memory Agent', icon: BookOpen, desc: 'Stores, recalls, and forgets long-term and short-term memories about the user.' },
  calendar_handler: { name: 'Calendar Agent', icon: Calendar, desc: 'Manages calendar events: listing, adding, or deleting scheduled events.' },
  web_searcher: { name: 'Web Searcher', icon: Search, desc: 'Performs live web searches and Google News lookups, aligning results with stored user interests.' },
  document_vault: { name: 'Document Vault Agent', icon: FileText, desc: 'Performs semantic vector search over uploaded private documents using cosine similarity.' },
  qa_engineer: { name: 'QA Engineer', icon: Shield, desc: 'Reviews code for bugs, vulnerabilities, and test coverage. Issues APPROVE or REJECT verdicts.' },
  tool_creator_agent: { name: 'Tool Creation Agent', icon: Wrench, desc: 'Coordinates dynamic tool creation: designs plan, requests HITL approval, then implements and deploys.' },
  agent_creator_agent: { name: 'Agent Creation Agent', icon: UserPlus, desc: 'Dynamically designs and integrates new specialist agents into the multi-agent loop.' },
  developer_agent: { name: 'Developer Agent', icon: Layers, desc: 'Orchestrates software development pipelines, manages workspace files, writes source code, and deploys new custom tools.' },
  sports_agent: { name: 'Sports Agent', icon: Trophy, desc: 'Gathers and tracks sports news, scores, highlights, or team articles from Bleacher Report, ensuring unseen stories are shown first.' },
  news_agent: { name: 'News Agent', icon: Newspaper, desc: 'Gathers general news briefs from TMZ and performs randomized searches on user preference topics, evaluating accuracy results.' },
  movie_tv_agent: { name: 'Movie & TV Agent', icon: Clapperboard, desc: 'Finds what is new on streaming, upcoming release dates, and where to watch a title, using The Movie Database plus Rotten Tomatoes and Reddit for reviews.' },
  deep_research_agent: { name: 'Deep Research Agent', icon: Microscope, desc: 'Crawls multiple sources on a topic and grows PATTI\'s permanent shared knowledge base so repeat questions are answered faster.' },
  deep_research_pro_agent: { name: 'Deep Research Pro', icon: Telescope, desc: 'Runs a long-form multi-source web investigation in the background, reporting back later in the Deep Research Results chat.' },
  course_builder_agent: { name: 'Course Builder Agent', icon: GraduationCap, desc: 'Writes full multi-lesson courses and study guides with PATTI\'s own model, saving them to disk and reporting back in the Generated Courses chat.' },
  document_generator_agent: { name: 'Document Generator', icon: FilePlus, desc: 'Produces downloadable PDF, Word, Excel, and PowerPoint files from generated content.' },
  document_formatter_agent: { name: 'Document Formatter', icon: FileEdit, desc: 'Reformats an uploaded document into clean headings, tables, and code blocks, optionally adding illustrative images.' },
  automation_handler: { name: 'Automation Handler', icon: Clock, desc: 'Sets up, lists, pauses, resumes, or cancels recurring automated requests running on a schedule.' },
  graphics_engineer: { name: 'Graphics Engineer', icon: Palette, desc: 'Authors SVG graphics and sources/edits real photographic images for icons, badges, and illustrations.' }
};
const DEFAULT_AGENT_ICON = Bot;
const DEFAULT_AGENT_DESC = 'A specialist agent available to the Supervisor.';

export default function App({ toolLogs: propToolLogs, activeAgent: propActiveAgent, isStreaming: propIsStreaming }) {
  const [localActiveAgent, setLocalActiveAgent] = useState(null);
  const [localIsStreaming, setLocalIsStreaming] = useState(false);
  const [localToolLogs, setLocalToolLogs] = useState([]);

  const activeAgent = propActiveAgent !== undefined ? propActiveAgent : localActiveAgent;
  const isStreaming = propIsStreaming !== undefined ? propIsStreaming : localIsStreaming;
  const toolLogs = propToolLogs !== undefined ? propToolLogs : localToolLogs;

  const [token, setToken] = useState(localStorage.getItem('main_host_token') || '');
  const api = useApi(token);
  const [hostUrl, setHostUrl] = useState(localStorage.getItem('main_host_url') || '');
  const [settings, setSettings] = useState(null);
  // BUG-4/FEAT-5: fetched from the backend instead of hardcoded - see AGENT_PRESENTATION above.
  const [agents, setAgents] = useState([]);
  const [configMode, setConfigMode] = useState(!token || !hostUrl);
  const [inputUrl, setInputUrl] = useState(hostUrl || 'http://localhost:3000');
  const [inputToken, setInputToken] = useState(token);
  const [testStatus, setTestStatus] = useState('');
  const [popupAlert, setPopupAlert] = useState(null);
  const [popupConfirm, setPopupConfirm] = useState(null);

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
        title: 'P.A.T.T.I.',
        message
      });
    };
  }, []);

  const [activeSubTab, setActiveSubTab] = useState('network'); // 'network', 'vault', 'host', 'nodes'
  const tabScrollRef = React.useRef(null);
  const [showLeftArrow, setShowLeftArrow] = useState(false);
  const [showRightArrow, setShowRightArrow] = useState(false);
  const [documents, setDocuments] = useState([]);
  const logsScrollRef = React.useRef(null);

  const [aiState, setAiState] = useState({
    isBusy: false,
    activeTask: null,
    queueLength: 0,
    waitingQueue: [],
    thought: 'Idle',
    activeNode: null
  });
  
  // Nodes State
  const [nodes, setNodes] = useState([]);
  const [showAddNode, setShowAddNode] = useState(false);
  const [newNode, setNewNode] = useState({ node_name: '', device_type: 'rpi-5-8gb', ip_address: '', port: 3000, bridge_secret: '', mqtt_topic: '' });
  const [fileContent, setFileContent] = useState('');
  const [fileName, setFileName] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');

  // Host telemetry and service control states
  const [hostStatus, setHostStatus] = useState(null);
  const [loadingHost, setLoadingHost] = useState(false);
  const [restartServiceName, setRestartServiceName] = useState('patti');
  const [restartingService, setRestartingService] = useState(false);

   // Scanner and Walkthrough State
  const [scanning, setScanning] = useState(false);
  const [discoveredNodes, setDiscoveredNodes] = useState([]);
  
  // Health Polling State & Logic (Rule 5)
  const [nodeHealthMap, setNodeHealthMap] = useState({});
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  const [selectedGuideDevice, setSelectedGuideDevice] = useState('rpi-5-8gb');
  const [registeringNode, setRegisteringNode] = useState(null);
  const [selectedTerminalNode, setSelectedTerminalNode] = useState(null);
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const checkScrollArrows = () => {
    const el = tabScrollRef.current;
    if (el) {
      const { scrollLeft, scrollWidth, clientWidth } = el;
      setShowLeftArrow(scrollLeft > 2);
      setShowRightArrow(scrollLeft < scrollWidth - clientWidth - 2);
    }
  };

  useEffect(() => {
    const el = tabScrollRef.current;
    if (el) {
      el.addEventListener('scroll', checkScrollArrows);
      window.addEventListener('resize', checkScrollArrows);
      
      const timer = setTimeout(checkScrollArrows, 300);
      return () => {
        el.removeEventListener('scroll', checkScrollArrows);
        window.removeEventListener('resize', checkScrollArrows);
        clearTimeout(timer);
      };
    }
  }, [tabScrollRef.current, settings, activeSubTab]);


  // Autoscroll active agent to top
  useEffect(() => {
    const activeCard = document.querySelector('.active-agent');
    const gridContainer = document.querySelector('.memory-grid');
    if (activeCard && gridContainer) {
      gridContainer.scrollTo({
        top: activeCard.offsetTop - gridContainer.offsetTop - 10,
        behavior: 'smooth'
      });
    }
  }, [activeAgent, aiState.thought]);

  // Autoscroll Live Agent Routing Sequence logs to the bottom
  useEffect(() => {
    const el = logsScrollRef.current;
    if (el) {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [toolLogs]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    if (urlToken) {
      localStorage.setItem('main_host_token', urlToken);
      localStorage.setItem('main_host_url', window.location.origin);
      window.history.replaceState({}, document.title, window.location.pathname);
      window.location.reload();
    }
  }, []);

  useEffect(() => {
    if (!token || !hostUrl) return;
    api.get('/api/settings').then(({ ok, data, error }) => {
      if (ok) setSettings(data);
      else console.error('Failed to load settings:', error);
    });
  }, [token, hostUrl]);

  // BUG-4/FEAT-5: the real, current agent roster - merges each entry's canonical name/
  // displayName from the backend with local presentation (icon/description), falling back to a
  // generic icon/description for any agent this dashboard doesn't have presentation data for.
  useEffect(() => {
    if (!token || !hostUrl) return;
    api.get('/api/agents').then(({ ok, data, error }) => {
      if (!ok) {
        console.error('Failed to load agent roster:', error);
        return;
      }
      const list = (data.agents || []).map(a => {
        const presentation = AGENT_PRESENTATION[a.name];
        return {
          type: a.name,
          name: presentation?.name || a.displayName,
          icon: presentation?.icon || DEFAULT_AGENT_ICON,
          desc: presentation?.desc || DEFAULT_AGENT_DESC
        };
      });
      setAgents(list);
    });
  }, [token, hostUrl]);

  const handleConnect = async (e) => {
    e.preventDefault();
    setTestStatus('Connecting...');
    // Not migrated to useApi(): this tests a candidate URL/token the user just typed into the
    // connect form, not the app's own stored `token` state that useApi is bound to.
    try {
      const formattedUrl = inputUrl.replace(/\/$/, '');
      const res = await fetch(`${formattedUrl}/api/host/status`, {
        headers: { 'Authorization': `Bearer ${inputToken}` }
      });
      if (res.ok) {
        localStorage.setItem('main_host_url', formattedUrl);
        localStorage.setItem('main_host_token', inputToken);
        setTestStatus('Connected successfully! Saving settings...');
        setTimeout(() => {
          window.location.reload();
        }, 1000);
      } else {
        setTestStatus(`Error: Connection failed with status ${res.status}`);
      }
    } catch (err) {
      setTestStatus(`Connection error: ${err.message}`);
    }
  };

  const handleDisconnect = () => {
    setPopupConfirm({
      type: 'confirm',
      title: 'P.A.T.T.I.',
      message: 'Disconnect from this Main Host and reset configurations?',
      onConfirm: () => {
        localStorage.removeItem('main_host_url');
        localStorage.removeItem('main_host_token');
        window.location.reload();
      }
    });
  };





  const performNodeHealthPoll = async (configuredNodes) => {
    const { ok, data, error } = await api.get('/api/nodes/health-check');
    if (ok) {
      setNodeHealthMap(data);
    } else {
      console.error('Failed to poll node health:', error);
    }
  };


  const handleScanNodes = async () => {
    setScanning(true);
    setDiscoveredNodes([]);
    const { ok, data } = await api.post('/api/nodes/scan');
    if (ok) {
      setDiscoveredNodes(data.nodes || []);
    } else {
      alert('Failed to scan local network.');
    }
    setScanning(false);
  };



  const handleConfirmRegisterNode = async (e) => {
    if (e) e.preventDefault();
    if (!registeringNode) return;
    const { ok, data, error } = await api.post('/api/nodes', registeringNode);
    if (ok) {
      fetchNodes();
      setDiscoveredNodes(prev => prev.filter(n => n.ip_address !== registeringNode.ip_address));
      setRegisteringNode(null);
    } else {
      alert(`Failed to register discovered node: ${(data && data.error) || error}`);
    }
  };

  useEffect(() => {
    if (activeSubTab === 'host') {
      fetchHostStatus();
      if (typeof window !== 'undefined' && !window.__vitest_worker__ && !process.env.VITEST) {
        const interval = setInterval(fetchHostStatus, 10000);
        return () => clearInterval(interval);
      }
    }
    if (activeSubTab === 'nodes') {
      const lastScanTime = localStorage.getItem('last_nodes_scan_time');
      const oneDayMs = 24 * 60 * 60 * 1000;
      const needsScan = !lastScanTime || (Date.now() - parseInt(lastScanTime, 10) > oneDayMs);
      
      if (needsScan) {
        fetchNodes(true);
        localStorage.setItem('last_nodes_scan_time', Date.now().toString());
      } else {
        fetchNodes(false);
      }
    }
  }, [activeSubTab]);

  useEffect(() => {
    if (activeSubTab === 'nodes' && nodes.length > 0) {
      performNodeHealthPoll(nodes);
      const intervalId = setInterval(() => {
        performNodeHealthPoll(nodes);
      }, 60000);
      return () => clearInterval(intervalId);
    }
  }, [activeSubTab, nodes]);

  useEffect(() => {
    if (!token) return;
    let eventSource = null;
    try {
      eventSource = new EventSource(`/api/alerts/stream?token=${encodeURIComponent(token)}`);
      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data && data.type === 'ai_state') {
            setAiState({
              isBusy: data.isBusy,
              activeTask: data.activeTask,
              queueLength: data.queueLength,
              waitingQueue: data.waitingQueue || [],
              thought: data.thought || 'Idle',
              activeNode: data.activeNode || null
            });
          } else if (data && data.type === 'streaming_status') {
            setLocalIsStreaming(data.isStreaming);
            if (data.isStreaming) {
              setLocalToolLogs([]);
              setLocalActiveAgent(null);
            }
          } else if (data && data.type === 'agent_status') {
            setLocalActiveAgent(data.agent);
          } else if (data && data.type === 'tool_call') {
            // Note: backend tool_call payloads don't carry a unique id, so this always
            // appends rather than trying (and failing) to dedupe on `.id`.
            setLocalToolLogs(prev => (data.toolCall ? [...prev, data.toolCall] : prev));
          } else if (data && data.type === 'node_status_change') {
            setNodeHealthMap(prev => ({
              ...prev,
              [data.nodeId]: { status: data.status }
            }));
          } else if (data && (data.type === 'error' || data.type === 'warning')) {
            setPopupAlert({
              type: data.type,
              title: 'P.A.T.T.I. Alert',
              message: data.message
            });
          }
        } catch (e) {}
      };
    } catch (e) {
      console.error('[AgentDashboard] Failed to initialize SSE EventSource:', e);
    }
    return () => {
      if (eventSource) eventSource.close();
    };
  }, [token]);



  const fetchNodes = async (runScan = false) => {
    if (runScan) setScanning(true);
    const { ok, data, error } = runScan ? await api.post('/api/nodes/sync') : await api.get('/api/nodes');
    if (ok) {
      setNodes(Array.isArray(data) ? data : (data.nodes || []));
    } else {
      console.error('Failed to fetch nodes:', error);
    }
    if (runScan) setScanning(false);
  };
  const handleAddNode = async (e) => {
    e.preventDefault();
    const { ok, data, error } = await api.post('/api/nodes', newNode);
    if (ok) {
      setNewNode({ node_name: '', device_type: 'rpi-5-8gb', ip_address: '', port: 3000, bridge_secret: '', mqtt_topic: '' });
      setShowAddNode(false);
      fetchNodes();
    } else {
      alert(`Failed to add node: ${(data && data.error) || error}`);
    }
  };

  const handleDeleteNode = (id) => {
    setPopupConfirm({
      type: 'confirm',
      title: 'P.A.T.T.I.',
      message: 'Remove this field node?',
      onConfirm: async () => {
        const { ok } = await api.delete(`/api/nodes/${id}`);
        if (ok) fetchNodes();
      }
    });
  };

  const fetchHostStatus = async () => {
    setLoadingHost(true);
    const { ok, data, error } = await api.get('/api/host/status');
    if (ok) {
      setHostStatus(data);
    } else {
      console.error('Failed to fetch host status:', error);
    }
    setLoadingHost(false);
  };

  const handleRestartService = async () => {
    if (!restartServiceName.trim()) return;
    setRestartingService(true);
    const { ok, data, error } = await api.post('/api/host/service/restart', { service: restartServiceName });
    if (ok) {
      alert((data && data.message) || 'Service restart initiated.');
    } else {
      alert(`Failed to restart service: ${(data && data.error) || error}`);
    }
    setRestartingService(false);
  };



  useEffect(() => {
    fetchDocuments();
  }, []);

  const fetchDocuments = async () => {
    const { ok, data, error } = await api.get('/api/vault');
    if (ok) {
      setDocuments(data);
    } else {
      console.error('Failed to fetch documents:', error);
    }
  };

  const handleUpload = async (e) => {
    e.preventDefault();
    if (!fileName || !fileContent.trim()) {
      setUploadError('Please specify a filename and enter some content.');
      return;
    }
    setUploadError('');
    setIsUploading(true);

    const { ok, data, error } = await api.post('/api/vault', { filename: fileName, content: fileContent });
    if (ok) {
      setFileName('');
      setFileContent('');
      fetchDocuments();
    } else {
      setUploadError((data && data.error) || error || 'Failed to upload document.');
    }
    setIsUploading(false);
  };

  const handleDelete = (id) => {
    setPopupConfirm({
      type: 'confirm',
      title: 'P.A.T.T.I.',
      message: 'Are you sure you want to delete this document? This will remove all vector chunks from RAG memory.',
      onConfirm: async () => {
        const { ok, error } = await api.delete(`/api/vault/${id}`);
        if (ok) {
          fetchDocuments();
        } else {
          console.error('Failed to delete document:', error);
        }
      }
    });
  };

  const handleFileInputChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (evt) => {
      setFileContent(evt.target.result);
    };
    reader.readAsText(file);
  };

  // BUG-4 (docs/REVIEW_2026-08-03.md): replaced two ~20-branch hand-maintained matching chains
  // (one per agent, easy to forget when adding a new agent) with one exact-match against the
  // canonical name each agent is now identified by everywhere - agentType here is always a
  // real backend/utils/agents/<name>.js filename (from GET /api/agents), and the backend
  // itself reports that same canonical name via onAgentStatus/onToolCall
  // (backend/services/agent_loop.js: `agentName = decision.tool.replace('delegate_to_', '')`).
  // This deliberately drops the old chains' extra tool-level aliases (e.g. 'developer' also
  // matching 'read_file'/'write_file'/'execute_command') - those represented in-flight tool
  // activity under a delegated agent, not the delegation event itself, and reintroducing that
  // per-agent would recreate the exact hand-maintained-list problem this fix removes. The
  // structured chain below (the more reliable signal) is unaffected in the common case.
  const getAgentStatus = (agentType) => {
    // When streaming is explicitly finished (false), all agents return to Idle
    if (isStreaming === false) return 'Idle';

    // Heuristic based on real-time SSE thoughts: does the canonical name (or its
    // underscore-to-space form, e.g. "communication specialist") appear in the thought text.
    const thought = (aiState.thought || '').toLowerCase();
    if (aiState.isBusy && thought) {
      const spaced = agentType.replace(/_/g, ' ');
      if (thought.includes(agentType) || thought.includes(spaced)) return 'Active';
    }

    let currentAgent = activeAgent || (toolLogs && toolLogs.length > 0 ? (toolLogs[toolLogs.length - 1].agent || toolLogs[toolLogs.length - 1].tool) : null) || (isStreaming ? 'supervisor' : null);
    if (!currentAgent) return 'Idle';

    currentAgent = currentAgent.toLowerCase().replace('delegate_to_', '');
    if (currentAgent === agentType) return 'Active';

    return 'Idle';
  };



  if (configMode) {
    return (
      <div className="auth-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'radial-gradient(circle at 50% 50%, #1e1b4b 0%, #0b0f19 80%)' }}>
        <div className="auth-card" style={{ width: '100%', maxWidth: '480px', padding: '32px', background: 'var(--bg-glass)', backdropFilter: 'blur(16px)', border: '1px solid var(--border-glass)', borderRadius: '24px', boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.37)' }}>
          <h2 style={{ fontSize: '1.6rem', marginBottom: '24px', background: 'linear-gradient(135deg, #fff 30%, #06b6d4 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', textAlign: 'center', fontWeight: 'bold' }}>Agent Monitor Dashboard</h2>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '24px', textAlign: 'center' }}>
            Configure your standalone dashboard monitor to connect to the Main Host.
          </p>
          <form onSubmit={handleConnect} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div className="form-group" style={{ textAlign: 'left' }}>
              <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '8px', fontWeight: 550 }}>Main Host URL</label>
              <input 
                type="url" 
                className="form-control" 
                placeholder="http://192.168.1.42:3000" 
                value={inputUrl} 
                onChange={e => setInputUrl(e.target.value)} 
                required 
                style={{ width: '100%', padding: '12px', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-glass)', borderRadius: '12px', color: 'var(--text-primary)' }}
              />
            </div>
            <div className="form-group" style={{ textAlign: 'left' }}>
              <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '8px', fontWeight: 550 }}>Access Token (JWT)</label>
              <textarea 
                className="form-control" 
                rows="4"
                placeholder="Paste your JWT auth token here..." 
                value={inputToken} 
                onChange={e => setInputToken(e.target.value)} 
                required 
                style={{ width: '100%', padding: '12px', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-glass)', borderRadius: '12px', color: 'var(--text-primary)', fontFamily: 'monospace', resize: 'vertical' }}
              />
            </div>
            {testStatus && (
              <div style={{ fontSize: '0.85rem', textAlign: 'center', color: testStatus.includes('successfully') ? 'var(--accent-green)' : '#f87171', padding: '8px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px' }}>
                {testStatus}
              </div>
            )}
            {/* This button's background is a fixed vivid accent gradient regardless of theme,
                so the text color stays fixed white too - it's not a page-surface color. */}
            <button type="submit" className="btn btn-primary" style={{ padding: '12px', background: 'linear-gradient(135deg, #8b5cf6, #06b6d4)', border: 'none', borderRadius: '12px', color: '#fff', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.3s ease' }}>
              Connect & Save
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="memory-pane" style={{
      padding: '16px 20px',
      display: 'flex',
      flexDirection: 'column',
      height: activeSubTab === 'network' ? '100vh' : 'auto',
      minHeight: '100vh',
      overflowY: activeSubTab === 'network' ? 'hidden' : 'auto',
      boxSizing: 'border-box'
    }}>
      <div className="section-header" style={{
        marginBottom: '16px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'nowrap',
        width: '100%',
        flexShrink: 0,
        gap: '16px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
          <Network className="text-accent-primary" size={24} />
          <h2 style={{ margin: 0, whiteSpace: 'nowrap', fontSize: '1.25rem' }}>Agent Network Dashboard</h2>
        </div>

        <div className="scroll-tab-container" style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          flexShrink: 1,
          overflow: 'hidden',
          maxWidth: '100%',
          padding: '0 28px'
        }}>
          {showLeftArrow && (
            <button 
              onClick={() => {
                tabScrollRef.current?.scrollBy({ left: -160, behavior: 'smooth' });
              }}
              style={{
                position: 'absolute',
                left: 0,
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'rgba(30, 41, 59, 0.9)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                color: 'var(--text-primary)',
                borderRadius: '50%',
                width: '24px',
                height: '24px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                zIndex: 10,
                boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
                transition: 'all 0.2s ease',
                padding: 0
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--accent-primary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'rgba(30, 41, 59, 0.9)'; }}
            >
              <ChevronLeft size={16} />
            </button>
          )}

          <div 
            ref={tabScrollRef}
            className="sub-tab-buttons" 
            style={{
              display: 'flex',
              gap: '8px',
              alignItems: 'center',
              flexWrap: 'nowrap',
              overflowX: 'auto',
              maxWidth: '100%',
              paddingBottom: '4px',
              scrollbarWidth: 'none',
              msOverflowStyle: 'none',
              WebkitOverflowScrolling: 'touch'
            }}
          >
            <button 
              className="btn"
              onClick={handleDisconnect}
              // Fixed danger-red background regardless of theme; text stays fixed white to match.
              style={{ padding: '6px 12px', fontSize: '0.82rem', background: '#dc2626', color: '#fff', border: 'none', borderRadius: '6px', whiteSpace: 'nowrap', flexShrink: 0 }}
            >
              Disconnect Host
            </button>
            <button 
              className={`btn btn-secondary ${activeSubTab === 'network' ? 'active' : ''}`}
              onClick={() => setActiveSubTab('network')}
              style={{ padding: '6px 12px', fontSize: '0.82rem', borderRadius: '6px', whiteSpace: 'nowrap', flexShrink: 0 }}
            >
              <Layers size={14} style={{ marginRight: '6px' }} />
              Agent Network
            </button>
            <button 
              className={`btn btn-secondary ${activeSubTab === 'vault' ? 'active' : ''}`}
              onClick={() => setActiveSubTab('vault')}
              style={{ padding: '6px 12px', fontSize: '0.82rem', borderRadius: '6px', whiteSpace: 'nowrap', flexShrink: 0 }}
            >
              <FileText size={14} style={{ marginRight: '6px' }} />
              Document Vault (RAG)
            </button>
            <button 
              className={`btn btn-secondary ${activeSubTab === 'nodes' ? 'active' : ''}`}
              onClick={() => setActiveSubTab('nodes')}
              style={{ padding: '6px 12px', fontSize: '0.82rem', borderRadius: '6px', whiteSpace: 'nowrap', flexShrink: 0 }}
            >
              <Server size={14} style={{ marginRight: '6px' }} />
              Field Nodes
            </button>
            <button 
              className={`btn btn-secondary ${activeSubTab === 'host' ? 'active' : ''}`}
              onClick={() => setActiveSubTab('host')}
              style={{ padding: '6px 12px', fontSize: '0.82rem', borderRadius: '6px', whiteSpace: 'nowrap', flexShrink: 0 }}
            >
              <Cpu size={14} style={{ marginRight: '6px' }} />
              System Control
            </button>
            <button 
              className={`btn btn-secondary ${activeSubTab === 'tokens' ? 'active' : ''}`}
              onClick={() => setActiveSubTab('tokens')}
              style={{ padding: '6px 12px', fontSize: '0.82rem', borderRadius: '6px', whiteSpace: 'nowrap', flexShrink: 0 }}
            >
              <BarChart2 size={14} style={{ marginRight: '6px' }} />
              Show Token Count
            </button>
             {(settings?.is_main_host === true || settings?.is_main_host === 1 || settings?.is_main_host === '1') && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && (window.location.port === '3000' || window.location.port === '5173') && (
              <button 
                className={`btn btn-secondary ${activeSubTab === 'logs' ? 'active' : ''}`}
                onClick={() => setActiveSubTab('logs')}
                style={{ padding: '6px 12px', fontSize: '0.82rem', borderRadius: '6px', whiteSpace: 'nowrap', flexShrink: 0 }}
              >
                <Monitor size={14} style={{ marginRight: '6px' }} />
                LM Studio Logs
              </button>
            )}
          </div>

          {showRightArrow && (
            <button 
              onClick={() => {
                tabScrollRef.current?.scrollBy({ left: 160, behavior: 'smooth' });
              }}
              style={{
                position: 'absolute',
                right: 0,
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'rgba(30, 41, 59, 0.9)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                color: 'var(--text-primary)',
                borderRadius: '50%',
                width: '24px',
                height: '24px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                zIndex: 10,
                boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
                transition: 'all 0.2s ease',
                padding: 0
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--accent-primary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'rgba(30, 41, 59, 0.9)'; }}
            >
              <ChevronRight size={16} />
            </button>
          )}
        </div>
      </div>

      <div style={{
        flex: '1 1 0%',
        overflowY: activeSubTab === 'network' ? 'hidden' : 'auto',
        display: activeSubTab === 'network' ? 'flex' : 'block',
        flexDirection: activeSubTab === 'network' ? 'column' : 'initial',
        minHeight: 0,
        paddingRight: activeSubTab === 'network' ? '0' : '4px'
      }}>
        {activeSubTab === 'network' && (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            height: '100%',
            overflow: 'hidden'
          }}>
            {/* Section 2: Real-time Concurrency Queue Status */}
            <div className="memory-card" style={{
              padding: '16px',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              background: 'rgba(255,255,255,0.02)',
              backdropFilter: 'blur(10px)',
              flexShrink: 0
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <RefreshCw className={aiState.isBusy ? 'spin text-accent-primary' : 'text-secondary'} size={20} />
                  <h3 style={{ fontSize: '1rem', margin: 0, color: 'var(--text-primary)' }}>AI Concurrency Queue & Pipeline Status</h3>
                </div>
                <span className={`badge ${aiState.isBusy ? 'badge-short-term' : 'badge-long-term'}`} style={{ padding: '4px 12px', fontSize: '0.78rem' }}>
                  {aiState.isBusy ? 'BUSY / PROCESSING' : 'IDLE / READY'}
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                <div>
                  <div style={{ marginBottom: '6px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Current Thought / Activity:</div>
                  <div style={{ 
                    background: 'rgba(0,0,0,0.3)', 
                    padding: '10px 12px', 
                    borderRadius: '8px', 
                    fontFamily: 'monospace', 
                    fontSize: '0.82rem', 
                    color: 'var(--accent-primary)',
                    height: '80px',
                    overflowY: 'auto'
                  }}>
                    {aiState.thought}
                  </div>
                  {aiState.activeNode && (
                    <div style={{ marginTop: '6px', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                      Active Node Execution: <strong style={{ color: 'var(--text-primary)' }}>{aiState.activeNode}</strong>
                    </div>
                  )}
                </div>

                <div>
                  <div style={{ marginBottom: '6px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Waiting Queue ({aiState.queueLength} tasks):</div>
                  <div style={{ 
                    background: 'rgba(0,0,0,0.3)', 
                    padding: '10px 12px', 
                    borderRadius: '8px', 
                    height: '80px',
                    overflowY: 'auto',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px'
                  }}>
                    {aiState.waitingQueue.length > 0 ? (
                      aiState.waitingQueue.map((t, idx) => (
                        <div key={idx} style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', justifyContent: 'space-between' }}>
                          <span>#{idx + 1}: {t.metadata.name}</span>
                          <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>{t.metadata.nodeId}</span>
                        </div>
                      ))
                    ) : (
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textAlign: 'center', padding: '8px' }}>
                        No waiting requests. Queue is empty.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Section 3: Agent Status Grid */}
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              flex: '1 1 0%',
              minHeight: '150px',
              overflow: 'hidden'
            }}>
              <h3 style={{ fontSize: '1rem', marginBottom: '8px', color: 'var(--text-primary)', flexShrink: 0 }}>Active Agent Registry</h3>
              <div className="memory-grid" style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                gap: '12px',
                overflowY: 'auto',
                flex: '1 1 0%',
                paddingRight: '6px'
              }}>
                {[...agents].sort((a, b) => {
                  const aActive = getAgentStatus(a.type) === 'Active';
                  const bActive = getAgentStatus(b.type) === 'Active';
                  if (aActive && !bActive) return -1;
                  if (!aActive && bActive) return 1;
                  return 0;
                }).map((agent, index) => {
                  const status = getAgentStatus(agent.type);
                  const IconComponent = agent.icon;
                  return (
                    <div 
                      key={index} 
                      className={`memory-card ${status === 'Active' ? 'active-agent' : ''}`} 
                      style={{ 
                        padding: '12px 16px', 
                        position: 'relative',
                        border: status === 'Active' ? '1px solid var(--accent-primary)' : '1px solid rgba(255, 255, 255, 0.05)',
                        boxShadow: status === 'Active' ? '0 0 15px rgba(100, 108, 255, 0.2)' : 'none',
                        transition: 'all 0.3s ease'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          {IconComponent && <IconComponent size={15} className={status === 'Active' ? 'text-accent-primary' : 'text-secondary'} />}
                          <h4 style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-primary)', margin: 0 }}>{agent.name}</h4>
                        </div>
                        <span className={`badge ${status === 'Active' ? 'badge-short-term' : 'badge-long-term'}`} style={{ fontSize: '0.72rem', padding: '2px 6px' }}>
                          {status}
                        </span>
                      </div>
                      <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.35, margin: 0 }}>{agent.desc}</p>
                      {status === 'Active' && (
                        <div className="pulsing-glow" style={{
                          position: 'absolute',
                          top: 0, left: 0, right: 0, bottom: 0,
                          border: '1px solid var(--accent-primary)',
                          borderRadius: '12px',
                          pointerEvents: 'none',
                          animation: 'pulse 1.5s infinite alternate'
                        }} />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Section 4: Real-time Agent Execution logs */}
            <div className="memory-card" style={{
              padding: '16px',
              display: 'flex',
              flexDirection: 'column',
              flex: '1 1 0%',
              minHeight: '120px',
              overflow: 'hidden',
              marginBottom: 0
            }}>
              <h3 style={{ fontSize: '1rem', marginBottom: '8px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                <Cpu size={18} className="text-accent-primary" /> Live Agent Routing Sequence
              </h3>
              <div 
                ref={logsScrollRef}
                style={{
                  overflowY: 'auto',
                  flex: '1 1 0%',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                  paddingRight: '6px'
                }}>
                {toolLogs && toolLogs.length > 0 ? (
                  toolLogs.map((log, idx) => (
                    <div key={idx} style={{ 
                      display: 'flex', 
                      alignItems: 'center', 
                      gap: '12px', 
                      padding: '8px 12px', 
                      background: 'rgba(255,255,255,0.05)', 
                      borderRadius: '8px', 
                      fontSize: '0.85rem'
                    }}>
                      <CheckCircle size={14} className="text-accent-primary" />
                      <div>
                        <strong style={{ color: 'var(--text-primary)' }}>[{log.tool.toUpperCase()}]</strong> action: <code>{log.action}</code>
                        {log.params && <span style={{ color: 'var(--text-secondary)', marginLeft: '8px' }}>({JSON.stringify(log.params)})</span>}
                      </div>
                    </div>
                  ))
                ) : (
                  <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 'auto' }}>
                    No active session logs. Interact with the chat supervisor to trigger agent routing.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {activeSubTab === 'vault' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', alignItems: 'start' }}>
          {/* Document Upload panel */}
          <div className="memory-card" style={{ padding: '20px' }}>
            <h3 style={{ fontSize: '1.1rem', marginBottom: '16px', color: 'var(--text-primary)' }}>Add Document to RAG Vault</h3>
            <form onSubmit={handleUpload} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div className="form-group">
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '4px', display: 'block' }}>Upload File (.txt, .md)</label>
                <input 
                  type="file" 
                  accept=".txt,.md" 
                  onChange={handleFileInputChange} 
                  className="form-control" 
                  style={{ padding: '8px', background: 'rgba(0,0,0,0.2)' }}
                />
              </div>

              <div className="form-group">
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '4px', display: 'block' }}>Document Name</label>
                <input 
                  type="text" 
                  placeholder="document_name.txt"
                  value={fileName}
                  onChange={e => setFileName(e.target.value)}
                  className="form-control"
                  required
                />
              </div>

              <div className="form-group">
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '4px', display: 'block' }}>Document Raw Content</label>
                <textarea 
                  rows={8}
                  placeholder="Paste document text context here to parse and index..."
                  value={fileContent}
                  onChange={e => setFileContent(e.target.value)}
                  className="form-control"
                  style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '0.85rem' }}
                  required
                />
              </div>

              {uploadError && <div style={{ color: '#ff6b6b', fontSize: '0.8rem' }}>{uploadError}</div>}

              <button type="submit" className="btn btn-primary" disabled={isUploading} style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: '8px' }}>
                {isUploading ? <RefreshCw size={14} className="spin" /> : <Upload size={14} />}
                {isUploading ? 'Chunking & Embedding...' : 'Index Document'}
              </button>
            </form>
          </div>

          {/* Indexed Documents list */}
          <div className="memory-card" style={{ padding: '20px' }}>
            <h3 style={{ fontSize: '1.1rem', marginBottom: '16px', color: 'var(--text-primary)' }}>Indexed Documents</h3>
            {documents.length > 0 ? (
              <div style={{ maxHeight: '450px', overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)', textAlign: 'left', color: 'var(--text-secondary)' }}>
                      <th style={{ padding: '8px' }}>Filename</th>
                      <th style={{ padding: '8px' }}>Size</th>
                      <th style={{ padding: '8px', textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {documents.map(doc => (
                      <tr key={doc.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                        <td style={{ padding: '10px 8px', color: 'var(--text-primary)', fontWeight: 500 }}>{doc.filename}</td>
                        <td style={{ padding: '10px 8px', color: 'var(--text-secondary)' }}>{(doc.file_size / 1024).toFixed(1)} KB</td>
                        <td style={{ padding: '10px 8px', textAlign: 'right' }}>
                          <button 
                            className="btn btn-icon" 
                            onClick={() => handleDelete(doc.id)}
                            style={{ color: '#ff6b6b', padding: '4px' }}
                            title="Delete document and remove all vector indexes"
                          >
                            <Trash2 size={16} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '40px 10px', color: 'var(--text-secondary)' }}>
                No documents indexed in your Private RAG Vault. Write or upload files to start querying private files.
              </div>
            )}
          </div>
        </div>
      )}

      {activeSubTab === 'nodes' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {/* Active Field Node Topology SVG Graph */}
          <div style={{
            background: 'var(--bg-glass)',
            border: '1px solid var(--border-glass)',
            borderRadius: '16px',
            padding: '20px',
            boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Network size={20} style={{ color: 'var(--accent-primary)' }} />
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
                  Active Field Node Topology
                </h3>
              </div>
              <button 
                onClick={() => { fetchNodes(true); localStorage.setItem('last_nodes_scan_time', Date.now().toString()); }} 
                disabled={scanning}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '0.85rem'
                }}
              >
                <RefreshCw size={14} className={scanning ? 'spin' : ''} style={{ animation: scanning ? 'spin 1.5s linear infinite' : 'none' }} />
                <span>{scanning ? 'Scanning...' : 'Refresh'}</span>
              </button>
            </div>

            <div style={{
              width: '100%',
              height: 'auto',
              aspectRatio: '800 / 320',
              maxHeight: '360px',
              background: 'rgba(15, 23, 42, 0.4)',
              borderRadius: '12px',
              border: '1px solid rgba(255,255,255,0.05)',
              overflow: 'hidden',
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              <svg width="100%" height="100%" viewBox="0 0 800 320" style={{ pointerEvents: 'auto' }}>
                <defs>
                  <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                    <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="1"/>
                  </pattern>
                  <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                    <feGaussianBlur stdDeviation="6" result="blur" />
                    <feComposite in="SourceGraphic" in2="blur" operator="over" />
                  </filter>
                </defs>
                <rect width="100%" height="100%" fill="url(#grid)" />

                {/* Radar Wave Pulse */}
                {(nodes.filter(n => {
                  const health = nodeHealthMap[n.id];
                  const isOnline = health ? health.status === 'online' : n.is_online;
                  return (isOnline === 1 || isOnline === true || isOnline === '1') && n.ip_address !== '192.168.1.1' && !n.ip_address.endsWith('.1');
                }).length === 0 || scanning) && (
                  <>
                    <circle cx="400" cy="160" r="30" fill="none" stroke="#22c55e" strokeWidth="1.5" opacity="0.6">
                      <animate attributeName="r" values="30;160" dur="4s" repeatCount="indefinite" />
                      <animate attributeName="opacity" values="0.6;0" dur="4s" repeatCount="indefinite" />
                    </circle>
                    <circle cx="400" cy="160" r="30" fill="none" stroke="#22c55e" strokeWidth="1.5" opacity="0.3">
                      <animate attributeName="r" values="30;160" dur="4s" begin="2s" repeatCount="indefinite" />
                      <animate attributeName="opacity" values="0.3;0" dur="4s" begin="2s" repeatCount="indefinite" />
                    </circle>
                  </>
                )}

                {/* Link lines */}
                {nodes.filter(n => {
                  const health = nodeHealthMap[n.id];
                  const isOnline = health ? health.status === 'online' : n.is_online;
                  return (isOnline === 1 || isOnline === true || isOnline === '1') && n.ip_address !== '192.168.1.1' && !n.ip_address.endsWith('.1');
                }).map((node, i, arr) => {
                  const angle = (i * 2 * Math.PI) / arr.length;
                  const radius = 120;
                  const x = 400 + radius * Math.cos(angle);
                  const y = 160 + radius * Math.sin(angle);

                  return (
                    <g key={`link-${node.id || node.ip_address}`}>
                      <line 
                        x1="400" 
                        y1="160" 
                        x2={x} 
                        y2={y} 
                        stroke="#22c55e" 
                        strokeWidth="2.5" 
                        strokeDasharray="6,4" 
                        opacity="0.8"
                        filter="url(#glow)"
                      />
                      <circle r="4.5" fill="#4ade80">
                        <animateMotion dur="2.5s" repeatCount="indefinite" path={`M 400 160 L ${x} ${y}`} />
                      </circle>
                    </g>
                  );
                })}

                {/* Main Host */}
                <g transform="translate(400, 160)">
                  <circle r="34" fill="#1e1b4b" stroke="var(--accent-primary)" strokeWidth="3" filter="url(#glow)" />
                  <text y="5" textAnchor="middle" fill="#fff" fontSize="18" fontWeight="bold">💻</text>
                  <text y="52" textAnchor="middle" fill="#fff" fontSize="12" fontWeight="600">Main Host</text>
                  <text y="66" textAnchor="middle" fill="var(--text-secondary)" fontSize="10">127.0.0.1</text>
                </g>

                {/* Orbiting Discovered Active Nodes */}
                {nodes.filter(n => {
                  const health = nodeHealthMap[n.id];
                  const isOnline = health ? health.status === 'online' : n.is_online;
                  return (isOnline === 1 || isOnline === true || isOnline === '1') && n.ip_address !== '192.168.1.1' && !n.ip_address.endsWith('.1');
                }).map((node, i, arr) => {
                  const angle = (i * 2 * Math.PI) / arr.length;
                  const radius = 120;
                  const x = 400 + radius * Math.cos(angle);
                  const y = 160 + radius * Math.sin(angle);

                  let deviceSymbol = '📱';
                  const devType = node.device_type ? node.device_type.toLowerCase() : '';
                  if (devType.includes('rpi')) deviceSymbol = '🍓';
                  else if (devType.includes('esp32')) deviceSymbol = '🔌';
                  else if (devType.includes('assistant')) deviceSymbol = '🔊';

                  const isRpiOrLinux = devType.includes('rpi') || devType.includes('linux');

                  return (
                    <g 
                      key={`node-${node.id || node.ip_address}`} 
                      transform={`translate(${x}, ${y})`}
                      style={{ cursor: isRpiOrLinux ? 'pointer' : 'default' }}
                      onClick={() => {
                        if (isRpiOrLinux) {
                          setSelectedTerminalNode(node);
                          setIsTerminalOpen(true);
                        }
                      }}
                    >
                      <circle r="24" fill="#0f172a" stroke="#22c55e" strokeWidth="2.5" filter="url(#glow)" />
                      <text y="5" textAnchor="middle" fill="#fff" fontSize="14">{deviceSymbol}</text>
                      <text y="38" textAnchor="middle" fill="#fff" fontSize="11" fontWeight="600">
                        {node.node_name}
                      </text>
                      <text y="50" textAnchor="middle" fill="#22c55e" fontSize="9.5" fontWeight="bold">
                        {node.ip_address}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>

          {/* Table of Nodes and Management Actions */}
          <div className="memory-card" style={{ padding: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
              <h3 style={{ fontSize: '1.1rem', color: 'var(--text-primary)', margin: 0 }}>Distributed Field Nodes</h3>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn btn-secondary" onClick={() => setShowInstallGuide(!showInstallGuide)} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', padding: '6px 12px' }}>
                  <BookOpen size={14} /> Install Guide
                </button>
                <button className="btn btn-secondary" onClick={() => { fetchNodes(true); localStorage.setItem('last_nodes_scan_time', Date.now().toString()); }} disabled={scanning} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', padding: '6px 12px' }}>
                  <RefreshCw size={14} className={scanning ? 'spin' : ''} style={{ animation: scanning ? 'spin 1.5s linear infinite' : 'none' }} /> {scanning ? 'Refreshing...' : 'Refresh'}
                </button>
                <button className="btn btn-secondary" onClick={handleScanNodes} disabled={scanning} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', padding: '6px 12px' }}>
                  <Search size={14} /> {scanning ? 'Scanning...' : 'Scan LAN'}
                </button>
                <button className="btn btn-primary" onClick={() => setShowAddNode(!showAddNode)} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', padding: '6px 12px' }}>
                  <Plus size={14} /> Add Node
                </button>
              </div>
            </div>

            {showInstallGuide && (
              <div style={{ padding: '16px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px', marginBottom: '20px', border: '1px solid rgba(255,255,255,0.1)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <h4 style={{ margin: 0, color: 'var(--text-primary)', fontSize: '0.95rem' }}>Device Setup Walkthrough Guide</h4>
                  <select 
                    className="form-control" 
                    value={selectedGuideDevice} 
                    onChange={e => setSelectedGuideDevice(e.target.value)}
                    style={{ width: 'auto', padding: '4px 8px', fontSize: '0.85rem' }}
                  >
                    <option value="rpi-5-8gb">Raspberry Pi 5 (8GB)</option>
                    <option value="rpi-5-16gb">Raspberry Pi 5 (16GB)</option>
                    <option value="esp32">ESP32 (MicroPython)</option>
                    <option value="windows">Windows / PC</option>
                  </select>
                </div>

                {selectedGuideDevice.startsWith('rpi') && (
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
                    <p><strong>To set up this Raspberry Pi as a Field Node:</strong></p>
                    <ol style={{ paddingLeft: '20px', margin: '0 0 10px 0' }}>
                      <li>Open a terminal on your Raspberry Pi.</li>
                      <li>Clone the project repository:<br />
                        <code style={{ background: '#0f172a', padding: '2px 6px', borderRadius: '4px', display: 'block', margin: '4px 0', color: '#38bdf8' }}>
                          git clone https://github.com/[USER]/PATTI.git
                        </code>
                      </li>
                      <li>Run the setup script:<br />
                        <code style={{ background: '#0f172a', padding: '2px 6px', borderRadius: '4px', display: 'block', margin: '4px 0', color: '#38bdf8' }}>
                          cd PATTI && ./setup.sh
                        </code>
                      </li>
                      <li>Choose <strong>Field Node</strong> (Option 2) when prompted for role, and select your Raspberry Pi device type.</li>
                      <li>Enter your Main Host IP address when prompted:<br />
                        <code style={{ background: '#0f172a', padding: '2px 6px', borderRadius: '4px', display: 'block', margin: '4px 0', color: '#34d399' }}>
                          {window.location.hostname || '192.168.1.42'}
                        </code>
                      </li>
                    </ol>
                    <p style={{ margin: 0 }}>💡 <em>Note: Leave the Bridge Secret blank here to automatically pair using the shared LLM API key.</em></p>
                  </div>
                )}

                {selectedGuideDevice === 'esp32' && (
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
                    <p><strong>To set up an ESP32 microcontroller as a Field Node:</strong></p>
                    <ol style={{ paddingLeft: '20px', margin: '0 0 10px 0' }}>
                      <li>Flash MicroPython onto your ESP32 board.</li>
                      <li>Upload the contents of the <code style={{ color: 'var(--text-primary)' }}>backend/nodes/esp32/</code> directory (containing <code style={{ color: 'var(--text-primary)' }}>boot.py</code> and <code style={{ color: 'var(--text-primary)' }}>main.py</code>) to your board.</li>
                      <li>Configure your local WiFi SSID and password in the configuration file on the board.</li>
                      <li>Set the matching authentication bridge secret.</li>
                    </ol>
                  </div>
                )}

                {selectedGuideDevice === 'windows' && (
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
                    <p><strong>To set up another Windows PC as a Field Node:</strong></p>
                    <ol style={{ paddingLeft: '20px', margin: '0 0 10px 0' }}>
                      <li>Clone the project repository in PowerShell:<br />
                        <code style={{ background: '#0f172a', padding: '2px 6px', borderRadius: '4px', display: 'block', margin: '4px 0', color: '#38bdf8' }}>
                          git clone https://github.com/[USER]/PATTI.git
                        </code>
                      </li>
                      <li>Navigate to the folder and execute setup:<br />
                        <code style={{ background: '#0f172a', padding: '2px 6px', borderRadius: '4px', display: 'block', margin: '4px 0', color: '#38bdf8' }}>
                          cd PATTI && .\setup.ps1
                        </code>
                      </li>
                      <li>Answer <strong>No (n)</strong> to the Main Host role prompt to install it as a Field Node.</li>
                    </ol>
                  </div>
                )}
              </div>
            )}

            {scanning && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', padding: '30px 10px', color: 'var(--text-secondary)' }}>
                <RefreshCw size={24} className="animate-spin text-accent-primary" />
                <span>Scanning local network subnet for active P.A.T.T.I. nodes...</span>
              </div>
            )}

            {!scanning && discoveredNodes.length > 0 && (
              <div style={{ padding: '16px', background: 'rgba(52,211,153,0.05)', borderRadius: '8px', marginBottom: '20px', border: '1px solid rgba(52,211,153,0.1)' }}>
                <h4 style={{ margin: '0 0 12px 0', color: '#34d399', fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <CheckCircle size={16} /> Discovered Nodes on LAN
                </h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {discoveredNodes.map((n, idx) => (
                    <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(0,0,0,0.1)', padding: '8px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '0.85rem' }}>
                        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{n.ip_address}:{n.port}</span>
                        <span style={{ margin: '0 8px', color: 'var(--text-secondary)' }}>|</span>
                        <span style={{ color: 'var(--text-secondary)' }}>Type: {n.device_type}</span>
                        {/* Fixed accent-colored badge background regardless of theme; text stays fixed white to match. */}
                        {n.is_main_host && <span style={{ marginLeft: '8px', background: 'var(--accent-primary)', fontSize: '0.7rem', padding: '2px 6px', borderRadius: '4px', color: '#fff' }}>Main Host</span>}
                      </div>
                      <button className="btn btn-primary" onClick={() => setRegisteringNode({ node_name: `${n.device_type.toUpperCase()} Node`, device_type: n.device_type, ip_address: n.ip_address, port: n.port, bridge_secret: '', mqtt_topic: '' })} style={{ fontSize: '0.75rem', padding: '4px 10px' }}>
                        Quick Register
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {showAddNode && (
              <form onSubmit={handleAddNode} style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '20px', padding: '16px', background: 'rgba(0,0,0,0.1)', borderRadius: '8px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Node Name</label>
                    <input type="text" className="form-control" placeholder="e.g. Living Room Pi" required value={newNode.node_name} onChange={e => setNewNode({...newNode, node_name: e.target.value})} />
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Device Type</label>
                    <select className="form-control" value={newNode.device_type} onChange={e => setNewNode({...newNode, device_type: e.target.value})}>
                      <option value="rpi-5-8gb">Raspberry Pi 5 (8GB)</option>
                      <option value="rpi-5-16gb">Raspberry Pi 5 (16GB)</option>
                      <option value="rpi-4-4gb">Raspberry Pi 4 (4GB+)</option>
                      <option value="rpi-zero-2w">Raspberry Pi Zero 2W</option>
                      <option value="esp32-wroom">ESP32 WROOM (WiFi)</option>
                      <option value="windows">Windows / PC</option>
                    </select>
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>IP Address</label>
                    <input type="text" className="form-control" placeholder="192.168.1.50" required value={newNode.ip_address} onChange={e => setNewNode({...newNode, ip_address: e.target.value})} />
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Bridge Secret (Optional)</label>
                    <input type="password" className="form-control" placeholder="Optional Auth Token" value={newNode.bridge_secret} onChange={e => setNewNode({...newNode, bridge_secret: e.target.value})} />
                  </div>
                  <div className="form-group" style={{ margin: 0, gridColumn: '1 / -1' }}>
                    <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      MQTT Topic / Node ID {newNode.device_type === 'esp32-wroom' ? '(required for ESP32 control)' : '(Optional)'}
                    </label>
                    <input type="text" className="form-control" placeholder="e.g. esp32_a1b2c3d4e5f6 (printed on the device's serial console at boot)" value={newNode.mqtt_topic} onChange={e => setNewNode({...newNode, mqtt_topic: e.target.value})} />
                  </div>
                </div>
                <button type="submit" className="btn btn-primary" style={{ alignSelf: 'flex-start' }}>Save Node</button>
              </form>
            )}

            {nodes.length > 0 ? (
              <div style={{ overflowX: 'auto', width: '100%', scrollbarWidth: 'thin' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', minWidth: '650px' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)', textAlign: 'left', color: 'var(--text-secondary)' }}>
                      <th style={{ padding: '8px' }}>Status</th>
                      <th style={{ padding: '8px' }}>Name</th>
                      <th style={{ padding: '8px' }}>Type</th>
                      <th style={{ padding: '8px' }}>IP:Port</th>
                      <th style={{ padding: '8px' }}>Health Status</th>
                      <th style={{ padding: '8px' }}>Last Seen</th>
                      <th style={{ padding: '8px', textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...nodes].sort((a, b) => {
                      const aOnline = !!(nodeHealthMap[a.id] ? nodeHealthMap[a.id].status === 'online' : a.is_online);
                      const bOnline = !!(nodeHealthMap[b.id] ? nodeHealthMap[b.id].status === 'online' : b.is_online);
                      if (aOnline !== bOnline) return aOnline ? -1 : 1;

                      // Within the same online/offline group, sort by IP address numerically (octet by octet)
                      const ipToNumber = (ip) => (ip || '0.0.0.0').split('.')
                        .reduce((acc, octet) => acc * 256 + (parseInt(octet, 10) || 0), 0);
                      return ipToNumber(a.ip_address) - ipToNumber(b.ip_address);
                    }).map(node => {
                      const health = nodeHealthMap[node.id];
                      const isOnline = health ? health.status === 'online' : node.is_online;
                      return (
                        <tr key={node.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                          <td style={{ padding: '10px 8px' }}>
                            <div style={{ 
                              width: '10px', 
                              height: '10px', 
                              borderRadius: '50%', 
                              background: isOnline ? '#34d399' : '#ff6b6b',
                              boxShadow: isOnline ? '0 0 8px #34d399' : 'none'
                            }}></div>
                          </td>
                          <td style={{ padding: '10px 8px', color: 'var(--text-primary)', fontWeight: 500 }}>{node.node_name}</td>
                          <td style={{ padding: '10px 8px', color: 'var(--text-secondary)' }}>{node.device_type}</td>
                          <td style={{ padding: '10px 8px', color: 'var(--text-secondary)' }}>{node.ip_address}:{node.port}</td>
                          <td style={{ padding: '10px 8px' }}>
                            {/* Fixed status-colored background (green/red) regardless of theme; text stays fixed white to match. */}
                            <span className="badge" style={{
                              padding: '4px 10px',
                              borderRadius: '6px',
                              background: isOnline ? '#059669' : '#dc2626',
                              color: '#fff',
                              fontWeight: 600,
                              fontSize: '0.8rem',
                              display: 'inline-block',
                              textAlign: 'center',
                              minWidth: '80px',
                              boxShadow: isOnline ? '0 0 6px rgba(5,150,105,0.4)' : '0 0 6px rgba(220,38,38,0.4)'
                            }}>
                              {isOnline ? 'ONLINE' : 'OFFLINE'}
                            </span>
                            <span style={{ marginLeft: '8px', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                              {isOnline ? 'Ready for tasks' : 'Unreachable'}
                            </span>
                          </td>
                          <td style={{ padding: '10px 8px', color: 'var(--text-secondary)' }}>{new Date(node.last_seen).toLocaleString()}</td>
                          <td style={{ padding: '10px 8px', textAlign: 'right' }}>
                            <button className="btn btn-icon" onClick={() => handleDeleteNode(node.id)} style={{ color: '#ff6b6b', padding: '4px' }}>
                              <Trash2 size={16} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '40px 10px', color: 'var(--text-secondary)' }}>
                No remote nodes configured. Add an ESP32 or Raspberry Pi to distribute tasks.
              </div>
            )}
          </div>
        </div>
      )}

      {activeSubTab === 'host' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {hostStatus ? (
            <>
              {/* Telemetry Status Cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
                <div className="memory-card" style={{ padding: '20px' }}>
                  <h3 style={{ fontSize: '1rem', color: 'rgba(255,255,255,0.7)', margin: '0 0 12px 0' }}>CPU Specifications</h3>
                  <div style={{ fontSize: '1.25rem', fontWeight: 'bold', color: 'var(--text-primary)', marginBottom: '8px' }}>
                    {hostStatus.cpu.cores} Cores
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    Model: {hostStatus.cpu.model}
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                    Load Avg: {hostStatus.cpu.loadAvg.map(l => l.toFixed(2)).join(', ')}
                  </div>
                </div>

                <div className="memory-card" style={{ padding: '20px' }}>
                  <h3 style={{ fontSize: '1rem', color: 'rgba(255,255,255,0.7)', margin: '0 0 12px 0' }}>Memory Utilization</h3>
                  <div style={{ fontSize: '1.25rem', fontWeight: 'bold', color: 'var(--text-primary)', marginBottom: '8px' }}>
                    {hostStatus.memory.percentage}% Used
                  </div>
                  <div style={{ height: '6px', background: 'rgba(255,255,255,0.1)', borderRadius: '3px', overflow: 'hidden', marginBottom: '8px' }}>
                    <div style={{ height: '100%', width: `${hostStatus.memory.percentage}%`, background: 'var(--accent-primary)' }}></div>
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    {(hostStatus.memory.used / 1024 / 1024 / 1024).toFixed(1)} GB / {(hostStatus.memory.total / 1024 / 1024 / 1024).toFixed(1)} GB
                  </div>
                </div>

                <div className="memory-card" style={{ padding: '20px' }}>
                  <h3 style={{ fontSize: '1rem', color: 'rgba(255,255,255,0.7)', margin: '0 0 12px 0' }}>Uptime</h3>
                  <div style={{ fontSize: '1.25rem', fontWeight: 'bold', color: 'var(--text-primary)', marginBottom: '8px' }}>
                    {Math.floor(hostStatus.uptime / 3600)}h {Math.floor((hostStatus.uptime % 3600) / 60)}m
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    System is running stable
                  </div>
                </div>
              </div>

              {/* Service Management Panel */}
              <div className="memory-card" style={{ padding: '20px' }}>
                <h3 style={{ fontSize: '1.1rem', marginBottom: '16px', color: 'var(--text-primary)' }}>Service Management</h3>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <div className="form-group" style={{ flex: 1, minWidth: '200px', margin: 0 }}>
                    <label>Systemd Service Name</label>
                    <input
                      type="text"
                      className="form-control"
                      value={restartServiceName}
                      onChange={e => setRestartServiceName(e.target.value)}
                      placeholder="e.g. patti"
                    />
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleRestartService}
                    disabled={restartingService || !restartServiceName.trim()}
                    style={{ padding: '10px 24px' }}
                  >
                    {restartingService ? 'Restarting...' : '🔄 Restart Service'}
                  </button>
                </div>
              </div>

              {/* Live Reports & Telemetry Log views */}
              <div className="memory-card" style={{ padding: '20px' }}>
                <h3 style={{ fontSize: '1.1rem', marginBottom: '12px', color: 'var(--text-primary)' }}>Detailed Hardware Telemetry</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  {hostStatus.telemetry.temperature && (
                    <div>
                      <h4 style={{ fontSize: '0.9rem', color: 'var(--accent-primary)', marginBottom: '6px' }}>CPU Temperature Sensors</h4>
                      <pre style={{ margin: 0, padding: '12px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '8px', fontSize: '0.8rem', color: '#eee', whiteSpace: 'pre-wrap' }}>
                        {hostStatus.telemetry.temperature}
                      </pre>
                    </div>
                  )}

                  {hostStatus.telemetry.power && (
                    <div>
                      <h4 style={{ fontSize: '0.9rem', color: 'var(--accent-primary)', marginBottom: '6px' }}>Power Draw / Battery Diagnostics</h4>
                      <pre style={{ margin: 0, padding: '12px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '8px', fontSize: '0.8rem', color: '#eee', whiteSpace: 'pre-wrap' }}>
                        {hostStatus.telemetry.power}
                      </pre>
                    </div>
                  )}

                  {hostStatus.telemetry.network && (
                    <div>
                      <h4 style={{ fontSize: '0.9rem', color: 'var(--accent-primary)', marginBottom: '6px' }}>Network & WiFi Telemetry</h4>
                      <pre style={{ margin: 0, padding: '12px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '8px', fontSize: '0.8rem', color: '#eee', whiteSpace: 'pre-wrap' }}>
                        {hostStatus.telemetry.network}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div style={{ textAlign: 'center', padding: '40px 10px', color: 'var(--text-secondary)' }}>
              {loadingHost ? 'Loading system specs...' : 'Failed to retrieve system status.'}
            </div>
          )}
        </div>
      )}

      {activeSubTab === 'tokens' && (
        <TokenCountView token={token} />
      )}

      {activeSubTab === 'logs' && (settings?.is_main_host === true || settings?.is_main_host === 1 || settings?.is_main_host === '1') && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && (window.location.port === '3000' || window.location.port === '5173') && (
        <LMStudioLogsView token={token} />
      )}
      {/* Quick Register Confirmation Modal */}
      {registeringNode && (
        <div className="modal-overlay" onClick={() => setRegisteringNode(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '400px', width: '90%' }}>
            <div className="modal-header" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '12px' }}>
              <h3 style={{ margin: 0, fontSize: '1.1rem', color: 'var(--text-primary)' }}>Confirm Node Registration</h3>
              <button className="btn-icon" onClick={() => setRegisteringNode(null)}>
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleConfirmRegisterNode} style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '14px' }}>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0 }}>
                Specify details for registering the discovered node at <strong>{registeringNode.ip_address}:{registeringNode.port}</strong>.
              </p>
              
              <div className="form-group" style={{ margin: 0 }}>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Node Name</label>
                <input 
                  type="text" 
                  className="form-control" 
                  required 
                  value={registeringNode.node_name} 
                  onChange={e => setRegisteringNode({ ...registeringNode, node_name: e.target.value })} 
                />
              </div>

              <div className="form-group" style={{ margin: 0 }}>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Device Type</label>
                <select 
                  className="form-control" 
                  value={registeringNode.device_type} 
                  onChange={e => {
                    const newType = e.target.value;
                    const defaultName = `${newType.toUpperCase()} Node`;
                    setRegisteringNode({ 
                      ...registeringNode, 
                      device_type: newType,
                      node_name: registeringNode.node_name === `${registeringNode.device_type.toUpperCase()} Node` ? defaultName : registeringNode.node_name 
                    });
                  }}
                >
                  <option value="rpi-5-8gb">Raspberry Pi 5 (8GB)</option>
                  <option value="rpi-5-16gb">Raspberry Pi 5 (16GB)</option>
                  <option value="rpi-4-4gb">Raspberry Pi 4 (4GB+)</option>
                  <option value="rpi-zero-2w">Raspberry Pi Zero 2W</option>
                  <option value="esp32-wroom">ESP32 WROOM (WiFi)</option>
                  <option value="windows">Windows / PC</option>
                </select>
              </div>

              <div className="form-group" style={{ margin: 0 }}>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  MQTT Topic / Node ID {registeringNode.device_type === 'esp32-wroom' ? '(required for ESP32 control)' : '(Optional)'}
                </label>
                <input
                  type="text"
                  className="form-control"
                  placeholder="e.g. esp32_a1b2c3d4e5f6 (printed on the device's serial console at boot)"
                  value={registeringNode.mqtt_topic || ''}
                  onChange={e => setRegisteringNode({ ...registeringNode, mqtt_topic: e.target.value })}
                />
              </div>

              <div style={{ display: 'flex', gap: '10px', marginTop: '12px', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '12px' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setRegisteringNode(null)} style={{ flex: 1 }}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>
                  Register
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <RpiTerminalModal
        isOpen={isTerminalOpen}
        onClose={() => { setIsTerminalOpen(false); setSelectedTerminalNode(null); }}
        node={selectedTerminalNode}
        token={token}
        onNodeUpdated={fetchNodes}
      />

      <CustomAlertModal
        alert={popupAlert}
        onClose={() => setPopupAlert(null)}
      />

      <CustomAlertModal
        alert={popupConfirm}
        onClose={() => setPopupConfirm(null)}
      />
    </div>
  );
}
