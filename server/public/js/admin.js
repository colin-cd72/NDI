(async function() {
  // Auth check — redirect if not admin
  let currentUser = null;
  try {
    const res = await fetch('/auth/me');
    const data = await res.json();
    if (!data.user || data.user.role !== 'admin') {
      window.location.href = '/';
      return;
    }
    currentUser = data.user;
  } catch (err) {
    window.location.href = '/';
    return;
  }

  document.getElementById('userInfo').textContent = currentUser.username;

  // Logout
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' });
    window.location.href = '/';
  });

  // --- Bandwidth Chart Setup ---
  const ctx = document.getElementById('bwChart').getContext('2d');
  const chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Inbound',
          data: [],
          borderColor: 'rgba(99, 102, 241, 1)',
          backgroundColor: 'rgba(99, 102, 241, 0.15)',
          fill: true,
          tension: 0.3,
          pointRadius: 0
        },
        {
          label: 'Outbound',
          data: [],
          borderColor: 'rgba(34, 197, 94, 1)',
          backgroundColor: 'rgba(34, 197, 94, 0.15)',
          fill: true,
          tension: 0.3,
          pointRadius: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          ticks: { color: '#9999aa', maxTicksLimit: 10 },
          grid: { color: 'rgba(45,45,61,0.5)' }
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: '#9999aa',
            callback: function(val) { return formatBandwidth(val); }
          },
          grid: { color: 'rgba(45,45,61,0.5)' }
        }
      },
      plugins: {
        legend: { labels: { color: '#e4e4e8' } },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              return ctx.dataset.label + ': ' + formatBandwidth(ctx.parsed.y);
            }
          }
        }
      }
    }
  });

  // --- Helpers ---
  function formatBandwidth(bps) {
    if (bps >= 1000000000) return (bps / 1000000000).toFixed(1) + ' Gbps';
    if (bps >= 1000000) return (bps / 1000000).toFixed(1) + ' Mbps';
    if (bps >= 1000) return (bps / 1000).toFixed(0) + ' Kbps';
    return bps.toFixed(0) + ' bps';
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Polling ---
  let seeded = false;

  async function poll() {
    try {
      const [bwRes, streamsRes] = await Promise.all([
        fetch('/api/admin/bandwidth'),
        fetch('/api/admin/streams')
      ]);
      if (!bwRes.ok) {
        if (bwRes.status === 401 || bwRes.status === 403) {
          window.location.href = '/';
          return;
        }
        return;
      }
      const bwData = await bwRes.json();
      const streamsData = streamsRes.ok ? await streamsRes.json() : { streams: [] };
      updateCards(bwData);
      updateChart(bwData);
      updateStreamTable(bwData);
      updateViewerTable(streamsData.streams);
    } catch (err) {
      console.error('Bandwidth poll error:', err);
    }
  }

  function updateCards(data) {
    document.getElementById('rxBps').textContent = formatBandwidth(data.server.rxBps);
    document.getElementById('txBps').textContent = formatBandwidth(data.server.txBps);
    document.getElementById('activeStreams').textContent = data.totals.activeStreams;
    document.getElementById('totalViewers').textContent = data.totals.totalViewers;
  }

  function updateChart(data) {
    if (!seeded && data.history.length > 1) {
      // Seed with full history on first load
      chart.data.labels = data.history.map(h => formatTime(h.ts));
      chart.data.datasets[0].data = data.history.map(h => h.rxBps);
      chart.data.datasets[1].data = data.history.map(h => h.txBps);
      seeded = true;
    } else if (seeded && data.history.length > 0) {
      // Append latest sample
      const latest = data.history[data.history.length - 1];
      chart.data.labels.push(formatTime(latest.ts));
      chart.data.datasets[0].data.push(latest.rxBps);
      chart.data.datasets[1].data.push(latest.txBps);

      // Trim to 150 samples
      while (chart.data.labels.length > 150) {
        chart.data.labels.shift();
        chart.data.datasets[0].data.shift();
        chart.data.datasets[1].data.shift();
      }
    }
    chart.update('none');
  }

  function updateStreamTable(data) {
    const tbody = document.getElementById('streamTableBody');
    if (data.streams.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="bw-table-empty">No active streams</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    for (const s of data.streams) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(s.name)}</td>
        <td>${s.viewers}</td>
        <td>${formatBandwidth(s.inboundBps)}</td>
        <td>${formatBandwidth(s.outboundBps)}</td>
        <td><button class="btn btn-small btn-danger" data-kill-stream="${escapeHtml(s.sourceId)}">Kill Stream</button></td>
      `;
      tr.querySelector('[data-kill-stream]').addEventListener('click', async (e) => {
        const sourceId = e.target.dataset.killStream;
        if (!confirm(`Stop stream "${s.name}" for all viewers?`)) return;
        await fetch('/api/admin/stream/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceId })
        });
        poll();
      });
      tbody.appendChild(tr);
    }
  }

  function updateViewerTable(streams) {
    const tbody = document.getElementById('viewerTableBody');
    const rows = [];
    for (const s of streams) {
      for (const v of s.viewers) {
        rows.push({ username: v.username, viewerId: v.viewerId, sourceId: s.sourceId, sourceName: s.name });
      }
    }
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="bw-table-empty">No active viewers</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(r.username)}</td>
        <td>${escapeHtml(r.sourceName)}</td>
        <td><button class="btn btn-small btn-danger" data-kick-source="${escapeHtml(r.sourceId)}" data-kick-viewer="${escapeHtml(r.viewerId)}">Kick</button></td>
      `;
      tr.querySelector('[data-kick-viewer]').addEventListener('click', async (e) => {
        const sourceId = e.target.dataset.kickSource;
        const viewerId = e.target.dataset.kickViewer;
        if (!confirm(`Kick ${r.username} from "${r.sourceName}"?`)) return;
        await fetch('/api/admin/stream/kick', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceId, viewerId })
        });
        poll();
      });
      tbody.appendChild(tr);
    }
  }

  // --- User Management ---
  const addUserForm = document.getElementById('addUserForm');
  const userList = document.getElementById('userList');

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
      const sourceBadge = u.allowed_sources
        ? `<span class="user-role">${JSON.parse(u.allowed_sources).length} source(s)</span>`
        : '<span class="user-role" style="background:var(--success);color:white">All sources</span>';
      const actions = [];
      actions.push(`<button class="btn btn-small btn-outline" data-sources-id="${u.id}" data-sources-name="${escapeHtml(u.username)}" data-sources-val="${escapeHtml(u.allowed_sources || '')}">Sources</button>`);
      if (u.id !== currentUser.id) {
        actions.push(`<button class="btn btn-small btn-danger" data-id="${u.id}">Delete</button>`);
      } else {
        actions.push('<span style="color:var(--text-secondary);font-size:0.8rem">you</span>');
      }
      li.innerHTML = `
        <div class="user-info">
          <span>${escapeHtml(u.username)}</span>
          <span class="user-role ${u.role}">${u.role}</span>
          ${sourceBadge}
        </div>
        <div style="display:flex;gap:0.5rem;align-items:center">${actions.join('')}</div>
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
      const srcBtn = li.querySelector('[data-sources-id]');
      if (srcBtn) {
        srcBtn.addEventListener('click', () => {
          openSourcesModal(
            parseInt(srcBtn.dataset.sourcesId, 10),
            srcBtn.dataset.sourcesName,
            srcBtn.dataset.sourcesVal ? JSON.parse(srcBtn.dataset.sourcesVal) : null
          );
        });
      }
      userList.appendChild(li);
    }
  }

  // --- Source Permissions Modal ---
  const sourcesModal = document.getElementById('sourcesModal');
  const sourcesModalUser = document.getElementById('sourcesModalUser');
  const allowAllCheckbox = document.getElementById('allowAllCheckbox');
  const sourceCheckboxes = document.getElementById('sourceCheckboxes');
  let modalUserId = null;

  document.getElementById('sourcesModalClose').addEventListener('click', closeSourcesModal);
  document.getElementById('sourcesModalCancel').addEventListener('click', closeSourcesModal);
  sourcesModal.addEventListener('click', (e) => {
    if (e.target === sourcesModal) closeSourcesModal();
  });

  allowAllCheckbox.addEventListener('change', () => {
    const disabled = allowAllCheckbox.checked;
    sourceCheckboxes.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.disabled = disabled;
      if (disabled) cb.checked = true;
    });
  });

  async function openSourcesModal(userId, username, currentAllowed) {
    modalUserId = userId;
    sourcesModalUser.textContent = username;

    // Fetch available sources
    let sources = [];
    try {
      const res = await fetch('/api/sources');
      const data = await res.json();
      sources = data.sources || [];
    } catch (err) {
      console.error('Failed to fetch sources:', err);
    }

    const isAllowAll = currentAllowed === null;
    allowAllCheckbox.checked = isAllowAll;

    sourceCheckboxes.innerHTML = '';
    if (sources.length === 0) {
      sourceCheckboxes.innerHTML = '<p style="color:var(--text-secondary);font-size:0.85rem">No NDI sources currently available. Sources will appear when the agent is connected.</p>';
    } else {
      for (const s of sources) {
        const checked = isAllowAll || (currentAllowed && currentAllowed.includes(s.id));
        const label = document.createElement('label');
        label.className = 'source-checkbox-row';
        label.innerHTML = `<input type="checkbox" value="${escapeHtml(s.id)}" ${checked ? 'checked' : ''} ${isAllowAll ? 'disabled' : ''}> ${escapeHtml(s.name)}`;
        sourceCheckboxes.appendChild(label);
      }
    }

    sourcesModal.hidden = false;
  }

  function closeSourcesModal() {
    sourcesModal.hidden = true;
    modalUserId = null;
  }

  document.getElementById('sourcesModalSave').addEventListener('click', async () => {
    if (modalUserId === null) return;

    let allowedSources = null;
    if (!allowAllCheckbox.checked) {
      allowedSources = [];
      sourceCheckboxes.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
        allowedSources.push(cb.value);
      });
    }

    try {
      const res = await fetch(`/auth/users/${modalUserId}/sources`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowedSources })
      });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || 'Failed to save');
        return;
      }
      closeSourcesModal();
      loadUsers();
    } catch (err) {
      alert('Failed to save source permissions');
    }
  });

  // --- Init ---
  loadUsers();
  poll();
  setInterval(poll, 2000);
})();
