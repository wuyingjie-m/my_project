# Furnace Deployment

This copy is prepared for a Furnace Ubuntu 24.04 server.

Runtime layout:

- Public entry: Furnace HTTPS domain at `/`
- Server entry: `0.0.0.0:80`
- Reverse proxy: Nginx on `0.0.0.0:80`
- Dashboard app: Next.js on `127.0.0.1:3000`
- OpenClaw instances: `/data/agent/<instance>/.openclaw/openclaw.json`

Default environment:

```bash
OPENCLAW_INSTANCES_DIR=/data/agent
OPENCLAW_CONFIG_PATH=/data/agent/openclaw_GTM/.openclaw/openclaw.json
OPENCLAW_HOME=/data/agent/openclaw_GTM/.openclaw
NEXT_PUBLIC_OPENCLAW_GATEWAY_PROXY=1
```

Change `OPENCLAW_CONFIG_PATH` and `OPENCLAW_HOME` in `openclaw-bot-review.service`
if another instance should be treated as the primary/default instance.

Install outline:

```bash
apt update
apt install -y nodejs npm nginx
mkdir -p /opt
cp -a OpenClaw-bot-review-furnace /opt/openclaw-bot-review-furnace
cd /opt/openclaw-bot-review-furnace
npm ci
npm run build
chmod +x deploy/furnace/start-openclaw-bot-review.sh
cp deploy/furnace/openclaw-bot-review.service /etc/systemd/system/openclaw-bot-review.service
cp deploy/furnace/nginx-openclaw-bot-review.conf /etc/nginx/sites-available/openclaw-bot-review
ln -sf /etc/nginx/sites-available/openclaw-bot-review /etc/nginx/sites-enabled/openclaw-bot-review
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl daemon-reload
systemctl enable --now openclaw-bot-review
systemctl reload nginx
```

Furnace acceptance checks:

```bash
ss -lntp | grep ':80'
curl -I -H 'Host: <slug>.apps.dashuichangliu.com' http://127.0.0.1/
systemctl status openclaw-bot-review --no-pager
```

The HTTP status for the `curl` check should be `200`-`399`.
Do not configure HTTPS certificates on the server; Furnace terminates TLS before
forwarding HTTP traffic to port 80.
