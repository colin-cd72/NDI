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
  const adminModal = document.getElementById('adminModal');
  const closeModal = document.getElementById('closeModal');
  const addUserForm = document.getElementById('addUserForm');
  const userList = document.getElementById('userList');

  userInfo.textContent = currentUser.username;
  if (currentUser.role === 'admin') {
    adminBtn.hidden = false;
  }

  // Player
  const videoEl = document.getElementById('videoPlayer');
  const player = new NDIPlayer(videoEl);
  let activeSourceId = null;
  let sources = [];

  // WebSocket connection
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
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

    sourceList.innerHTML = '';
    for (const src of sources) {
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

    // Stop current stream if any
    if (activeSourceId) {
      await fetch('/api/stream/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: activeSourceId })
      });
      player.stop();
    }

    // Start new stream
    try {
      const res = await fetch('/api/stream/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: src.id })
      });
      const data = await res.json();

      if (!res.ok) {
        console.error('Start stream error:', data.error);
        return;
      }

      activeSourceId = src.id;
      playerPlaceholder.hidden = true;

      // Build the FLV URL for mpegts.js
      const flvUrl = `${protocol}//${location.host}/live${data.streamPath}.flv`;
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
  }

  // Logout
  logoutBtn.addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' });
    window.location.href = '/';
  });

  // Admin modal
  adminBtn.addEventListener('click', () => {
    adminModal.hidden = false;
    loadUsers();
  });

  closeModal.addEventListener('click', () => {
    adminModal.hidden = true;
  });

  adminModal.addEventListener('click', (e) => {
    if (e.target === adminModal) adminModal.hidden = true;
  });

  addUserForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('newUsername').value.trim();
    const password = document.getElementById('newPassword').value;
    const role = document.getElementById('newRole').value;

    if (!username || !password) return;

    try {
      const res = await fetch('/auth/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, role })
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to create user');
        return;
      }
      addUserForm.reset();
      loadUsers();
    } catch (err) {
      alert('Failed to create user');
    }
  });

  async function loadUsers() {
    try {
      const res = await fetch('/auth/users');
      const data = await res.json();
      renderUsers(data.users || []);
    } catch (err) {
      console.error('Failed to load users:', err);
    }
  }

  function renderUsers(users) {
    userList.innerHTML = '';
    for (const u of users) {
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="user-info">
          <span>${escapeHtml(u.username)}</span>
          <span class="user-role ${u.role}">${u.role}</span>
        </div>
        ${u.id !== currentUser.id ? `<button class="btn btn-small btn-danger" data-id="${u.id}">Delete</button>` : '<span style="color:var(--text-secondary);font-size:0.8rem">you</span>'}
      `;
      const delBtn = li.querySelector('[data-id]');
      if (delBtn) {
        delBtn.addEventListener('click', async () => {
          if (!confirm(`Delete user "${u.username}"?`)) return;
          try {
            await fetch(`/auth/users/${u.id}`, { method: 'DELETE' });
            loadUsers();
          } catch (err) {
            alert('Failed to delete user');
          }
        });
      }
      userList.appendChild(li);
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Clean up on page unload
  window.addEventListener('beforeunload', () => {
    if (ws) ws.close();
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    if (activeSourceId) {
      navigator.sendBeacon('/api/stream/stop', JSON.stringify({ sourceId: activeSourceId }));
    }
  });

  // Start WebSocket connection
  connectWs();
})();
