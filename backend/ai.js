const { callLMStudio } = require('./utils/lmstudio');
const { handleCalendarTool } = require('./tools/calendar_tool');
const { handleWebSearchTool } = require('./tools/web_search_tool');
const { handleGoogleNewsTool } = require('./tools/google_news_tool');
const { handleWeatherTool } = require('./tools/weather_tool');
const { handleMemoryTool } = require('./tools/memory_tool');
const { handleTimeTool } = require('./tools/time_tool');
const { defaultOnlineBaseUrl, resolveTarget } = require('./llm/provider_config');
const { callLocalLLMStream } = require('./llm/local_stream');
const { callGeminiStream } = require('./llm/gemini_stream');
const {
  isSendMessageCommand,
  isIpOnlyMessage,
  stripSendMessagePrefix,
  isGoogleHomeDeviceRequest,
  isAgentInfoRequest,
  isUserInfoRequest
} = require('./services/interceptors');

// Run the agent loop
// Run the agent loop (Multi-Agent Coordinator)
async function runAgentLoop({
  db,
  userId,
  chatId,
  provider,
  modelName,
  supervisorModel,
  userMessage,
  images = [],
  history,
  geminiKey, // legacy, fallback to onlineKey
  localBaseUrl,
  localApiKey,
  localApiStyle,
  onlineUrl,
  onlineKey,
  onlineProvider,
  onThought,
  onContent,
  onToolCall,
  onAgentStatus,
  isAborted,
  abortSignal,
  onCommandApprovalRequired,
  forceMemoryAgent = false
}) {
  const { AGENT_PROMPTS, runAgentTurn, runWorkerAgent } = require('./utils/agents');

  // Filter history to ensure it starts with a user message
  const firstUserIdx = (history || []).findIndex(msg => msg.role === 'user');
  let cleanedHistory = firstUserIdx !== -1 ? history.slice(firstUserIdx) : [];
  if (process.env.NODE_ENV !== 'test') {
    cleanedHistory = [];
  }
  // Kept separate from cleanedHistory (which is intentionally wiped above so
  // the Supervisor/worker loop treats each turn independently). Approval and
  // clarification continuation flows - "did the user approve this command?",
  // "what were the tasks they just approved?" - need to see the immediately
  // preceding assistant turn regardless, or they have no way to know what's
  // being responded to and will fabricate an answer instead.
  const rawRecentHistory = firstUserIdx !== -1 ? history.slice(firstUserIdx) : [];

  // --- Direct Send Message to Device Interceptor ---
  const cleanMsgForSend = userMessage.trim().toLowerCase();
  const isSendMsgPattern = isSendMessageCommand(userMessage);
  const isIpOnlyPattern = isIpOnlyMessage(userMessage);

  if (isIpOnlyPattern && chatId) {
    let lastMsgs = [];
    try {
      lastMsgs = await db.all(
        'SELECT role, content FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 5',
        [chatId]
      );
    } catch (dbErr) {
      console.error('Failed to query messages in IP interceptor:', dbErr);
    }

    const lastAssistantMsg = lastMsgs.find(m => m.role === 'assistant');
    if (lastAssistantMsg && lastAssistantMsg.content.includes('Which device would you like to send this message to?')) {
      const originalUserMsgObj = lastMsgs.find(m => m.role === 'user' && isSendMessageCommand(m.content));
      if (originalUserMsgObj) {
        const ip = userMessage.trim();
        let temp = stripSendMessagePrefix(originalUserMsgObj.content);
        temp = temp.replace(/^\s*saying/i, '');
        const text = temp.trim();

        // Check if this is the ESP32 device
        let isEsp32 = false;
        try {
          const espNode = await db.get(
            `SELECT device_type, node_name FROM network_nodes 
             WHERE (ip_address = ? OR device_type LIKE '%esp32%' OR node_name LIKE '%esp32%') AND user_id = ? LIMIT 1`,
            [ip, userId]
          );
          if (espNode) {
            isEsp32 = true;
          }
        } catch (dbErr) {
          console.error('Failed to query network nodes in ESP32 check:', dbErr);
        }
        if (!isEsp32 && (originalUserMsgObj.content.toLowerCase().includes('esp32') || originalUserMsgObj.content.toLowerCase().includes('esp-32'))) {
          isEsp32 = true;
        }

        if (isEsp32) {
          onThought(`[ESP32 Intercept] Executing send_message on ESP32 at ${ip}: "${text}"\n`);
          const { handleEsp32Tool } = require('./tools/esp32_tool');
          const toolOutput = await handleEsp32Tool(ip, null, 'send_message', { message: text });
          
          if (toolOutput.startsWith('Error:')) {
            onContent(toolOutput);
            await db.run(
              'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)',
              [chatId, 'assistant', toolOutput]
            );
          } else {
            onContent("Action Complete");
            await db.run(
              'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)',
              [chatId, 'assistant', 'Action Complete']
            );
          }
          return;
        }

        onThought(`[Google Home Intercept] Executing speak_text on device ${ip}: "${text}"\n`);
        const { handleGoogleHomeTool } = require('./tools/google_home_tool');
        const toolOutput = await handleGoogleHomeTool(db, userId, 'speak_text', { text, device_ip: ip });

        let success = false;
        try {
          const parsed = JSON.parse(toolOutput);
          if (parsed.success) {
            success = true;
          }
        } catch (e) {}

        if (success) {
          onThought("Speak text completed successfully.\n");
          onContent("Action Complete");
          await db.run(
            'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)',
            [chatId, 'assistant', 'Action Complete']
          );
        } else {
          const errMsg = `Failed to send message to speaker: ${JSON.parse(toolOutput).error || 'Unknown error'}`;
          onContent(errMsg);
          await db.run(
            'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)',
            [chatId, 'assistant', errMsg]
          );
        }
        return;
      }
    }
  }

  if (isSendMsgPattern) {
    onThought("[Send Message Intercept] Direct Send Message command detected.\n");
    const ipMatch = userMessage.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    let ip = ipMatch ? ipMatch[0] : null;

    const hasEspKeyword = cleanMsgForSend.includes('esp32') || cleanMsgForSend.includes('esp-32');
    if (!ip && hasEspKeyword) {
      try {
        const defaultEspNode = await db.get(
          "SELECT ip_address FROM network_nodes WHERE (device_type LIKE '%esp32%' OR node_name LIKE '%esp32%') AND user_id = ? LIMIT 1",
          [userId]
        );
        if (defaultEspNode) {
          ip = defaultEspNode.ip_address;
        }
      } catch (dbErr) {
        console.error('Failed to fetch default ESP32 node IP:', dbErr);
      }
    }

    if (ip) {
      let temp = userMessage;
      if (ipMatch) {
        temp = temp.replace(new RegExp(`\\b${ip}\\b`, 'g'), '');
      }
      temp = stripSendMessagePrefix(temp);
      temp = temp.replace(/^\s*saying/i, '');
      const text = temp.trim();

      // Check if this is the ESP32 device
      let isEsp32 = hasEspKeyword;
      try {
        const espNode = await db.get(
          `SELECT device_type, node_name FROM network_nodes 
           WHERE (ip_address = ? OR device_type LIKE '%esp32%' OR node_name LIKE '%esp32%') AND user_id = ? LIMIT 1`,
          [ip, userId]
        );
        if (espNode) {
          isEsp32 = true;
        }
      } catch (dbErr) {
        console.error('Failed to query network nodes in ESP32 check:', dbErr);
      }

      if (isEsp32) {
        onThought(`[ESP32 Intercept] Executing send_message on ESP32 at ${ip}: "${text}"\n`);
        const { handleEsp32Tool } = require('./tools/esp32_tool');
        const toolOutput = await handleEsp32Tool(ip, null, 'send_message', { message: text });
        
        if (toolOutput.startsWith('Error:')) {
          onContent(toolOutput);
          await db.run(
            'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)',
            [chatId, 'assistant', toolOutput]
          );
        } else {
          onContent("Action Complete");
          await db.run(
            'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)',
            [chatId, 'assistant', 'Action Complete']
          );
        }
        return;
      }

      onThought(`[Google Home Intercept] Executing speak_text on device ${ip}: "${text}"\n`);
      const { handleGoogleHomeTool } = require('./tools/google_home_tool');
      const toolOutput = await handleGoogleHomeTool(db, userId, 'speak_text', { text, device_ip: ip });

      let success = false;
      try {
        const parsed = JSON.parse(toolOutput);
        if (parsed.success) {
          success = true;
        }
      } catch (e) {}

      if (success) {
        onThought("Speak text completed successfully.\n");
        onContent("Action Complete");
        await db.run(
          'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)',
          [chatId, 'assistant', 'Action Complete']
        );
      } else {
        const errMsg = `Failed to send message to speaker: ${JSON.parse(toolOutput).error || 'Unknown error'}`;
        onContent(errMsg);
        await db.run(
          'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)',
          [chatId, 'assistant', errMsg]
        );
      }
      return;
    } else {
      onThought("[Google Home Intercept] No device IP found. Scanning local network for Google Cast devices...\n");
      let devices = [];
      try {
        const mDnsSd = require('node-dns-sd');
        const deviceList = await mDnsSd.discover({ name: '_googlecast._tcp.local', timeout: 3 });
        devices = deviceList;
      } catch (scanErr) {
        console.error('Failed to scan for speakers:', scanErr);
      }

      if (devices.length === 0) {
        const errMsg = "No Google Home/Cast devices discovered on the local network. Please specify the target device IP address manually.";
        onContent(errMsg);
        await db.run(
          'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)',
          [chatId, 'assistant', errMsg]
        );
        return;
      }

      let responseText = "Which device would you like to send this message to? Please respond with the IP address. Available devices:\n\n";
      devices.forEach((device) => {
        responseText += `Device Name: ${device.fqdn}\n`;
        responseText += `IP Address: ${device.address}\n`;
        responseText += `Model: ${device.modelName}\n`;
        responseText += `-------------------------\n`;
      });

      onContent(responseText);
      await db.run(
        'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)',
        [chatId, 'assistant', responseText]
      );
      return;
    }
  }

  // --- Google Home Direct Bypass Interceptor ---
  if (isGoogleHomeDeviceRequest(userMessage)) {
    onThought("[Google Home Intercept] Direct action/location/device command detected. Bypassing supervisor and sending directly to Google Assistant...\n");
    if (onAgentStatus) onAgentStatus({ agent: 'system_specialist', status: 'active' });

    if (onToolCall) {
      onToolCall({
        tool: 'google_home',
        action: 'send_command',
        params: { command: userMessage },
        agent: 'system_specialist'
      });
    }

    let toolOutput = '';
    try {
      const { handleGoogleHomeTool } = require('./tools/google_home_tool');
      toolOutput = await handleGoogleHomeTool(db, userId, 'send_command', { command: userMessage });
    } catch (err) {
      toolOutput = JSON.stringify({ success: false, error: err.message });
    }

    onThought(`Google Assistant execution completed. Tool output: ${toolOutput}\n`);

    let success = false;
    try {
      const parsed = JSON.parse(toolOutput);
      if (parsed.success) {
        success = true;
      }
    } catch (e) {}

    if (success) {
      onThought("Command succeeded. Programmatically responding 'Action Complete' to the user...\n");
      onContent("Action Complete");
      
      if (db && typeof db.run === 'function' && chatId) {
        await db.run(
          'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)',
          [chatId, 'assistant', 'Action Complete']
        ).catch(err => console.error('Failed to save programmatic response to database:', err));
      }
      return;
    }

    if (onAgentStatus) onAgentStatus({ agent: 'communication_specialist', status: 'active' });
    onThought('Communication Specialist generating final response for Google device execution...\n');

    const commSpecialistSystemPrompt = require('./utils/agents/communication_specialist');
    const mode2SystemPrompt = commSpecialistSystemPrompt.replace(/<!-- START MODE 1 -->[\s\S]*?<!-- END MODE 1 -->/g, '');
    const responderInstruction = `${mode2SystemPrompt}
 
### INSTRUCTIONS:
- You are operating in **MODE 2: Format Results**.
- CRITICAL: You are NOT operating in MODE 1. Do NOT translate the request, do NOT output a JSON translation, and do NOT ask for clarification or missing information. Your ONLY task is to format the gathered results below.
- If you need to reason before answering, wrap ALL of it inside <think> and </think> tags with nothing else outside those tags besides your final answer - for example: <think>your thoughts here</think>your final response here. Do NOT narrate your reasoning, rules, or operating mode outside the <think> tags - the visible response must begin immediately with the real answer to the user, never with a description of what you are about to do.
- The user requested: "${userMessage}".
- The Google Home device tool returned this execution result:
${toolOutput}
- Present a warm, bubbly, and user-friendly final response formatting this result. Format in beautiful markdown with emojis. Let the user know the command succeeded or explain the failure.`;

    const isGemini = provider === 'gemini' || (provider === 'online' && onlineProvider === 'gemini');

    if (isGemini) {
      const activeKey = provider === 'gemini' ? (geminiKey || onlineKey) : onlineKey;
      await callGeminiStream(
        activeKey,
        modelName,
        responderInstruction,
        cleanedHistory,
        userMessage,
        onContent,
        abortSignal,
        db,
        userId,
        provider
      );
    } else {
      const { targetUrl, targetKey, targetStyle } = resolveTarget({
        provider, localBaseUrl, localApiKey, localApiStyle, onlineUrl, onlineKey, onlineProvider
      });

      const messages = [
        { role: 'system', content: responderInstruction }
      ];
      for (const msg of cleanedHistory) {
        messages.push({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.content
        });
      }
      messages.push({ role: 'user', content: userMessage });

      await callLocalLLMStream(
        targetUrl,
        targetKey,
        modelName,
        messages,
        targetStyle,
        onContent,
        abortSignal,
        db,
        userId,
        provider
      );
    }
    return;
  }
  // --- End of Google Home Direct Bypass Interceptor ---

  const settings = {
    db,
    userId,
    chatId,
    provider,
    modelName,
    onlineProvider,
    onlineKey,
    geminiKey,
    localBaseUrl,
    localApiKey,
    localApiStyle,
    onlineUrl,
    images,
    forceMemoryAgent,
    onToolCall,
    onAgentStatus,
    onCommandApprovalRequired,
    abortSignal,
    workingDirectory: null // will be set dynamically below
  };

  // Core/Location memories will be fetched programmatically below.
  // Other memories should be requested by the Supervisor dynamically using delegate_to_memory_agent.
  let memoriesResult = 'No relevant memories retrieved yet. Delegate to the memory agent if you need other past user facts.';

  // Programmatic fetch of core identity and location memories to guarantee availability
  try {
    const coreRows = await db.all(
      `SELECT id, content, level FROM memories 
       WHERE user_id = ? 
         AND (expires_at IS NULL OR expires_at > datetime('now'))
         AND (
           content LIKE '%zipcode%' OR 
           content LIKE '%location%' OR 
           content LIKE '%latitude%' OR 
           content LIKE '%longitude%' OR 
           content LIKE '%address%' OR 
           content LIKE '%first name%' OR 
           content LIKE '%last name%' OR
           content LIKE '%country%'
         )`,
      [userId]
    );
    if (coreRows && coreRows.length > 0) {
      const coreMemStrings = coreRows.map(r => `- [ID ${r.id}] ${r.content} (${r.level})`);
      memoriesResult = `${memoriesResult}\n\n### Core Identity & Location Memories:\n${coreMemStrings.join('\n')}`;
    }
  } catch (err) {
    console.error('Failed to programmatically query core memories:', err);
  }

  // Fetch user profile details
  let profileContext = '';
  try {
    const profile = await db.get('SELECT name, zipcode, country, temp_unit, dob, gender, political_leaning, interests FROM users WHERE id = ?', [userId]);
    if (profile) {
      profileContext = `### User Profile Details:
- Profile Name: ${profile.name || 'Not set'}
- Profile Zipcode: ${profile.zipcode || 'Not set'}
- Profile Country: ${profile.country || 'US'}
- Profile Temp Unit: ${profile.temp_unit || 'imperial'}
- Date of Birth (DOB): ${profile.dob || 'Not set'}
- Gender: ${profile.gender || 'Not set'}
- Political Leaning: ${profile.political_leaning || 'Undecided'}
- Specific Interests: ${profile.interests || '[]'}`;
    }
  } catch (err) {
    console.error('Failed to load user profile in agent loop:', err);
  }

  let dynamicCapabilitiesContext = '';
  try {
    const caps = await db.all('SELECT agent_name, tool_name, description, parameters FROM agent_capabilities');
    if (caps && caps.length > 0) {
      dynamicCapabilitiesContext = `\n\n### Dynamically Installed Custom Tools in the Mesh:`;
      for (const cap of caps) {
        dynamicCapabilitiesContext += `\n- Agent "**${cap.agent_name}**" has tool "**${cap.tool_name}**": ${cap.description}\n  Tool parameters: ${cap.parameters}`;
      }
      dynamicCapabilitiesContext += `\n\nWhen delegating tasks to these agents, you can expect them to be able to execute these custom tools.`;
    }
  } catch (err) {
    console.error('Failed to query agent capabilities in runAgentLoop:', err);
  }

  let workingDirectory = '';
  try {
    const settingsRow = await db.get('SELECT working_directory FROM user_settings WHERE user_id = ?', [userId]);
    workingDirectory = settingsRow?.working_directory;
  } catch (err) {
    console.error('Failed to query working_directory in runAgentLoop:', err);
  }
  const path = require('path');
  const defaultWorkingDir = path.resolve(path.join(__dirname, '..'));
  if (!workingDirectory) {
    workingDirectory = defaultWorkingDir;
  }
  let activePersonalityPrompt = '';
  try {
    const personalityRow = await db.get('SELECT system_prompt FROM custom_personalities WHERE is_active = 1');
    if (personalityRow) {
      activePersonalityPrompt = `\n\n### ACTIVE CUSTOM PERSONALITY (OVERRIDE PERSONA):\n${personalityRow.system_prompt}`;
    }
  } catch (err) {
    console.error('Failed to load active custom personality in runAgentLoop:', err);
  }

  let activeSkillsPrompt = '';
  try {
    const skillRows = await db.all('SELECT name, instructions FROM custom_skills WHERE is_active = 1');
    if (skillRows && skillRows.length > 0) {
      activeSkillsPrompt = '\n\n### ACTIVE CUSTOM SKILLS:\n' + skillRows.map(r => `- Skill "${r.name}":\n${r.instructions}`).join('\n\n');
    }
  } catch (err) {
    console.error('Failed to load active custom skills in runAgentLoop:', err);
  }

  settings.workingDirectory = workingDirectory;

  // --- Personal Info Interceptor ---
  if (isAgentInfoRequest(userMessage) || isUserInfoRequest(userMessage)) {
    const isAgentInfo = isAgentInfoRequest(userMessage);
    const targetAgent = isAgentInfo ? 'system_specialist' : 'memory_agent';
    
    onThought(`[Personal Info Intercept] Personal information query detected. Routing directly to ${targetAgent}...\n`);
    if (onAgentStatus) onAgentStatus({ agent: targetAgent, status: 'active' });

    if (onToolCall) {
      onToolCall({
        tool: `delegate_to_${targetAgent}`,
        action: 'delegate',
        params: { task: userMessage },
        agent: targetAgent
      });
    }

    let toolOutput = '';
    try {
      toolOutput = await runWorkerAgent(targetAgent, settings, JSON.stringify({ task: userMessage }), db, userId, chatId);
    } catch (err) {
      toolOutput = `Error getting information: ${err.message}`;
    }

    onThought(`${isAgentInfo ? 'System Specialist' : 'Memory Agent'} execution completed. Tool output: ${toolOutput}\n`);

    let profileDetailsText = '';
    if (!isAgentInfo) {
      try {
        const profile = await db.get('SELECT name, zipcode, country, temp_unit, dob, gender, political_leaning, interests FROM users WHERE id = ?', [userId]);
        if (profile) {
          profileDetailsText = `\n\n### User Profile Details:\n- Name: ${profile.name || 'Not set'}\n- Zipcode: ${profile.zipcode || 'Not set'}\n- Country: ${profile.country || 'US'}\n- Temp Unit: ${profile.temp_unit || 'imperial'}\n- Date of Birth (DOB): ${profile.dob || 'Not set'}\n- Gender: ${profile.gender || 'Not set'}\n- Political Leaning: ${profile.political_leaning || 'Not set'}\n- Interests: ${profile.interests || '[]'}`;
        }
      } catch (profileErr) {
        console.error('Failed to get user profile details for intercept:', profileErr);
      }
    }

    if (onAgentStatus) onAgentStatus({ agent: 'communication_specialist', status: 'active' });
    onThought('Communication Specialist generating final response...\n');

    const commSpecialistSystemPrompt = require('./utils/agents/communication_specialist');
    const mode2SystemPrompt = commSpecialistSystemPrompt.replace(/<!-- START MODE 1 -->[\s\S]*?<!-- END MODE 1 -->/g, '');
    const responderInstruction = `${mode2SystemPrompt}${activePersonalityPrompt}
 
### INSTRUCTIONS:
- You are operating in **MODE 2: Format Results**.
- CRITICAL: You are NOT operating in MODE 1. Do NOT translate the request, do NOT output a JSON translation, and do NOT ask for clarification or missing information. Your ONLY task is to format the gathered results below.
- If you need to reason before answering, wrap ALL of it inside <think> and </think> tags with nothing else outside those tags besides your final answer - for example: <think>your thoughts here</think>your final response here. Do NOT narrate your reasoning, rules, or operating mode outside the <think> tags - the visible response must begin immediately with the real answer to the user, never with a description of what you are about to do.
- The user requested: "${userMessage}".
- The ${isAgentInfo ? 'System Specialist' : 'Memory Agent'} returned this context:
${toolOutput}
${profileDetailsText ? `Here is the user profile details context:\n${profileDetailsText}` : ''}
- Present a warm, bubbly, and user-friendly final response presenting this information. Format in beautiful markdown with tables, emojis, and visual progress bars where appropriate.`;

    const isGemini = provider === 'gemini' || (provider === 'online' && onlineProvider === 'gemini');

    if (isGemini) {
      const activeKey = provider === 'gemini' ? (geminiKey || onlineKey) : onlineKey;
      await callGeminiStream(
        activeKey,
        modelName,
        responderInstruction,
        [],
        userMessage,
        onContent,
        abortSignal,
        db,
        userId,
        provider
      );
    } else {
      const { targetUrl, targetKey, targetStyle } = resolveTarget({
        provider, localBaseUrl, localApiKey, localApiStyle, onlineUrl, onlineKey, onlineProvider
      });

      let userContent = userMessage;
      if (images && images.length > 0 && targetStyle !== 'anthropic' && targetStyle !== 'local-gemini') {
        userContent = [{ type: 'text', text: userMessage }];
        for (const img of images) {
          userContent.push({ type: 'image_url', image_url: { url: img } });
        }
      }

      const messages = [
        { role: 'system', content: responderInstruction },
        { role: 'user', content: userContent }
      ];

      await callLocalLLMStream(
        targetUrl,
        targetKey,
        modelName,
        messages,
        targetStyle,
        onContent,
        abortSignal,
        db,
        userId,
        provider
      );
    }
    return;
  }

  const workspaceContext = `\n\n### Workspace System Directories:
- Root Working Directory: ${workingDirectory}
- Built-in Agents File: ${path.join(workingDirectory, 'backend/utils/agents.js')}
- Built-in Tools Directory: ${path.join(workingDirectory, 'backend/tools/')}
- Dynamic Tools Registry: ${path.join(workingDirectory, 'tool_registry/tools/')}`;

  let feedbackContext = '';
  try {
    const { getInjectedContext } = require('./services/feedback_learning');
    feedbackContext = await getInjectedContext(userMessage);
  } catch (fbErr) {
    console.error('Failed to get feedback context in runAgentLoop:', fbErr);
  }

  let systemPrompt = AGENT_PROMPTS.supervisor + feedbackContext + activeSkillsPrompt + `\n\n${profileContext}\n\n### User Memories Context:\n${memoriesResult}${dynamicCapabilitiesContext}${workspaceContext}`;
  let currentHistory = [...cleanedHistory];
  let accumulatedToolOutputs = [];
  let toolCallsCount = 0;
  const maxToolCalls = 10;
  const seenToolCalls = new Set();

  // Intercept chat-based approvals for code execution
  const lastAssistantMsg = [...rawRecentHistory].reverse().find(msg => msg.role === 'assistant');
  let customSystemPromptContext = '';

  if (lastAssistantMsg) {
    if (lastAssistantMsg.content.includes('[Supervisor Approval Required]')) {
      // Parse agent, command, file and content
      let parsedAgent = null;
      let parsedCommand = null;
      let parsedFile = null;
      let parsedContent = null;

      const agentIndex = lastAssistantMsg.content.indexOf('Agent:');
      const commandIndex = lastAssistantMsg.content.indexOf('Command:');
      const fileIndex = lastAssistantMsg.content.indexOf('File:');
      const contentIndex = lastAssistantMsg.content.indexOf('Content:');
      const qaIndex = lastAssistantMsg.content.indexOf('QA Analysis:');
      const errorIndex = lastAssistantMsg.content.indexOf('Error:');

      if (agentIndex !== -1) {
        if (commandIndex !== -1) {
          const endCommandIndex = qaIndex !== -1 ? qaIndex : (errorIndex !== -1 ? errorIndex : lastAssistantMsg.content.indexOf('This command could cause'));
          if (endCommandIndex !== -1 && endCommandIndex > commandIndex) {
            parsedAgent = lastAssistantMsg.content.substring(agentIndex + 6, commandIndex).trim();
            parsedCommand = lastAssistantMsg.content.substring(commandIndex + 8, endCommandIndex).trim();
          }
        } else if (fileIndex !== -1) {
          const endFileIndex = contentIndex !== -1 ? contentIndex : (qaIndex !== -1 ? qaIndex : lastAssistantMsg.content.indexOf('This file write could cause'));
          if (endFileIndex !== -1 && endFileIndex > fileIndex) {
            parsedAgent = lastAssistantMsg.content.substring(agentIndex + 6, fileIndex).trim();
            parsedFile = lastAssistantMsg.content.substring(fileIndex + 5, endFileIndex).trim();
            if (contentIndex !== -1) {
              const endContentIndex = qaIndex !== -1 ? qaIndex : (errorIndex !== -1 ? errorIndex : lastAssistantMsg.content.indexOf('This file write could cause'));
              parsedContent = lastAssistantMsg.content.substring(contentIndex + 8, endContentIndex).trim();
            }
          }
        }
      }

      if (parsedAgent && (parsedCommand || parsedFile)) {
        const reply = userMessage.trim().toLowerCase();
        if (reply.startsWith('1') || reply === 'yes' || reply.includes('approve') || reply.includes('go ahead') || reply.includes('ok')) {
          const { handleCoderTool } = require('./tools/coder_tools');
          let toolOutput = '';

          if (parsedCommand) {
            onThought(`User approved the command: "${parsedCommand}". Executing...\n`);
            try {
              toolOutput = await handleCoderTool('execute_command', { command: parsedCommand }, {
                userId,
                settings,
                skipVerification: true,
                agentName: parsedAgent
              });
            } catch (err) {
              toolOutput = `Error running command: ${err.message}`;
            }
          } else if (parsedFile) {
            onThought(`User approved writing to file: "${parsedFile}". Executing...\n`);
            try {
              toolOutput = await handleCoderTool('write_file', { filePath: parsedFile, content: parsedContent }, {
                userId,
                settings,
                skipVerification: true,
                agentName: parsedAgent
              });
            } catch (err) {
              toolOutput = `Error writing file: ${err.message}`;
            }
          }

          accumulatedToolOutputs.push({
            tool: `delegate_to_${parsedAgent}`,
            output: toolOutput
          });

          currentHistory.push({
            role: 'assistant',
            content: lastAssistantMsg.content
          });
          currentHistory.push({
            role: 'user',
            content: userMessage
          });
          currentHistory.push({
            role: 'user',
            content: parsedCommand ? `[Output for execute_command]:\n${toolOutput}` : `[Output for write_file]:\n${toolOutput}`
          });

          toolCallsCount = 1; // Mark that we did 1 tool call turn already
        } else if (reply.startsWith('2') || reply === 'no' || reply.includes('reject') || reply.includes('refuse')) {
          onThought("User rejected running the command/file write. Asking why...\n");
          const promptMsg = "Why did you choose not to go forward with this code?";
          onContent(promptMsg);

          if (db && typeof db.run === 'function' && chatId) {
            await db.run(
              'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)',
              [chatId, 'assistant', promptMsg]
            ).catch(err => console.error('Failed to save rejection prompt to database:', err));
          }
          return;
        }
      }
    } else if (lastAssistantMsg.content.includes('Why did you choose not to go forward with this code?')) {
      // The user is responding with their reason for rejection.
      // Find the original proposal in history.
      const originalProposal = [...rawRecentHistory].reverse().find(msg => msg.role === 'assistant' && msg.content.includes('[Supervisor Approval Required]'));
      let rejectedCommandInfo = '';
      if (originalProposal) {
        let parsedCommand = null;
        let parsedFile = null;
        const commandIndex = originalProposal.content.indexOf('Command:');
        const fileIndex = originalProposal.content.indexOf('File:');
        const qaIndex = originalProposal.content.indexOf('QA Analysis:');
        const errorIndex = originalProposal.content.indexOf('Error:');

        if (commandIndex !== -1) {
          const endCommandIndex = qaIndex !== -1 ? qaIndex : (errorIndex !== -1 ? errorIndex : originalProposal.content.indexOf('This command could cause'));
          if (endCommandIndex !== -1 && endCommandIndex > commandIndex) {
            parsedCommand = originalProposal.content.substring(commandIndex + 8, endCommandIndex).trim();
            rejectedCommandInfo = `The user rejected running this command: "${parsedCommand}".\n`;
          }
        } else if (fileIndex !== -1) {
          const contentIndex = originalProposal.content.indexOf('Content:');
          const endFileIndex = contentIndex !== -1 ? contentIndex : (qaIndex !== -1 ? qaIndex : originalProposal.content.indexOf('This file write could cause'));
          if (endFileIndex !== -1 && endFileIndex > fileIndex) {
            parsedFile = originalProposal.content.substring(fileIndex + 5, endFileIndex).trim();
            rejectedCommandInfo = `The user rejected writing to this file: "${parsedFile}".\n`;
          }
        }
      }

      customSystemPromptContext = `\n\n### User Code Rejection Context:
${rejectedCommandInfo}The user chose not to run the code/command and provided this reason: "${userMessage}".
Please evaluate their reason. If changes to the code or command are required based on their feedback, make those changes (e.g. call the coder/developer agent to edit the files, or adjust the command) and ask for approval again (which will undergo QA and Supervisor review again).
If no changes are required and you can proceed without executing the code, then continue.`;
    }
  }

  if (customSystemPromptContext) {
    systemPrompt += customSystemPromptContext;
  }

  let projectIdea = userMessage;
  if (process.env.NODE_ENV !== 'test') {
    try {
      onThought("Communication Specialist translating request to Project Idea...\n");
      if (onAgentStatus) onAgentStatus({ agent: 'communication_specialist', status: 'active' });
      const commSpecialistSystemPrompt = require('./utils/agents/communication_specialist');
      const mode1SystemPrompt = commSpecialistSystemPrompt.replace(/<!-- START MODE 2 -->[\s\S]*?<!-- END MODE 2 -->/g, '') + activePersonalityPrompt;
      const commSpecialistSettings = {
        ...settings,
        modelName: supervisorModel || settings.modelName
      };
      let commTurn = await runAgentTurn(
        'communication_specialist',
        mode1SystemPrompt,
        commSpecialistSettings,
        `Translate this user request: "${userMessage}"\nMode: Create Project Idea`,
        rawRecentHistory
      );

      // Handle tool call if requested by the Communication Specialist
      if (commTurn && commTurn.tool && commTurn.tool !== 'none') {
        onThought(`Communication Specialist invoked tool: "${commTurn.tool}" with action "${commTurn.action}"...\n`);
        let toolOutput = '';
        if (commTurn.tool === 'time') {
          try {
            const { handleTimeTool } = require('./tools/time_tool');
            toolOutput = await handleTimeTool(db, userId, commTurn.action, commTurn.params);
          } catch (timeErr) {
            toolOutput = `Error executing time tool: ${timeErr.message}`;
          }
        } else {
          toolOutput = `Error: Unsupported tool "${commTurn.tool}" for Communication Specialist.`;
        }
        onThought(`Tool output: ${toolOutput}\n`);

        // Run second turn with tool results
        commTurn = await runAgentTurn(
          'communication_specialist',
          mode1SystemPrompt,
          commSpecialistSettings,
          `Translate this user request: "${userMessage}"\nMode: Create Project Idea\nTool execution result for "${commTurn.tool}" ("${commTurn.action}"):\n${toolOutput}`,
          []
        );
      }

      if (commTurn && commTurn.params) {
        if (commTurn.params.requested_action === 'clarification_needed') {
          // Deterministic guard: read-only info lookups (sports, weather, news)
          // never need HITL approval, but the local model sometimes asks anyway
          // when the request has multiple parts. Override and route directly -
          // unless the message contains mutation verbs, in which case the HITL
          // confirmation must stand (never bypass approval for write actions).
          const mentionsMutation = /\b(delete|remove|create|add|cancel|update|modify|run|execute|write|install|restart|schedule a|set up)\b/i.test(userMessage);
          const readOnlyLookup = !mentionsMutation && /\b(score|scores|game|games|schedule|watch|sports|weather|forecast|news|headlines)\b/i.test(userMessage);
          if (readOnlyLookup) {
            onThought('[System] Clarification skipped: read-only lookup detected. Routing directly to Supervisor.\n');
            projectIdea = JSON.stringify({
              requested_action: /\b(score|scores|game|games|schedule|watch|team|teams)\b/i.test(userMessage) ? 'sports'
                : (/\b(weather|forecast|temperature)\b/i.test(userMessage) ? 'weather' : 'news'),
              data_needed: userMessage
            });
          } else {
            const choicesPayload = `INPUT_REQUIRED_CHOICES:${JSON.stringify({
              question: commTurn.params.question || "Need clarification",
              choices: commTurn.params.choices || ["Yes", "No"]
            })}`;
            onContent(choicesPayload);
            return;
          }
        } else {
          projectIdea = JSON.stringify(commTurn.params);
        }
      } else if (commTurn && commTurn.thought) {
        projectIdea = commTurn.thought;
      } else if (commTurn && typeof commTurn === 'string') {
        projectIdea = commTurn;
      }
      onThought(`Communication Specialist Project Idea: ${projectIdea}\n`);
    } catch (err) {
      console.error('Communication Specialist project idea translation failed:', err.message);
    }
  }

  while (toolCallsCount < maxToolCalls) {
    if (abortSignal?.aborted || (isAborted && isAborted())) {
      onThought("Stream aborted by user.\n");
      break;
    }
    let decision = null;
    if (onAgentStatus) onAgentStatus({ agent: 'supervisor', status: 'active' });
    onThought(`Supervisor deciding strategy (turn ${toolCallsCount + 1}/${maxToolCalls})...\n`);

    try {
      const supervisorSettings = {
        ...settings,
        modelName: supervisorModel || settings.modelName
      };
      let supervisorInput;
      if (process.env.NODE_ENV === 'test') {
        supervisorInput = userMessage;
      } else if (toolCallsCount === 0) {
        supervisorInput = `Project Idea:\n${projectIdea}`;
      } else {
        // Turns after the first repeat the same Project Idea as turn 1, which local models
        // sometimes misread as a brand-new, data-less request - state explicitly that results
        // already exist (in History Context below) so the model reasons over them instead of
        // treating this turn as a fresh, unanswerable request.
        supervisorInput = `Project Idea:\n${projectIdea}\n\nYou have already gathered ${accumulatedToolOutputs.length} tool/agent result(s) this conversation - see "History Context" below for exactly what was returned. Review them: if they already answer the request, set "tool" to "none" now so the response can be formatted. Only call another tool if something genuinely necessary is still missing.`;
      }
      decision = await runAgentTurn('supervisor', systemPrompt, supervisorSettings, supervisorInput, currentHistory);
    } catch (err) {
      console.error('Supervisor turn failed, using fallback "none":', err);
      decision = {
        thought: `Supervisor error: ${err.message}. Proceeding directly with default responder.`,
        tool: 'none',
        params: {}
      };
    }

    onThought(`Supervisor Thought: ${decision.thought}\n`);

    if (!decision.tool || decision.tool === 'none') {
      break;
    }

    // Normalize direct agent calls to delegation format
    let toolName = decision.tool;
    const agentNames = [
      'web_searcher',
      'calendar_handler',
      'coder',
      'qa_engineer',
      'weather_expert',
      'system_specialist',
      'memory_agent',
      'document_vault',
      'developer_agent',
      'node_agent',
      'tool_creator_agent',
      'agent_creator_agent'
    ];

    if (agentNames.includes(toolName)) {
      toolName = `delegate_to_${toolName}`;
    } else if (toolName === 'system_info' || toolName === 'system' || toolName === 'system_specialist') {
      toolName = 'delegate_to_system_specialist';
    } else if (toolName === 'developer' || toolName === 'delegate_to_developer') {
      toolName = 'delegate_to_developer_agent';
    } else if (toolName === 'tool_creator' || toolName === 'delegate_to_tool_creator') {
      toolName = 'delegate_to_tool_creator_agent';
    } else if (toolName === 'agent_creator' || toolName === 'delegate_to_agent_creator') {
      toolName = 'delegate_to_agent_creator_agent';
    }
    decision.tool = toolName;

    // Loop detection protection
    const isDelegation = decision.tool.startsWith('delegate_to_');
    const toolCallSignature = isDelegation
      ? decision.tool
      : `${decision.tool}:${decision.action || 'default'}:${JSON.stringify(decision.params || {})}`;
    if (seenToolCalls.has(toolCallSignature)) {
      onThought(`[Loop Detector] Detected duplicate delegation or tool call in coordinator loop: "${toolCallSignature}". Force terminating loop to prevent runaway execution.\n`);
      break;
    }
    seenToolCalls.add(toolCallSignature);

    onThought(`Supervisor invoking tool/delegate: "${decision.tool}" with action "${decision.action}"...\n`);
    onToolCall({ tool: decision.tool, action: decision.action || 'delegate', params: decision.params });

    let toolOutput = '';

    // Check for delegation
    if (decision.tool.startsWith('delegate_to_') && decision.tool !== 'delegate_to_remote_node') {
      const agentName = decision.tool.replace('delegate_to_', '');

      if (agentName === 'ask_communication_expert') {
        const commSpecialistSystemPrompt = require('./utils/agents/communication_specialist');
        const mode1SystemPrompt = commSpecialistSystemPrompt.replace(/<!-- START MODE 2 -->[\s\S]*?<!-- END MODE 2 -->/g, '');
        const commSpecialistSettings = {
          ...settings,
          modelName: supervisorModel || settings.modelName
        };
        onThought("Supervisor asking Communication Specialist for clarification...\n");
        if (onAgentStatus) onAgentStatus({ agent: 'communication_specialist', status: 'active' });

        let queryTask = userMessage;
        if (decision.params && typeof decision.params === 'object') {
          queryTask = decision.params.query || decision.params.task || userMessage;
        } else if (typeof decision.params === 'string') {
          queryTask = decision.params;
        }

        const commTurn = await runAgentTurn(
          'communication_specialist',
          mode1SystemPrompt,
          commSpecialistSettings,
          `Clarify this missing information: "${queryTask}"\nMode: Create Project Idea`,
          []
        );

        if (commTurn && commTurn.params && commTurn.params.requested_action === 'clarification_needed') {
          const choicesPayload = `INPUT_REQUIRED_CHOICES:${JSON.stringify({
            question: commTurn.params.question || "Need clarification",
            choices: commTurn.params.choices || ["Yes", "No"]
          })}`;
          onContent(choicesPayload);
          return;
        } else {
          const fallbackPayload = `INPUT_REQUIRED_CHOICES:${JSON.stringify({
            question: queryTask,
            choices: ["Provide detail", "Cancel"]
          })}`;
          onContent(fallbackPayload);
          return;
        }
      }

      let subTaskObj = {};
      if (decision.params && typeof decision.params === 'object') {
        subTaskObj = { ...decision.params };
      } else if (typeof decision.params === 'string') {
        subTaskObj = { task: decision.params };
      } else {
        subTaskObj = { task: userMessage };
      }

      // Merge action parameter if it exists on the top-level decision
      if (decision.action && !subTaskObj.action) {
        subTaskObj.action = decision.action;
      }

      // Ensure there's a task or query defined
      if (!subTaskObj.task && !subTaskObj.query) {
        subTaskObj.task = userMessage;
      }

      const subTask = JSON.stringify(subTaskObj);

      onThought(`Delegating sub-task to Agent "${agentName}": "${subTask}"...\n`);
      if (onAgentStatus) onAgentStatus({ agent: agentName, status: 'active' });
      try {
        toolOutput = await runWorkerAgent(agentName, settings, subTask, db, userId, chatId);
      } catch (err) {
        try {
          const { broadcastAlert } = require('./routes/alerts');
          broadcastAlert({
            type: 'error',
            message: `Agent "${agentName}" encountered an execution error: ${err.message}`,
            timestamp: new Date().toISOString()
          });
        } catch (alertErr) { }

        if (agentName === 'system_specialist') {
          toolOutput = JSON.stringify({
            status: "error",
            summary: "Failed to execute task",
            data: {
              error: err.message
            }
          });
        } else {
          toolOutput = `Agent "${agentName}" delegation failed: ${err.message}`;
        }
      }
      if (onAgentStatus) onAgentStatus({ agent: 'supervisor', status: 'active' });

      // Programmatic short-circuit on delegation failure to prevent hallucinations
      if (toolOutput && typeof toolOutput === 'string') {
        if (toolOutput.includes('"status":"error"') || toolOutput.includes('delegation failed')) {
          onThought(`Sub-agent delegation failure detected. Short-circuiting loop to prevent hallucinations.\n`);
          let errMsg = toolOutput;
          try {
            const parsed = JSON.parse(toolOutput);
            if (parsed.data?.error) errMsg = parsed.data.error;
            else if (parsed.summary) errMsg = parsed.summary;
          } catch (e) { }

          try {
            const { broadcastAlert } = require('./routes/alerts');
            broadcastAlert({
              type: 'error',
              message: `Agentic execution failure in "${agentName}": ${errMsg}`,
              timestamp: new Date().toISOString()
            });
          } catch (alertErr) { }

          onContent(`Error: The system specialist failed to execute the task. Details: ${errMsg}`);
          return;
        }
      }

      // Check if sub-agent output requires user input/permission
      if (toolOutput && typeof toolOutput === 'string' && toolOutput.includes('INPUT_REQUIRED_FROM_USER')) {
        const cleanedOutput = toolOutput.replace('INPUT_REQUIRED_FROM_USER:', '').trim();
        onContent(cleanedOutput);
        return; // Return immediately to pause the coordinator loop
      }
    } else {
      // Execute direct fallback tools of supervisor
      if (decision.tool === 'calendar') {
        toolOutput = await handleCalendarTool(db, userId, decision.action, decision.params);
      } else if (decision.tool === 'search_web') {
        const q = decision.params?.query || userMessage;
        toolOutput = await handleWebSearchTool(db, userId, q);
      } else if (decision.tool === 'google_news') {
        toolOutput = await handleGoogleNewsTool(decision.params?.query);
      } else if (decision.tool === 'weather') {
        toolOutput = await handleWeatherTool(db, userId, decision.action, decision.params);
      } else if (decision.tool === 'host_machine') {
        const { handleHostMachineTool } = require('./tools/host_machine_tool');
        toolOutput = await handleHostMachineTool(decision.action, decision.params);
      } else if (decision.tool === 'time') {
        const { handleTimeTool } = require('./tools/time_tool');
        toolOutput = await handleTimeTool(db, userId, decision.action, decision.params);
      } else if (decision.tool === 'tts') {
        const { handleTtsTool } = require('./tools/tts_tool');
        toolOutput = await handleTtsTool(db, userId, decision.action, decision.params);
      } else if (decision.tool === 'google_home') {
        const { handleGoogleHomeTool } = require('./tools/google_home_tool');
        toolOutput = await handleGoogleHomeTool(db, userId, decision.action, decision.params);
      } else if (decision.tool === 'esp32_tool') {
        const { handleEsp32Tool } = require('./tools/esp32_tool');
        toolOutput = await handleEsp32Tool(
          decision.params?.ipAddress || decision.params?.ip_address,
          decision.params?.port || null,
          decision.action,
          decision.params
        );
      } else if (decision.tool === 'delegate_to_remote_node') {
        try {
          const { nodeId, command } = decision.params;
          const fetch = require('node-fetch'); // Ensure fetch is available
          const bridgeRes = await fetch(`http://localhost:${process.env.PORT || 3000}/api/bridge/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.token}` },
            body: JSON.stringify({ nodeId, command })
          });
          const data = await bridgeRes.json();
          toolOutput = JSON.stringify(data);
        } catch (err) {
          toolOutput = `Remote node execution error: ${err.message}`;
        }
      } else if (decision.tool === 'network_scanner') {
        const { handleNetworkScanner } = require('./tools/network_scanner');
        toolOutput = await handleNetworkScanner(decision.action, decision.params);
      } else {
        toolOutput = `Error: Tool "${decision.tool}" is unrecognized by Supervisor.`;
      }
    }

    let safeResult = typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput);
    const limit = decision.tool === 'delegate_to_news_agent' ? 25000 : 3000;
    if (safeResult.length > limit) {
      safeResult = safeResult.substring(0, limit) + "\n... [TRUNCATED: Response too large for context]";
    }
    toolOutput = safeResult;

    onThought(`Response received from tool/agent (length: ${toolOutput.length})\n`);

    accumulatedToolOutputs.push({
      tool: decision.tool,
      output: toolOutput
    });

    currentHistory.push({
      role: 'assistant',
      content: `Thought: ${decision.thought}\nCalling tool: ${decision.tool} with parameters: ${JSON.stringify(decision.params)}`
    });
    currentHistory.push({
      role: 'user',
      content: `[Output for ${decision.tool}]:\n${toolOutput}`
    });

    toolCallsCount++;
  }

  // Now, call the Responder Agent to output the streamed response
  if (abortSignal?.aborted || (isAborted && isAborted())) {
    onThought("Stream aborted by user.\n");
    return;
  }
  let responderInstruction = '';
  if (process.env.NODE_ENV === 'test') {
    if (onAgentStatus) onAgentStatus({ agent: 'supervisor', status: 'active' });
    onThought('Supervisor generating final response...\n');
    responderInstruction = `You are a helpful, smart AI Personal Assistant Supervisor.
If you need to reason before answering, wrap ALL of it inside <think> and </think> tags with nothing else outside those tags besides your final answer - for example: <think>your thoughts here</think>your final response here. Do NOT narrate your reasoning, rules, or operating mode outside the <think> tags - the visible response must begin immediately with the real answer to the user, never with a description of what you are about to do.
CRITICAL: Avoid going in loops or repeating analysis. Keep any thinking process concise and make a clear decision quickly, then close the </think> tag and output your final response immediately.
Here is the user request: "${userMessage}".
${accumulatedToolOutputs.length > 0 ? `We delegated tasks/queried tools to gather context. Here are the report/action results:\n${accumulatedToolOutputs.map(t => `--- [Source: ${t.tool}] ---\n${t.output}`).join('\n\n')}` : ''}
Formulate a rich, helpful final response. Format in beautiful markdown. Fully support emojis.
Make sure to answer the user query directly and clearly.`;
  } else {
    if (onAgentStatus) onAgentStatus({ agent: 'communication_specialist', status: 'active' });
    onThought('Communication Specialist generating bubbly final response...\n');
    const commSpecialistSystemPrompt = require('./utils/agents/communication_specialist');
    const mode2SystemPrompt = commSpecialistSystemPrompt.replace(/<!-- START MODE 1 -->[\s\S]*?<!-- END MODE 1 -->/g, '');
    let currentTimeContext = '';
    try {
      const { handleTimeTool } = require('./tools/time_tool');
      currentTimeContext = await handleTimeTool(db, userId, 'current_time', {});
    } catch (timeErr) {
      console.error('Failed to get current time for responder instruction:', timeErr);
    }
    responderInstruction = `${mode2SystemPrompt}${activePersonalityPrompt}
 
### INSTRUCTIONS:
- You are operating in **MODE 2: Format Results**.
- CRITICAL: You are NOT operating in MODE 1. Do NOT translate the request, do NOT output a JSON translation, and do NOT ask for clarification or missing information. Your ONLY task is to format the gathered results below.
- If you need to reason before answering, wrap ALL of it inside <think> and </think> tags with nothing else outside those tags besides your final answer - for example: <think>your thoughts here</think>your final response here. Do NOT narrate your reasoning, rules, or operating mode outside the <think> tags - the visible response must begin immediately with the real answer to the user, never with a description of what you are about to do.
- Present a warm, bubbly, and welcoming final response containing ALL details of the gathered report results below.
- CRITICAL: The gathered report/action results below (if any) are ALL the information you have - there is no further data coming. Never describe an action as "in progress", "being processed", "underway", or "will be provided shortly". If no results are present below and the request needed data you don't have, say so plainly instead of fabricating a status update.
- Here is the user request: "${userMessage}".
- Project Idea that was executed: "${projectIdea}"
${currentTimeContext ? `\n### Current System Time Context:\n${currentTimeContext}\n` : ''}
${accumulatedToolOutputs.length > 0 ? `Here are the gathered report/action results:\n${accumulatedToolOutputs.map(t => `--- [Source: ${t.tool}] ---\n${t.output}`).join('\n\n')}` : 'No tool/agent results were gathered for this request.'}`;
  }

  const isGemini = provider === 'gemini' || (provider === 'online' && onlineProvider === 'gemini');

  if (isGemini) {
    const activeKey = provider === 'gemini' ? (geminiKey || onlineKey) : onlineKey;
    await callGeminiStream(
      activeKey,
      modelName,
      responderInstruction,
      cleanedHistory,
      userMessage,
      onContent,
      abortSignal,
      db,
      userId,
      provider
    );
  } else {
    const { targetUrl, targetKey, targetStyle } = resolveTarget({
      provider, localBaseUrl, localApiKey, localApiStyle, onlineUrl, onlineKey, onlineProvider
    });

    const messages = [
      { role: 'system', content: responderInstruction }
    ];
    for (const msg of cleanedHistory) {
      messages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content
      });
    }

    let userContent = userMessage;
    if (images && images.length > 0 && targetStyle !== 'anthropic' && targetStyle !== 'local-gemini') {
      userContent = [{ type: 'text', text: userMessage }];
      for (const img of images) {
        userContent.push({ type: 'image_url', image_url: { url: img } });
      }
    }
    messages.push({ role: 'user', content: userContent });

    await callLocalLLMStream(
      targetUrl,
      targetKey,
      modelName,
      messages,
      targetStyle,
      onContent,
      abortSignal,
      db,
      userId,
      provider
    );
  }
}

async function generateGreetingAndSave(db, userId, chatId) {
  let userName = '';
  try {
    const user = await db.get('SELECT name FROM users WHERE id = ?', [userId]);
    userName = user?.name || '';
  } catch (err) {
    console.error('Failed to fetch user name for greeting:', err);
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const greeting = `Hello${userName ? ' ' + userName : ''}! Today is ${dateStr} ${timeStr}. What can I do for you next?`;

  try {
    await db.run(
      'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)',
      [chatId, 'assistant', greeting]
    );
  } catch (dbErr) {
    console.error('Failed to save generated greeting to database:', dbErr);
  }
}

/**
 * Sanitizes incoming text by stripping off any embedded 
 * <think> reasoning tokens before processing JSON payloads.
 */
function cleanAgentResponse(rawText) {
  if (!rawText) return '';
  let cleanText = rawText.trim();

  // Safely discard the internal trace block if it bypasses the parser
  if (cleanText.includes('</think>')) {
    const parts = cleanText.split('</think>');
    cleanText = parts[parts.length - 1].trim();
  }

  return cleanText;
}

// Example integration within your multi-agent execution thread:
async function processAgentTurn(promptContext) {
  // 1. Dispatch formatted prompt context to the local server array
  const rawLLMOutput = await callLMStudio(promptContext);

  // 2. Clean out any loose markdown logic or lingering thought blocks
  const sanitizedJSON = cleanAgentResponse(rawLLMOutput);

  try {
    // 3. Hand the raw action instructions directly to tool registries safely
    return JSON.parse(sanitizedJSON);
  } catch (parseError) {
    console.error("Failed to parse clean model output into structural JSON object:", parseError);
    console.error("Attempted Content String was:", sanitizedJSON);
    throw new Error("Model emitted an invalid tool orchestration structure.");
  }
}

module.exports = {
  runAgentLoop,
  handleGoogleNewsTool,
  generateGreetingAndSave,
  cleanAgentResponse,
  processAgentTurn
};
