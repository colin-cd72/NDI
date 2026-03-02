module.exports = {
  apps: [{
    name: 'ndi-remote-viewer',
    script: 'src/index.js',
    cwd: '/home/ndi/htdocs/ndi.4tmrw.net',
    env: {
      NODE_ENV: 'production'
    },
    instances: 1,
    autorestart: true,
    max_memory_restart: '512M',
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
