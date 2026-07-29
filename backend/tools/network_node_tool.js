const { getDb } = require('../db');

async function handleListNetworkNodes(userId) {
  try {
    const db = await getDb();
    const nodes = await db.all(
      'SELECT id, node_name, device_type, ip_address, port, is_online FROM network_nodes WHERE user_id = ?',
      [userId]
    );
    if (nodes.length === 0) {
      return 'No remote network nodes registered. Please register them in Settings -> Nodes first.';
    }
    const details = nodes.map(n => 
      `- [ID: ${n.id}] Name: "${n.node_name}" (${n.device_type}) | Address: http://${n.ip_address}:${n.port} | Status: ${n.is_online ? 'ONLINE' : 'OFFLINE'}`
    );
    return `### Registered Network Nodes:\n${details.join('\n')}`;
  } catch (err) {
    return `Error listing network nodes: ${err.message}`;
  }
}

async function handleRemoteNodeBridge(params, options = {}) {
  const { nodeId, action } = params;
  if (!nodeId) return 'Error: "nodeId" is required.';
  if (!action) return 'Error: "action" is required.';

  let actionParams = params.actionParams || {};
  if (Object.keys(actionParams).length === 0) {
    const { command, filePath, content } = params;
    actionParams = { command, filePath, content };
  }

  try {
    const db = await getDb();
    
    // Check if target node exists (support both ID and name lookup)
    let node = null;
    if (nodeId !== undefined && nodeId !== null) {
      if (!isNaN(nodeId) && Number.isInteger(Number(nodeId))) {
        node = await db.get('SELECT * FROM network_nodes WHERE id = ? AND user_id = ?', [Number(nodeId), options.userId]);
      }
      if (!node) {
        node = await db.get('SELECT * FROM network_nodes WHERE LOWER(node_name) = ? AND user_id = ?', [String(nodeId).toLowerCase(), options.userId]);
      }
      if (!node) {
        // Flexible fallback: strip non-alphanumeric characters and check name or device type
        const cleanNodeId = String(nodeId).toLowerCase().replace(/[^a-z0-9]/g, '');
        if (cleanNodeId) {
          const allNodes = await db.all('SELECT * FROM network_nodes WHERE user_id = ?', [options.userId]);
          if (allNodes && Array.isArray(allNodes)) {
            node = allNodes.find(n => {
              const cleanName = n.node_name.toLowerCase().replace(/[^a-z0-9]/g, '');
              const cleanType = (n.device_type || '').toLowerCase().replace(/[^a-z0-9]/g, '');
              return (
                cleanName === cleanNodeId ||
                cleanType === cleanNodeId ||
                cleanNodeId.includes(cleanName) ||
                cleanName.includes(cleanNodeId)
              );
            });
          }
        }
      }
    }
    if (!node) {
      return `Error: Node with ID ${nodeId} not found in database.`;
    }

    const resolvedNodeId = node.id;
    console.log(`[Network Node Tool] Resolved NodeId: "${nodeId}" matches Node: "${node.node_name}" [ID: ${resolvedNodeId}]`);

    // Check if the target node is the Parent/Main Host.
    // If it is, allow and route locally using Main Host local tools.
    if (node.is_main_host === 1 || node.node_name.toLowerCase() === 'parent') {
      const { handleCoderTool } = require('./coder_tools');
      if (action === 'run_command') {
        return await handleCoderTool('execute_command', { command: actionParams.command }, options);
      } else if (action === 'write_file') {
        return await handleCoderTool('write_file', { filePath: actionParams.filePath, content: actionParams.content }, options);
      } else if (action === 'read_file') {
        return await handleCoderTool('read_file', { filePath: actionParams.filePath }, options);
      } else if (action === 'system_info') {
        const { handleHostMachineTool } = require('./host_machine_tool');
        const os = require('os');
        const tempReport = await handleHostMachineTool('get_temperature');
        const powerReport = await handleHostMachineTool('get_power');
        const netReport = await handleHostMachineTool('get_network_info');
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        return `### Main Host System Telemetry:\n- OS: ${os.type()} ${os.release()} (${os.arch()})\n- Memory Total: ${(totalMem / 1024 / 1024).toFixed(0)} MB\n- Memory Free: ${(freeMem / 1024 / 1024).toFixed(0)} MB\n- Temperature: ${tempReport}\n- Power: ${powerReport}\n- Network: ${netReport}`;
      } else {
        return `Error: Action "${action}" is not supported on the Main Host node.`;
      }
    }

    const cmdParams = { ...actionParams };
    
    // If the action is a shell command requiring sudo, check for sudo password approval locally
    if (action === 'run_command' && cmdParams.command && cmdParams.command.includes('sudo') && !cmdParams.sudo_password) {
      if (options.onCommandApprovalRequired) {
        const { requestApproval } = require('../utils/commandApproval');
        const approvalResult = await requestApproval(options.onCommandApprovalRequired, {
          command: cmdParams.command,
          safety_analysis: {
            risk_level: 'medium',
            reason: `Execute administrative command on remote node "${node.node_name}"`,
            potential_harm: 'Unauthorized system modifications on remote node',
            recommendation: 'review_carefully'
          },
          userId: options.userId
        });
        if (!approvalResult.approved) {
          return `Command execution rejected by user.`;
        }
        cmdParams.sudo_password = approvalResult.password;
      }
    }

    // Resolve authentication token: 
    // 1. Registered node bridge_secret
    // 2. Local environment BRIDGE_SECRET
    // 3. Local decrypted local_key
    let tokenToSend = node.bridge_secret;
    if (!tokenToSend) {
      tokenToSend = process.env.BRIDGE_SECRET;
    }
    if (!tokenToSend) {
      const settings = await db.get('SELECT local_key FROM user_settings LIMIT 1');
      if (settings && settings.local_key) {
        const { decrypt } = require('../utils/crypto');
        try {
          tokenToSend = decrypt(settings.local_key);
        } catch (e) {
          tokenToSend = settings.local_key;
        }
      }
    }

    // Call the remote node API
    const targetUrl = `http://${node.ip_address}:${node.port || 3000}/api/bridge/execute`;
    console.log(`[Network Bridge] Routing action "${action}" to Node "${node.node_name}" at ${targetUrl}`);
    
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenToSend || ''}`
      },
      body: JSON.stringify({
        action,
        params: cmdParams
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      return `Error: Remote execution failed with status ${response.status}: ${errorText}`;
    }

    const data = await response.json();
    return `### Execution Result from Node "${node.node_name}":\n${data.output || data.message || JSON.stringify(data, null, 2)}`;
  } catch (err) {
    return `Error routing command to remote node: ${err.message}`;
  }
}

async function handleNetworkNodeTool(action, params = {}, options = {}) {
  switch (action) {
    case 'list_network_nodes':
      return handleListNetworkNodes(options.userId);
    case 'remote_node_bridge':
      return handleRemoteNodeBridge(params, options);
    default:
      return `Error: Unknown network node tool action "${action}".`;
  }
}

module.exports = { handleNetworkNodeTool };
