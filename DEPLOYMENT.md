# Deployment

`aplan.top` and `www.aplan.top` currently resolve to `59.82.113.122`. If that is your server IP, DNS is ready.

This app is ready for a single-server deployment behind Nginx.

Build the frontend on your local machine or in CI, then upload the runtime
artifact to the server. The server does not need to run `npm ci` or
`npm run build`, which avoids webpack build OOM on small machines:

```bash
npm run deploy:artifact
scp release/stock-portfolio-*.tar.gz deploy/install-artifact.sh deploy/stock-portfolio.service your-server:/tmp/
```

Use `SKIP_NPM_CI=1 npm run deploy:artifact` only when local dependencies are
already installed and you want to skip reinstalling them.

If `dist/` was already built and you only want to package the existing output,
use `SKIP_NPM_CI=1 SKIP_BUILD=1 npm run deploy:artifact`.

On the server, install the artifact and run the service:

```bash
sudo useradd --system --create-home --home-dir /opt/stock-portfolio --shell /usr/sbin/nologin stockapp
sudo mkdir -p /opt/stock-portfolio /var/lib/stock-portfolio
sudo chown -R stockapp:stockapp /opt/stock-portfolio /var/lib/stock-portfolio
sudo env RESTART_SERVICE=0 bash /tmp/install-artifact.sh /tmp/stock-portfolio-*.tar.gz
sudo cp /opt/stock-portfolio/current/.env.production.example /etc/stock-portfolio.env
sudo editor /etc/stock-portfolio.env
sudo cp /tmp/stock-portfolio.service /etc/systemd/system/stock-portfolio.service
sudo systemctl daemon-reload
sudo systemctl enable --now stock-portfolio
```

The service runs the prebuilt artifact with:

```bash
PORT=8080 \
HOST=127.0.0.1 \
NODE_ENV=production \
DATA_DIR=/var/lib/stock-portfolio \
COOKIE_SECURE=true \
STOCK_APP_USERNAME=operator \
STOCK_APP_PASSWORD=change-me \
SESSION_TTL_DAYS=30 \
SESSION_SECRET=replace-with-a-long-random-string \
node server/server.js
```

The Node server serves `dist/`, exposes authenticated APIs under `/api`, and exposes unauthenticated health checks at `/healthz`.

For full single-server steps, including no-build updates, use [deploy/README.md](deploy/README.md). It includes:

- systemd service: [deploy/stock-portfolio.service](deploy/stock-portfolio.service)
- Nginx config for `aplan.top`: [deploy/nginx-aplan.top.conf](deploy/nginx-aplan.top.conf)
- environment template: [.env.production.example](.env.production.example)
- artifact builder: [deploy/build-artifact.sh](deploy/build-artifact.sh)
- artifact installer: [deploy/install-artifact.sh](deploy/install-artifact.sh)

Recommended production settings:

- Put the service behind HTTPS before exposing it publicly.
- Set `COOKIE_SECURE=true` when the public URL is HTTPS.
- Point `DATA_DIR` to a persistent disk. The default is `./data`.
- Replace the sample password before sharing the link.
- Login cookies are long-lived by default: `SESSION_TTL_DAYS=30`. Set `SESSION_SECRET` to a stable random string so sessions survive service restarts and can be invalidated intentionally by rotating the secret.
- The app uses a single login account. The backend still treats this account as an operator so it can manage trades and fund flows.
- Holding prices are refreshed by the backend via Tencent quote data. Use `PRICE_SYMBOL_MAP` when a local stock code needs a custom quote symbol, for example `{"BRK.B":"usBRK.B","00700":"hk00700"}`.
