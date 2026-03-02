// Bandwidth monitor: reads /proc/net/dev on Linux, computes rx/tx bytes/sec.
// On non-Linux systems, returns zeros gracefully.

const fs = require('fs');
const streamController = require('./stream-controller');

const INTERVAL_MS = 2000;
const MAX_HISTORY = 150; // 150 samples × 2s = 5 minutes
const ESTIMATED_STREAM_BPS = 4 * 1000 * 1000; // 4 Mbps per viewer

let iface = process.env.NET_INTERFACE || 'eth0';
let timer = null;
let prevRx = null;
let prevTx = null;
let prevTime = null;
let currentRxBps = 0;
let currentTxBps = 0;
const history = []; // { ts, rxBps, txBps }

function parseNetDev() {
  try {
    const data = fs.readFileSync('/proc/net/dev', 'utf8');
    const lines = data.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith(iface + ':')) continue;
      // Format: iface: rx_bytes rx_packets ... tx_bytes tx_packets ...
      const parts = trimmed.split(/[:\s]+/);
      // parts[0] = iface, parts[1] = rx_bytes, ... parts[9] = tx_bytes
      return {
        rxBytes: parseInt(parts[1], 10),
        txBytes: parseInt(parts[9], 10)
      };
    }
  } catch (e) {
    // Not Linux or file not accessible
  }
  return null;
}

function sample() {
  const now = Date.now();
  const netData = parseNetDev();

  if (netData && prevRx !== null && prevTime !== null) {
    const elapsed = (now - prevTime) / 1000; // seconds
    if (elapsed > 0) {
      currentRxBps = Math.max(0, (netData.rxBytes - prevRx) / elapsed) * 8; // bits/sec
      currentTxBps = Math.max(0, (netData.txBytes - prevTx) / elapsed) * 8;
    }
  }

  if (netData) {
    prevRx = netData.rxBytes;
    prevTx = netData.txBytes;
    prevTime = now;
  }

  history.push({ ts: now, rxBps: currentRxBps, txBps: currentTxBps });
  if (history.length > MAX_HISTORY) {
    history.shift();
  }
}

function getSnapshot() {
  const activeStreams = streamController.getActiveStreams();
  const sources = streamController.getSources();

  // Build per-stream info
  const streams = [];
  let totalViewers = 0;
  let totalStreamOutbound = 0;

  for (const [sourceId, stream] of Object.entries(activeStreams)) {
    const source = sources.find(s => s.id === sourceId);
    const viewers = stream.viewers;
    const outboundBps = viewers * ESTIMATED_STREAM_BPS;
    totalViewers += viewers;
    totalStreamOutbound += outboundBps;

    streams.push({
      sourceId,
      name: source ? source.name : sourceId,
      viewers,
      inboundBps: ESTIMATED_STREAM_BPS, // one inbound stream from agent
      outboundBps
    });
  }

  return {
    server: {
      rxBps: currentRxBps,
      txBps: currentTxBps,
      interface: iface
    },
    streams,
    totals: {
      activeStreams: streams.length,
      totalViewers,
      estimatedOutboundBps: totalStreamOutbound
    },
    history: history.map(h => ({ ts: h.ts, rxBps: h.rxBps, txBps: h.txBps }))
  };
}

function start() {
  if (timer) return;
  // Take an initial sample immediately
  sample();
  timer = setInterval(sample, INTERVAL_MS);
  console.log(`[BandwidthMonitor] Started monitoring interface: ${iface}`);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, getSnapshot };
