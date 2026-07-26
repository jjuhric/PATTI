const aiQueue = require('../services/ai_queue');
const { broadcastAlert } = require('../routes/alerts');

jest.mock('../routes/alerts', () => ({
  broadcastAlert: jest.fn()
}));

describe('AI Concurrency FIFO Queue Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    aiQueue.queue = [];
    aiQueue.isProcessing = false;
    aiQueue.activeTask = null;
  });

  test('enqueues a task and executes it sequentially', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const taskLog = [];
    const task1 = aiQueue.enqueue(async (onThought) => {
      onThought('Executing task 1');
      await new Promise(resolve => setTimeout(resolve, 50));
      taskLog.push(1);
      return 'result1';
    }, { nodeId: 'node1', name: 'Task 1' });

    const task2 = aiQueue.enqueue(async (onThought) => {
      onThought('Executing task 2');
      await new Promise(resolve => setTimeout(resolve, 10));
      taskLog.push(2);
      return 'result2';
    }, { nodeId: 'node2', name: 'Task 2' });

    const state = aiQueue.getState();
    expect(state.isBusy).toBe(true);
    expect(state.queueLength).toBe(1);

    const r1 = await task1;
    const r2 = await task2;

    expect(r1).toBe('result1');
    expect(r2).toBe('result2');
    expect(taskLog).toEqual([1, 2]);
    expect(broadcastAlert).toHaveBeenCalled();

    process.env.NODE_ENV = originalEnv;
  });
});

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

describe('ai_queue.js host-wins arbitration', () => {
  let originalNodeEnv;

  beforeEach(() => {
    jest.clearAllMocks();
    aiQueue.queue = [];
    aiQueue.isProcessing = false;
    aiQueue.activeTask = null;
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  test('host tasks resolve normally and report busyBy: "host"', async () => {
    const promise = aiQueue.enqueue(async () => { await sleep(50); return 'ok'; }, { origin: 'host', nodeId: 'chat-ui', name: 'Host Task' });
    await sleep(10);
    expect(aiQueue.getState().isBusy).toBe(true);
    expect(aiQueue.getState().busyBy).toBe('host');
    await expect(promise).resolves.toBe('ok');
    expect(aiQueue.getState().isBusy).toBe(false);
  });

  test('a host task showing up mid-generation aborts and preempts an active PATTI client task', async () => {
    const clientAbort = new AbortController();
    const clientPromise = aiQueue.enqueue(async () => {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 2000);
        clientAbort.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
      });
      return 'client-finished-normally';
    }, { origin: 'patti_client', nodeId: 'patti-client', name: 'Client Task', abortController: clientAbort });

    await sleep(20);
    expect(aiQueue.getState().busyBy).toBe('patti_client');

    const hostPromise = aiQueue.enqueue(async () => 'host-finished', { origin: 'host', nodeId: 'chat-ui', name: 'Host Task' });

    await expect(clientPromise).rejects.toMatchObject({ code: 'HOST_PREEMPTED' });
    expect(clientAbort.signal.aborted).toBe(true);
    await expect(hostPromise).resolves.toBe('host-finished');
  });

  test('a queued (not yet running) PATTI client task is rejected when a host task preempts the active one', async () => {
    const blockerAbort = new AbortController();
    const blockerPromise = aiQueue.enqueue(async () => {
      await sleep(500);
      return 'blocker-done';
    }, { origin: 'patti_client', nodeId: 'patti-client', name: 'Blocker', abortController: blockerAbort });

    await sleep(20);

    const hostPromise = aiQueue.enqueue(async () => 'host-done', { origin: 'host', nodeId: 'chat-ui', name: 'Host' });

    await expect(blockerPromise).rejects.toMatchObject({ code: 'HOST_PREEMPTED' });
    await expect(hostPromise).resolves.toBe('host-done');
  });

  test('a new PATTI client request is rejected immediately with HOST_BUSY while a host task is active', async () => {
    const hostPromise = aiQueue.enqueue(async () => {
      await sleep(300);
      return 'host-done';
    }, { origin: 'host', nodeId: 'chat-ui', name: 'Host' });

    await sleep(20);
    expect(aiQueue.getState().busyBy).toBe('host');

    await expect(
      aiQueue.enqueue(async () => 'should-not-run', { origin: 'patti_client', nodeId: 'patti-client', name: 'Client' })
    ).rejects.toMatchObject({ code: 'HOST_BUSY' });

    await expect(hostPromise).resolves.toBe('host-done');
  });

  test('a new PATTI client request is rejected immediately with HOST_BUSY while a host task is only queued', async () => {
    const firstHost = aiQueue.enqueue(async () => { await sleep(300); return 'first'; }, { origin: 'host', nodeId: 'chat-ui', name: 'Host 1' });
    await sleep(20);
    const secondHost = aiQueue.enqueue(async () => 'second', { origin: 'host', nodeId: 'chat-ui', name: 'Host 2' });

    await expect(
      aiQueue.enqueue(async () => 'should-not-run', { origin: 'patti_client', nodeId: 'patti-client', name: 'Client' })
    ).rejects.toMatchObject({ code: 'HOST_BUSY' });

    await expect(firstHost).resolves.toBe('first');
    await expect(secondHost).resolves.toBe('second');
  });

  test('PATTI client tasks run normally and report busyBy when the host is idle', async () => {
    const promise = aiQueue.enqueue(async () => { await sleep(50); return 'client-ok'; }, { origin: 'patti_client', nodeId: 'patti-client', name: 'Client Task' });
    await sleep(10);
    expect(aiQueue.getState().busyBy).toBe('patti_client');
    await expect(promise).resolves.toBe('client-ok');
  });

  test('missing origin defaults to host (backward compatible with existing call sites)', async () => {
    const promise = aiQueue.enqueue(async () => { await sleep(50); return 'default-ok'; }, { nodeId: 'chat-ui', name: 'No Origin Specified' });
    await sleep(10);
    expect(aiQueue.getState().busyBy).toBe('host');
    await expect(promise).resolves.toBe('default-ok');
  });
});
