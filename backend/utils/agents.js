const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { llmFetchSignal } = require('./fetchTimeout');
const { resolveTarget, resolveEndpoint, buildHeaders, buildBody, extractResponseText } = require('../llm/provider_config');

const AGENT_PROMPTS = new Proxy({}, {
  get(target, prop) {
    if (typeof prop === 'symbol') return target[prop];
    let agentName = prop;
    if (agentName === 'coder') {
      agentName = 'developer_agent';
    }
    try {
      const basePrompt = require(`./agents/${agentName}`);
      if (typeof basePrompt === 'string') {
        const { getCustomizationsPrompt } = require('./customizations_loader');
        return getCustomizationsPrompt(agentName, basePrompt);
      }
      return basePrompt;
    } catch (err) {
      logger.warn(`Warning: Prompt file for agent "${agentName}" not found: ${err.message}`);
      return undefined;
    }
  },
  has(target, prop) {
    if (typeof prop === 'symbol') return false;
    let agentName = prop;
    if (agentName === 'coder') {
      agentName = 'developer_agent';
    }
    return fs.existsSync(path.join(__dirname, 'agents', `${agentName}.js`));
  },
  ownKeys(target) {
    try {
      const files = fs.readdirSync(path.join(__dirname, 'agents'));
      return files
        .filter(file => file.endsWith('.js'))
        .map(file => file.slice(0, -3));
    } catch (err) {
      return [];
    }
  },
  getOwnPropertyDescriptor(target, prop) {
    return {
      enumerable: true,
      configurable: true
    };
  }
});

// Reusable function to execute a single LLM decision turn
async function runAgentTurn(agentName, systemPrompt, settings, userMessage, history, retriesLeft = 1) {
  const {
    provider,
    modelName,
    onlineProvider,
    onlineKey,
    geminiKey,
    localBaseUrl,
    localApiKey,
    localApiStyle,
    onlineUrl,
    db,
    userId
  } = settings;

  const isGemini = provider === 'gemini' || (provider === 'online' && onlineProvider === 'gemini');
  let respText = '';

  const instructions = `You MUST output your decision in this exact JSON format:
{
  "thought": "your step-by-step reasoning",
  "tool": "tool_name_or_none",
  "action": "action_name_if_any",
  "params": {}
}

If you are done, set "tool" to "none". Do NOT output anything else but valid JSON.

User Message: ${userMessage}
History Context: ${JSON.stringify(history.slice(-5))}`;

  const fullPrompt = `${systemPrompt}\n\n${instructions}`;

  if (isGemini) {
    const activeKey = provider === 'gemini' ? (geminiKey || onlineKey) : onlineKey;
    if (!activeKey) throw new Error('Gemini API key is not configured.');
    const genAI = new GoogleGenerativeAI(activeKey);
    const model = genAI.getGenerativeModel({
      model: modelName || 'gemini-2.0-flash',
      generationConfig: { responseMimeType: 'application/json' }
    });
    const result = await model.generateContent(fullPrompt, { signal: settings.abortSignal });
    respText = result.response.text();

    // Log token usage
    let tokenCount = 0;
    if (result.response.usageMetadata && result.response.usageMetadata.totalTokenCount) {
      tokenCount = result.response.usageMetadata.totalTokenCount;
    } else {
      tokenCount = Math.ceil((fullPrompt.length + respText.length) / 4);
    }
    if (db && typeof db.run === 'function' && userId) {
      const providerType = provider === 'local' ? 'local' : 'online';
      db.run(
        'INSERT INTO token_usage (user_id, model_name, provider_type, token_count) VALUES (?, ?, ?, ?)',
        [userId, modelName || 'gemini-2.0-flash', providerType, tokenCount]
      ).catch(err => console.error('Failed to log Gemini agent turn tokens:', err));
    }
  } else {
    const { targetUrl, targetKey, targetStyle } = resolveTarget(settings);
    const headers = buildHeaders(targetKey, targetStyle);
    const endpoint = resolveEndpoint(targetUrl, targetStyle);
    const body = buildBody({
      targetStyle,
      provider,
      modelName,
      systemText: systemPrompt,
      userText: instructions,
      images: settings.images,
      temperature: 0.1,
      jsonMode: true,
      maxTokensOnline: targetStyle === 'openai' ? 2048 : 1024
    });

    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: llmFetchSignal(settings.abortSignal)
      });
    } catch (fetchErr) {
      if (retriesLeft > 0 && !settings.abortSignal?.aborted) {
        logger.warn(`runAgentTurn fetch exception for agent "${agentName}", retrying (${retriesLeft} attempt(s) left): ${fetchErr.message}`);
        return runAgentTurn(agentName, systemPrompt, settings, userMessage, history, retriesLeft - 1);
      }
      throw fetchErr;
    }

    if (!res.ok && body.response_format) {
      console.warn("Local/OpenAI LLM failed with response_format, retrying without it...");
      delete body.response_format;
      res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: llmFetchSignal(settings.abortSignal)
      });
    }

    if (!res.ok) {
      const errText = await res.text();
      if (retriesLeft > 0 && !settings.abortSignal?.aborted) {
        logger.warn(`runAgentTurn LLM error for agent "${agentName}", retrying (${retriesLeft} attempt(s) left): ${res.status} - ${errText}`);
        return runAgentTurn(agentName, systemPrompt, settings, userMessage, history, retriesLeft - 1);
      }
      throw new Error(`LLM Error: ${res.status} - ${errText}`);
    }

    const data = await res.json();
    respText = extractResponseText(data, targetStyle);

    // Log token usage
    let tokenCount = 0;
    if (data.usage && data.usage.total_tokens) {
      tokenCount = data.usage.total_tokens;
    } else if (data.usage && data.usage.input_tokens && data.usage.output_tokens) {
      tokenCount = data.usage.input_tokens + data.usage.output_tokens;
    } else {
      tokenCount = Math.ceil((fullPrompt.length + respText.length) / 4);
    }
    if (db && typeof db.run === 'function' && userId) {
      const providerType = provider === 'local' ? 'local' : 'online';
      db.run(
        'INSERT INTO token_usage (user_id, model_name, provider_type, token_count) VALUES (?, ?, ?, ?)',
        [userId, modelName || 'unknown', providerType, tokenCount]
      ).catch(err => console.error('Failed to log OpenAI/Local agent turn tokens:', err));
    }
  }

  respText = respText
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<\|channel>thought[\s\S]*?<channel\|>/g, '')
    .trim();

  try {
    const parsed = JSON.parse(respText);
    if (parsed && parsed.next_action) {
      parsed.tool = parsed.next_action;
      parsed.params = parsed.refined_data || {};
      parsed.thought = parsed.intent || '';
    }
    return parsed;
  } catch (err) {
    const firstBrace = respText.indexOf('{');
    const lastBrace = respText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      try {
        const parsed = JSON.parse(respText.substring(firstBrace, lastBrace + 1));
        if (parsed && parsed.next_action) {
          parsed.tool = parsed.next_action;
          parsed.params = parsed.refined_data || {};
          parsed.thought = parsed.intent || '';
        }
        return parsed;
      } catch (e) {}
    }
    console.warn(`Failed to parse agent JSON, falling back to none: ${respText}`);
    return {
      thought: `Parsing failed. Raw response: ${respText}`,
      tool: 'none',
      action: '',
      params: {}
    };
  }
}

async function runAgentResponse(agentName, systemPrompt, settings, userMessage, history, toolOutputs, retriesLeft = 1) {
  const {
    provider,
    modelName,
    onlineProvider,
    onlineKey,
    geminiKey,
    localBaseUrl,
    localApiKey,
    localApiStyle,
    onlineUrl,
    db,
    userId
  } = settings;

  const isGemini = provider === 'gemini' || (provider === 'online' && onlineProvider === 'gemini');
  const responderInstruction = `${systemPrompt}

Based on the task: "${userMessage}"
And these tool outputs:
${JSON.stringify(toolOutputs)}

Generate a response. You MUST return your response as a strict JSON object with this exact schema:
{
  "status": "success" | "error",
  "summary": "a brief single-sentence summary of the action/result",
  "data": {} // key-value data of your findings and results
}
CRITICAL: The tool outputs above are ALL the information you have - there is no further data coming. Never describe an action as "in progress", "being processed", "underway", or "will be provided shortly". If the tool outputs above do not contain enough information to answer the task, set "status" to "error" and explain in "summary" what information is missing. Do NOT include any other text, markdown wrapper, or conversational filler outside the JSON object.`;

  let rawRespText = '';

  if (isGemini) {
    const activeKey = provider === 'gemini' ? (geminiKey || onlineKey) : onlineKey;
    const genAI = new GoogleGenerativeAI(activeKey);
    const model = genAI.getGenerativeModel({ 
      model: modelName || 'gemini-2.5-flash',
      generationConfig: { responseMimeType: 'application/json' }
    });
    const result = await model.generateContent(responderInstruction, { signal: settings.abortSignal });
    rawRespText = result.response.text();

    // Log token usage
    let tokenCount = 0;
    if (result.response.usageMetadata && result.response.usageMetadata.totalTokenCount) {
      tokenCount = result.response.usageMetadata.totalTokenCount;
    } else {
      tokenCount = Math.ceil((responderInstruction.length + rawRespText.length) / 4);
    }
    if (db && typeof db.run === 'function' && userId) {
      const providerType = provider === 'local' ? 'local' : 'online';
      db.run(
        'INSERT INTO token_usage (user_id, model_name, provider_type, token_count) VALUES (?, ?, ?, ?)',
        [userId, modelName || 'gemini-2.5-flash', providerType, tokenCount]
      ).catch(err => console.error('Failed to log Gemini response tokens:', err));
    }
  } else {
    const { targetUrl, targetKey, targetStyle } = resolveTarget(settings);
    const headers = buildHeaders(targetKey, targetStyle);
    // resolveEndpoint/buildBody now give this call the same local-gemini support the other
    // provider-calling functions already had - this function was previously missing it
    // entirely and would have sent an openai-shaped request to a local-gemini server.
    const endpoint = resolveEndpoint(targetUrl, targetStyle);
    // Anthropic keeps its existing shape (the full instruction as "system", a fixed short
    // user turn) rather than the systemPrompt/responderInstruction split every other style
    // uses, since that's how this call was already built for Anthropic specifically.
    const isAnthropic = targetStyle === 'anthropic';
    const body = buildBody({
      targetStyle,
      provider,
      modelName,
      systemText: isAnthropic ? responderInstruction : systemPrompt,
      userText: isAnthropic ? 'Generate report.' : responderInstruction,
      images: settings.images,
      temperature: 0.2,
      jsonMode: true,
      maxTokensOnline: targetStyle === 'openai' ? 2048 : 1024
    });

    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: llmFetchSignal(settings.abortSignal)
      });
    } catch (fetchErr) {
      if (retriesLeft > 0 && !settings.abortSignal?.aborted) {
        logger.warn(`runAgentResponse fetch exception for agent "${agentName}", retrying (${retriesLeft} attempt(s) left): ${fetchErr.message}`);
        return runAgentResponse(agentName, systemPrompt, settings, userMessage, history, toolOutputs, retriesLeft - 1);
      }
      throw fetchErr;
    }

    if (!res.ok && body.response_format) {
      console.warn("Local/OpenAI LLM response failed with response_format, retrying without it...");
      delete body.response_format;
      res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: llmFetchSignal(settings.abortSignal)
      });
    }

    if (!res.ok) {
      if (retriesLeft > 0 && !settings.abortSignal?.aborted) {
        logger.warn(`runAgentResponse LLM error for agent "${agentName}", retrying (${retriesLeft} attempt(s) left): ${res.status}`);
        return runAgentResponse(agentName, systemPrompt, settings, userMessage, history, toolOutputs, retriesLeft - 1);
      }
      throw new Error(`LLM Error: ${res.status}`);
    }

    const data = await res.json();
    rawRespText = extractResponseText(data, targetStyle);

    // Log token usage
    let tokenCount = 0;
    if (data.usage && data.usage.total_tokens) {
      tokenCount = data.usage.total_tokens;
    } else if (data.usage && data.usage.input_tokens && data.usage.output_tokens) {
      tokenCount = data.usage.input_tokens + data.usage.output_tokens;
    } else {
      const promptText = targetStyle === 'anthropic' ? systemPrompt + responderInstruction : JSON.stringify(body);
      tokenCount = Math.ceil((promptText.length + rawRespText.length) / 4);
    }
    if (db && typeof db.run === 'function' && userId) {
      const providerType = provider === 'local' ? 'local' : 'online';
      db.run(
        'INSERT INTO token_usage (user_id, model_name, provider_type, token_count) VALUES (?, ?, ?, ?)',
        [userId, modelName || 'unknown', providerType, tokenCount]
      ).catch(err => console.error('Failed to log non-gemini response tokens:', err));
    }
  }

  // Robustly ensure output is a valid JSON string
  let cleanResp = rawRespText.trim();
  try {
    JSON.parse(cleanResp);
    return cleanResp;
  } catch (err) {
    const firstBrace = cleanResp.indexOf('{');
    const lastBrace = cleanResp.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      try {
        const substring = cleanResp.substring(firstBrace, lastBrace + 1);
        JSON.parse(substring);
        return substring;
      } catch (e) {}
    }
    return JSON.stringify({
      status: "success",
      summary: rawRespText,
      data: {}
    });
  }
}

async function runWorkerAgent(agentName, settings, task, db, userId, chatId) {
  global.activeAgentOps = (global.activeAgentOps || 0) + 1;
  try {
    let targetAgent = agentName;
    if (targetAgent === 'coder') {
      targetAgent = 'developer_agent';
    }
    let systemPrompt = AGENT_PROMPTS[targetAgent];
    if (!systemPrompt) throw new Error(`Unknown agent: ${agentName}`);

    const path = require('path');
    const workingDirectory = settings.workingDirectory || path.resolve(path.join(__dirname, '../..'));
    
    // Selectively append workspace context
    const needsWorkspace = ['developer_agent', 'qa_engineer', 'tool_creator_agent', 'agent_creator_agent', 'coder', 'graphics_engineer'].includes(targetAgent);
    if (needsWorkspace) {
      const workspaceContext = `\n\n### Workspace System Directories:
- Root Working Directory: ${workingDirectory}
- Built-in Agents File: ${path.join(workingDirectory, 'backend/utils/agents.js')}
- Built-in Tools Directory: ${path.join(workingDirectory, 'backend/tools/')}
- Dynamic Tools Registry: ${path.join(workingDirectory, 'tool_registry/tools/')}`;
      systemPrompt += workspaceContext;
    }

    // Always available to every worker agent: a DB-backed paging/scratchpad tool so a
    // large assigned task, or the agent's own accumulated findings on a long task, never
    // has to sit entirely inside one live prompt. See backend/tools/job_store_tool.js.
    systemPrompt += `\n\n### Job Store Tool (Large Task / Working Memory):
- If your assigned task says it was "staged for paged reading" and gives you a job_id, call {"tool": "job_store", "action": "read_spec", "params": {"job_id": "...", "seq": 0}} and keep incrementing seq while the JSON response's "hasMore" is true, to read your full task before doing anything else.
- On a long or multi-step task, use {"tool": "job_store", "action": "write_note", "params": {"job_id": "...", "content": "..."}} to record findings/decisions/progress as you go, instead of relying on them staying in your own live context. Use {"tool": "job_store", "action": "read_notes", "params": {"job_id": "...", "seq": 0}} (same paging convention) to read your own notes back later, e.g. when assembling a final result.
- Pick any stable job_id yourself (e.g. derived from the task) if one wasn't given to you.`;

    // Fetch and inject user profile details if db and userId are available
    if (db && userId) {
      try {
        const profile = await db.get(
          'SELECT name, zipcode, country, temp_unit, interests FROM users WHERE id = ?',
          [userId]
        );
        if (profile) {
          systemPrompt += `\n\n### User Profile Context:`;
          systemPrompt += `\n- Profile Name: ${profile.name || 'Not set'}`;

          const needsLocation = ['weather_expert', 'web_searcher', 'system_specialist'].includes(targetAgent);
          if (needsLocation) {
            systemPrompt += `\n- Profile Zipcode: ${profile.zipcode || 'Not set'}`;
            systemPrompt += `\n- Profile Country: ${profile.country || 'US'}`;
            systemPrompt += `\n- Profile Temp Unit: ${profile.temp_unit || 'imperial'}`;
          }

          const needsPersonalDetails = ['web_searcher', 'memory_agent', 'news_agent'].includes(targetAgent);
          if (needsPersonalDetails) {
            systemPrompt += `\n- Specific Interests: ${profile.interests || '[]'}`;
          }
        }
      } catch (err) {
        console.error('Failed to load user profile in runWorkerAgent:', err);
      }
    }

    // Dynamic tools are only relevant for developer/creator/coder agents
    const needsDynamicTools = ['developer_agent', 'coder', 'tool_creator_agent', 'agent_creator_agent', 'supervisor'].includes(targetAgent);
    if (db && needsDynamicTools) {
      try {
        const caps = await db.all('SELECT tool_name, description, parameters FROM agent_capabilities WHERE agent_name = ?', [targetAgent]);
        if (caps && caps.length > 0) {
          systemPrompt += `\n\n### Dynamically Installed Custom Tools Available to You:`;
          for (const cap of caps) {
            systemPrompt += `\n- **${cap.tool_name}**: ${cap.description}\n  Tool declaration schema: ${cap.parameters}`;
          }
          systemPrompt += `\n\nTo use any of these dynamic tools, specify the tool name in the "tool" parameter and the action/params as required.`;
        }
      } catch (err) {
        console.error('Failed to load agent capabilities in runWorkerAgent:', err);
      }
    }

  const history = [];
  const toolOutputs = [];
  let turn = 0;
  const maxTurns = 5;
  const seenToolCalls = new Set();

  while (turn < maxTurns) {
    if (settings.abortSignal?.aborted) {
      break;
    }
    const decision = await runAgentTurn(agentName, systemPrompt, settings, task, history);
    
    if (!decision.tool || decision.tool === 'none') {
      break;
    }

    // Loop detection protection
    const toolCallSignature = `${decision.tool}:${decision.action || 'default'}:${JSON.stringify(decision.params || {})}`;
    if (seenToolCalls.has(toolCallSignature)) {
      console.warn(`[Loop Detector] Detected duplicate tool call in worker loop: "${toolCallSignature}". Force terminating worker turn.`);
      break;
    }
    seenToolCalls.add(toolCallSignature);

    // Rule 3: Stream immediate step announcements to prevent continuous thinking states
    if (settings.onIntermediateStatusUpdate) {
      settings.onIntermediateStatusUpdate({
        message: `Asking ${decision.tool} agent for operational task: "${decision.action || 'processing'}"...`,
        thought: decision.thought
      });
    }
    if (settings.onStatusUpdate) {
      settings.onStatusUpdate(`Asking ${decision.tool} agent for operational task: "${decision.action || 'processing'}"...`);
    }

    // Rule 1 & 8: Intercept genuinely novel, higher-blast-radius mutations that don't
    // already have their own narrowed, risk-based safety check baked in. write_file and
    // execute_command are deliberately NOT gated here - handleCoderTool already runs a
    // QA+Supervisor safety audit for those (see codeVerifier.js) that only pauses for
    // genuinely damaging actions, and dev_pipeline's create_tool already runs its own
    // qa_engineer design review before finishing - gating those a second time here would
    // just re-ask for routine, already-vetted work the user asked for. A remote node write/
    // command has no such internal review yet (it can disrupt a physical device), so it
    // still gets a real human approval gate here.
    const isMutationAction = decision.tool === 'remote_node_bridge' && ['write_file', 'run_command'].includes(decision.action);

    if (isMutationAction && settings.onCommandApprovalRequired) {
      const commandDescription = decision.params?.command
        || (decision.params?.filePath ? `Write to "${decision.params.filePath}" on a remote node` : `${decision.tool}: ${decision.action}`);

      // Mirrors the same working pattern already used by coder_tools.js's legacy path
      // and network_node_tool.js's own sudo-command approval flow (see requestApproval).
      const { requestApproval } = require('./commandApproval');
      const approvalResult = await requestApproval(settings.onCommandApprovalRequired, {
        command: commandDescription,
        safety_analysis: {
          risk_level: 'medium',
          reason: `${agentName} wants to ${decision.action === 'run_command' ? 'run a command' : 'write a file'} on a remote network node.`,
          potential_harm: 'Could disrupt or damage the remote device if the command or content is incorrect.',
          recommendation: 'review_carefully'
        },
        userId
      });

      if (!approvalResult.approved) {
        return "Pipeline Interrupted: Remote node file/command mutation was explicitly rejected by the human operator.";
      }
    }

    if (settings.onToolCall) {
      settings.onToolCall({ tool: decision.tool, action: decision.action || 'execute', params: decision.params, agent: agentName });
    }

    let output = '';
    if (decision.tool === 'weather') {
      const { handleWeatherTool } = require('../tools/weather_tool');
      output = await handleWeatherTool(db, userId, decision.action, decision.params);
    } else if (decision.tool === 'host_machine') {
      const { handleHostMachineTool } = require('../tools/host_machine_tool');
      output = await handleHostMachineTool(decision.action, decision.params);
    } else if (decision.tool === 'image_tool') {
      const { handleImageTool } = require('../tools/image_tool');
      output = await handleImageTool(decision.action, decision.params);
    } else if (['read_file', 'write_file', 'list_dir', 'execute_command'].includes(decision.tool)) {
      const { handleCoderTool } = require('../tools/coder_tools');
      output = await handleCoderTool(decision.tool, decision.params, {
        userId,
        onCommandApprovalRequired: settings.onCommandApprovalRequired,
        settings,
        agentName
      });
    } else if (decision.tool === 'calendar') {
      const { handleCalendarTool } = require('../tools/calendar_tool');
      output = await handleCalendarTool(db, userId, decision.action, decision.params);
    } else if (decision.tool === 'manage_recurring_task') {
      const { handleRecurringTaskTool } = require('../tools/recurring_task_tool');
      output = await handleRecurringTaskTool(db, userId, decision.action, decision.params);
    } else if (decision.tool === 'time') {
      const { handleTimeTool } = require('../tools/time_tool');
      output = await handleTimeTool(db, userId, decision.action, decision.params);
    } else if (decision.tool === 'tts') {
      const { handleTtsTool } = require('../tools/tts_tool');
      output = await handleTtsTool(db, userId, decision.action, decision.params);
    } else if (decision.tool === 'google_home') {
      const { handleGoogleHomeTool } = require('../tools/google_home_tool');
      output = await handleGoogleHomeTool(db, userId, decision.action, decision.params);
    } else if (decision.tool === 'search_web') {
      const { handleWebSearchTool } = require('../tools/web_search_tool');
      const q = decision.params?.query || task;
      output = await handleWebSearchTool(db, userId, q);
    } else if (decision.tool === 'google_news') {
      const { handleGoogleNewsTool } = require('../tools/google_news_tool');
      output = await handleGoogleNewsTool(decision.params?.query);
    } else if (decision.tool === 'sports') {
      const { handleSportsTool } = require('../tools/sports_tool');
      output = await handleSportsTool(db, userId, decision.action, decision.params);
    } else if (decision.tool === 'movie_tv') {
      const { handleMovieTvTool } = require('../tools/movie_tv_tool');
      output = await handleMovieTvTool(db, userId, decision.action, decision.params);
    } else if (decision.tool === 'news') {
      const { handleNewsTool } = require('../tools/news_tool');
      output = await handleNewsTool(db, userId, decision.action, decision.params);
    } else if (decision.tool === 'memory') {
      const { handleMemoryTool } = require('../tools/memory_tool');
      const toolParams = { ...decision.params, agentName };
      output = await handleMemoryTool(db, userId, decision.action, toolParams);
    } else if (decision.tool === 'query_vault') {
      const { handleVaultTool } = require('../tools/vault_tool');
      output = await handleVaultTool(db, userId, 'query', decision.params);
    } else if (decision.tool === 'query_system_docs') {
      const { handleSystemDocsTool } = require('../tools/system_docs_tool');
      output = await handleSystemDocsTool('query', decision.params);
    } else if (decision.tool === 'job_store') {
      const { handleJobStoreTool } = require('../tools/job_store_tool');
      output = await handleJobStoreTool(db, decision.action, decision.params);
    } else if (['list_network_nodes', 'remote_node_bridge'].includes(decision.tool)) {
      const { handleNetworkNodeTool } = require('../tools/network_node_tool');
      const mergedParams = { ...decision.params };
      if (!mergedParams.action && decision.action && decision.action !== 'execute' && decision.action !== 'default') {
        mergedParams.action = decision.action;
      }
      output = await handleNetworkNodeTool(decision.tool, mergedParams, {
        userId,
        onCommandApprovalRequired: settings.onCommandApprovalRequired,
        settings
      });
    } else if (decision.tool === 'remote_node_tool') {
      const { handleRemoteNodeTool } = require('../tools/remote_node_tool');
      output = await handleRemoteNodeTool(decision.action, decision.params, {
        userId,
        settings
      });
    } else if (decision.tool === 'esp32_tool') {
      const { handleEsp32Tool } = require('../tools/esp32_tool');
      output = await handleEsp32Tool(
        decision.params?.ipAddress || decision.params?.ip_address,
        decision.params?.port || null,
        decision.action,
        decision.params
      );
    } else if (decision.tool === 'tool_manager') {
      const { handleToolManagerTool } = require('../tools/tool_manager_tool');
      output = await handleToolManagerTool(decision.action, decision.params);
    } else if (decision.tool === 'dev_pipeline') {
      const { handleDevPipelineTool } = require('../tools/dev_pipeline_tool');
      output = await handleDevPipelineTool(decision.action, decision.params, {
        userId,
        onToolCall: settings.onToolCall,
        onAgentStatus: settings.onAgentStatus,
        onCommandApprovalRequired: settings.onCommandApprovalRequired,
        abortSignal: settings.abortSignal
      });
    } else if (decision.tool === 'network_scanner') {
      const { handleNetworkScanner } = require('../tools/network_scanner');
      output = await handleNetworkScanner(decision.action, decision.params);
    } else if (decision.tool === 'document_generator') {
      const { handleDocumentGeneratorTool } = require('../tools/document_generator_tool');
      output = await handleDocumentGeneratorTool(db, userId, decision.action, decision.params);
    } else if (decision.tool === 'deep_research') {
      const { handleDeepResearchTool } = require('../tools/deep_research_tool');
      output = await handleDeepResearchTool(db, userId, decision.action, decision.params);
    } else if (decision.tool === 'deep_research_pro') {
      const { handleDeepResearchProTool } = require('../tools/deep_research_pro_tool');
      output = await handleDeepResearchProTool(db, userId, decision.action, decision.params);
    } else if (decision.tool === 'course_builder') {
      const { handleCourseBuilderTool } = require('../tools/course_builder_tool');
      output = await handleCourseBuilderTool(db, userId, decision.action, decision.params);
    } else if (decision.tool === 'dev_project') {
      const { handleDevProjectTool } = require('../tools/dev_project_tool');
      output = await handleDevProjectTool(db, userId, decision.action, decision.params);
    } else if (decision.tool === 'document_formatter') {
      const { handleDocumentFormatterTool } = require('../tools/document_formatter_tool');
      output = await handleDocumentFormatterTool(db, userId, decision.action, decision.params, chatId);
    } else {
      // Check if it is a dynamically installed custom tool
      try {
        const path = require('path');
        const fs = require('fs');
        const dynamicToolPath = path.join(__dirname, '../tools/dynamic', decision.tool, 'handler.js');
        if (fs.existsSync(dynamicToolPath)) {
          const toolRow = await db.get('SELECT manifest FROM installed_tools WHERE tool_name = ?', [decision.tool]);
          if (toolRow) {
            const manifest = JSON.parse(toolRow.manifest);
            const exportedFnName = manifest.exported_function;
            const toolModule = require(dynamicToolPath);
            const handlerFn = toolModule[exportedFnName];
            if (typeof handlerFn === 'function') {
              output = await handlerFn(decision.action, decision.params);
            } else {
              output = `Error: Exported function "${exportedFnName}" not found in dynamic tool module "${decision.tool}".`;
            }
          } else {
            output = `Error: Dynamic tool "${decision.tool}" is not registered in database.`;
          }
        } else {
          output = `Error: Tool "${decision.tool}" is not accessible to this agent.`;
        }
      } catch (err) {
        output = `Error executing dynamic tool "${decision.tool}": ${err.message}`;
      }
    }

    // Rule 7 Loop: Missing input context collection
    if (output && typeof output === 'string' && output.includes('INPUT_REQUIRED_FROM_USER')) {
      if (settings.onPromptHumanInterception) {
        const userPayloadResponse = await settings.onPromptHumanInterception({ message: output });
        decision.params.userInputContext = userPayloadResponse;
        continue; // Seamlessly loop back and re-run with parameters active
      }
    }

    let safeResult = typeof output === 'string' ? output : JSON.stringify(output);
    const limit = decision.tool === 'news' ? 25000 : 3000;
    if (safeResult.length > limit) {
      safeResult = safeResult.substring(0, limit) + "\n... [TRUNCATED: Response too large for context]";
    }
    output = safeResult;

    toolOutputs.push({ tool: decision.tool, action: decision.action, output });
    
    history.push({
      role: 'assistant',
      content: `Thought: ${decision.thought}\nCalling tool: ${decision.tool} with parameters: ${JSON.stringify(decision.params)}`
    });
    history.push({
      role: 'user',
      content: `[Tool Output for ${decision.tool}]:\n${output}`
    });

    turn++;
  }

  // Safeguard: web_searcher must never report search results/status without having
  // actually executed a real web search. Weaker local models sometimes bail out of the
  // tool-call loop after a preliminary step (e.g. memory recall) and then hallucinate a
  // "search in progress" status in the final response. Force the real search here so the
  // final formatter always has genuine data to work with.
  if (agentName === 'web_searcher' && !toolOutputs.some(t => t.tool === 'search_web')) {
    let forcedQuery = task;
    try {
      const parsedTask = JSON.parse(task);
      forcedQuery = parsedTask.query || parsedTask.task || task;
    } catch (e) { }

    let forcedOutput;
    try {
      const { handleWebSearchTool } = require('../tools/web_search_tool');
      forcedOutput = await handleWebSearchTool(db, userId, forcedQuery);
    } catch (err) {
      forcedOutput = `Error: search_web failed - ${err.message}`;
    }
    let safeForced = typeof forcedOutput === 'string' ? forcedOutput : JSON.stringify(forcedOutput);
    if (safeForced.length > 3000) {
      safeForced = safeForced.substring(0, 3000) + "\n... [TRUNCATED: Response too large for context]";
    }
    toolOutputs.push({ tool: 'search_web', action: 'search_web', output: safeForced });
  }

  return await runAgentResponse(agentName, systemPrompt, settings, task, history, toolOutputs);
  } finally {
    global.activeAgentOps = Math.max(0, global.activeAgentOps - 1);
  }
}

async function runSupervisorTurn(systemPrompt, settings, userMessage) {
  const {
    provider,
    modelName,
    onlineProvider,
    onlineKey,
    geminiKey,
    localBaseUrl,
    localApiKey,
    localApiStyle,
    onlineUrl,
    db,
    userId
  } = settings;

  const isGemini = provider === 'gemini' || (provider === 'online' && onlineProvider === 'gemini');
  let respText = '';

  const fullPrompt = `${systemPrompt}\n\nUser Request: ${userMessage}`;

  if (isGemini) {
    const activeKey = provider === 'gemini' ? (geminiKey || onlineKey) : onlineKey;
    if (!activeKey) throw new Error('Gemini API key is not configured.');
    const genAI = new GoogleGenerativeAI(activeKey);
    const model = genAI.getGenerativeModel({
      model: modelName || 'gemini-2.0-flash',
      generationConfig: { responseMimeType: 'application/json' }
    });
    const result = await model.generateContent(fullPrompt, { signal: settings.abortSignal });
    respText = result.response.text();

    // Log token usage
    let tokenCount = 0;
    if (result.response.usageMetadata && result.response.usageMetadata.totalTokenCount) {
      tokenCount = result.response.usageMetadata.totalTokenCount;
    } else {
      tokenCount = Math.ceil((fullPrompt.length + respText.length) / 4);
    }
    if (db && typeof db.run === 'function' && userId) {
      const providerType = provider === 'local' ? 'local' : 'online';
      db.run(
        'INSERT INTO token_usage (user_id, model_name, provider_type, token_count) VALUES (?, ?, ?, ?)',
        [userId, modelName || 'gemini-2.0-flash', providerType, tokenCount]
      ).catch(err => console.error('Failed to log Gemini supervisor tokens:', err));
    }
  } else {
    const { targetUrl, targetKey, targetStyle } = resolveTarget(settings);
    const headers = buildHeaders(targetKey, targetStyle);
    const endpoint = resolveEndpoint(targetUrl, targetStyle);
    const isAnthropic = targetStyle === 'anthropic';
    const body = buildBody({
      targetStyle,
      provider,
      modelName,
      systemText: systemPrompt,
      userText: isAnthropic ? `Parse this user request and return the JSON handoff output: ${userMessage}` : userMessage,
      temperature: 0.1,
      jsonMode: true,
      maxTokensOnline: 1024
    });

    let res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: llmFetchSignal(settings.abortSignal)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`LLM Error: ${res.status} - ${errText}`);
    }

    const data = await res.json();
    respText = extractResponseText(data, targetStyle);

    // Log token usage
    let tokenCount = 0;
    if (data.usage && data.usage.total_tokens) {
      tokenCount = data.usage.total_tokens;
    } else if (data.usage && data.usage.input_tokens && data.usage.output_tokens) {
      tokenCount = data.usage.input_tokens + data.usage.output_tokens;
    } else {
      tokenCount = Math.ceil((fullPrompt.length + respText.length) / 4);
    }
    if (db && typeof db.run === 'function' && userId) {
      const providerType = provider === 'local' ? 'local' : 'online';
      db.run(
        'INSERT INTO token_usage (user_id, model_name, provider_type, token_count) VALUES (?, ?, ?, ?)',
        [userId, modelName || 'unknown', providerType, tokenCount]
      ).catch(err => console.error('Failed to log OpenAI/Local supervisor tokens:', err));
    }
  }

  respText = respText
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<\|channel>thought[\s\S]*?<channel\|>/g, '')
    .trim();

  // Use a local JSON regex parsing block
  const firstBrace = respText.indexOf('{');
  const lastBrace = respText.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(respText.substring(firstBrace, lastBrace + 1));
    } catch (e) {}
  }
  return JSON.parse(respText);
}

async function runSupervisorHandoff(userPrompt, settings = {}, db = null, userId = null) {
  const supervisorPrompt = AGENT_PROMPTS.supervisor;
  if (!supervisorPrompt) throw new Error('Supervisor agent prompt not found.');

  const decision = await runSupervisorTurn(supervisorPrompt, settings, userPrompt);

  let workerName = decision.next_action || '';
  if (workerName.startsWith('delegate_to_')) {
    workerName = workerName.replace(/^delegate_to_/, '');
  }

  if (!workerName) {
    throw new Error(`Supervisor routing failed. Next action: "${decision.next_action}"`);
  }

  const refinedContext = typeof decision.refined_data === 'string'
    ? decision.refined_data
    : JSON.stringify(decision.refined_data || {});

  const output = await runWorkerAgent(workerName, settings, refinedContext, db, userId);
  return {
    supervisor_decision: decision,
    worker_output: output
  };
}

module.exports = {
  AGENT_PROMPTS,
  runAgentTurn,
  runWorkerAgent,
  runSupervisorHandoff
};
