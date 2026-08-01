const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authenticateToken } = require('../middleware/auth');

router.get('/', authenticateToken, async (req, res) => {
  try {
    const db = await getDb();
    const user = await db.get('SELECT name, zipcode, country, temp_unit, weather_api_key, interests, favorite_teams FROM users WHERE id = ?', [req.user.id]);
    
    if (user) {
      const { decrypt } = require('../utils/crypto');
      const maskKey = (key) => {
        if (!key) return '';
        const dec = decrypt(key);
        if (dec.length <= 8) return '••••••••';
        return dec.substring(0, 4) + '••••••••' + dec.substring(dec.length - 4);
      };
      user.weather_api_key = user.weather_api_key ? maskKey(user.weather_api_key) : user.weather_api_key;
      try {
        user.interests = JSON.parse(user.interests || '[]');
      } catch (e) {
        user.interests = [];
      }
      try {
        user.favorite_teams = JSON.parse(user.favorite_teams || '[]');
      } catch (e) {
        user.favorite_teams = [];
      }
    }

    res.json(user || { name: '', zipcode: '', country: 'US', temp_unit: 'imperial', weather_api_key: '', interests: [], favorite_teams: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/', authenticateToken, async (req, res) => {
  const { name, zipcode, country, temp_unit, weather_api_key, interests, favorite_teams } = req.body;
  try {
    const db = await getDb();
    const { encrypt } = require('../utils/crypto');
    const existing = await db.get('SELECT weather_api_key FROM users WHERE id = ?', [req.user.id]);
    const isMasked = (val) => val && val.includes('••');
    // Defense-in-depth against a pasted key with leading/trailing
    // whitespace (a common copy-paste artifact) silently becoming an
    // invalid key once encrypted -- the frontend already trims on input,
    // but any other client (e.g. a direct API call) hits this too.
    const trimmedWeatherKey = weather_api_key ? weather_api_key.trim() : weather_api_key;

    const finalWeatherKey = isMasked(trimmedWeatherKey)
      ? existing?.weather_api_key
      : (trimmedWeatherKey ? encrypt(trimmedWeatherKey) : null);

    const interestsString = JSON.stringify(interests || []);
    const favoriteTeamsString = JSON.stringify(favorite_teams || []);

    await db.run(
      `UPDATE users SET name = ?, zipcode = ?, country = ?, temp_unit = ?, weather_api_key = ?, interests = ?, favorite_teams = ? WHERE id = ?`,
      [name || '', zipcode || '', country || 'US', temp_unit || 'imperial', finalWeatherKey, interestsString, favoriteTeamsString, req.user.id]
    );
    res.json({ success: true, message: 'Profile updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
