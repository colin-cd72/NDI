const express = require('express');
const session = require('express-session');
const BetterSQLiteStore = require('./session-store');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const authRoutes = require('./auth/auth-routes');
const { requireAuth, requireAdmin } = require('./auth/auth-middleware');
const streamController = require('./stream-controller');
const userStore = require('./auth/user-store');
const bandwidthMonitor = require('./bandwidth-monitor');
const { broadcastToViewers } = require('./ws-server');

// Broadcast updated sources whenever stream state changes (e.g. grace timer expiry)
streamController.setOnStateChange(() => {
  broadcastToViewers({ type: 'sources', sources: streamController.getSources() });
});

function createApp() {
  const app = express();

  // Trust nginx proxy (required for secure cookies + rate limiter behind reverse proxy)
  app.set('trust proxy', 1);

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

  // Session store (synchronous better-sqlite3)
  const sessionMiddleware = session({
    store: new BetterSQLiteStore({
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
    const allSources = streamController.getSources();
    const allowed = userStore.getAllowedSources(req.session.userId);
    if (allowed === null) {
      return res.json({ sources: allSources });
    }
    res.json({ sources: allSources.filter(s => allowed.includes(s.id)) });
  });

  app.post('/api/stream/start', requireAuth, (req, res) => {
    const { sourceId } = req.body;
    if (!sourceId) {
      return res.status(400).json({ error: 'sourceId required' });
    }

    // Check source access permission
    const allowed = userStore.getAllowedSources(req.session.userId);
    if (allowed !== null && !allowed.includes(sourceId)) {
      return res.status(403).json({ error: 'You do not have access to this source' });
    }

    const viewerId = req.sessionID || req.session.userId;
    streamController.registerViewer(viewerId, req.session.username);
    console.log(`[API] stream/start: user=${req.session.username} sourceId=${sourceId} viewerId=${viewerId}`);
    const result = streamController.requestStream(sourceId, viewerId);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    // Immediately broadcast updated viewer counts to all viewers
    broadcastToViewers({ type: 'sources', sources: streamController.getSources() });
    res.json({ streamPath: result.streamPath });
  });

  app.post('/api/stream/stop', requireAuth, (req, res) => {
    const { sourceId } = req.body;
    if (!sourceId) {
      return res.status(400).json({ error: 'sourceId required' });
    }
    const viewerId = req.sessionID || req.session.userId;
    console.log(`[API] stream/stop: user=${req.session.username} sourceId=${sourceId} viewerId=${viewerId}`);
    streamController.releaseStream(sourceId, viewerId);
    // Immediately broadcast updated viewer counts
    broadcastToViewers({ type: 'sources', sources: streamController.getSources() });
    res.json({ ok: true });
  });

  // Admin bandwidth API
  app.get('/api/admin/bandwidth', requireAdmin, (req, res) => {
    res.json(bandwidthMonitor.getSnapshot());
  });

  // Admin: detailed viewer info per stream
  app.get('/api/admin/streams', requireAdmin, (req, res) => {
    res.json({ streams: streamController.getDetailedStreams() });
  });

  // Admin: force stop an entire stream
  app.post('/api/admin/stream/stop', requireAdmin, (req, res) => {
    const { sourceId } = req.body;
    if (!sourceId) return res.status(400).json({ error: 'sourceId required' });
    console.log(`[Admin] Force stopping stream: ${sourceId}`);
    streamController.forceStopStream(sourceId);
    broadcastToViewers({ type: 'sources', sources: streamController.getSources() });
    broadcastToViewers({ type: 'stream-status', sourceId, status: 'available' });
    res.json({ ok: true });
  });

  // Admin: kick a specific viewer from a stream
  app.post('/api/admin/stream/kick', requireAdmin, (req, res) => {
    const { sourceId, viewerId } = req.body;
    if (!sourceId || !viewerId) return res.status(400).json({ error: 'sourceId and viewerId required' });
    console.log(`[Admin] Kicking viewer ${viewerId} from stream ${sourceId}`);
    streamController.forceKickViewer(sourceId, viewerId);
    broadcastToViewers({ type: 'sources', sources: streamController.getSources() });
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
