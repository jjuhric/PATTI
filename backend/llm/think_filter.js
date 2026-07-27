// Some local "reasoning" models (DeepSeek-R1 distills, QwQ, certain Qwen/Gemma builds, etc.)
// wrap their internal chain-of-thought in <think>...</think> (or LM Studio's
// <|channel>thought ... <channel|> variant) before their real answer. backend/utils/llm_text.js
// already strips these for single-shot (non-streaming) calls via a simple regex, but the two
// STREAMING call sites (backend/llm/local_stream.js, backend/llm/gemini_stream.js) forward every
// chunk straight to onChunk with no filtering at all - so on a model that uses these tags, the
// user sees raw internal reasoning leak directly into the chat. This is the streaming-safe
// equivalent: tags can arrive split across multiple chunk boundaries, so a plain per-chunk regex
// would either fail to match a split tag or (worse) accidentally strip real content that merely
// resembles a tag prefix.
const TAG_PAIRS = [
  { open: '<think>', close: '</think>' },
  { open: '<|channel>thought', close: '<channel|>' }
];

const ALL_OPEN_TAGS = TAG_PAIRS.map((p) => p.open);

// Given text ending mid-stream, returns the length of the longest trailing suffix that could
// still grow into one of `candidates` with more incoming data - that suffix must be held back
// (not emitted yet) so a tag split across a chunk boundary is never leaked or mangled.
function longestPendingSuffix(text, candidates) {
  const maxLen = Math.min(text.length, Math.max(...candidates.map((c) => c.length)) - 1);
  for (let len = maxLen; len > 0; len--) {
    const suffix = text.slice(text.length - len);
    if (candidates.some((c) => c.startsWith(suffix))) return len;
  }
  return 0;
}

/**
 * Streaming-safe filter that strips <think>/<|channel>thought reasoning blocks out of an
 * incrementally-arriving text stream, forwarding only the visible answer text to `onVisible`.
 * Tracks whether anything non-whitespace was ever actually emitted (`hasVisibleContent`) so
 * callers can detect the degenerate case of a model that only "thought" and never answered.
 */
class ThinkTagFilter {
  constructor(onVisible) {
    this._onVisible = onVisible;
    this._buffer = '';
    this._activeClose = null; // null = not currently inside a reasoning block
    this.hasVisibleContent = false;
  }

  feed(chunk) {
    this._buffer += chunk;
    this._process();
  }

  // Call once the underlying stream has ended. Flushes any content that was held back only
  // because it might have completed into an opening tag - if a reasoning block was left
  // unterminated (the model got cut off mid-thought), that content is deliberately dropped
  // rather than leaked.
  end() {
    if (this._activeClose === null && this._buffer) {
      this._emit(this._buffer);
    }
    this._buffer = '';
  }

  _emit(text) {
    if (!text) return;
    if (text.trim()) this.hasVisibleContent = true;
    this._onVisible(text);
  }

  _process() {
    for (;;) {
      if (this._activeClose === null) {
        let earliestIdx = -1;
        let matchedPair = null;
        for (const pair of TAG_PAIRS) {
          const idx = this._buffer.indexOf(pair.open);
          if (idx !== -1 && (earliestIdx === -1 || idx < earliestIdx)) {
            earliestIdx = idx;
            matchedPair = pair;
          }
        }
        if (matchedPair) {
          this._emit(this._buffer.slice(0, earliestIdx));
          this._buffer = this._buffer.slice(earliestIdx + matchedPair.open.length);
          this._activeClose = matchedPair.close;
          continue;
        }
        const holdLen = longestPendingSuffix(this._buffer, ALL_OPEN_TAGS);
        const emitLen = this._buffer.length - holdLen;
        if (emitLen > 0) {
          this._emit(this._buffer.slice(0, emitLen));
          this._buffer = this._buffer.slice(emitLen);
        }
        return;
      }

      const closeIdx = this._buffer.indexOf(this._activeClose);
      if (closeIdx !== -1) {
        this._buffer = this._buffer.slice(closeIdx + this._activeClose.length);
        this._activeClose = null;
        continue;
      }
      // Still inside a reasoning block with no close tag in sight yet - discard everything
      // except a possible partial close-tag suffix, since reasoning content is never emitted.
      const holdLen = longestPendingSuffix(this._buffer, [this._activeClose]);
      this._buffer = this._buffer.slice(this._buffer.length - holdLen);
      return;
    }
  }
}

// Single-shot equivalent for complete (non-streaming) text, shared with backend/utils/llm_text.js.
function stripThinkTags(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<\|channel>thought[\s\S]*?<channel\|>/g, '')
    .trim();
}

module.exports = { ThinkTagFilter, stripThinkTags };
