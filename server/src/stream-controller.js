// Track NDI sources reported by agent, active streams, and viewer counts.

const sources = new Map();       // sourceId -> { name, status }
const activeStreams = new Map();  // sourceId -> { viewers: Set<userId>, streamPath, graceTimer }
const GRACE_PERIOD_MS = 30000;   // 30s before stopping an unwatched stream

let agentWs = null;              // Reference to the agent WebSocket (set by ws-server)

function setAgentWs(ws) {
  agentWs = ws;
}

function updateSources(sourceList) {
  // sourceList: [{ id, name }]
  sources.clear();
  for (const s of sourceList) {
    sources.set(s.id, { name: s.name, status: activeStreams.has(s.id) ? 'streaming' : 'available' });
  }
}

function getSources() {
  const list = [];
  for (const [id, info] of sources) {
    const stream = activeStreams.get(id);
    list.push({
      id,
      name: info.name,
      status: stream ? 'streaming' : 'available',
      viewers: stream ? stream.viewers.size : 0
    });
  }
  return list;
}

function requestStream(sourceId, userId) {
  if (!sources.has(sourceId)) {
    return { ok: false, error: 'Source not found' };
  }

  const streamKey = process.env.STREAM_KEY || 'default-key';
  const streamPath = `/live/${streamKey}_${sourceId}`;

  if (activeStreams.has(sourceId)) {
    // Stream already active — add viewer
    const stream = activeStreams.get(sourceId);
    stream.viewers.add(userId);
    if (stream.graceTimer) {
      clearTimeout(stream.graceTimer);
      stream.graceTimer = null;
    }
    return { ok: true, streamPath };
  }

  // Start new stream — tell agent
  activeStreams.set(sourceId, {
    viewers: new Set([userId]),
    streamPath,
    graceTimer: null
  });

  // Update source status
  if (sources.has(sourceId)) {
    sources.get(sourceId).status = 'streaming';
  }

  if (agentWs && agentWs.readyState === 1) {
    agentWs.send(JSON.stringify({
      type: 'start-stream',
      sourceId,
      streamKey: `${streamKey}_${sourceId}`
    }));
  } else {
    console.warn('[StreamController] No agent connected, cannot start stream');
  }

  return { ok: true, streamPath };
}

function releaseStream(sourceId, userId) {
  const stream = activeStreams.get(sourceId);
  if (!stream) return;

  stream.viewers.delete(userId);

  if (stream.viewers.size === 0) {
    // Grace period before stopping
    stream.graceTimer = setTimeout(() => {
      stopStream(sourceId);
    }, GRACE_PERIOD_MS);
  }
}

function stopStream(sourceId) {
  const stream = activeStreams.get(sourceId);
  if (!stream) return;

  if (stream.graceTimer) {
    clearTimeout(stream.graceTimer);
  }
  activeStreams.delete(sourceId);

  // Update source status
  if (sources.has(sourceId)) {
    sources.get(sourceId).status = 'available';
  }

  // Tell agent to stop
  if (agentWs && agentWs.readyState === 1) {
    agentWs.send(JSON.stringify({ type: 'stop-stream', sourceId }));
  }
}

function getActiveStreams() {
  const result = {};
  for (const [id, stream] of activeStreams) {
    result[id] = { viewers: stream.viewers.size, streamPath: stream.streamPath };
  }
  return result;
}

module.exports = {
  setAgentWs,
  updateSources,
  getSources,
  requestStream,
  releaseStream,
  stopStream,
  getActiveStreams
};
