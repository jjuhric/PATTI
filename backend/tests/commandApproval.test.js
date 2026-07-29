const { registerPendingCommand, resolveCommand, pendingCommands, requestApproval } = require('../utils/commandApproval');

describe('Command Approval Utility Tests', () => {
  beforeEach(() => {
    pendingCommands.clear();
  });

  test('registerPendingCommand should add command to pending list and resolve when resolved', async () => {
    const commandId = 'cmd_test';
    const command = 'npm run test';
    const userId = 1;

    const promise = registerPendingCommand(commandId, command, userId);

    expect(pendingCommands.has(commandId)).toBe(true);
    const pendingObj = pendingCommands.get(commandId);
    expect(pendingObj.command).toBe(command);
    expect(pendingObj.userId).toBe(userId);

    // Resolve command
    const resolved = resolveCommand(commandId, true, 'npm run test --edited');
    expect(resolved).toBe(true);

    const result = await promise;
    expect(result.approved).toBe(true);
    expect(result.command).toBe('npm run test --edited');
    expect(pendingCommands.has(commandId)).toBe(false);
  });

  test('resolveCommand should return false if commandId does not exist', () => {
    const resolved = resolveCommand('non_existent', true);
    expect(resolved).toBe(false);
  });

  test('resolveCommand should use original command if editedCommand is not provided', async () => {
    const commandId = 'cmd_test_original';
    const command = 'ls -la';
    const userId = 1;

    const promise = registerPendingCommand(commandId, command, userId);
    resolveCommand(commandId, true);

    const result = await promise;
    expect(result.approved).toBe(true);
    expect(result.command).toBe(command);
  });

  describe('requestApproval', () => {
    test('auto-approves when no onCommandApprovalRequired callback is supplied', async () => {
      const result = await requestApproval(undefined, { command: 'echo hi', userId: 1 });
      expect(result).toEqual({ approved: true, command: 'echo hi' });
    });

    test('notifies the callback and resolves once the real decision comes in', async () => {
      let firedEvent = null;
      const onCommandApprovalRequired = (evt) => {
        firedEvent = evt;
        setTimeout(() => resolveCommand(evt.commandId, true), 10);
      };

      const result = await requestApproval(onCommandApprovalRequired, {
        command: 'rm old-file.txt',
        safety_analysis: { risk_level: 'medium' },
        userId: 7
      });

      expect(firedEvent).not.toBeNull();
      expect(firedEvent.command).toBe('rm old-file.txt');
      expect(firedEvent.safety_analysis).toEqual({ risk_level: 'medium' });
      expect(typeof firedEvent.commandId).toBe('string');
      expect(result.approved).toBe(true);
    });

    test('propagates rejection from the real decision', async () => {
      const onCommandApprovalRequired = (evt) => {
        setTimeout(() => resolveCommand(evt.commandId, false), 10);
      };

      const result = await requestApproval(onCommandApprovalRequired, { command: 'rm old-file.txt', userId: 7 });
      expect(result.approved).toBe(false);
    });
  });
});
