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

const GRATITUDE_RE = /\b(thanks|thank you|thx|ty|appreciate it|appreciated)\b/i;
const PRAISE_RE = /\b(good|perfect|great|awesome|excellent|amazing|nice|wonderful|fantastic|brilliant)\b/i;

// Anything suggesting the message carries a real question or request alongside the gratitude/
// praise, so it must NOT be short-circuited - "thanks, can you also check the weather" needs
// the real pipeline, not a canned reply. Deliberately biased toward false negatives (missing a
// fast-path opportunity) over false positives (silently dropping a real request).
// "help" is deliberately NOT bare here - "thank you for your help"/"thanks for helping" are
// gratitude, not requests, so only the imperative phrasings count as a real request signal.
const REQUEST_SIGNAL_RE = /[?]|\b(can you|could you|would you|will you|please|now|also|next|and then|what|when|where|how|why|who|which|do you|should|need|want|help me|help with|can you help|check|find|get me|show me|tell me|give me|go ahead|can we|let's|make|set|turn|run|open|close|start|stop|restart|create|delete|remove|schedule|remind)\b/i;

/**
 * Matches a short message that is purely conversational gratitude/praise with nothing else
 * actionable in it - "thanks!", "that was great, thank you", "perfect, awesome job". These
 * currently pay for the full three-LLM-call pipeline (Communication Specialist translate ->
 * Supervisor decision -> Communication Specialist final response) just to arrive at "no tool
 * needed, say you're welcome" - three chances for a flaky local LLM call to fail on a message
 * that needed zero of them. Capped at 20 words so a longer message isn't misread as pure
 * acknowledgment just because it happens to contain "great" or "thanks" somewhere in it.
 */
function isSimpleAcknowledgment(msg) {
  const clean = (msg || '').trim();
  if (!clean) return false;
  if (clean.split(/\s+/).length > 20) return false;
  if (REQUEST_SIGNAL_RE.test(clean)) return false;
  return GRATITUDE_RE.test(clean) || PRAISE_RE.test(clean);
}

module.exports = {
  isSendMessageCommand,
  isIpOnlyMessage,
  stripSendMessagePrefix,
  isGoogleHomeDeviceRequest,
  isAgentInfoRequest,
  isUserInfoRequest,
  isSimpleAcknowledgment
};
