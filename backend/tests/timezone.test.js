const { getUserLocalNow } = require('../utils/timezone');

describe('utils/timezone.js - getUserLocalNow', () => {
  test('resolves hour, date, and weekday for a given IANA timezone at a fixed instant', () => {
    const at = new Date('2026-07-30T15:00:00Z'); // a Thursday in UTC
    // America/Chicago is UTC-5 in July (CDT) -> 15:00 UTC = 10:00 local, still Thursday.
    expect(getUserLocalNow('America/Chicago', at)).toEqual({ hour: 10, dateStr: '2026-07-30', weekday: 'thu' });
    // Pacific/Kiritimati is a fixed UTC+14, no DST -> 15:00 UTC = 05:00 local, next day (Friday).
    expect(getUserLocalNow('Pacific/Kiritimati', at)).toEqual({ hour: 5, dateStr: '2026-07-31', weekday: 'fri' });
  });

  test('falls back to America/Chicago when no timezone is given', () => {
    const at = new Date('2026-07-30T15:00:00Z');
    expect(getUserLocalNow(null, at)).toEqual({ hour: 10, dateStr: '2026-07-30', weekday: 'thu' });
  });

  test('defaults `at` to now when omitted', () => {
    const result = getUserLocalNow('America/Chicago');
    expect(typeof result.hour).toBe('number');
    expect(result.dateStr).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']).toContain(result.weekday);
  });
});
