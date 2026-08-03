import React, { useState, useEffect } from 'react';
import { Network, FileText, Upload, Trash2, Cpu, Eye, CheckCircle, RefreshCw, Layers, Plus, Server, Monitor, Search, BookOpen, X, BarChart2, Cloud, Code, Shield, Wrench, UserPlus, Calendar, ChevronLeft, ChevronRight, Trophy, Newspaper, Clapperboard, Microscope, Telescope, GraduationCap, FilePlus, FileEdit } from 'lucide-react';
import TokenCountView from './TokenCountView';
import RpiTerminalModal from './RpiTerminalModal';
import LMStudioLogsView from './LMStudioLogsView';
import CustomAlertModal from './CustomAlertModal';

const agents = [
  {
    type: 'communication_specialist',
    name: 'Communication Specialist',
    icon: RefreshCw,
    desc: 'Primary contact for the user. Bubbly, warm, and welcomes the user. Translates requests into project ideas and formats final reports beautifully.'
  },
  {
    type: 'supervisor',
    name: 'Supervisor Agent',
    icon: Network,
    desc: 'Master orchestrator. Reads the full agent capability registry and routes every task to the best-suited specialist agent.'
  },
  {
    type: 'weather',
    name: 'Weather Expert',
    icon: Cloud,
    desc: 'Fetches current conditions, hourly forecasts, and daily weather data using your zipcode.'
  },
  {
    type: 'system',
    name: 'System Agent',
    icon: Cpu,
    desc: 'Queries local host: CPU, RAM, disk, temperature, processes, services, security scans, and scripting on the current machine only.'
  },
  {
    type: 'node',
    name: 'Node Agent',
    icon: Server,
    desc: 'Routes commands and queries to remote RPi or ESP32 field nodes. Cannot query Main Host from a remote context.'
  },
  {
    type: 'memory',
    name: 'Memory Agent',
    icon: BookOpen,
    desc: 'Stores, recalls, and forgets long-term and short-term memories about the user.'
  },
  {
    type: 'calendar',
    name: 'Calendar Agent',
    icon: Calendar,
    desc: 'Manages calendar events: listing, adding, or deleting scheduled events.'
  },
  {
    type: 'crawler',
    name: 'Web Searcher',
    icon: Search,
    desc: 'Performs live web searches and Google News lookups, aligning results with stored user interests.'
  },
  {
    type: 'rag',
    name: 'Document Vault Agent',
    icon: FileText,
    desc: 'Performs semantic vector search over uploaded private documents using cosine similarity.'
  },
  {
    type: 'qa',
    name: 'QA Engineer',
    icon: Shield,
    desc: 'Reviews code for bugs, vulnerabilities, and test coverage. Issues APPROVE or REJECT verdicts.'
  },
  {
    type: 'tool_creator',
    name: 'Tool Creation Agent',
    icon: Wrench,
    desc: 'Coordinates dynamic tool creation: designs plan, requests HITL approval, then implements and deploys.'
  },
  {
    type: 'agent_creator',
    name: 'Agent Creation Agent',
    icon: UserPlus,
    desc: 'Dynamically designs and integrates new specialist agents into the multi-agent loop.'
  },
  {
    type: 'developer',
    name: 'Developer Agent',
    icon: Layers,
    desc: 'Orchestrates software development pipelines, manages workspace files, writes source code, and deploys new custom tools.'
  },
  {
    type: 'sports',
    name: 'Sports Agent',
    icon: Trophy,
    desc: 'Gathers and tracks sports news, scores, highlights, or team articles from Bleacher Report, ensuring unseen stories are shown first.'
  },
  {
    type: 'news',
    name: 'News Agent',
    icon: Newspaper,
    desc: 'Gathers general news briefs from TMZ and performs randomized searches on user preference topics, evaluating accuracy results.'
  },
  {
    type: 'movie_tv',
    name: 'Movie & TV Agent',
    icon: Clapperboard,
    desc: 'Finds what is new on streaming, upcoming release dates, and where to watch a title, using The Movie Database plus Rotten Tomatoes and Reddit for reviews.'
  },
  {
    type: 'deep_research',
    name: 'Deep Research Agent',
    icon: Microscope,
    desc: 'Crawls multiple sources on a topic and grows PATTI\'s permanent shared knowledge base so repeat questions are answered faster.'
  },
  {
    type: 'deep_research_pro',
    name: 'Deep Research Pro',
    icon: Telescope,
    desc: 'Runs a long-form multi-source web investigation in the background, reporting back later in the Deep Research Results chat.'
  },
  {
    type: 'course_builder',
    name: 'Course Builder Agent',
    icon: GraduationCap,
    desc: 'Writes full multi-lesson courses and study guides with PATTI\'s own model, saving them to disk and reporting back in the Generated Courses chat.'
  },
  {
    type: 'document_generator',
    name: 'Document Generator',
    icon: FilePlus,
    desc: 'Produces downloadable PDF, Word, Excel, and PowerPoint files from generated content.'
  },
  {
    type: 'document_formatter',
    name: 'Document Formatter',
    icon: FileEdit,
    desc: 'Reformats an uploaded document into clean headings, tables, and code blocks, optionally adding illustrative images.'
  }
];

export default function App({ toolLogs: propToolLogs, activeAgent: propActiveAgent, isStreaming: propIsStreaming }) {
  const [localActiveAgent, setLocalActiveAgent] = useState(null);
  const [localIsStreaming, setLocalIsStreaming] = useState(false);
  const [localToolLogs, setLocalToolLogs] = useState([]);

  const activeAgent = propActiveAgent !== undefined ? propActiveAgent : localActiveAgent;
  const isStreaming = propIsStreaming !== undefined ? propIsStreaming : localIsStreaming;
  const toolLogs = propToolLogs !== undefined ? propToolLogs : localToolLogs;

  const [token, setToken] = useState(localStorage.getItem('main_host_token') || '');
  const [hostUrl, setHostUrl] = useState(localStorage.getItem('main_host_url') || '');
  const [settings, setSettings] = useState(null);
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
    fetch('/api/settings', {
      headers: { 'Authorization': `Bearer ${token}` }
    })
    .then(res => res.json())
    .then(data => setSettings(data))
    .catch(err => console.error('Failed to load settings:', err));
  }, [token, hostUrl]);

  const handleConnect = async (e) => {
    e.preventDefault();
    setTestStatus('Connecting...');
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
    try {
      const res = await fetch('/api/nodes/health-check', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setNodeHealthMap(data);
      }
    } catch (err) {
      console.error('Failed to poll node health:', err);
    }
  };


  const handleScanNodes = async () => {
    setScanning(true);
    setDiscoveredNodes([]);
    try {
      const res = await fetch('/api/nodes/scan', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setDiscoveredNodes(data.nodes || []);
      } else {
        alert('Failed to scan local network.');
      }
    } catch (err) {
      alert(`Error scanning network: ${err.message}`);
    } finally {
      setScanning(false);
    }
  };



  const handleConfirmRegisterNode = async (e) => {
    if (e) e.preventDefault();
    if (!registeringNode) return;
    try {
      const res = await fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(registeringNode)
      });
      if (res.ok) {
        fetchNodes();
        setDiscoveredNodes(prev => prev.filter(n => n.ip_address !== registeringNode.ip_address));
        setRegisteringNode(null);
      } else {
        const data = await res.json();
        alert(`Failed to register discovered node: ${data.error}`);
      }
    } catch (err) {
      alert(`Error registering node: ${err.message}`);
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
    try {
      let res;
      if (runScan) {
        res = await fetch('/api/nodes/sync', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        });
      } else {
        res = await fetch('/api/nodes', { headers: { 'Authorization': `Bearer ${token}` } });
      }
      if (res.ok) {
        const data = await res.json();
        setNodes(Array.isArray(data) ? data : (data.nodes || []));
      }
    } catch (err) {
      console.error('Failed to fetch nodes:', err);
    } finally {
      if (runScan) setScanning(false);
    }
  };
  const handleAddNode = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(newNode)
      });
      if (res.ok) {
        setNewNode({ node_name: '', device_type: 'rpi-5-8gb', ip_address: '', port: 3000, bridge_secret: '', mqtt_topic: '' });
        setShowAddNode(false);
        fetchNodes();
      } else {
        const data = await res.json();
        alert(`Failed to add node: ${data.error}`);
      }
    } catch (err) { alert(`Error adding node: ${err.message}`); }
  };

  const handleDeleteNode = (id) => {
    setPopupConfirm({
      type: 'confirm',
      title: 'P.A.T.T.I.',
      message: 'Remove this field node?',
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/nodes/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (res.ok) fetchNodes();
        } catch (err) { alert(`Error deleting node: ${err.message}`); }
      }
    });
  };

  const fetchHostStatus = async () => {
    setLoadingHost(true);
    try {
      const res = await fetch('/api/host/status', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setHostStatus(data);
      }
    } catch (err) {
      console.error('Failed to fetch host status:', err);
    } finally {
      setLoadingHost(false);
    }
  };

  const handleRestartService = async () => {
    if (!restartServiceName.trim()) return;
    setRestartingService(true);
    try {
      const res = await fetch('/api/host/service/restart', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ service: restartServiceName })
      });
      const data = await res.json();
      if (res.ok) {
        alert(data.message || 'Service restart initiated.');
      } else {
        alert(`Failed to restart service: ${data.error}`);
      }
    } catch (err) {
      alert(`Error restarting service: ${err.message}`);
    } finally {
      setRestartingService(false);
    }
  };



  useEffect(() => {
    fetchDocuments();
  }, []);

  const fetchDocuments = async () => {
    try {
      const res = await fetch('/api/vault', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setDocuments(data);
      }
    } catch (err) {
      console.error('Failed to fetch documents:', err);
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

    try {
      const res = await fetch('/api/vault', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ filename: fileName, content: fileContent })
      });
      
      const data = await res.json();
      if (res.ok) {
        setFileName('');
        setFileContent('');
        fetchDocuments();
      } else {
        setUploadError(data.error || 'Failed to upload document.');
      }
    } catch (err) {
      setUploadError('Connection error while uploading.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleDelete = (id) => {
    setPopupConfirm({
      type: 'confirm',
      title: 'P.A.T.T.I.',
      message: 'Are you sure you want to delete this document? This will remove all vector chunks from RAG memory.',
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/vault/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (res.ok) {
            fetchDocuments();
          }
        } catch (err) {
          console.error('Failed to delete document:', err);
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

  const getAgentStatus = (agentType) => {
    // When streaming is explicitly finished (false), all agents return to Idle
    if (isStreaming === false) return 'Idle';

    // Heuristics based on real-time SSE thoughts
    const thought = (aiState.thought || '').toLowerCase();
    if (aiState.isBusy && thought) {
      if (agentType === 'communication_specialist' && (thought.includes('communication_specialist') || thought.includes('communication specialist') || thought.includes('translating request') || thought.includes('generating bubbly final response'))) return 'Active';
      if (agentType === 'supervisor' && (thought.includes('supervisor') || thought.includes('deciding strategy') || thought.includes('generating final response'))) return 'Active';
      if (agentType === 'weather' && (thought.includes('weather_expert') || thought.includes('weather expert') || thought.includes('weather'))) return 'Active';
      if (agentType === 'memory' && (thought.includes('memory_agent') || thought.includes('memory expert') || thought.includes('memory'))) return 'Active';
      if (agentType === 'calendar' && (thought.includes('calendar_handler') || thought.includes('calendar expert') || thought.includes('calendar'))) return 'Active';
      if (agentType === 'crawler' && (thought.includes('web_searcher') || thought.includes('search_web') || thought.includes('web searcher'))) return 'Active';
      if (agentType === 'rag' && (thought.includes('document_vault') || thought.includes('document vault') || thought.includes('rag'))) return 'Active';
      if (agentType === 'qa' && (thought.includes('qa_engineer') || thought.includes('qa engineer') || thought.includes('qa_agent'))) return 'Active';
      if (agentType === 'tool_creator' && (thought.includes('tool_creator') || thought.includes('tool creation'))) return 'Active';
      if (agentType === 'agent_creator' && (thought.includes('agent_creator') || thought.includes('agent creation'))) return 'Active';
      if (agentType === 'developer' && (thought.includes('developer_agent') || thought.includes('developer expert') || thought.includes('developer'))) return 'Active';
      if (agentType === 'system' && (thought.includes('system_specialist') || thought.includes('system expert') || thought.includes('system_agent') || thought.includes('system agent'))) return 'Active';
      if (agentType === 'node' && (thought.includes('node_agent') || thought.includes('node expert') || thought.includes('node agent'))) return 'Active';
      if (agentType === 'sports' && (thought.includes('sports_agent') || thought.includes('sports expert') || thought.includes('sports'))) return 'Active';
      if (agentType === 'news' && (thought.includes('news_agent') || thought.includes('news expert') || thought.includes('news'))) return 'Active';
      if (agentType === 'movie_tv' && (thought.includes('movie_tv_agent') || thought.includes('movie & tv') || thought.includes('movie'))) return 'Active';
      // "deep_research_pro_agent" does not contain "deep_research_agent", so these two stay
      // distinct - but the pro check must not be written as a bare "deep_research" substring.
      if (agentType === 'deep_research' && thought.includes('deep_research_agent')) return 'Active';
      if (agentType === 'deep_research_pro' && thought.includes('deep_research_pro')) return 'Active';
      if (agentType === 'course_builder' && (thought.includes('course_builder') || thought.includes('course builder'))) return 'Active';
      if (agentType === 'document_generator' && (thought.includes('document_generator') || thought.includes('document generator'))) return 'Active';
      if (agentType === 'document_formatter' && (thought.includes('document_formatter') || thought.includes('document formatter'))) return 'Active';
    }

    let currentAgent = activeAgent || (toolLogs && toolLogs.length > 0 ? (toolLogs[toolLogs.length - 1].agent || toolLogs[toolLogs.length - 1].tool) : null) || (isStreaming ? 'supervisor' : null);
    if (!currentAgent) return 'Idle';

    currentAgent = currentAgent.toLowerCase().replace('delegate_to_', '');

    if (agentType === 'communication_specialist' && (currentAgent === 'communication_specialist' || currentAgent === 'communication' || currentAgent === 'expert')) return 'Active';
    if (agentType === 'supervisor' && currentAgent === 'supervisor') return 'Active';
    if (agentType === 'memory' && (currentAgent === 'memory_agent' || currentAgent === 'memory')) return 'Active';
    if (agentType === 'calendar' && (currentAgent === 'calendar_handler' || currentAgent === 'calendar')) return 'Active';
    if (agentType === 'crawler' && (currentAgent === 'web_searcher' || currentAgent === 'search_web' || currentAgent === 'google_news')) return 'Active';
    if (agentType === 'rag' && (currentAgent === 'document_vault' || currentAgent === 'query_vault')) return 'Active';
    if (agentType === 'dev' && (currentAgent === 'coder' || currentAgent === 'read_file' || currentAgent === 'write_file' || currentAgent === 'execute_command')) return 'Active';
    if (agentType === 'tool_creator' && (currentAgent === 'tool_creator_agent' || currentAgent === 'tool_creator' || currentAgent === 'dev_pipeline')) return 'Active';
    if (agentType === 'agent_creator' && (currentAgent === 'agent_creator_agent' || currentAgent === 'agent_creator')) return 'Active';
    if (agentType === 'qa' && currentAgent === 'qa_engineer') return 'Active';
    if (agentType === 'weather' && (currentAgent === 'weather_expert' || currentAgent === 'weather')) return 'Active';
    if (agentType === 'system' && (currentAgent === 'system_specialist' || currentAgent === 'system' || currentAgent === 'host_machine')) return 'Active';
    if (agentType === 'node' && (currentAgent === 'node_agent' || currentAgent === 'network_node' || currentAgent === 'list_network_nodes' || currentAgent === 'remote_node_bridge')) return 'Active';
    if (agentType === 'developer' && (currentAgent === 'developer_agent' || currentAgent === 'developer' || currentAgent === 'dev_pipeline')) return 'Active';
    if (agentType === 'sports' && (currentAgent === 'sports_agent' || currentAgent === 'sports')) return 'Active';
    if (agentType === 'news' && (currentAgent === 'news_agent' || currentAgent === 'news')) return 'Active';
    // Matches both the delegating agent name and the underlying tool name, since currentAgent
    // falls back to the last tool log's tool when no agent was reported.
    if (agentType === 'movie_tv' && (currentAgent === 'movie_tv_agent' || currentAgent === 'movie_tv' || currentAgent === 'movie')) return 'Active';
    if (agentType === 'deep_research' && (currentAgent === 'deep_research_agent' || currentAgent === 'deep_research')) return 'Active';
    if (agentType === 'deep_research_pro' && (currentAgent === 'deep_research_pro_agent' || currentAgent === 'deep_research_pro')) return 'Active';
    if (agentType === 'course_builder' && (currentAgent === 'course_builder_agent' || currentAgent === 'course_builder')) return 'Active';
    if (agentType === 'document_generator' && (currentAgent === 'document_generator_agent' || currentAgent === 'document_generator')) return 'Active';
    if (agentType === 'document_formatter' && (currentAgent === 'document_formatter_agent' || currentAgent === 'document_formatter')) return 'Active';

    return 'Idle';
  };



  if (configMode) {
    return (
      <div className="auth-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'radial-gradient(circle at 50% 50%, #1e1b4b 0%, #0b0f19 80%)' }}>
        <div className="auth-card" style={{ width: '100%', maxWidth: '480px', padding: '32px', background: 'rgba(17, 24, 39, 0.45)', backdropFilter: 'blur(16px)', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '24px', boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.37)' }}>
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
                style={{ width: '100%', padding: '12px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', color: '#fff' }}
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
                style={{ width: '100%', padding: '12px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', color: '#fff', fontFamily: 'monospace', resize: 'vertical' }}
              />
            </div>
            {testStatus && (
              <div style={{ fontSize: '0.85rem', textAlign: 'center', color: testStatus.includes('successfully') ? 'var(--accent-green)' : '#f87171', padding: '8px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px' }}>
                {testStatus}
              </div>
            )}
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
                color: '#fff',
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
                color: '#fff',
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
                  <h3 style={{ fontSize: '1rem', margin: 0, color: '#fff' }}>AI Concurrency Queue & Pipeline Status</h3>
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
                      Active Node Execution: <strong style={{ color: '#fff' }}>{aiState.activeNode}</strong>
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
                          <h4 style={{ fontWeight: 600, fontSize: '0.9rem', color: '#fff', margin: 0 }}>{agent.name}</h4>
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
              <h3 style={{ fontSize: '1rem', marginBottom: '8px', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
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
                        <strong style={{ color: '#fff' }}>[{log.tool.toUpperCase()}]</strong> action: <code>{log.action}</code>
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
            <h3 style={{ fontSize: '1.1rem', marginBottom: '16px', color: '#fff' }}>Add Document to RAG Vault</h3>
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
            <h3 style={{ fontSize: '1.1rem', marginBottom: '16px', color: '#fff' }}>Indexed Documents</h3>
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
                        <td style={{ padding: '10px 8px', color: '#fff', fontWeight: 500 }}>{doc.filename}</td>
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
              <h3 style={{ fontSize: '1.1rem', color: '#fff', margin: 0 }}>Distributed Field Nodes</h3>
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
                  <h4 style={{ margin: 0, color: '#fff', fontSize: '0.95rem' }}>Device Setup Walkthrough Guide</h4>
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
                      <li>Upload the contents of the <code style={{ color: '#fff' }}>backend/nodes/esp32/</code> directory (containing <code style={{ color: '#fff' }}>boot.py</code> and <code style={{ color: '#fff' }}>main.py</code>) to your board.</li>
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
                        <span style={{ fontWeight: 600, color: '#fff' }}>{n.ip_address}:{n.port}</span>
                        <span style={{ margin: '0 8px', color: 'var(--text-secondary)' }}>|</span>
                        <span style={{ color: 'var(--text-secondary)' }}>Type: {n.device_type}</span>
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
                          <td style={{ padding: '10px 8px', color: '#fff', fontWeight: 500 }}>{node.node_name}</td>
                          <td style={{ padding: '10px 8px', color: 'var(--text-secondary)' }}>{node.device_type}</td>
                          <td style={{ padding: '10px 8px', color: 'var(--text-secondary)' }}>{node.ip_address}:{node.port}</td>
                          <td style={{ padding: '10px 8px' }}>
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
                  <div style={{ fontSize: '1.25rem', fontWeight: 'bold', color: '#fff', marginBottom: '8px' }}>
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
                  <div style={{ fontSize: '1.25rem', fontWeight: 'bold', color: '#fff', marginBottom: '8px' }}>
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
                  <div style={{ fontSize: '1.25rem', fontWeight: 'bold', color: '#fff', marginBottom: '8px' }}>
                    {Math.floor(hostStatus.uptime / 3600)}h {Math.floor((hostStatus.uptime % 3600) / 60)}m
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    System is running stable
                  </div>
                </div>
              </div>

              {/* Service Management Panel */}
              <div className="memory-card" style={{ padding: '20px' }}>
                <h3 style={{ fontSize: '1.1rem', marginBottom: '16px', color: '#fff' }}>Service Management</h3>
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
                <h3 style={{ fontSize: '1.1rem', marginBottom: '12px', color: '#fff' }}>Detailed Hardware Telemetry</h3>
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
              <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#fff' }}>Confirm Node Registration</h3>
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
