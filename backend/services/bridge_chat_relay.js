const { llmFetchSignal } = require('../utils/fetchTimeout');

/**
 * Relays one generation turn from a PATTI client to the host's
 * /api/bridge/chat-stream endpoint, parsing the host's SSE stream and dispatching the same
 * callback shape chat_stream_handler.js's runChatStream uses, so routes/chat.js can wire
 * either implementation with nearly identical code depending on PATTI_ROLE.
 *
 * Both real agent thoughts and the host's own "[System] Loading model..." notices arrive as
 * the same 'thought' SSE event (the host can't tell them apart on the wire either - see
 * chat_stream_handler.js) and are both forwarded to onThought. Any 'interrupted' event
 * (the host was busy, or preempted this request mid-stream) is surfaced via onInterrupted
 * rather than thrown, since it's an expected outcome of host-wins arbitration, not a failure.
 */
async function relayChatStreamFromHost({
  hostBridgeUrl,
  hostBridgeSecret,
  message,
  images,
  history,
  onThought,
  onContent,
  onToolCall,
  onAgentStatus,
  onModelUsed,
  onCommandApprovalRequired,
  onInterrupted,
  abortController
}) {
  const endpoint = `${hostBridgeUrl.replace(/\/$/, '')}/api/bridge/chat-stream`;

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${hostBridgeSecret}`
      },
      body: JSON.stringify({ message, images, history }),
      signal: llmFetchSignal(abortController.signal)
    });
  } catch (err) {
    throw new Error(`Could not reach the host: ${err.message}`);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Host returned an error: ${response.status} ${errText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let frameEnd;
    while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);
      if (!frame.trim() || frame.startsWith(':')) continue; // heartbeat comment lines

      let eventName = 'message';
      let dataStr = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
      }
      if (!dataStr) continue;

      let data;
      try {
        data = JSON.parse(dataStr);
      } catch (e) {
        continue;
      }

      switch (eventName) {
        case 'thought':
          onThought(data);
          break;
        case 'content':
          onContent(data);
          break;
        case 'tool':
          onToolCall(data);
          break;
        case 'agent_status':
          onAgentStatus(data);
          break;
        case 'model_used':
          onModelUsed(data.model);
          break;
        case 'command_approval_required':
          onCommandApprovalRequired(data);
          break;
        case 'interrupted':
          onInterrupted(data.message);
          break;
        case 'error':
          throw new Error(data.message || 'The host reported an error generating a response.');
        case 'done':
        default:
          break;
      }
    }
  }
}

module.exports = { relayChatStreamFromHost };
