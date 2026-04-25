#!/bin/bash
# Reinstall all polymarket systemd services + Docker stack from current branch.
# Run as root (or via sudo) on a live box for manual recovery/reinstall.
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
UBUNTU_USER="${SUDO_USER:-ubuntu}"

echo "=== Polymarket Service Installer ==="
echo "Repo: $REPO_DIR"
echo "User: $UBUNTU_USER"

# 1. npm install (root repo)
echo ""
echo "[1/5] Installing npm dependencies..."
sudo -u "$UBUNTU_USER" npm install --prefix "$REPO_DIR"

# 2. polymarket-paper.service (SQLite sim engine)
echo ""
echo "[2/5] Writing polymarket-paper.service..."
cat > /etc/systemd/system/polymarket-paper.service << EOF
[Unit]
Description=Polymarket paper-trading engine (backend sim)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$UBUNTU_USER
WorkingDirectory=$REPO_DIR
Environment=NODE_ENV=production
Environment=PAPER_PORT=7801
Environment=PAPER_HOST=127.0.0.1
EnvironmentFile=-$REPO_DIR/.env
ExecStart=/usr/bin/node --experimental-strip-types --no-warnings=ExperimentalWarning sim/server.ts
Restart=on-failure
RestartSec=5
StandardOutput=append:$REPO_DIR/paper-engine.log
StandardError=append:$REPO_DIR/paper-engine.log

[Install]
WantedBy=multi-user.target
EOF

# 3. polymarket-frontend.service (Vite dev server)
echo "[3/5] Writing polymarket-frontend.service..."
cat > /etc/systemd/system/polymarket-frontend.service << EOF
[Unit]
Description=Polymarket frontend (Vite dev server)
After=network-online.target polymarket-paper.service
Wants=network-online.target

[Service]
Type=simple
User=$UBUNTU_USER
WorkingDirectory=$REPO_DIR
Environment=NODE_ENV=development
ExecStart=$REPO_DIR/node_modules/.bin/vite --host
Restart=on-failure
RestartSec=5
StandardOutput=append:$REPO_DIR/frontend.log
StandardError=append:$REPO_DIR/frontend.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable polymarket-paper polymarket-frontend

# 4. Docker stack — Postgres + NestJS backend
echo ""
echo "[4/5] Starting Docker containers (Postgres + NestJS backend)..."
cd "$REPO_DIR/backend"
sudo -u "$UBUNTU_USER" docker compose up -d --build

# 5. Start paper engine
echo ""
echo "[5/5] Starting polymarket-paper service..."
systemctl start polymarket-paper

echo ""
echo "=== Done ==="
echo "Paper engine  : systemctl status polymarket-paper"
echo "Frontend      : systemctl status polymarket-frontend"
echo "Nest backend  : docker ps"
echo "Logs (paper)  : tail -f $REPO_DIR/paper-engine.log"
echo "Logs (frontend): tail -f $REPO_DIR/frontend.log"
echo ""
echo "NOTE: Copy .env to $REPO_DIR/.env before the paper engine can connect to live APIs."
