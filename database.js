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
    const queryUsers = `
      CREATE TABLE IF NOT EXISTS users (
        chat_id BIGINT PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        password TEXT NOT NULL,
        sections TEXT NOT NULL DEFAULT '{}',
        registered_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await pool.query(queryUsers);
    
    // Dynamically alter schema to add schedule state tracking column
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_schedule_state TEXT DEFAULT '{}';`);
    
    const queryShares = `
      CREATE TABLE IF NOT EXISTS calendar_shares (
        requester BIGINT NOT NULL,
        receiver BIGINT NOT NULL,
        status VARCHAR(20) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (requester, receiver)
      );
    `;
    await pool.query(queryShares);

    const queryNotes = `
      CREATE TABLE IF NOT EXISTS session_notes (
        chat_id BIGINT NOT NULL,
        session_id VARCHAR(255) NOT NULL,
        note TEXT NOT NULL,
        PRIMARY KEY (chat_id, session_id)
      );
    `;
    await pool.query(queryNotes);
    console.log('[DB] PostgreSQL database tables initialized successfully.');
  } else {
    if (!fs.existsSync(DB_FILE)) {
      writeData({ shares: [], session_notes: {} });
    } else {
      const dbData = readData();
      let updated = false;
      if (!dbData.shares) {
        dbData.shares = [];
        updated = true;
      }
      if (!dbData.session_notes) {
        dbData.session_notes = {};
        updated = true;
      }
      if (updated) {
        writeData(dbData);
      }
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
      last_schedule_state: dbData[chatId]?.last_schedule_state || '{}',
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
    const foundKey = Object.keys(dbData)
      .filter(key => key !== 'shares' && key !== 'session_notes')
      .find(key => dbData[key].email === normalizedEmail);
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
    return Object.keys(dbData)
      .filter(key => key !== 'shares' && key !== 'session_notes')
      .map(key => {
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
    // Delete sharing links, notes, and user
    await pool.query(`DELETE FROM calendar_shares WHERE requester = $1 OR receiver = $1;`, [chatId]);
    await pool.query(`DELETE FROM session_notes WHERE chat_id = $1;`, [chatId]);
    const query = `DELETE FROM users WHERE chat_id = $1;`;
    const res = await pool.query(query, [chatId]);
    return res.rowCount > 0;
  } else {
    const dbData = readData();
    if (dbData[chatId]) {
      delete dbData[chatId];
      if (dbData.shares) {
        const cid = Number(chatId);
        dbData.shares = dbData.shares.filter(s => Number(s.requester) !== cid && Number(s.receiver) !== cid);
      }
      if (dbData.session_notes && dbData.session_notes[chatId]) {
        delete dbData.session_notes[chatId];
      }
      writeData(dbData);
      return true;
    }
    return false;
  }
}

// Schedule state tracking helper methods
async function saveUserScheduleState(chatId, state) {
  const stateStr = typeof state === 'string' ? state : JSON.stringify(state);
  if (pool) {
    const query = `UPDATE users SET last_schedule_state = $2 WHERE chat_id = $1;`;
    await pool.query(query, [chatId, stateStr]);
  } else {
    const dbData = readData();
    if (dbData[chatId]) {
      dbData[chatId].last_schedule_state = stateStr;
      writeData(dbData);
    }
  }
}

async function getUserScheduleState(chatId) {
  if (pool) {
    const query = `SELECT last_schedule_state FROM users WHERE chat_id = $1;`;
    const res = await pool.query(query, [chatId]);
    if (res.rows.length === 0) return {};
    try {
      return JSON.parse(res.rows[0].last_schedule_state || '{}');
    } catch {
      return {};
    }
  } else {
    const dbData = readData();
    const row = dbData[chatId];
    if (!row || !row.last_schedule_state) return {};
    try {
      return JSON.parse(row.last_schedule_state || '{}');
    } catch {
      return {};
    }
  }
}

// Mutual consent calendar sharing helper methods
async function createShareRequest(requesterId, receiverId) {
  const reqId = Number(requesterId);
  const recId = Number(receiverId);

  if (pool) {
    // Check if there is already a pending request from receiver to requester
    const checkQuery = `SELECT * FROM calendar_shares WHERE requester = $2 AND receiver = $1 AND status = 'pending';`;
    const checkRes = await pool.query(checkQuery, [reqId, recId]);

    if (checkRes.rows.length > 0) {
      // Mutual handshake! Transition relationship status to accepted
      const updateQuery = `UPDATE calendar_shares SET status = 'accepted' WHERE requester = $2 AND receiver = $1;`;
      await pool.query(updateQuery, [reqId, recId]);
      return 'accepted';
    } else {
      // Create new pending request (requester -> receiver)
      const insertQuery = `
        INSERT INTO calendar_shares (requester, receiver, status)
        VALUES ($1, $2, 'pending')
        ON CONFLICT (requester, receiver) DO NOTHING;
      `;
      await pool.query(insertQuery, [reqId, recId]);
      return 'pending';
    }
  } else {
    const dbData = readData();
    if (!dbData.shares) dbData.shares = [];

    // Check if there is already a pending request from receiver to requester
    const index = dbData.shares.findIndex(s => Number(s.requester) === recId && Number(s.receiver) === reqId && s.status === 'pending');
    if (index !== -1) {
      dbData.shares[index].status = 'accepted';
      writeData(dbData);
      return 'accepted';
    } else {
      // Create new pending request
      const exists = dbData.shares.some(s => Number(s.requester) === reqId && Number(s.receiver) === recId);
      if (!exists) {
        dbData.shares.push({
          requester: reqId,
          receiver: recId,
          status: 'pending',
          created_at: new Date().toISOString()
        });
        writeData(dbData);
      }
      return 'pending';
    }
  }
}

async function getShares(chatId) {
  const cid = Number(chatId);
  if (pool) {
    const query = `
      SELECT cs.*, 
             u1.email AS req_email,
             u2.email AS rec_email
      FROM calendar_shares cs
      JOIN users u1 ON cs.requester = u1.chat_id
      JOIN users u2 ON cs.receiver = u2.chat_id
      WHERE cs.requester = $1 OR cs.receiver = $1;
    `;
    const res = await pool.query(query, [cid]);
    return res.rows.map(row => {
      const isRequester = Number(row.requester) === cid;
      const friendId = isRequester ? Number(row.receiver) : Number(row.requester);
      const friendEmail = isRequester ? row.rec_email : row.req_email;
      return {
        friendId,
        friendEmail,
        status: row.status,
        isRequester
      };
    });
  } else {
    const dbData = readData();
    const shares = dbData.shares || [];
    const results = [];
    
    shares.forEach(s => {
      const reqId = Number(s.requester);
      const recId = Number(s.receiver);
      if (reqId === cid || recId === cid) {
        const isRequester = reqId === cid;
        const friendId = isRequester ? recId : reqId;
        const friendRow = dbData[friendId];
        const friendEmail = friendRow ? friendRow.email : 'Unknown';
        results.push({
          friendId,
          friendEmail,
          status: s.status,
          isRequester
        });
      }
    });
    return results;
  }
}

async function deleteShare(chatId, friendChatId) {
  const cid = Number(chatId);
  const fid = Number(friendChatId);
  
  if (pool) {
    const query = `
      DELETE FROM calendar_shares 
      WHERE (requester = $1 AND receiver = $2) 
         OR (requester = $2 AND receiver = $1);
    `;
    const res = await pool.query(query, [cid, fid]);
    return res.rowCount > 0;
  } else {
    const dbData = readData();
    const shares = dbData.shares || [];
    const initialLen = shares.length;
    
    dbData.shares = shares.filter(s => {
      const req = Number(s.requester);
      const rec = Number(s.receiver);
      return !((req === cid && rec === fid) || (req === fid && rec === cid));
    });
    
    if (dbData.shares.length < initialLen) {
      writeData(dbData);
      return true;
    }
    return false;
  }
}

async function areFriends(chatIdA, chatIdB) {
  const idA = Number(chatIdA);
  const idB = Number(chatIdB);
  
  if (pool) {
    const query = `
      SELECT * FROM calendar_shares 
      WHERE ((requester = $1 AND receiver = $2) OR (requester = $2 AND receiver = $1))
        AND status = 'accepted';
    `;
    const res = await pool.query(query, [idA, idB]);
    return res.rows.length > 0;
  } else {
    const dbData = readData();
    const shares = dbData.shares || [];
    return shares.some(s => {
      const req = Number(s.requester);
      const rec = Number(s.receiver);
      return ((req === idA && rec === idB) || (req === idB && rec === idA)) && s.status === 'accepted';
    });
  }
}

// Session notes/reminders database helpers
async function saveSessionNote(chatId, sessionId, note) {
  const cid = Number(chatId);
  if (pool) {
    const query = `
      INSERT INTO session_notes (chat_id, session_id, note)
      VALUES ($1, $2, $3)
      ON CONFLICT (chat_id, session_id)
      DO UPDATE SET note = EXCLUDED.note;
    `;
    await pool.query(query, [cid, sessionId, note]);
  } else {
    const dbData = readData();
    if (!dbData.session_notes) dbData.session_notes = {};
    if (!dbData.session_notes[cid]) dbData.session_notes[cid] = {};
    dbData.session_notes[cid][sessionId] = note;
    writeData(dbData);
  }
}

async function getSessionNotes(chatId) {
  const cid = Number(chatId);
  if (pool) {
    const query = `SELECT session_id, note FROM session_notes WHERE chat_id = $1;`;
    const res = await pool.query(query, [cid]);
    const notes = {};
    res.rows.forEach(row => {
      notes[row.session_id] = row.note;
    });
    return notes;
  } else {
    const dbData = readData();
    if (!dbData.session_notes || !dbData.session_notes[cid]) return {};
    return dbData.session_notes[cid];
  }
}

async function deleteSessionNote(chatId, sessionId) {
  const cid = Number(chatId);
  if (pool) {
    const query = `DELETE FROM session_notes WHERE chat_id = $1 AND session_id = $2;`;
    await pool.query(query, [cid, sessionId]);
  } else {
    const dbData = readData();
    if (dbData.session_notes && dbData.session_notes[cid] && dbData.session_notes[cid][sessionId]) {
      delete dbData.session_notes[cid][sessionId];
      writeData(dbData);
    }
  }
}

module.exports = {
  initDatabase,
  saveUser,
  saveUserSections,
  getUser,
  getUserByEmail,
  getAllUsers,
  deleteUser,
  saveUserScheduleState,
  getUserScheduleState,
  createShareRequest,
  getShares,
  deleteShare,
  areFriends,
  saveSessionNote,
  getSessionNotes,
  deleteSessionNote
};
