const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const DB_FILE = path.join(__dirname, 'users.json');

// Encryption settings
const ALGORITHM = 'aes-256-cbc';
// Ensure ENCRYPTION_KEY is 32 bytes and ENCRYPTION_IV is 16 bytes.
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

// Read database from file
function readData() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error reading users database:', err);
  }
  return {};
}

// Write database to file
function writeData(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing users database:', err);
  }
}

// Initialize database schema (placeholder for compatibility)
function initDatabase() {
  return new Promise((resolve) => {
    if (!fs.existsSync(DB_FILE)) {
      writeData({});
    }
    console.log('[DB] JSON database initialized successfully.');
    resolve();
  });
}

// DB Operations
function saveUser(chatId, email, password) {
  return new Promise((resolve) => {
    const dbData = readData();
    const encryptedPassword = encrypt(password);
    
    dbData[chatId] = {
      chat_id: Number(chatId),
      email: email.toLowerCase(),
      password: encryptedPassword,
      sections: dbData[chatId]?.sections || '{}', // Keep sections if updating user
      registered_at: dbData[chatId]?.registered_at || new Date().toISOString()
    };
    
    writeData(dbData);
    resolve({ chatId, email });
  });
}

function saveUserSections(chatId, sections) {
  return new Promise((resolve, reject) => {
    const dbData = readData();
    if (!dbData[chatId]) {
      return reject(new Error('User not found.'));
    }
    dbData[chatId].sections = JSON.stringify(sections);
    writeData(dbData);
    resolve();
  });
}

function getUser(chatId) {
  return new Promise((resolve) => {
    const dbData = readData();
    const row = dbData[chatId];
    if (!row) {
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
}

function getUserByEmail(email) {
  return new Promise((resolve) => {
    const dbData = readData();
    const foundKey = Object.keys(dbData).find(key => dbData[key].email === email.toLowerCase());
    const row = foundKey ? dbData[foundKey] : null;
    
    if (!row) {
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
}

function getAllUsers() {
  return new Promise((resolve) => {
    const dbData = readData();
    const users = Object.keys(dbData).map(key => {
      const row = dbData[key];
      return {
        chatId: row.chat_id,
        email: row.email,
        password: decrypt(row.password),
        sections: JSON.parse(row.sections || '{}'),
        registeredAt: row.registered_at
      };
    });
    resolve(users);
  });
}

function deleteUser(chatId) {
  return new Promise((resolve) => {
    const dbData = readData();
    if (dbData[chatId]) {
      delete dbData[chatId];
      writeData(dbData);
      resolve(true);
    } else {
      resolve(false);
    }
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
