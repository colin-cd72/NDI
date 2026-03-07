const WebSocket = require('ws');

class AgentWsClient {
  constructor(url, streamKey) {
    this.url = url;
    this.streamKey = streamKey;
    this.ws = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.onStartStream = null;  // callback(sourceId, streamKey)
    this.onStopStream = null;   // callback(sourceId)
    this.connected = false;
    this.reconnectDelay = 5000; // starts at 5s, grows exponentially
  }

  connect() {
    // Close any existing connection before reconnecting
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch (e) {}
      this.ws = null;
    }
    this.connected = false;
    this.stopHeartbeat();

    const wsUrl = `${this.url}?key=${this.streamKey}`;
    console.log(`[WS] Connecting to ${this.url}...`);

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      console.log('[WS] Connected to server');
      this.connected = true;
      this.reconnectDelay = 5000; // reset backoff on successful connect
      this.startHeartbeat();
      // Notify that we connected so sources can be re-sent
      if (this.onConnected) this.onConnected();
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        this.handleMessage(msg);
      } catch (err) {
        console.error('[WS] Parse error:', err);
      }
    });

    this.ws.on('close', () => {
      console.log('[WS] Disconnected');
      this.connected = false;
      this.stopHeartbeat();
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[WS] Error:', err.message);
    });
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'start-stream':
        console.log(`[WS] Server requests stream start: ${msg.sourceId}`);
        if (this.onStartStream) {
          this.onStartStream(msg.sourceId, msg.streamKey);
        }
        break;

      case 'stop-stream':
        console.log(`[WS] Server requests stream stop: ${msg.sourceId}`);
        if (this.onStopStream) {
          this.onStopStream(msg.sourceId);
        }
        break;

      case 'heartbeat-ack':
        // Server acknowledged our heartbeat
        break;

      default:
        console.log('[WS] Unknown message type:', msg.type);
    }
  }

  sendSources(sources) {
    if (!this.connected || !this.ws) return;
    this.ws.send(JSON.stringify({
      type: 'sources',
      sources: sources.map(s => ({ id: s.id, name: s.name }))
    }));
  }

  sendStreamStarted(sourceId) {
    if (!this.connected || !this.ws) return;
    this.ws.send(JSON.stringify({ type: 'stream-started', sourceId }));
  }

  sendStreamStopped(sourceId) {
    if (!this.connected || !this.ws) return;
    this.ws.send(JSON.stringify({ type: 'stream-stopped', sourceId }));
  }

  sendStreamError(sourceId, error) {
    if (!this.connected || !this.ws) return;
    this.ws.send(JSON.stringify({ type: 'stream-error', sourceId, error }));
  }

  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      if (this.connected && this.ws) {
        this.ws.send(JSON.stringify({ type: 'heartbeat' }));
      }
    }, 15000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    console.log(`[WS] Reconnecting in ${(delay / 1000).toFixed(0)}s...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    // Exponential backoff: 5s → 10s → 20s → 40s → 60s max
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
  }

  close() {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

module.exports = AgentWsClient;
