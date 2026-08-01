const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

// Mock db.js to use an in-memory database
let mockTestDb = null;
let mockDbError = false;
jest.mock('../db', () => {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const fs = require('fs');
  const path = require('path');

  return {
    getDb: async () => {
      if (mockDbError) throw new Error('Database error');
      if (mockTestDb) return mockTestDb;
      mockTestDb = await open({
        filename: ':memory:',
        driver: sqlite3.Database
      });
      const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
      await mockTestDb.exec(schemaSql);
      return mockTestDb;
    }
  };
});

const profileRouter = require('../routes/profile');
const { JWT_SECRET } = require('../middleware/auth');
const app = express();
app.use(express.json());
app.use('/api/profile', profileRouter);

describe('Profile Router Tests', () => {
  let token;
  let userId;

  beforeAll(async () => {
    // Require internally to avoid out of scope reference in beforeAll
    const { open } = require('sqlite');
    const sqlite3 = require('sqlite3');
    const fs = require('fs');
    const path = require('path');

    const db = await open({
      filename: ':memory:',
      driver: sqlite3.Database
    });
    mockTestDb = db;
    const schemaSql = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
    await mockTestDb.exec(schemaSql);

    // Create user and generate token
    const result = await db.run("INSERT INTO users (username, password_hash) VALUES ('profileuser', 'hashed')");
    userId = result.lastID;
    token = jwt.sign({ id: userId, username: 'profileuser' }, JWT_SECRET);
  });

  afterAll(async () => {
    if (mockTestDb) {
      await mockTestDb.close();
      mockTestDb = null;
    }
  });

  beforeEach(() => {
    mockDbError = false;
  });

  test('GET /api/profile - returns empty profile initially', async () => {
    const res = await request(app)
      .get('/api/profile')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      name: null,
      zipcode: null,
      country: 'US',
      temp_unit: 'imperial',
      weather_api_key: null,
      interests: [],
      favorite_teams: []
    });
  });

  test('PUT /api/profile - updates preferences', async () => {
    const payload = {
      name: 'John Doe',
      zipcode: '90210',
      country: 'CA',
      temp_unit: 'metric',
      weather_api_key: 'apikey123',
      interests: ['Artificial Intelligence', 'Cycling'],
      favorite_teams: ['Dallas Cowboys', 'Texas Rangers']
    };

    const res = await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${token}`)
      .send(payload);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Profile updated successfully.' });

    // Verify GET reflects updates
    const getRes = await request(app)
      .get('/api/profile')
      .set('Authorization', `Bearer ${token}`);

    expect(getRes.statusCode).toBe(200);
    expect(getRes.body.name).toBe(payload.name);
    expect(getRes.body.zipcode).toBe(payload.zipcode);
    expect(getRes.body.country).toBe(payload.country);
    expect(getRes.body.temp_unit).toBe(payload.temp_unit);
    expect(getRes.body.weather_api_key).toBe('apik••••••••y123');
    expect(getRes.body.interests).toEqual(payload.interests);
    expect(getRes.body.favorite_teams).toEqual(payload.favorite_teams);
  });

  test('PUT /api/profile - trims whitespace from a pasted API key before storing', async () => {
    const payload = {
      name: 'John Doe',
      zipcode: '90210',
      country: 'CA',
      temp_unit: 'metric',
      // Simulates a copy-paste artifact (trailing newline/spaces) -- an
      // untrimmed key like this silently fails OpenWeatherMap auth later.
      weather_api_key: '  apikey123  \n',
      interests: [],
      favorite_teams: []
    };

    const res = await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${token}`)
      .send(payload);

    expect(res.statusCode).toBe(200);

    const getRes = await request(app)
      .get('/api/profile')
      .set('Authorization', `Bearer ${token}`);

    // The masked value reveals the first/last 4 characters of what's
    // actually stored -- if it weren't trimmed, the trailing characters
    // would be whitespace instead of "y123".
    expect(getRes.body.weather_api_key).toBe('apik••••••••y123');
  });

  test('PUT /api/profile - preserves existing key when masked key is submitted', async () => {
    const payload = {
      name: 'John Doe',
      zipcode: '90210',
      country: 'CA',
      temp_unit: 'metric',
      weather_api_key: 'apik••••••••y123'
    };

    const res = await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${token}`)
      .send(payload);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Profile updated successfully.' });
  });

  test('PUT /api/profile - updates key to null when empty key is submitted', async () => {
    const payload = {
      name: 'John Doe',
      zipcode: '90210',
      country: 'CA',
      temp_unit: 'metric',
      weather_api_key: ''
    };

    const res = await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${token}`)
      .send(payload);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Profile updated successfully.' });

    const getRes = await request(app)
      .get('/api/profile')
      .set('Authorization', `Bearer ${token}`);
    expect(getRes.body.weather_api_key).toBeNull();
  });

  test('GET /api/profile - masks short keys with full bullet placeholder', async () => {
    // Save a short key
    await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'John Doe',
        zipcode: '90210',
        country: 'CA',
        temp_unit: 'metric',
        weather_api_key: 'short'
      });

    const getRes = await request(app)
      .get('/api/profile')
      .set('Authorization', `Bearer ${token}`);

    expect(getRes.statusCode).toBe(200);
    expect(getRes.body.weather_api_key).toBe('••••••••');
  });

  test('error paths - database failure catches', async () => {
    mockDbError = true;

    const getRes = await request(app)
      .get('/api/profile')
      .set('Authorization', `Bearer ${token}`);
    expect(getRes.statusCode).toBe(500);

    const putRes = await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Error Name' });
    expect(putRes.statusCode).toBe(500);
  });
});
