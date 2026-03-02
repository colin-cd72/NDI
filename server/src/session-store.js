const session = require('express-session');
const Database = require('better-sqlite3');
const path = require('path');

class BetterSQLiteStore extends session.Store {
  constructor(options = {}) {
    super();
    const dbPath = options.dir
      ? path.join(options.dir, options.db || 'sessions.db')
      : path.join(__dirname, '..', 'db', 'sessions.db');

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expired INTEGER NOT NULL
      )
    `);

    // Prepared statements
    this._get = this.db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired > ?');
    this._set = this.db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)');
    this._destroy = this.db.prepare('DELETE FROM sessions WHERE sid = ?');
    this._cleanup = this.db.prepare('DELETE FROM sessions WHERE expired <= ?');

    // Cleanup expired sessions every 15 minutes
    this._cleanupInterval = setInterval(() => {
      this._cleanup.run(Date.now());
    }, 15 * 60 * 1000);
  }

  get(sid, callback) {
    try {
      const row = this._get.get(sid, Date.now());
      if (!row) return callback(null, null);
      callback(null, JSON.parse(row.sess));
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sess, callback) {
    try {
      const maxAge = sess.cookie && sess.cookie.maxAge ? sess.cookie.maxAge : 86400000;
      const expired = Date.now() + maxAge;
      this._set.run(sid, JSON.stringify(sess), expired);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      this._destroy.run(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  clear(callback) {
    try {
      this.db.exec('DELETE FROM sessions');
      callback(null);
    } catch (err) {
      callback(err);
    }
  }
}

module.exports = BetterSQLiteStore;
