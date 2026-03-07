// Track NDI sources reported by agent, active streams, and viewer counts.

const sources = new Map();       // sourceId -> { name, status }
const activeStreams = new Map();  // sourceId -> { viewers: Set<viewerId>, streamPath, graceTimer }
const viewerNames = new Map();   // viewerId -> username
const GRACE_PERIOD_MS = 30000;   // 30s before stopping an unwatched stream

let agentWs = null;              // Reference to the agent WebSocket (set by ws-server)
let onStateChange = null;        // Called when sources/streams change (set by web-server)
function setOnStateChange(cb) { onStateChange = cb; }

function setAgentWs(ws) {
  agentWs = ws;
}

function getAgentWs() {
  return agentWs;
}

function updateSources(sourceList) {
  // sourceList: [{ id, name }]
  // Diff instead of clear-all to avoid wiping active streams on transient discovery hiccups
  const newIds = new Set(sourceList.map(s => s.id));

  // Remove sources that are no longer reported (but keep active streams)
  for (const id of sources.keys()) {
    if (!newIds.has(id) && !activeStreams.has(id)) {
      sources.delete(id);
    }
  }

  // Add/update sources from the new list
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
      if (onStateChange) onStateChange();
    }, GRACE_PERIOD_MS);
  }
}

function stopStream(sourceId) {
  cleanupStreamState(sourceId);

  // Tell agent to stop
  if (agentWs && agentWs.readyState === 1) {
    agentWs.send(JSON.stringify({ type: 'stop-stream', sourceId }));
  }
}

// Clean up server-side state without messaging the agent (used when agent reports stop)
function cleanupStreamState(sourceId) {
  const stream = activeStreams.get(sourceId);
  if (!stream) return;

  if (stream.graceTimer) {
    clearTimeout(stream.graceTimer);
  }
  activeStreams.delete(sourceId);

  if (sources.has(sourceId)) {
    sources.get(sourceId).status = 'available';
  }
}

function registerViewer(viewerId, username) {
  viewerNames.set(viewerId, username);
}

function unregisterViewer(viewerId) {
  viewerNames.delete(viewerId);
}

function getActiveStreams() {
  const result = {};
  for (const [id, stream] of activeStreams) {
    result[id] = { viewers: stream.viewers.size, streamPath: stream.streamPath };
  }
  return result;
}

function getDetailedStreams() {
  const result = [];
  for (const [sourceId, stream] of activeStreams) {
    const source = sources.get(sourceId);
    const viewers = [];
    for (const viewerId of stream.viewers) {
      viewers.push({
        viewerId,
        username: viewerNames.get(viewerId) || 'unknown'
      });
    }
    result.push({
      sourceId,
      name: source ? source.name : sourceId,
      viewers
    });
  }
  return result;
}

function forceStopStream(sourceId) {
  stopStream(sourceId);
  if (onStateChange) onStateChange();
}

function forceKickViewer(sourceId, viewerId) {
  releaseStream(sourceId, viewerId);
  if (onStateChange) onStateChange();
}

module.exports = {
  setAgentWs,
  getAgentWs,
  setOnStateChange,
  registerViewer,
  unregisterViewer,
  updateSources,
  getSources,
  requestStream,
  releaseStream,
  stopStream,
  cleanupStreamState,
  getActiveStreams,
  getDetailedStreams,
  forceStopStream,
  forceKickViewer
};
