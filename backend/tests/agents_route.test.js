const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

// FEAT-5 (docs/REVIEW_2026-08-03.md): GET /api/agents, backed by the real AGENT_PROMPTS proxy
// (utils/agents.js), which discovers agent prompt files from backend/utils/agents/ on disk.

jest.mock('../db', () => ({
  getDb: async () => ({
    get: async () => ({ id: 1 })
  })
}));

const agentsRouter = require('../routes/agents');
const { JWT_SECRET } = require('../middleware/auth');

const app = express();
app.use(express.json());
app.use('/api/agents', agentsRouter);

describe('GET /api/agents', () => {
  const token = jwt.sign({ id: 1, username: 'testuser' }, JWT_SECRET);

  test('returns 401 with no token', async () => {
    const res = await request(app).get('/api/agents');
    expect(res.status).toBe(401);
  });

  test('returns the real, current agent roster from backend/utils/agents/ - not a hardcoded list', async () => {
    const fs = require('fs');
    const path = require('path');
    const expectedNames = fs.readdirSync(path.join(__dirname, '../utils/agents'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => f.slice(0, -3))
      .sort();

    const res = await request(app).get('/api/agents').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.agents)).toBe(true);
    expect(res.body.agents.map((a) => a.name)).toEqual(expectedNames);
    // Known agents that are easy to accidentally forget when hardcoding a roster by hand
    // (docs/IMPLEMENTATION_PLAN.md documents these six as having gone missing before).
    const names = res.body.agents.map((a) => a.name);
    for (const known of ['movie_tv_agent', 'deep_research_agent', 'deep_research_pro_agent', 'course_builder_agent', 'document_generator_agent', 'document_formatter_agent']) {
      expect(names).toContain(known);
    }
  });

  test('each agent has a human-readable displayName derived from its canonical name', async () => {
    const res = await request(app).get('/api/agents').set('Authorization', `Bearer ${token}`);
    const weatherAgent = res.body.agents.find((a) => a.name === 'weather_expert');
    expect(weatherAgent.displayName).toBe('Weather Expert');
  });

  test('agents are sorted alphabetically by canonical name', async () => {
    const res = await request(app).get('/api/agents').set('Authorization', `Bearer ${token}`);
    const names = res.body.agents.map((a) => a.name);
    expect(names).toEqual([...names].sort());
  });
});
