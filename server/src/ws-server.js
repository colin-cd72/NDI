const { WebSocketServer } = require('ws');
const url = require('url');
const cookie = require('cookie');
const streamController = require('./stream-controller');

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
      streamController.setAgentWs(null);
      // Notify viewers that sources are gone
      broadcastToViewers({ type: 'sources', sources: [] });
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
      viewerClients.add(ws);

      console.log(`[WS] Viewer connected: ${ws.username}`);

      // Send current sources immediately
      ws.send(JSON.stringify({
        type: 'sources',
        sources: streamController.getSources()
      }));

      ws.on('close', () => {
        viewerClients.delete(ws);
        console.log(`[WS] Viewer disconnected: ${ws.username}`);
      });
    });
  });
}

function broadcastToViewers(msg) {
  const data = JSON.stringify(msg);
  for (const client of viewerClients) {
    if (client.readyState === 1) {
      client.send(data);
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
