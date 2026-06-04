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
STORAGE_DRIVER=sqlite \
DB_FILE=/var/lib/stock-portfolio/aplan.sqlite \
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

## GitHub Actions Deploy

The workflow in [.github/workflows/deploy.yml](.github/workflows/deploy.yml)
builds the app on GitHub Actions, uploads the runtime artifact over SSH, and
runs `deploy/install-artifact.sh` on the server. The server still does not run
`npm ci` or `npm run build`. During deployment the workflow checks the server
runtime and installs Node.js 20 and SQLite when they are missing on common
Ubuntu/Debian, CentOS, Alibaba Cloud Linux, or other yum/dnf based images.

Configure these repository secrets in GitHub:

- `DEPLOY_HOST`: server IP or domain.
- `DEPLOY_USER`: SSH user on the server. This user must be able to run `sudo`
  without an interactive password for deployment commands.
- `DEPLOY_SSH_KEY`: private SSH key used by GitHub Actions to log in to the
  server. Use a dedicated deploy key, not your GitHub account key.
- `PRODUCTION_ENV`: optional content for `/etc/stock-portfolio.env`. If omitted,
  create `/etc/stock-portfolio.env` on the server before the first deploy.
- `DEPLOY_PORT`: optional SSH port. Defaults to `22`.
- `DEPLOY_KNOWN_HOSTS`: optional pinned server host key. If omitted, the workflow
  uses `ssh-keyscan`.

Recommended deploy-key setup:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/aplan_github_actions -C github-actions-aplan -N ""
ssh-copy-id -i ~/.ssh/aplan_github_actions.pub DEPLOY_USER@DEPLOY_HOST
cat ~/.ssh/aplan_github_actions
```

Paste the private key printed by the last command into `DEPLOY_SSH_KEY`.

Optional repository variables:

- `DEPLOY_ENABLED`: set to `true` to deploy automatically on every push to
  `main`. Without this, use manual runs from the Actions tab.
- `APP_ROOT`: defaults to `/opt/stock-portfolio`.
- `DATA_DIR`: defaults to `/var/lib/stock-portfolio`.
- `SERVICE_NAME`: defaults to `stock-portfolio`.
- `RUN_USER`: defaults to `stockapp`.
- `RUN_GROUP`: defaults to `stockapp`.
- `HEALTHCHECK_URL`: defaults to `http://127.0.0.1:8080/healthz`.

Recommended `PRODUCTION_ENV` secret:

```env
NODE_ENV=production
PORT=8080
HOST=127.0.0.1
DATA_DIR=/var/lib/stock-portfolio
STORAGE_DRIVER=sqlite
DB_FILE=/var/lib/stock-portfolio/aplan.sqlite
COOKIE_SECURE=true
STOCK_APP_USERNAME=operator
STOCK_APP_PASSWORD=replace-with-a-strong-password
SESSION_TTL_DAYS=30
SESSION_SECRET=replace-with-at-least-32-random-characters
QUOTE_REFRESH_TIMEOUT_MS=10000
```

The workflow can be run manually from the GitHub Actions tab. Pushes to `main`
deploy automatically only after `DEPLOY_ENABLED=true` is set.

Recommended production settings:

- Put the service behind HTTPS before exposing it publicly.
- Set `COOKIE_SECURE=true` when the public URL is HTTPS.
- Use `STORAGE_DRIVER=sqlite` in production. The default production database
  path is `/var/lib/stock-portfolio/aplan.sqlite`.
- Point `DATA_DIR` and `DB_FILE` to a persistent disk.
- Replace the sample password before sharing the link.
- Login cookies are long-lived by default: `SESSION_TTL_DAYS=30`. Set `SESSION_SECRET` to a stable random string so sessions survive service restarts and can be invalidated intentionally by rotating the secret.
- The app uses a single login account. The backend still treats this account as an operator so it can manage trades and fund flows.
- Holding prices are refreshed by the backend via Tencent quote data. Use `PRICE_SYMBOL_MAP` when a local stock code needs a custom quote symbol, for example `{"BRK.B":"usBRK.B","00700":"hk00700"}`.

## Data Storage

Development can still use the JSON store by setting `STORAGE_DRIVER=json`, but
production defaults to SQLite. On first SQLite startup, if the database is empty
and `DATA_FILE`/`data/store.json` exists, the app imports existing JSON data
into SQLite automatically.

For a single Alibaba Cloud ECS instance, SQLite with WAL is the recommended
production baseline: it is local, fast, transactional, and simple to back up.
Use Alibaba Cloud RDS MySQL/PostgreSQL later if you need multiple app servers,
remote database management, point-in-time recovery, or managed high
availability.

Back up SQLite with:

```bash
sudo sqlite3 /var/lib/stock-portfolio/aplan.sqlite ".backup '/var/lib/stock-portfolio/aplan.$(date +%F-%H%M%S).sqlite'"
```
