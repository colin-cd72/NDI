# NDI Remote Viewer - Server Info

## Server Details
- **Domain:** ndi.4tmrw.net
- **IP:** 82.25.86.219
- **SSH:** `ssh root@82.25.86.219`
- **Panel:** CloudPanel
- **App port:** 3434 (CloudPanel proxies HTTPS -> 3434)
- **RTMP port:** 1935 (FFmpeg ingest)
- **HTTP-FLV port:** 8000 (internal, nginx proxied)

## Server Paths
- **App root:** `/home/ndi/htdocs/ndi.4tmrw.net`
- **PM2 config:** `ecosystem.config.js`
- **SQLite DBs:** `db/` directory (created at runtime)

## Deployment
1. SSH into server: `ssh root@82.25.86.219`
2. Upload server/ contents to `/home/ndi/htdocs/ndi.4tmrw.net`
3. Run `npm install --production`
4. Configure `.env` with production secrets
5. Open firewall port 1935 for RTMP
6. Start with PM2: `pm2 start ecosystem.config.js`

## Nginx WebSocket Proxy
Add to CloudPanel vhost config:
```nginx
location /ws {
    proxy_pass http://127.0.0.1:3434;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}

location /live {
    proxy_pass http://127.0.0.1:8000;
    proxy_http_version 1.1;
    chunked_transfer_encoding on;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```
