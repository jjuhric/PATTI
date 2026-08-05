// One-time migration: re-encrypts every DB_ENCRYPTION_SECRET-derived column under a new
// DB_ENCRYPTION_SALT, so the salt can be rotated away from the legacy hardcoded 'salt' value
// (see SEC-9 in docs/REVIEW_2026-08-03.md) without losing access to already-encrypted data.
//
// Usage:
//   DB_ENCRYPTION_SALT_NEW=<random value, e.g. `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`> \
//     node backend/scripts/rotate_encryption_salt.js
//
// Run this BEFORE setting DB_ENCRYPTION_SALT in .env to the new value - it needs to decrypt
// existing data under the current (old) salt first. After it reports success, set
// DB_ENCRYPTION_SALT=<the same value you passed as DB_ENCRYPTION_SALT_NEW> in .env and restart.
require('dotenv').config();
const crypto = require('crypto');
const { getDb } = require('../db');

const ALGORITHM = 'aes-256-gcm';

function deriveKey(secret, salt) {
  return crypto.scryptSync(secret, salt, 32);
}

function encryptWithKey(key, text) {
  if (!text) return text;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decryptWithKey(key, encryptedText) {
  if (!encryptedText) return encryptedText;
  const parts = encryptedText.split(':');
  if (parts.length !== 3) return null; // not encrypted / already plaintext - leave alone
  const [ivHex, authTagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// table, primary key column, list of encrypted columns
const TARGETS = [
  { table: 'users', pk: 'id', columns: ['weather_api_key'] },
  { table: 'user_settings', pk: 'id', columns: ['gemini_key', 'local_key', 'online_key'] },
  { table: 'network_nodes', pk: 'id', columns: ['ssh_password', 'ssh_key'] }
];

async function main() {
  const secret = process.env.DB_ENCRYPTION_SECRET;
  if (!secret) {
    console.error('DB_ENCRYPTION_SECRET is not set - aborting.');
    process.exit(1);
    return;
  }
  const newSalt = process.env.DB_ENCRYPTION_SALT_NEW;
  if (!newSalt) {
    console.error('DB_ENCRYPTION_SALT_NEW is required. See the usage comment at the top of this script.');
    process.exit(1);
    return;
  }
  const oldSalt = process.env.DB_ENCRYPTION_SALT || 'salt';
  if (oldSalt === newSalt) {
    console.error('DB_ENCRYPTION_SALT_NEW matches the current salt already in use - nothing to do.');
    process.exit(1);
    return;
  }

  const oldKey = deriveKey(secret, oldSalt);
  const newKey = deriveKey(secret, newSalt);

  const db = await getDb();
  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const { table, pk, columns } of TARGETS) {
    const rows = await db.all(`SELECT ${pk}, ${columns.join(', ')} FROM ${table}`);
    for (const row of rows) {
      const updates = {};
      for (const col of columns) {
        const value = row[col];
        if (!value) continue;
        let plaintext;
        try {
          plaintext = decryptWithKey(oldKey, value);
        } catch (err) {
          console.warn(`  ! ${table}.${col} (id=${row[pk]}): could not decrypt under the old salt (${err.message}) - left unchanged.`);
          failed++;
          continue;
        }
        if (plaintext === null) {
          skipped++; // not actually encrypted ciphertext - leave as-is
          continue;
        }
        updates[col] = encryptWithKey(newKey, plaintext);
      }
      const updatedCols = Object.keys(updates);
      if (updatedCols.length === 0) continue;
      const setClause = updatedCols.map(c => `${c} = ?`).join(', ');
      await db.run(`UPDATE ${table} SET ${setClause} WHERE ${pk} = ?`, [...updatedCols.map(c => updates[c]), row[pk]]);
      migrated += updatedCols.length;
    }
  }

  console.log(`Done. Re-encrypted ${migrated} column value(s) under the new salt.`);
  if (skipped) console.log(`Left ${skipped} column value(s) unchanged (not recognized as ciphertext).`);
  if (failed) console.log(`Failed to decrypt ${failed} column value(s) under the old salt - check DB_ENCRYPTION_SALT matches what was in use before running this script.`);
  console.log(`Next step: set DB_ENCRYPTION_SALT=${newSalt} in .env and restart PATTI.`);
  process.exit(failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

module.exports = { main, deriveKey, encryptWithKey, decryptWithKey };
