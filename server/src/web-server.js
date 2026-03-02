const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const authRoutes = require('./auth/auth-routes');
const { requireAuth } = require('./auth/auth-middleware');
const streamController = require('./stream-controller');

function createApp() {
  const app = express();

  // Security headers (relaxed CSP for video player)
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'", "wss:", "ws:"],
        mediaSrc: ["'self'", "blob:"],
        workerSrc: ["'self'", "blob:"]
      }
    }
  }));

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // Session store
  const sessionMiddleware = session({
    store: new SQLiteStore({
      dir: path.join(__dirname, '..', 'db'),
      db: 'sessions.db'
    }),
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      sameSite: 'lax'
    }
  });
  app.use(sessionMiddleware);

  // Rate limit login attempts
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    message: { error: 'Too many login attempts, try again later' },
    standardHeaders: true,
    legacyHeaders: false
  });
  app.use('/auth/login', loginLimiter);
  app.use('/auth/setup', loginLimiter);

  // Auth routes
  app.use('/auth', authRoutes);

  // Stream API
  app.get('/api/sources', requireAuth, (req, res) => {
    res.json({ sources: streamController.getSources() });
  });

  app.post('/api/stream/start', requireAuth, (req, res) => {
    const { sourceId } = req.body;
    if (!sourceId) {
      return res.status(400).json({ error: 'sourceId required' });
    }
    const result = streamController.requestStream(sourceId, req.session.userId);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    res.json({ streamPath: result.streamPath });
  });

  app.post('/api/stream/stop', requireAuth, (req, res) => {
    const { sourceId } = req.body;
    if (!sourceId) {
      return res.status(400).json({ error: 'sourceId required' });
    }
    streamController.releaseStream(sourceId, req.session.userId);
    res.json({ ok: true });
  });

  // Static files
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // SPA fallback — serve dashboard for authenticated, login for others
  app.get('*', (req, res) => {
    if (req.session && req.session.userId) {
      res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
    } else {
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    }
  });

  return { app, sessionMiddleware };
}

module.exports = { createApp };
