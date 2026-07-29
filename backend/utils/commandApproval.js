const pendingCommands = new Map();

/**
 * Registers a pending command and returns a promise that resolves
 * when the command is approved or rejected by the user.
 * 
 * @param {string} commandId Unique command ID
 * @param {string} command The command proposed to run
 * @param {number} userId The user's database ID
 * @returns {Promise<{ approved: boolean, command: string }>} Result
 */
function registerPendingCommand(commandId, command, userId) {
  return new Promise((resolve) => {
    pendingCommands.set(commandId, {
      resolve,
      command,
      userId,
      timestamp: Date.now()
    });
  });
}

/**
 * Resolves a pending command with the user's decision (approved/rejected).
 * 
 * @param {string} commandId Unique command ID
 * @param {boolean} approved True if approved, false if rejected
 * @param {string} [editedCommand] Custom/modified command edited by user
 * @returns {boolean} True if successfully resolved, false if not found
 */
function resolveCommand(commandId, approved, editedCommand, password) {
  const pending = pendingCommands.get(commandId);
  if (!pending) return false;
  pendingCommands.delete(commandId);
  pending.resolve({ approved, command: editedCommand || pending.command, password });
  return true;
}

function generateCommandId() {
  return 'cmd_' + Math.random().toString(36).substring(2, 15);
}

/**
 * Notifies the caller-supplied approval callback (if any) and waits for the user's
 * real decision, resolved later via the /approve-command REST endpoint calling
 * resolveCommand() with a matching commandId. Consolidates the commandId + notify +
 * registerPendingCommand pattern that used to be duplicated across coder_tools.js,
 * network_node_tool.js, and agents.js.
 *
 * @param {Function|undefined} onCommandApprovalRequired Fires a { commandId, command,
 *   safety_analysis } event (e.g. over SSE) to notify the user a decision is needed.
 *   If not provided, no gate is configured - approves automatically.
 * @param {{ command: string, safety_analysis?: object, userId?: number }} request
 * @returns {Promise<{ approved: boolean, command: string, password?: string }>}
 */
async function requestApproval(onCommandApprovalRequired, { command, safety_analysis, userId }) {
  if (!onCommandApprovalRequired) {
    return { approved: true, command };
  }
  const commandId = generateCommandId();
  onCommandApprovalRequired({ commandId, command, safety_analysis });
  return registerPendingCommand(commandId, command, userId);
}

module.exports = {
  registerPendingCommand,
  resolveCommand,
  pendingCommands,
  generateCommandId,
  requestApproval
};
