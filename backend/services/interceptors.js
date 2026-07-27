// Pure matching predicates used by runAgentLoop (backend/ai.js) to detect direct-action
// requests that should bypass the full Supervisor/worker delegation loop - e.g. "turn off the
// office lights" doesn't need a multi-turn agent conversation, it needs one tool call. These
// were previously inline closures with zero test coverage; extracted here so the matching logic
// itself (which is exactly the kind of hand-written regex/keyword heuristic that silently drifts)
// can be tested directly instead of only indirectly through a full runAgentLoop integration test.
//
// The stateful handler bodies that act on a match (DB lookups, tool dispatch, response
// generation) remain in ai.js for now - they're deeply coupled to runAgentLoop's local closure
// (settings, history, provider config, streaming callbacks) and extracting them is a separate,
// larger undertaking better done on its own. See docs/IMPLEMENTATION_PLAN.md.

const SEND_MESSAGE_PREFIX_RE = /^\s*send\s+(?:a\s+)?message\s+to\s+(?:device|esp32|esp)\b/i;
const IP_ONLY_RE = /^\s*(?:\d{1,3}\.){3}\d{1,3}\s*$/i;

/** Matches "send a message to device/esp32/esp ..." - the direct send-message command form. */
function isSendMessageCommand(msg) {
  return SEND_MESSAGE_PREFIX_RE.test((msg || '').trim().toLowerCase());
}

/** Matches a message that is nothing but a bare IPv4 address - the reply to "which device?". */
function isIpOnlyMessage(msg) {
  return IP_ONLY_RE.test((msg || '').trim().toLowerCase());
}

/** Strips the "send message to X" prefix, leaving whatever text follows (further trimmed by the caller). */
function stripSendMessagePrefix(text) {
  return text.replace(SEND_MESSAGE_PREFIX_RE, '');
}

const GOOGLE_HOME_LOCATIONS = [
  'office', 'living room', 'bedroom', 'faith\'s room', 'jeffery\'s room', 'all'
];

const GOOGLE_HOME_DEVICES = [
  'light', 'lights', 'tv', 't.v.', 'television', 'fan', 'plug', 'speaker',
  'nest', 'mini', 'display', 'screen', 'air conditioner', 'ac', 'heater',
  'switch', 'plug', 'device', 'thermostat', 'camera'
];

const GOOGLE_HOME_ACTION_RE = /\b(turn|make|set|dim|brighten|increase|decrease|pause|resume|stop|play)\b/i;

/**
 * Matches a direct smart-home command - a message naming both a known location and a known
 * device, plus an action verb (e.g. "turn off the office lights"). Requires all three parts:
 * a lone device name or a lone location name is too ambiguous to bypass the Supervisor for.
 */
function isGoogleHomeDeviceRequest(msg) {
  const cleanMsg = (msg || '').trim().toLowerCase();

  const matchedLoc = GOOGLE_HOME_LOCATIONS.find((loc) => new RegExp(`\\b${loc.replace("'", "\\'")}\\b`, 'i').test(cleanMsg));
  const matchedDev = GOOGLE_HOME_DEVICES.find((dev) => {
    const escapedDev = dev.replace('.', '\\.').replace("'", "\\'");
    return new RegExp(`\\b${escapedDev}\\b`, 'i').test(cleanMsg);
  });

  if (!matchedLoc || !matchedDev) return false;

  return GOOGLE_HOME_ACTION_RE.test(cleanMsg);
}

const AGENT_INFO_KEYWORDS = [
  'your info', 'your information', 'about you', 'who are you',
  'your specs', 'your host', 'your system', 'your settings', 'your name'
];

/** Matches "what are you"-style requests, routed straight to system_specialist. */
function isAgentInfoRequest(msg) {
  const cleanMsg = (msg || '').trim().toLowerCase();
  return AGENT_INFO_KEYWORDS.some((kw) => cleanMsg.includes(kw));
}

const USER_INFO_KEYWORDS = [
  'my info', 'my information', 'about me', 'who am i',
  'my details', 'my profile', 'my name', 'my birthday',
  'my dob', 'my zipcode', 'my location', 'my age',
  'my gender', 'my interests'
];

/** Matches "what do you know about me"-style requests, routed straight to memory_agent. */
function isUserInfoRequest(msg) {
  const cleanMsg = (msg || '').trim().toLowerCase();
  return USER_INFO_KEYWORDS.some((kw) => cleanMsg.includes(kw));
}

module.exports = {
  isSendMessageCommand,
  isIpOnlyMessage,
  stripSendMessagePrefix,
  isGoogleHomeDeviceRequest,
  isAgentInfoRequest,
  isUserInfoRequest
};
