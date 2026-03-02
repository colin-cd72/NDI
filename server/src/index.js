require('dotenv').config();

const http = require('http');
const path = require('path');
const fs = require('fs');
const userStore = require('./auth/user-store');
const { createApp } = require('./web-server');
const { createMediaServer } = require('./media-server');
const { createWsServer, startHeartbeat } = require('./ws-server');

// Ensure db directory exists
const dbDir = path.join(__dirname, '..', 'db');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Initialize database
userStore.init();
console.log('[DB] User store initialized');

// Create Express app
const { app, sessionMiddleware } = createApp();
const server = http.createServer(app);

// Create WebSocket server
const wss = createWsServer(server, sessionMiddleware);
startHeartbeat(wss);
console.log('[WS] WebSocket server attached');

// Create media server (RTMP + HTTP-FLV)
const nms = createMediaServer();
nms.run();
console.log(`[RTMP] Listening on port ${process.env.RTMP_PORT || 1935}`);
console.log(`[FLV] HTTP-FLV on port ${process.env.HTTP_FLV_PORT || 8000}`);

// Start HTTP server
const PORT = parseInt(process.env.PORT) || 3434;
server.listen(PORT, () => {
  console.log(`[Server] NDI Remote Viewer running on port ${PORT}`);
  console.log(`[Server] http://localhost:${PORT}`);
});
