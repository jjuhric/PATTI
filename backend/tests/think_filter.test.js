const { ThinkTagFilter, stripThinkTags } = require('../llm/think_filter');

describe('stripThinkTags', () => {
  test('removes a <think> block and trims', () => {
    expect(stripThinkTags('<think>internal reasoning</think>Final answer.')).toBe('Final answer.');
  });

  test('removes an <|channel>thought block', () => {
    expect(stripThinkTags('<|channel>thought reasoning here<channel|>Final answer.')).toBe('Final answer.');
  });

  test('passes plain text through unchanged (aside from trim)', () => {
    expect(stripThinkTags('  hello there  ')).toBe('hello there');
  });
});

describe('ThinkTagFilter', () => {
  function run(chunks) {
    const emitted = [];
    const filter = new ThinkTagFilter((text) => emitted.push(text));
    for (const chunk of chunks) filter.feed(chunk);
    filter.end();
    return { text: emitted.join(''), hasVisibleContent: filter.hasVisibleContent };
  }

  test('passes plain text through with no tags', () => {
    const { text, hasVisibleContent } = run(['Hello', ' there']);
    expect(text).toBe('Hello there');
    expect(hasVisibleContent).toBe(true);
  });

  test('strips a <think> block delivered in a single chunk', () => {
    const { text } = run(['<think>reasoning</think>Final answer.']);
    expect(text).toBe('Final answer.');
  });

  test('strips a <think> block whose open tag is split across chunk boundaries', () => {
    const { text } = run(['Before<thi', 'nk>reasoning</thi', 'nk>After']);
    expect(text).toBe('BeforeAfter');
  });

  test('strips a <think> block split token-by-token', () => {
    const chunks = 'Hi <think>let me think about this</think> there!'.split('');
    const { text } = run(chunks);
    expect(text).toBe('Hi  there!');
  });

  test('strips multiple separate <think> blocks in one stream', () => {
    const { text } = run(['<think>one</think>A<think>two</think>B']);
    expect(text).toBe('AB');
  });

  test('strips the <|channel>thought / <channel|> variant', () => {
    const { text } = run(['Hi <|channel>thought reasoning here<channel|> there!']);
    expect(text).toBe('Hi  there!');
  });

  test('drops an unterminated <think> block at end of stream rather than leaking it', () => {
    const { text, hasVisibleContent } = run(['Answer so far. <think>this reasoning never closes']);
    expect(text).toBe('Answer so far. ');
    expect(hasVisibleContent).toBe(true);
  });

  test('reports hasVisibleContent=false when the stream is pure reasoning with no answer', () => {
    const { text, hasVisibleContent } = run(['<think>only reasoning, no real answer</think>']);
    expect(text).toBe('');
    expect(hasVisibleContent).toBe(false);
  });

  test('does not mistake ordinary text resembling a tag prefix for a real tag', () => {
    const { text } = run(['Use a < sign, then think about it, then >close it.']);
    expect(text).toBe('Use a < sign, then think about it, then >close it.');
  });
});
