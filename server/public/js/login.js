(async function() {
  const form = document.getElementById('loginForm');
  const errorEl = document.getElementById('error');
  const submitBtn = document.getElementById('submitBtn');
  const subtitle = document.getElementById('subtitle');

  // Check if setup is required (no users yet)
  try {
    const res = await fetch('/auth/me');
    const data = await res.json();

    if (data.user) {
      // Already logged in
      window.location.href = '/dashboard.html';
      return;
    }

    if (data.setupRequired) {
      subtitle.textContent = 'Create your admin account';
      submitBtn.textContent = 'Create Account';
      form.dataset.setup = 'true';
    }
  } catch (err) {
    // Server might be down, show login form anyway
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    submitBtn.disabled = true;

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    if (!username || !password) {
      showError('Username and password are required');
      submitBtn.disabled = false;
      return;
    }

    try {
      const endpoint = form.dataset.setup === 'true' ? '/auth/setup' : '/auth/login';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await res.json();

      if (!res.ok) {
        showError(data.error || 'Login failed');
        submitBtn.disabled = false;
        return;
      }

      window.location.href = '/dashboard.html';
    } catch (err) {
      showError('Connection error. Please try again.');
      submitBtn.disabled = false;
    }
  });

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }
})();
