jest.mock('../db', () => ({
  getDb: jest.fn().mockResolvedValue({
    get: jest.fn().mockResolvedValue(null),
    run: jest.fn().mockResolvedValue({})
  })
}));
jest.mock('../utils/crypto', () => ({ decrypt: jest.fn(v => v) }));
jest.mock('../utils/agents', () => ({ runWorkerAgent: jest.fn() }));
// The real logger's winston-daily-rotate-file transport registers its own background
// timers, which would otherwise contaminate the timer-count assertions below - this
// test is only concerned with what research_daemon.js itself schedules.
jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

const { startDaemon, stopDaemon } = require('../services/research_daemon');

describe('Research Daemon - timer scheduling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Fixed "noon" system time so every run deterministically takes the
    // "outside the 12 AM - 5 AM research window" branch - the exact branch
    // that used to double-schedule its own retry timer.
    jest.setSystemTime(new Date('2026-07-30T12:00:00'));
  });

  afterEach(() => {
    stopDaemon();
    jest.useRealTimers();
  });

  // Unrelated modules pulled in transitively (e.g. the real logger's daily-rotate-file
  // transport) may register their own background timers, so these tests compare the
  // CHANGE in pending-timer count around each daemon action rather than an absolute
  // count - that isolates what the daemon itself is scheduling.

  test('startDaemon schedules exactly one new timer', () => {
    const before = jest.getTimerCount();
    startDaemon();
    expect(jest.getTimerCount() - before).toBe(1);
  });

  test('checkAndRunResearch schedules exactly one follow-up timer, not two', async () => {
    startDaemon();
    const beforeFire = jest.getTimerCount();

    // Fire the initial 10s timer, which invokes checkAndRunResearch(). It should
    // hit the "outside research window" early-return and schedule its retry - and
    // only its retry, not an extra duplicate from a stale `finally` reschedule.
    // One timer fires (removed) and, if fixed, exactly one new one replaces it -
    // a net change of zero. The old bug scheduled two, a net change of +1.
    await jest.advanceTimersByTimeAsync(10000);

    expect(jest.getTimerCount() - beforeFire).toBe(0);
  });

  test('repeated cycles never accumulate extra timers', async () => {
    startDaemon();
    const baseline = jest.getTimerCount();

    // Advance through several full 30-minute "outside window" cycles. If the old
    // double-scheduling bug were still present, this would grow the daemon's own
    // pending timer count on every cycle (net +1 per cycle: 1 -> 2 -> 3 -> 4...).
    for (let i = 0; i < 4; i++) {
      await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
    }

    expect(jest.getTimerCount() - baseline).toBe(0);
  });

  test('stopDaemon clears the daemon\'s own pending timer', () => {
    const before = jest.getTimerCount();
    startDaemon();
    expect(jest.getTimerCount() - before).toBe(1);
    stopDaemon();
    expect(jest.getTimerCount() - before).toBe(0);
  });
});
