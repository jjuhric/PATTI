const path = require('path');
const fs = require('fs');
const os = require('os');

// The "accepts a valid name" cases below exercise the real action handlers past validation,
// which would otherwise run a real shell command - on Windows, restart_service's primary path
// stops/starts the actual "PATTI-Assistant" scheduled task regardless of the service name
// passed in. Mock child_process so nothing real ever executes.
jest.mock('child_process', () => ({
  exec: jest.fn((...args) => {
    const callback = args[args.length - 1];
    if (typeof callback === 'function') callback(null, 'mocked stdout', '');
  }),
  execSync: jest.fn(() => 'Caption=Mocked OS\n')
}));

// Avoid touching the real database.db just to read device_type/is_main_host settings -
// handleHostMachineTool already falls back to sensible defaults if getDb() throws.
jest.mock('../db', () => ({
  getDb: async () => { throw new Error('db not available in this unit test'); }
}));

const { handleHostMachineTool } = require('../tools/host_machine_tool');

// Covers the SEC-1/SEC-2 hardening in docs/REVIEW_2026-08-03.md: service-name validation
// (blocks shell-metacharacter injection) and the untrusted-upload-dir guard on run_script.
describe('host_machine_tool security guards', () => {
  const invalidServiceNames = [
    'x & calc',
    'x; rm -rf /',
    'x | cat /etc/passwd',
    'x`whoami`',
    'x$(whoami)',
    'has spaces',
    'quote"here',
  ];

  describe.each([
    ['get_service_status'],
    ['get_journal_logs'],
    ['restart_service'],
  ])('%s rejects an unsafe service name', (action) => {
    test.each(invalidServiceNames)('rejects "%s"', async (service) => {
      const result = await handleHostMachineTool(action, { service });
      expect(result).toMatch(/invalid characters/i);
    });

    test('accepts a plain alphanumeric service name without throwing an injection error', async () => {
      const result = await handleHostMachineTool(action, { service: 'PATTI-Assistant' });
      expect(result).not.toMatch(/invalid characters/i);
    });
  });

  describe('run_script', () => {
    const uploadsDir = path.join(process.cwd(), 'chat_attachments', 'test-guard-user');

    afterEach(() => {
      if (fs.existsSync(uploadsDir)) {
        fs.rmSync(uploadsDir, { recursive: true, force: true });
      }
    });

    test('refuses to execute a script from chat_attachments/', async () => {
      fs.mkdirSync(uploadsDir, { recursive: true });
      const scriptPath = path.join(uploadsDir, 'payload.sh');
      fs.writeFileSync(scriptPath, '#!/bin/sh\necho pwned\n');

      const relativePath = path.relative(process.cwd(), scriptPath);
      const result = await handleHostMachineTool('run_script', { scriptPath: relativePath });

      expect(result).toMatch(/untrusted user content/i);
    });

    test('still rejects a scriptPath outside the workspace/home entirely', async () => {
      // Filesystem root is outside both process.cwd() (backend/) and the home directory.
      const outsidePath = path.join(path.parse(process.cwd()).root, 'definitely-outside-patti-test.sh');
      const result = await handleHostMachineTool('run_script', { scriptPath: outsidePath });
      expect(result).toMatch(/access denied/i);
    });
  });

  // BUG-15 (docs/REVIEW_2026-08-03.md): restart_service on Windows now runs
  // restart_patti_service.ps1 (which kills the stale node.exe orphan between stop and start)
  // instead of a bare Stop-ScheduledTask/Start-ScheduledTask pair that left it racing a fresh one.
  describe('restart_service on Windows', () => {
    const { exec } = require('child_process');
    let platformSpy;

    beforeEach(() => {
      exec.mockClear();
      // CI runs this suite on Linux - force the win32 branch explicitly rather than relying on
      // the actual OS, so this test's outcome doesn't depend on which machine runs it.
      platformSpy = jest.spyOn(os, 'platform').mockReturnValue('win32');
    });

    afterEach(() => {
      platformSpy.mockRestore();
    });

    test('invokes restart_patti_service.ps1 via powershell -File instead of inline Stop/Start-ScheduledTask', async () => {
      await handleHostMachineTool('restart_service', { service: 'PATTI-Assistant' });

      expect(exec).toHaveBeenCalledTimes(1);
      const command = exec.mock.calls[0][0];
      expect(command).toMatch(/powershell -ExecutionPolicy Bypass -File/);
      expect(command).toMatch(/restart_patti_service\.ps1/);
      // The old bare-pair invocation must be gone, not just supplemented.
      expect(command).not.toMatch(/Stop-ScheduledTask -TaskName PATTI-Assistant -ErrorAction SilentlyContinue"$/);
    });

    test('reports success once the script runs without throwing', async () => {
      const result = await handleHostMachineTool('restart_service', { service: 'PATTI-Assistant' });
      expect(result).toMatch(/Successfully restarted Windows scheduled task "PATTI-Assistant"/);
    });
  });
});
