// Bandwidth monitor: tracks NDI app-level traffic based on active streams and viewers.
// Inbound = RTMP streams from agent, Outbound = HTTP-FLV to viewers.

const streamController = require('./stream-controller');

const INTERVAL_MS = 2000;
const MAX_HISTORY = 150; // 150 samples × 2s = 5 minutes
const STREAM_BITRATE_BPS = parseInt(process.env.STREAM_BITRATE) || 4 * 1000 * 1000; // 4 Mbps

let timer = null;
const history = []; // { ts, inboundBps, outboundBps }

function sample() {
  const activeStreams = streamController.getActiveStreams();

  let inboundBps = 0;
  let outboundBps = 0;

  for (const [, stream] of Object.entries(activeStreams)) {
    inboundBps += STREAM_BITRATE_BPS;  // one RTMP ingest per stream
    outboundBps += stream.viewers * STREAM_BITRATE_BPS;  // one FLV output per viewer
  }

  history.push({ ts: Date.now(), inboundBps, outboundBps });
  if (history.length > MAX_HISTORY) {
    history.shift();
  }
}

function getSnapshot() {
  const activeStreams = streamController.getActiveStreams();
  const sources = streamController.getSources();

  const streams = [];
  let totalViewers = 0;
  let totalInbound = 0;
  let totalOutbound = 0;

  for (const [sourceId, stream] of Object.entries(activeStreams)) {
    const source = sources.find(s => s.id === sourceId);
    const outboundBps = stream.viewers * STREAM_BITRATE_BPS;
    totalViewers += stream.viewers;
    totalInbound += STREAM_BITRATE_BPS;
    totalOutbound += outboundBps;

    streams.push({
      sourceId,
      name: source ? source.name : sourceId,
      viewers: stream.viewers,
      inboundBps: STREAM_BITRATE_BPS,
      outboundBps
    });
  }

  const latest = history.length > 0 ? history[history.length - 1] : { inboundBps: 0, outboundBps: 0 };

  return {
    server: {
      rxBps: latest.inboundBps,
      txBps: latest.outboundBps
    },
    streams,
    totals: {
      activeStreams: streams.length,
      totalViewers,
      inboundBps: totalInbound,
      outboundBps: totalOutbound
    },
    history: history.map(h => ({ ts: h.ts, rxBps: h.inboundBps, txBps: h.outboundBps }))
  };
}

function start() {
  if (timer) return;
  sample();
  timer = setInterval(sample, INTERVAL_MS);
  console.log(`[BandwidthMonitor] Tracking NDI app traffic (${STREAM_BITRATE_BPS / 1000000} Mbps per stream)`);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, getSnapshot };
