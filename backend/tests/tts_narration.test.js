jest.mock('../utils/llm_text', () => ({ generateText: jest.fn() }));
jest.mock('../services/ai_queue', () => ({ getState: jest.fn() }));

const { generateText } = require('../utils/llm_text');
const aiQueue = require('../services/ai_queue');
const { narrateForSpeech, looksLikeReport } = require('../utils/tts_narration');

const settings = { provider: 'local' };
const idle = () => aiQueue.getState.mockReturnValue({ isBusy: false, queueLength: 0 });

beforeEach(() => {
  jest.clearAllMocks();
  idle();
});

describe('looksLikeReport', () => {
  test.each([
    ['a markdown heading', '## Weather Report\nSunny today.'],
    ['three or more list items', '- one\n- two\n- three'],
    ['long prose', 'x'.repeat(600)]
  ])('treats %s as a report', (_label, text) => {
    expect(looksLikeReport(text)).toBe(true);
  });

  test.each([
    ['a short reply', 'Sure, it is 72 degrees out.'],
    ['empty text', ''],
    ['a couple of list items', '- one\n- two']
  ])('does not treat %s as a report', (_label, text) => {
    expect(looksLikeReport(text)).toBe(false);
  });
});

describe('narrateForSpeech', () => {
  test('rewrites a report into spoken narration', async () => {
    generateText.mockResolvedValueOnce('It is sunny and about seventy degrees today.');
    const result = await narrateForSpeech(settings, '## Weather\n- Temp: 72F\n- Humidity: 50%\n- Wind: 5mph');
    expect(result).toBe('It is sunny and about seventy degrees today.');
  });

  test('leaves short conversational text alone without calling the model', async () => {
    const text = 'Sure thing!';
    expect(await narrateForSpeech(settings, text)).toBe(text);
    expect(generateText).not.toHaveBeenCalled();
  });

  test('falls back to the original text when narration fails', async () => {
    const report = '## Report\n- a\n- b\n- c';
    generateText.mockRejectedValueOnce(new Error('LLM offline'));
    expect(await narrateForSpeech(settings, report)).toBe(report);
  });

  test('falls back when the model returns nothing usable', async () => {
    const report = '## Report\n- a\n- b\n- c';
    generateText.mockResolvedValueOnce('   ');
    expect(await narrateForSpeech(settings, report)).toBe(report);
  });

  test('yields to in-flight work rather than queueing behind it', async () => {
    aiQueue.getState.mockReturnValue({ isBusy: true, queueLength: 0 });
    const report = '## Report\n- a\n- b\n- c';
    expect(await narrateForSpeech(settings, report)).toBe(report);
    expect(generateText).not.toHaveBeenCalled();
  });

  test('yields when another request is already waiting', async () => {
    aiQueue.getState.mockReturnValue({ isBusy: false, queueLength: 2 });
    const report = '## Report\n- a\n- b\n- c';
    expect(await narrateForSpeech(settings, report)).toBe(report);
    expect(generateText).not.toHaveBeenCalled();
  });
});
