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
  const prevCount = sources.size;

  // Remove sources that are no longer reported (but keep active streams)
  for (const id of sources.keys()) {
    if (!newIds.has(id) && !activeStreams.has(id)) {
      const name = sources.get(id).name;
      console.log(`[Sources] Removed: ${name} (${id})`);
      sources.delete(id);
    }
  }

  // Add/update sources from the new list
  for (const s of sourceList) {
    if (!sources.has(s.id)) {
      console.log(`[Sources] Discovered: ${s.name} (${s.id})`);
    }
    sources.set(s.id, { name: s.name, status: activeStreams.has(s.id) ? 'streaming' : 'available' });
  }

  if (sources.size !== prevCount) {
    console.log(`[Sources] Total: ${sources.size} sources available`);
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
  const sourceName = sources.has(sourceId) ? sources.get(sourceId).name : sourceId;
  const username = viewerNames.get(userId) || userId;

  if (!sources.has(sourceId)) {
    console.log(`[Stream] Request DENIED — source not found: ${sourceId} (user: ${username})`);
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
      console.log(`[Stream] Grace period cancelled for "${sourceName}" — ${username} joined`);
    }
    console.log(`[Stream] "${sourceName}" — ${username} joined (${stream.viewers.size} viewers)`);
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
    console.log(`[Stream] Starting "${sourceName}" — requested by ${username}`);
    agentWs.send(JSON.stringify({
      type: 'start-stream',
      sourceId,
      streamKey: `${streamKey}_${sourceId}`
    }));
  } else {
    console.warn(`[Stream] Cannot start "${sourceName}" — no agent connected`);
  }

  return { ok: true, streamPath };
}

function releaseStream(sourceId, userId) {
  const stream = activeStreams.get(sourceId);
  if (!stream) return;

  const sourceName = sources.has(sourceId) ? sources.get(sourceId).name : sourceId;
  const username = viewerNames.get(userId) || userId;
  stream.viewers.delete(userId);
  console.log(`[Stream] "${sourceName}" — ${username} left (${stream.viewers.size} viewers remaining)`);

  if (stream.viewers.size === 0) {
    console.log(`[Stream] "${sourceName}" — no viewers, starting ${GRACE_PERIOD_MS / 1000}s grace period`);
    // Grace period before stopping
    stream.graceTimer = setTimeout(() => {
      console.log(`[Stream] "${sourceName}" — grace period expired, stopping stream`);
      stopStream(sourceId);
      if (onStateChange) onStateChange();
    }, GRACE_PERIOD_MS);
  }
}

function stopStream(sourceId) {
  const sourceName = sources.has(sourceId) ? sources.get(sourceId).name : sourceId;
  console.log(`[Stream] Stopping "${sourceName}" — telling agent`);
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

  const sourceName = sources.has(sourceId) ? sources.get(sourceId).name : sourceId;
  console.log(`[Stream] Cleanup "${sourceName}" — had ${stream.viewers.size} viewer(s)`);

  if (stream.graceTimer) {
    clearTimeout(stream.graceTimer);
  }
  activeStreams.delete(sourceId);

  if (sources.has(sourceId)) {
    sources.get(sourceId).status = 'available';
  }

  console.log(`[Stream] Active streams: ${activeStreams.size}`);
}

function registerViewer(viewerId, username) {
  if (!viewerNames.has(viewerId)) {
    console.log(`[Viewer] Registered: ${username} (${viewerId})`);
  }
  viewerNames.set(viewerId, username);
}

function unregisterViewer(viewerId) {
  const username = viewerNames.get(viewerId) || viewerId;
  console.log(`[Viewer] Unregistered: ${username}`);
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
  const sourceName = sources.has(sourceId) ? sources.get(sourceId).name : sourceId;
  console.log(`[Admin] Force stop: "${sourceName}"`);
  stopStream(sourceId);
  if (onStateChange) onStateChange();
}

function forceStopAllStreams() {
  console.log(`[Admin] Force stop ALL — ${activeStreams.size} active stream(s)`);
  for (const sourceId of [...activeStreams.keys()]) {
    stopStream(sourceId);
  }
  if (onStateChange) onStateChange();
}

function forceKickViewer(sourceId, viewerId) {
  const sourceName = sources.has(sourceId) ? sources.get(sourceId).name : sourceId;
  const username = viewerNames.get(viewerId) || viewerId;
  console.log(`[Admin] Kick: ${username} from "${sourceName}"`);
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
  forceStopAllStreams,
  forceKickViewer
};
