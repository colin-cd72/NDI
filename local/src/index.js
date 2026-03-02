require('dotenv').config();

const { discoverSources, destroyFinder } = require('./ndi-discovery');
const streamManager = require('./stream-manager');
const AgentWsClient = require('./ws-client');

const SERVER_WS_URL = process.env.SERVER_WS_URL || 'wss://ndi.4tmrw.net/ws/agent';
const STREAM_KEY = process.env.STREAM_KEY || 'change-me-to-a-random-secret';
const DISCOVERY_INTERVAL = parseInt(process.env.NDI_DISCOVERY_INTERVAL) || 10000;

let knownSources = [];

// Create WebSocket client
const wsClient = new AgentWsClient(SERVER_WS_URL, STREAM_KEY);

// Handle stream start requests from server
wsClient.onStartStream = (sourceId, streamKey) => {
  const source = knownSources.find(s => s.id === sourceId);
  if (!source) {
    console.error(`[Agent] Source not found: ${sourceId}`);
    wsClient.sendStreamError(sourceId, 'Source not found');
    return;
  }

  streamManager.startStream(source, streamKey);
  wsClient.sendStreamStarted(sourceId);
};

// Handle stream stop requests from server
wsClient.onStopStream = (sourceId) => {
  streamManager.stopStream(sourceId);
  wsClient.sendStreamStopped(sourceId);
};

// Re-send sources whenever we reconnect
wsClient.onConnected = () => {
  if (knownSources.length > 0) {
    console.log(`[Agent] Re-sending ${knownSources.length} sources after reconnect`);
    wsClient.sendSources(knownSources);
  }
};

// Discovery loop
async function discoveryLoop() {
  try {
    const sources = await discoverSources();

    // Check if sources changed
    const newIds = sources.map(s => s.id).sort().join(',');
    const oldIds = knownSources.map(s => s.id).sort().join(',');

    if (newIds !== oldIds) {
      console.log(`[Agent] Sources changed: ${sources.map(s => s.name).join(', ') || 'none'}`);
      knownSources = sources;
      wsClient.sendSources(sources);
    }
  } catch (err) {
    console.error('[Agent] Discovery error:', err.message);
  }
}

// Start
console.log('[Agent] NDI Remote Viewer Agent starting...');
console.log(`[Agent] Server: ${SERVER_WS_URL}`);
console.log(`[Agent] Discovery interval: ${DISCOVERY_INTERVAL}ms`);

wsClient.connect();

// Initial discovery then periodic
discoveryLoop();
setInterval(discoveryLoop, DISCOVERY_INTERVAL);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[Agent] Shutting down...');
  streamManager.stopAll();
  destroyFinder();
  wsClient.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[Agent] Shutting down...');
  streamManager.stopAll();
  destroyFinder();
  wsClient.close();
  process.exit(0);
});
