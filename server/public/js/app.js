(async function() {
  // Auth check
  let currentUser = null;
  try {
    const res = await fetch('/auth/me');
    const data = await res.json();
    if (!data.user) {
      window.location.href = '/';
      return;
    }
    currentUser = data.user;
  } catch (err) {
    window.location.href = '/';
    return;
  }

  // UI elements
  const userInfo = document.getElementById('userInfo');
  const adminBtn = document.getElementById('adminBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const sourceList = document.getElementById('sourceList');
  const agentStatus = document.getElementById('agentStatus');
  const playerPlaceholder = document.getElementById('playerPlaceholder');
  const playerOverlay = document.getElementById('playerOverlay');
  const streamInfo = document.getElementById('streamInfo');
  userInfo.textContent = currentUser.username;
  if (currentUser.role === 'admin') {
    adminBtn.hidden = false;
  }

  // Player
  const videoEl = document.getElementById('videoPlayer');
  const player = new NDIPlayer(videoEl);
  let activeSourceId = null;
  let sources = [];
  let switchGeneration = 0; // Guards against overlapping toggleSource calls

  // WebSocket connection for viewer messages
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // HTTP-FLV uses regular HTTP(S) protocol
  const httpProtocol = location.protocol;
  let ws;
  let wsReconnectTimer;

  function connectWs() {
    ws = new WebSocket(`${protocol}//${location.host}/ws/viewer`);

    ws.onopen = () => {
      console.log('Viewer WebSocket connected');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWsMessage(msg);
      } catch (err) {
        console.error('WS parse error:', err);
      }
    };

    ws.onclose = () => {
      console.log('Viewer WebSocket disconnected, reconnecting...');
      agentStatus.textContent = 'Agent: Disconnected';
      agentStatus.className = 'agent-status disconnected';
      wsReconnectTimer = setTimeout(connectWs, 3000);
    };

    ws.onerror = (err) => {
      console.error('WS error:', err);
    };
  }

  function handleWsMessage(msg) {
    switch (msg.type) {
      case 'sources':
        sources = msg.sources;
        if (sources.length > 0) {
          agentStatus.textContent = 'Agent: Connected';
          agentStatus.className = 'agent-status connected';
        } else {
          agentStatus.textContent = 'Agent: Disconnected';
          agentStatus.className = 'agent-status disconnected';
        }
        renderSources();
        break;

      case 'stream-status':
        updateSourceStatus(msg.sourceId, msg.status);
        break;

      case 'stream-error':
        console.error('Stream error:', msg.sourceId, msg.error);
        if (msg.sourceId === activeSourceId) {
          stopViewing();
          playerPlaceholder.innerHTML = `<p style="color:var(--danger)">Stream error: ${escapeHtml(msg.error)}</p>`;
          playerPlaceholder.hidden = false;
        }
        break;
    }
  }

  function renderSources() {
    if (sources.length === 0) {
      sourceList.innerHTML = '<li class="source-empty">No sources available</li>';
      return;
    }

    // Sort by name so the list never reorders between renders
    const sorted = [...sources].sort((a, b) => a.name.localeCompare(b.name));

    sourceList.innerHTML = '';
    for (const src of sorted) {
      const li = document.createElement('li');
      li.className = 'source-item' + (src.id === activeSourceId ? ' active' : '');
      li.innerHTML = `
        <span class="source-name">${escapeHtml(src.name)}</span>
        <span class="source-badge ${src.status === 'streaming' ? 'streaming' : ''}">${
          src.status === 'streaming' ? `${src.viewers} watching` : 'available'
        }</span>
      `;
      li.addEventListener('click', () => toggleSource(src));
      sourceList.appendChild(li);
    }
  }

  function updateSourceStatus(sourceId, status) {
    const src = sources.find(s => s.id === sourceId);
    if (src) {
      src.status = status;
      renderSources();
    }
  }

  async function toggleSource(src) {
    if (activeSourceId === src.id) {
      stopViewing();
      return;
    }

    // Increment generation to invalidate any in-flight switch
    const thisGen = ++switchGeneration;

    // Stop current stream if any
    if (activeSourceId) {
      const stopId = activeSourceId;
      activeSourceId = null;
      player.stop();
      renderSources();
      await fetch('/api/stream/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: stopId })
      });
    }

    // Bail if another click superseded this one
    if (thisGen !== switchGeneration) return;

    // Start new stream
    try {
      const res = await fetch('/api/stream/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: src.id })
      });

      // Bail if superseded while waiting for API response
      if (thisGen !== switchGeneration) return;

      const data = await res.json();

      if (!res.ok) {
        console.error('Start stream error:', data.error);
        return;
      }

      activeSourceId = src.id;
      playerPlaceholder.hidden = true;

      // Tell server what we're watching (for stale viewer cleanup)
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'watching', sourceId: src.id }));
      }

      // Build the FLV URL for mpegts.js (HTTP-FLV over HTTPS)
      // streamPath is already "/live/KEY_sourceId", so just append .flv
      const flvUrl = `${httpProtocol}//${location.host}${data.streamPath}.flv`;
      player.play(flvUrl, src.name);

      streamInfo.textContent = src.name;
      playerOverlay.hidden = false;

      renderSources();
    } catch (err) {
      console.error('Failed to start stream:', err);
    }
  }

  async function stopViewing() {
    if (activeSourceId) {
      try {
        await fetch('/api/stream/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceId: activeSourceId })
        });
      } catch (err) {
        // Best effort
      }
    }
    player.stop();
    activeSourceId = null;
    playerPlaceholder.hidden = false;
    playerPlaceholder.innerHTML = '<p>Select an NDI source to start viewing</p>';
    playerOverlay.hidden = true;
    renderSources();

    // Tell server we stopped watching
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'watching', sourceId: null }));
    }
  }

  // Logout
  logoutBtn.addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' });
    window.location.href = '/';
  });

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Fullscreen
  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const playerContainer = document.getElementById('playerContainer');

  fullscreenBtn.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      playerContainer.requestFullscreen().catch(err => {
        console.error('Fullscreen error:', err);
      });
    }
  });

  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) {
      fullscreenBtn.title = 'Exit Fullscreen';
      fullscreenBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3"/></svg>';
    } else {
      fullscreenBtn.title = 'Fullscreen';
      fullscreenBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>';
    }
  });

  // Double-click video to toggle fullscreen
  videoEl.addEventListener('dblclick', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      playerContainer.requestFullscreen().catch(() => {});
    }
  });

  // Clean up on page unload
  window.addEventListener('beforeunload', () => {
    if (ws) ws.close();
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    if (activeSourceId) {
      navigator.sendBeacon('/api/stream/stop', new Blob([JSON.stringify({ sourceId: activeSourceId })], { type: 'application/json' }));
    }
  });

  // Start WebSocket connection
  connectWs();
})();
