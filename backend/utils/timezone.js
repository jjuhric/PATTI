/**
 * Resolves "now" (or an optional past `at` timestamp) into a given IANA timezone's local hour
 * (0-23), calendar date (YYYY-MM-DD), and weekday (3-letter lowercase, e.g. 'mon'), with no
 * external API call - `users.timezone` is already a real IANA zone string, so Intl can do this
 * directly. Shared by utils/briefing.js and utils/recurring_tasks_scheduler.js.
 */
function getUserLocalNow(timezone, at = new Date()) {
  const tz = timezone || 'America/Chicago';
  const hourStr = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(at);
  // Some ICU versions format midnight as "24" rather than "00" - normalize either way.
  const hour = parseInt(hourStr, 10) % 24;
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(at); // YYYY-MM-DD
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(at).toLowerCase().slice(0, 3);
  return { hour, dateStr, weekday };
}

module.exports = { getUserLocalNow };
