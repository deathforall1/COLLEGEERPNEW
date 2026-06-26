const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { Pool } = require('pg');

const DB_FILE = path.join(__dirname, 'users.json');
const DATABASE_URL = process.env.DATABASE_URL;

let pool = null;
if (DATABASE_URL) {
  console.log('[DB] DATABASE_URL detected. Configuring PostgreSQL connection pool.');
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
      rejectUnauthorized: false // Required for Render/Supabase connection
    }
  });
} else {
  console.log('[DB] No DATABASE_URL detected. Falling back to local users.json.');
}

// Encryption settings
const ALGORITHM = 'aes-256-cbc';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY 
  ? crypto.scryptSync(process.env.ENCRYPTION_KEY, 'salt', 32)
  : Buffer.from('f98c76dae4b3c2d1e0f98c76dae4b3c2', 'utf-8');
const ENCRYPTION_IV = process.env.ENCRYPTION_IV
  ? crypto.scryptSync(process.env.ENCRYPTION_IV, 'salt', 16)
  : Buffer.from('e0f98c76dae4b3c2', 'utf-8');

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

// Local JSON File operations
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

function writeData(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing users database:', err);
  }
}

// Initialize database schema
async function initDatabase() {
  if (pool) {
    const query = `
      CREATE TABLE IF NOT EXISTS users (
        chat_id BIGINT PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        password TEXT NOT NULL,
        sections TEXT NOT NULL DEFAULT '{}',
        registered_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await pool.query(query);
    console.log('[DB] PostgreSQL database tables initialized successfully.');
  } else {
    if (!fs.existsSync(DB_FILE)) {
      writeData({});
    }
    console.log('[DB] JSON database initialized successfully.');
  }
}

// DB Operations
async function saveUser(chatId, email, password) {
  const encryptedPassword = encrypt(password);
  const normalizedEmail = email.toLowerCase().trim();
  
  if (pool) {
    const query = `
      INSERT INTO users (chat_id, email, password, sections)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (chat_id)
      DO UPDATE SET email = EXCLUDED.email, password = EXCLUDED.password;
    `;
    // Fetch sections if they already exist to preserve them
    const existing = await getUser(chatId);
    const sections = existing ? JSON.stringify(existing.sections) : '{}';
    
    await pool.query(query, [chatId, normalizedEmail, encryptedPassword, sections]);
    return { chatId, email: normalizedEmail };
  } else {
    const dbData = readData();
    dbData[chatId] = {
      chat_id: Number(chatId),
      email: normalizedEmail,
      password: encryptedPassword,
      sections: dbData[chatId]?.sections || '{}',
      registered_at: dbData[chatId]?.registered_at || new Date().toISOString()
    };
    writeData(dbData);
    return { chatId, email: normalizedEmail };
  }
}

async function saveUserSections(chatId, sections) {
  if (pool) {
    const query = `UPDATE users SET sections = $2 WHERE chat_id = $1;`;
    const res = await pool.query(query, [chatId, JSON.stringify(sections)]);
    if (res.rowCount === 0) {
      throw new Error('User not found.');
    }
  } else {
    const dbData = readData();
    if (!dbData[chatId]) {
      throw new Error('User not found.');
    }
    dbData[chatId].sections = JSON.stringify(sections);
    writeData(dbData);
  }
}

async function getUser(chatId) {
  if (pool) {
    const query = `SELECT * FROM users WHERE chat_id = $1;`;
    const res = await pool.query(query, [chatId]);
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      chatId: Number(row.chat_id),
      email: row.email,
      password: decrypt(row.password),
      sections: JSON.parse(row.sections || '{}'),
      registeredAt: row.registered_at
    };
  } else {
    const dbData = readData();
    const row = dbData[chatId];
    if (!row) return null;
    return {
      chatId: row.chat_id,
      email: row.email,
      password: decrypt(row.password),
      sections: JSON.parse(row.sections || '{}'),
      registeredAt: row.registered_at
    };
  }
}

async function getUserByEmail(email) {
  const normalizedEmail = email.toLowerCase().trim();
  if (pool) {
    const query = `SELECT * FROM users WHERE email = $1;`;
    const res = await pool.query(query, [normalizedEmail]);
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      chatId: Number(row.chat_id),
      email: row.email,
      password: decrypt(row.password),
      sections: JSON.parse(row.sections || '{}'),
      registeredAt: row.registered_at
    };
  } else {
    const dbData = readData();
    const foundKey = Object.keys(dbData).find(key => dbData[key].email === normalizedEmail);
    const row = foundKey ? dbData[foundKey] : null;
    if (!row) return null;
    return {
      chatId: row.chat_id,
      email: row.email,
      password: decrypt(row.password),
      sections: JSON.parse(row.sections || '{}'),
      registeredAt: row.registered_at
    };
  }
}

async function getAllUsers() {
  if (pool) {
    const query = `SELECT * FROM users;`;
    const res = await pool.query(query);
    return res.rows.map(row => ({
      chatId: Number(row.chat_id),
      email: row.email,
      password: decrypt(row.password),
      sections: JSON.parse(row.sections || '{}'),
      registeredAt: row.registered_at
    }));
  } else {
    const dbData = readData();
    return Object.keys(dbData).map(key => {
      const row = dbData[key];
      return {
        chatId: row.chat_id,
        email: row.email,
        password: decrypt(row.password),
        sections: JSON.parse(row.sections || '{}'),
        registeredAt: row.registered_at
      };
    });
  }
}

async function deleteUser(chatId) {
  if (pool) {
    const query = `DELETE FROM users WHERE chat_id = $1;`;
    const res = await pool.query(query, [chatId]);
    return res.rowCount > 0;
  } else {
    const dbData = readData();
    if (dbData[chatId]) {
      delete dbData[chatId];
      writeData(dbData);
      return true;
    }
    return false;
  }
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
