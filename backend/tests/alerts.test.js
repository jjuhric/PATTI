const alertsRouter = require('../routes/alerts');

function connectMockClient(userId) {
  let closedCallback = null;
  const mockReq = {
    user: { id: userId },
    on: jest.fn().mockImplementation((event, callback) => {
      if (event === 'close') closedCallback = callback;
    })
  };
  const mockRes = {
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn(),
    end: jest.fn()
  };

  const streamRoute = alertsRouter.stack.find(layer => layer.route && layer.route.path === '/stream');
  const handler = streamRoute.route.stack[streamRoute.route.stack.length - 1].handle;
  handler(mockReq, mockRes);

  return { mockRes, close: () => closedCallback && closedCallback() };
}

describe('Alerts Router Tests', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('broadcastAlert handles objects and strings safely without crash', () => {
    expect(() => {
      alertsRouter.broadcastAlert("string alert");
      alertsRouter.broadcastAlert({ object: 'alert' });
    }).not.toThrow();
  });

  test('stream endpoint registers connection and cleans up on close', () => {
    jest.useFakeTimers();
    const { mockRes, close } = connectMockClient(1);

    expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(mockRes.flushHeaders).toHaveBeenCalled();

    jest.advanceTimersByTime(16000);
    expect(mockRes.write).toHaveBeenCalledWith(': heartbeat\n\n');

    close();
  });

  describe('per-user scoping', () => {
    test('broadcastAlert with no userId reaches every connected client (system-status alerts)', () => {
      const clientA = connectMockClient(1);
      const clientB = connectMockClient(2);

      alertsRouter.broadcastAlert({ type: 'agent_status', agent: 'x', status: 'active' });

      expect(clientA.mockRes.write).toHaveBeenCalledWith(expect.stringContaining('agent_status'));
      expect(clientB.mockRes.write).toHaveBeenCalledWith(expect.stringContaining('agent_status'));

      clientA.close();
      clientB.close();
    });

    test('broadcastAlert with a userId reaches only that user\'s own connections', () => {
      const clientA = connectMockClient(1);
      const clientB = connectMockClient(2);

      alertsRouter.broadcastAlert({ type: 'info', message: 'Private to user 1' }, 1);

      expect(clientA.mockRes.write).toHaveBeenCalledWith(expect.stringContaining('Private to user 1'));
      expect(clientB.mockRes.write).not.toHaveBeenCalledWith(expect.stringContaining('Private to user 1'));

      clientA.close();
      clientB.close();
    });

    test('a scoped alert still reaches multiple connections belonging to the same user (e.g. two open tabs)', () => {
      const tab1 = connectMockClient(5);
      const tab2 = connectMockClient(5);

      alertsRouter.broadcastAlert({ type: 'info', message: 'Your thing is ready.' }, 5);

      expect(tab1.mockRes.write).toHaveBeenCalledWith(expect.stringContaining('Your thing is ready.'));
      expect(tab2.mockRes.write).toHaveBeenCalledWith(expect.stringContaining('Your thing is ready.'));

      tab1.close();
      tab2.close();
    });
  });
});
