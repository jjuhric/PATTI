const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

jest.mock('../utils/tavily_search', () => ({
  getTavilyUsage: jest.fn(),
  isConfigured: jest.fn()
}));

const { getTavilyUsage, isConfigured } = require('../utils/tavily_search');
const searchUsageRouter = require('../routes/search_usage');
const { JWT_SECRET } = require('../middleware/auth');

jest.mock('../db', () => ({
  getDb: async () => ({
    get: async () => ({ id: 1 })
  })
}));

const app = express();
app.use(express.json());
app.use('/api/search-usage', searchUsageRouter);

describe('Search Usage API Router Tests', () => {
  const token = jwt.sign({ id: 1, username: 'testuser' }, JWT_SECRET);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns 401 with no token', async () => {
    const res = await request(app).get('/api/search-usage');
    expect(res.status).toBe(401);
  });

  test('returns configured:false with zeros when TAVILY_API_KEY is not set', async () => {
    isConfigured.mockReturnValue(false);
    const res = await request(app).get('/api/search-usage').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: false, used: 0, limit: 0 });
    expect(getTavilyUsage).not.toHaveBeenCalled();
  });

  test('returns used/limit when configured and the API call succeeds', async () => {
    isConfigured.mockReturnValue(true);
    getTavilyUsage.mockResolvedValue({ used: 150, limit: 1000 });
    const res = await request(app).get('/api/search-usage').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: true, used: 150, limit: 1000 });
  });

  test('returns 502 when configured but the Tavily API call fails', async () => {
    isConfigured.mockReturnValue(true);
    getTavilyUsage.mockResolvedValue(null);
    const res = await request(app).get('/api/search-usage').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(502);
    expect(res.body.configured).toBe(true);
  });
});
