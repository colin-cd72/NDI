const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const BCRYPT_ROUNDS = 12;
let db;

function init() {
  const dbPath = path.join(__dirname, '..', '..', 'db', 'users.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migration: add allowed_sources column
  try {
    db.exec(`ALTER TABLE users ADD COLUMN allowed_sources TEXT DEFAULT NULL`);
  } catch (e) {
    // Column already exists — ignore
  }

  return db;
}

function hasUsers() {
  const row = db.prepare('SELECT COUNT(*) as count FROM users').get();
  return row.count > 0;
}

async function createUser(username, password, role = 'viewer', email = null) {
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const stmt = db.prepare(
    'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)'
  );
  const result = stmt.run(username, email, hash, role);
  return { id: result.lastInsertRowid, username, email, role };
}

async function verifyPassword(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return null;
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return null;
  return { id: user.id, username: user.username, email: user.email, role: user.role };
}

function getUser(id) {
  const user = db.prepare('SELECT id, username, email, role, allowed_sources, created_at FROM users WHERE id = ?').get(id);
  return user || null;
}

function getAllUsers() {
  return db.prepare('SELECT id, username, email, role, allowed_sources, created_at FROM users').all();
}

function updateAllowedSources(userId, sources) {
  const value = sources === null ? null : JSON.stringify(sources);
  db.prepare('UPDATE users SET allowed_sources = ? WHERE id = ?').run(value, userId);
}

function getAllowedSources(userId) {
  const row = db.prepare('SELECT allowed_sources FROM users WHERE id = ?').get(userId);
  if (!row || row.allowed_sources === null) return null;
  return JSON.parse(row.allowed_sources);
}

function deleteUser(id) {
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return result.changes > 0;
}

module.exports = { init, hasUsers, createUser, verifyPassword, getUser, getAllUsers, deleteUser, updateAllowedSources, getAllowedSources };
