#!/bin/bash
set -e

# Deploy content-pipeline-v2 to Hetzner
# Usage: ./deploy.sh

SERVER="hetzner"
REMOTE_APP="/opt/content-pipeline-v2"
REMOTE_MODULES="/opt/content-pipeline-modules-v2"
LOCAL_APP="$(cd "$(dirname "$0")" && pwd)"
LOCAL_MODULES="$(cd "$LOCAL_APP/../content-pipeline-modules-v2" && pwd)"

echo "=== Content Pipeline v2 — Deploy to Hetzner ==="
echo ""

# 1. Build the React client locally
echo "[1/6] Building React client..."
cd "$LOCAL_APP/client"
npm run build
echo "      Client built successfully."

# 2. Create remote directories
echo "[2/6] Preparing server directories..."
ssh "$SERVER" "mkdir -p $REMOTE_APP/logs $REMOTE_MODULES"

# 3. Sync the app (excluding dev files)
echo "[3/6] Syncing app to server..."
rsync -azP --delete \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='.git' \
  --exclude='.DS_Store' \
  "$LOCAL_APP/" "$SERVER:$REMOTE_APP/"

# 4. Sync the modules repo
echo "[4/6] Syncing modules to server..."
rsync -azP --delete \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='.DS_Store' \
  "$LOCAL_MODULES/" "$SERVER:$REMOTE_MODULES/"

# 5. Install dependencies on server
echo "[5/6] Installing dependencies on server..."
ssh "$SERVER" "cd $REMOTE_APP && npm install --omit=dev"

# 6. Restart PM2
echo "[6/6] Restarting application..."
ssh "$SERVER" "cd $REMOTE_APP && pm2 delete content-pipeline-v2 2>/dev/null || true && pm2 start ecosystem.config.cjs && pm2 save"

echo ""
echo "=== Deploy complete ==="
echo "App is live at: http://188.245.110.34:3001"
echo ""
echo "Useful commands:"
echo "  ssh hetzner 'pm2 logs content-pipeline-v2'    # View logs"
echo "  ssh hetzner 'pm2 status'                       # Check status"
echo "  ssh hetzner 'curl localhost:3001/api/health'   # Health check"
