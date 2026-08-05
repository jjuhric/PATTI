const { handleUserFeedback, getInjectedContext } = require('../services/feedback_learning');
const { storeLearnedBehavior, searchLearnedBehaviors } = require('../utils/embeddings');

jest.mock('../utils/embeddings', () => {
  const actual = jest.requireActual('../utils/embeddings');
  return {
    ...actual,
    storeLearnedBehavior: jest.fn().mockResolvedValue(),
    searchLearnedBehaviors: jest.fn().mockResolvedValue([
      {
        text: 'original prompt text',
        metadata: { type: 'correction', correctAgent: 'weather_expert', userPrompt: 'original prompt text' },
        score: 0.9
      },
      {
        text: 'another prompt text',
        metadata: { type: 'success', userPrompt: 'another prompt text' },
        score: 0.9
      }
    ])
  };
});

describe('Continuous Learning & Feedback System Tests', () => {
  let mockDb;

  beforeAll(() => {
    mockDb = {
      all: jest.fn().mockResolvedValue([
        { id: 2, role: 'assistant', content: 'Here is some code.' },
        { id: 1, role: 'user', content: 'What is the weather like?' }
      ])
    };
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('handleUserFeedback: detects corrections and saves them', async () => {
    await handleUserFeedback(mockDb, 1, 101, 'No, you should ask weather_expert');
    expect(storeLearnedBehavior).toHaveBeenCalledWith(
      'What is the weather like?',
      expect.objectContaining({
        type: 'correction',
        correctAgent: 'weather_expert',
        feedback: 'No, you should ask weather_expert'
      })
    );
  });

  test('handleUserFeedback: detects positive reinforcement and saves it', async () => {
    await handleUserFeedback(mockDb, 1, 101, 'This is perfect, thank you!');
    expect(storeLearnedBehavior).toHaveBeenCalledWith(
      'What is the weather like?',
      expect.objectContaining({
        type: 'success',
        feedback: 'This is perfect, thank you!'
      })
    );
  });

  test('BUG-13: handleUserFeedback attributes success feedback to the agent(s) actually used', async () => {
    mockDb.all.mockResolvedValueOnce([
      { id: 2, role: 'assistant', content: 'Here is the forecast.', agents_used: JSON.stringify(['weather_expert']) },
      { id: 1, role: 'user', content: 'What is the weather like?' }
    ]);

    await handleUserFeedback(mockDb, 1, 101, 'Perfect, thanks!');
    expect(storeLearnedBehavior).toHaveBeenCalledWith(
      'What is the weather like?',
      expect.objectContaining({ type: 'success', agentsUsed: ['weather_expert'] })
    );
  });

  test('BUG-13: handleUserFeedback records an empty agentsUsed when the previous message has none', async () => {
    // The default mockDb.all resolves rows with no agents_used column at all.
    await handleUserFeedback(mockDb, 1, 101, 'This is perfect, thank you!');
    expect(storeLearnedBehavior).toHaveBeenCalledWith(
      'What is the weather like?',
      expect.objectContaining({ type: 'success', agentsUsed: [] })
    );
  });

  test('BUG-13: handleUserFeedback attributes a correction to what was actually used, alongside the corrected-to agent', async () => {
    mockDb.all.mockResolvedValueOnce([
      { id: 2, role: 'assistant', content: 'Some unrelated answer.', agents_used: JSON.stringify(['movie_tv_agent']) },
      { id: 1, role: 'user', content: 'What is the weather like?' }
    ]);

    await handleUserFeedback(mockDb, 1, 101, 'No, you should ask weather_expert');
    expect(storeLearnedBehavior).toHaveBeenCalledWith(
      'What is the weather like?',
      expect.objectContaining({ type: 'correction', correctAgent: 'weather_expert', agentsUsed: ['movie_tv_agent'] })
    );
  });

  test('getInjectedContext: returns prompt context for similar past queries', async () => {
    const context = await getInjectedContext('What is the weather?');
    expect(context).toContain('### CRITICAL: LEARNED ROUTING DIRECTIVES');
    expect(context).toContain('weather_expert');
  });

  test('BUG-13: getInjectedContext names the actual agent(s) for a success record that has attribution', async () => {
    searchLearnedBehaviors.mockResolvedValueOnce([
      {
        text: 'movie prompt',
        metadata: { type: 'success', userPrompt: 'movie prompt', agentsUsed: ['movie_tv_agent'] },
        score: 0.9
      }
    ]);
    const context = await getInjectedContext('recommend a movie');
    expect(context).toContain('delegate to **movie_tv_agent**');
  });

  test('BUG-13: getInjectedContext says "answered directly" for a success record with no delegation', async () => {
    searchLearnedBehaviors.mockResolvedValueOnce([
      {
        text: 'chitchat prompt',
        metadata: { type: 'success', userPrompt: 'chitchat prompt', agentsUsed: [] },
        score: 0.9
      }
    ]);
    const context = await getInjectedContext('say hello');
    expect(context).toContain('answered directly with no sub-agent delegation');
  });
});
