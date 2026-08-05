const { createPendingApproval, getPendingApproval, resolvePendingApproval } = require('../utils/pendingApprovals');

describe('pendingApprovals (SEC-3)', () => {
  describe('createPendingApproval', () => {
    test('inserts a row and supersedes any prior pending row for the chat', async () => {
      const db = { run: jest.fn().mockResolvedValue({ lastID: 1 }) };
      const token = await createPendingApproval(
        { db, chatId: 5, userId: 1 },
        { action: 'execute_command', agentName: 'coder', command: 'npm install' }
      );

      expect(token).toEqual(expect.any(String));
      expect(token.length).toBeGreaterThan(10);
      expect(db.run).toHaveBeenCalledWith(expect.stringContaining("status = 'superseded'"), [5]);
      expect(db.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO pending_approvals'),
        [token, 1, 5, 'execute_command', 'coder', 'npm install', null, null]
      );
    });

    test('returns null and does not touch the db when db/chatId/userId are missing', async () => {
      const db = { run: jest.fn() };
      expect(await createPendingApproval({}, { action: 'execute_command' })).toBeNull();
      expect(await createPendingApproval({ db }, { action: 'execute_command' })).toBeNull();
      expect(await createPendingApproval({ db, chatId: 1 }, { action: 'execute_command' })).toBeNull();
      expect(db.run).not.toHaveBeenCalled();
    });

    test('returns null (not throw) if the db write fails', async () => {
      const db = { run: jest.fn().mockRejectedValue(new Error('db down')) };
      const token = await createPendingApproval({ db, chatId: 1, userId: 1 }, { action: 'execute_command', command: 'x' });
      expect(token).toBeNull();
    });
  });

  describe('getPendingApproval', () => {
    test('queries for a pending row scoped to chat and user', async () => {
      const row = { id: 1, action: 'execute_command' };
      const db = { get: jest.fn().mockResolvedValue(row) };
      const result = await getPendingApproval(db, 1, 5);
      expect(result).toBe(row);
      expect(db.get).toHaveBeenCalledWith(expect.stringContaining("status = 'pending'"), [5, 1]);
    });

    test('returns null when db/chatId/userId are missing', async () => {
      expect(await getPendingApproval(null, 1, 5)).toBeNull();
      expect(await getPendingApproval({ get: jest.fn() }, null, 5)).toBeNull();
      expect(await getPendingApproval({ get: jest.fn() }, 1, null)).toBeNull();
    });

    test('returns null (not throw) if the query fails', async () => {
      const db = { get: jest.fn().mockRejectedValue(new Error('db down')) };
      expect(await getPendingApproval(db, 1, 5)).toBeNull();
    });
  });

  describe('resolvePendingApproval', () => {
    test('updates status and resolved_at for the given id', async () => {
      const db = { run: jest.fn().mockResolvedValue({}) };
      await resolvePendingApproval(db, 7, 'approved');
      expect(db.run).toHaveBeenCalledWith(expect.stringContaining('UPDATE pending_approvals SET status = ?'), ['approved', 7]);
    });

    test('does nothing when db or id is missing', async () => {
      const db = { run: jest.fn() };
      await resolvePendingApproval(null, 7, 'approved');
      await resolvePendingApproval(db, null, 'approved');
      expect(db.run).not.toHaveBeenCalled();
    });

    test('does not throw if the update fails', async () => {
      const db = { run: jest.fn().mockRejectedValue(new Error('db down')) };
      await expect(resolvePendingApproval(db, 7, 'approved')).resolves.toBeUndefined();
    });
  });
});
