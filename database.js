const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const DB_FILE = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(DB_FILE);

// Encryption settings
const ALGORITHM = 'aes-256-cbc';
// Ensure ENCRYPTION_KEY is 32 bytes and ENCRYPTION_IV is 16 bytes.
// Fallback to static secrets for local ease of use, but warn in production.
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY 
  ? crypto.scryptSync(process.env.ENCRYPTION_KEY, 'salt', 32)
  : Buffer.from('f98c76dae4b3c2d1e0f98c76dae4b3c2', 'utf-8'); // 32-byte fallback
const ENCRYPTION_IV = process.env.ENCRYPTION_IV
  ? crypto.scryptSync(process.env.ENCRYPTION_IV, 'salt', 16)
  : Buffer.from('e0f98c76dae4b3c2', 'utf-8'); // 16-byte fallback

// Helpers for encryption
function encrypt(text) {
  if (!text) return '';
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, ENCRYPTION_IV);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

function decrypt(text) {
  if (!text) return '';
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, ENCRYPTION_IV);
    let decrypted = decipher.update(text, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('Decryption failed:', err.message);
    return null;
  }
}

// Initialize database schema
function initDatabase() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`
        CREATE TABLE IF NOT EXISTS users (
          chat_id INTEGER PRIMARY KEY,
          email TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          sections TEXT DEFAULT '{}',
          registered_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) {
          console.error('Error creating database schema:', err);
          reject(err);
        } else {
          console.log('[DB] Database schema initialized successfully.');
          resolve();
        }
      });
    });
  });
}

// DB Operations
function saveUser(chatId, email, password) {
  return new Promise((resolve, reject) => {
    const encryptedPassword = encrypt(password);
    db.run(`
      INSERT INTO users (chat_id, email, password)
      VALUES (?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        email = excluded.email,
        password = excluded.password
    `, [chatId, email.toLowerCase(), encryptedPassword], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve({ chatId, email });
      }
    });
  });
}

function saveUserSections(chatId, sections) {
  return new Promise((resolve, reject) => {
    const sectionsJson = JSON.stringify(sections);
    db.run(`
      UPDATE users SET sections = ? WHERE chat_id = ?
    `, [sectionsJson, chatId], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function getUser(chatId) {
  return new Promise((resolve, reject) => {
    db.get(`
      SELECT chat_id, email, password, sections, registered_at FROM users WHERE chat_id = ?
    `, [chatId], (err, row) => {
      if (err) {
        reject(err);
      } else if (!row) {
        resolve(null);
      } else {
        resolve({
          chatId: row.chat_id,
          email: row.email,
          password: decrypt(row.password),
          sections: JSON.parse(row.sections || '{}'),
          registeredAt: row.registered_at
        });
      }
    });
  });
}

function getUserByEmail(email) {
  return new Promise((resolve, reject) => {
    db.get(`
      SELECT chat_id, email, password, sections, registered_at FROM users WHERE email = ?
    `, [email.toLowerCase()], (err, row) => {
      if (err) {
        reject(err);
      } else if (!row) {
        resolve(null);
      } else {
        resolve({
          chatId: row.chat_id,
          email: row.email,
          password: decrypt(row.password),
          sections: JSON.parse(row.sections || '{}'),
          registeredAt: row.registered_at
        });
      }
    });
  });
}

function getAllUsers() {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT chat_id, email, password, sections, registered_at FROM users
    `, [], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        const users = rows.map(row => ({
          chatId: row.chat_id,
          email: row.email,
          password: decrypt(row.password),
          sections: JSON.parse(row.sections || '{}'),
          registeredAt: row.registered_at
        }));
        resolve(users);
      }
    });
  });
}

function deleteUser(chatId) {
  return new Promise((resolve, reject) => {
    db.run(`
      DELETE FROM users WHERE chat_id = ?
    `, [chatId], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve(this.changes > 0);
      }
    });
  });
}

module.exports = {
  initDatabase,
  saveUser,
  saveUserSections,
  getUser,
  getUserByEmail,
  getAllUsers,
  deleteUser
};
