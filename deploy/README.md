# Single-server deployment

Assumptions:

- Domain: `aplan.top`
- App path: `/opt/stock-portfolio`
- Data path: `/var/lib/stock-portfolio`
- Node service listens on `127.0.0.1:8080`
- Nginx terminates HTTPS and proxies to Node
- Server needs a Node.js runtime, but does not need npm install/build steps
- Frontend build happens locally or in CI, not on the server

## Build an artifact

Run this on a machine with enough memory for webpack:

```bash
npm run deploy:artifact
```

If dependencies are already installed and you only want to rebuild/package:

```bash
SKIP_NPM_CI=1 npm run deploy:artifact
```

If `dist/` already exists and you only want to package the existing build:

```bash
SKIP_NPM_CI=1 SKIP_BUILD=1 npm run deploy:artifact
```

The artifact is written to `release/stock-portfolio-*.tar.gz`. It contains
only runtime files: `dist/`, `server/`, `deploy/`, `.env.production.example`,
and `package.json`. It does not include `node_modules`.

Upload the artifact and the installer to the server:

```bash
scp release/stock-portfolio-*.tar.gz deploy/install-artifact.sh deploy/stock-portfolio.service your-server:/tmp/
```

## First Deploy

```bash
sudo useradd --system --create-home --home-dir /opt/stock-portfolio --shell /usr/sbin/nologin stockapp
sudo mkdir -p /opt/stock-portfolio /var/lib/stock-portfolio
sudo chown -R stockapp:stockapp /opt/stock-portfolio /var/lib/stock-portfolio
```

Install the uploaded artifact without starting the service yet:

```bash
sudo env RESTART_SERVICE=0 bash /tmp/install-artifact.sh /tmp/stock-portfolio-*.tar.gz
```

Create the production environment file and install the systemd unit:

```bash
sudo cp /opt/stock-portfolio/current/.env.production.example /etc/stock-portfolio.env
sudo editor /etc/stock-portfolio.env
sudo cp /tmp/stock-portfolio.service /etc/systemd/system/stock-portfolio.service
sudo systemctl daemon-reload
sudo systemctl enable --now stock-portfolio
curl http://127.0.0.1:8080/healthz
```

## Nginx and HTTPS

Install Nginx and Certbot, then issue a certificate:

```bash
sudo mkdir -p /var/www/certbot
sudo cp /opt/stock-portfolio/current/deploy/nginx-aplan.top.conf /etc/nginx/sites-available/aplan.top
sudo ln -sf /etc/nginx/sites-available/aplan.top /etc/nginx/sites-enabled/aplan.top
sudo nginx -t
sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/certbot -d aplan.top -d www.aplan.top
sudo nginx -t
sudo systemctl reload nginx
```

## Update Deploy

Build and upload a new artifact from your local machine or CI, then run this
on the server:

```bash
sudo bash /tmp/install-artifact.sh /tmp/stock-portfolio-*.tar.gz
sudo systemctl status stock-portfolio --no-pager
```

The installer extracts each artifact into `/opt/stock-portfolio/releases/` and
updates `/opt/stock-portfolio/current`. The server only restarts Node; it does
not install npm packages or run webpack.

## GitHub Actions Deploy

The repository includes `.github/workflows/deploy.yml`. GitHub Actions builds
the frontend, creates the runtime artifact, uploads it to the server, installs
the systemd unit, and runs `install-artifact.sh`.

Required repository secrets:

- `DEPLOY_HOST`: server IP or domain.
- `DEPLOY_USER`: SSH user.
- `DEPLOY_SSH_KEY`: private key for SSH access from GitHub Actions to the server.

Optional repository secrets:

- `PRODUCTION_ENV`: content to install as `/etc/stock-portfolio.env`.
- `DEPLOY_PORT`: SSH port, default `22`.
- `DEPLOY_KNOWN_HOSTS`: pinned server host key. If omitted, the workflow uses
  `ssh-keyscan`.

Recommended deploy-key setup:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/aplan_github_actions -C github-actions-aplan -N ""
ssh-copy-id -i ~/.ssh/aplan_github_actions.pub DEPLOY_USER@DEPLOY_HOST
cat ~/.ssh/aplan_github_actions
```

Paste the private key printed by the last command into `DEPLOY_SSH_KEY`.

The deploy SSH user must be able to run `sudo` without an interactive password.
If `PRODUCTION_ENV` is not set, create `/etc/stock-portfolio.env` on the server
before the first workflow run.

Manual runs work from the GitHub Actions tab. To deploy automatically on every
push to `main`, set repository variable `DEPLOY_ENABLED=true`.

## Rollback

Point `current` at an older release and restart the service:

```bash
ls -1 /opt/stock-portfolio/releases
sudo ln -sfn /opt/stock-portfolio/releases/YYYYMMDDHHMMSS /opt/stock-portfolio/current
sudo systemctl restart stock-portfolio
```

## Backup

Back up `/var/lib/stock-portfolio/store.json`. For example:

```bash
sudo cp /var/lib/stock-portfolio/store.json "/var/lib/stock-portfolio/store.$(date +%F-%H%M%S).json"
```
