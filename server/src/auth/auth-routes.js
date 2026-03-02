const express = require('express');
const userStore = require('./user-store');
const { requireAuth, requireAdmin } = require('./auth-middleware');

const router = express.Router();

// POST /auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = await userStore.verifyPassword(username, password);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    res.json({ user: { id: user.id, username: user.username, role: user.role } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('Logout error:', err);
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

// GET /auth/me
router.get('/me', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.json({ user: null, setupRequired: !userStore.hasUsers() });
  }
  res.json({
    user: {
      id: req.session.userId,
      username: req.session.username,
      role: req.session.role
    }
  });
});

// POST /auth/setup — first-user admin creation
router.post('/setup', async (req, res) => {
  try {
    if (userStore.hasUsers()) {
      return res.status(400).json({ error: 'Setup already completed' });
    }
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const user = await userStore.createUser(username, password, 'admin');
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    res.json({ user: { id: user.id, username: user.username, role: user.role } });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    console.error('Setup error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auth/users — admin creates user
router.post('/users', requireAdmin, async (req, res) => {
  try {
    const { username, password, role, email } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const validRoles = ['viewer', 'admin'];
    const userRole = validRoles.includes(role) ? role : 'viewer';

    const user = await userStore.createUser(username, password, userRole, email || null);
    res.json({ user });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /auth/users — admin lists users
router.get('/users', requireAdmin, (req, res) => {
  const users = userStore.getAllUsers();
  res.json({ users });
});

// DELETE /auth/users/:id — admin deletes user
router.delete('/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.session.userId) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }
  const deleted = userStore.deleteUser(id);
  if (!deleted) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({ ok: true });
});

module.exports = router;
