const { WebSocketServer } = require('ws');
const url = require('url');
const cookie = require('cookie');
const streamController = require('./stream-controller');
const userStore = require('./auth/user-store');

const viewerClients = new Set();

function createWsServer(server, sessionMiddleware) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const { pathname } = url.parse(request.url);

    if (pathname === '/ws/agent') {
      handleAgentUpgrade(wss, request, socket, head);
    } else if (pathname === '/ws/viewer') {
      handleViewerUpgrade(wss, request, socket, head, sessionMiddleware);
    } else {
      socket.destroy();
    }
  });

  return wss;
}

function handleAgentUpgrade(wss, request, socket, head) {
  // Authenticate agent by stream key in query string
  const { query } = url.parse(request.url, true);
  const streamKey = process.env.STREAM_KEY || 'default-key';

  if (query.key !== streamKey) {
    console.log('[WS] Agent rejected: invalid stream key');
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    console.log('[WS] Agent connected');
    streamController.setAgentWs(ws);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        handleAgentMessage(ws, msg);
      } catch (err) {
        console.error('[WS] Agent message parse error:', err);
      }
    });

    ws.on('close', () => {
      console.log('[WS] Agent disconnected');
      // Only clear if this is still the active agent (not a stale connection)
      if (streamController.getAgentWs() === ws) {
        streamController.setAgentWs(null);
        broadcastToViewers({ type: 'sources', sources: [] });
      }
    });
  });
}

function handleAgentMessage(ws, msg) {
  switch (msg.type) {
    case 'sources':
      streamController.updateSources(msg.sources || []);
      broadcastToViewers({
        type: 'sources',
        sources: streamController.getSources()
      });
      break;

    case 'stream-started':
      console.log('[WS] Stream started for source:', msg.sourceId);
      broadcastToViewers({
        type: 'stream-status',
        sourceId: msg.sourceId,
        status: 'streaming'
      });
      break;

    case 'stream-stopped':
      console.log('[WS] Stream stopped for source:', msg.sourceId);
      // Clean up server-side state without re-messaging the agent
      streamController.cleanupStreamState(msg.sourceId);
      broadcastToViewers({
        type: 'stream-status',
        sourceId: msg.sourceId,
        status: 'available'
      });
      break;

    case 'stream-error':
      console.error('[WS] Stream error for source:', msg.sourceId, msg.error);
      broadcastToViewers({
        type: 'stream-error',
        sourceId: msg.sourceId,
        error: msg.error
      });
      break;

    case 'heartbeat':
      ws.send(JSON.stringify({ type: 'heartbeat-ack' }));
      break;

    default:
      console.log('[WS] Unknown agent message type:', msg.type);
  }
}

function handleViewerUpgrade(wss, request, socket, head, sessionMiddleware) {
  // Parse session from cookie to authenticate viewer
  const fakeRes = { writeHead: () => {}, end: () => {}, setHeader: () => {} };
  sessionMiddleware(request, fakeRes, () => {
    if (!request.session || !request.session.userId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.userId = request.session.userId;
      ws.username = request.session.username;
      ws.sessionID = request.sessionID || request.session.id;
      ws.isAlive = true;
      ws.activeSourceId = null; // track what this viewer is watching
      viewerClients.add(ws);

      console.log(`[WS] Viewer connected: ${ws.username}`);

      ws.on('pong', () => { ws.isAlive = true; });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'watching') {
            ws.activeSourceId = msg.sourceId || null;
          }
        } catch (e) {}
      });

      // Send current sources immediately (filtered per user)
      const allSources = streamController.getSources();
      ws.send(JSON.stringify({
        type: 'sources',
        sources: filterSourcesForUser(ws.userId, allSources)
      }));

      ws.on('close', () => {
        viewerClients.delete(ws);
        // Release any stream this viewer was watching
        if (ws.activeSourceId) {
          const viewerId = ws.sessionID || ws.userId;
          streamController.releaseStream(ws.activeSourceId, viewerId);
        }
        console.log(`[WS] Viewer disconnected: ${ws.username}`);
      });
    });
  });
}

function filterSourcesForUser(userId, sources) {
  const allowed = userStore.getAllowedSources(userId);
  if (allowed === null) return sources;
  return sources.filter(s => allowed.includes(s.id));
}

function userCanAccessSource(userId, sourceId) {
  const allowed = userStore.getAllowedSources(userId);
  if (allowed === null) return true;
  return allowed.includes(sourceId);
}

function broadcastToViewers(msg) {
  for (const client of viewerClients) {
    if (client.readyState !== 1) continue;

    if (msg.type === 'sources') {
      const filtered = filterSourcesForUser(client.userId, msg.sources);
      client.send(JSON.stringify({ type: 'sources', sources: filtered }));
    } else if (msg.type === 'stream-status' || msg.type === 'stream-error') {
      if (!userCanAccessSource(client.userId, msg.sourceId)) continue;
      // Debug: console.log(`[WS] Sending ${msg.type} (${msg.sourceId}) to viewer ${client.username} (uid:${client.userId})`);
      client.send(JSON.stringify(msg));
    } else {
      client.send(JSON.stringify(msg));
    }
  }
}

// Heartbeat interval to detect dead connections
function startHeartbeat(wss) {
  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);
}

module.exports = { createWsServer, broadcastToViewers, startHeartbeat };
