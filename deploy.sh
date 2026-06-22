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

# 0. Pre-flight: never deploy a parked commit (BACKLOG #31).
# Steps 3-4 rsync the ENTIRE working tree (--delete) to prod, so any commit
# tagged `parked-not-deployed` that sits in HEAD would be shipped silently,
# breaking a deliberate "do not deploy" park decision (e.g. #29's widenStepRange).
# Abort if the parked commit is an ancestor of HEAD, unless DEPLOY_ALLOW_PARKED=1
# is set to override consciously. Self-clears once the park tag is deleted at
# resurrection. (Note: rsync also excludes .git, so this guard is the ONLY thing
# standing between a parked working tree and production.)
# Scope: guards the Step-3 app-repo rsync. The Step-4 modules-repo rsync is
# intentionally NOT covered — no park mechanism exists in that repo today.
echo "[0/6] Pre-flight: parked-commit guard..."
PARKED_TAG="parked-not-deployed"
if git -C "$LOCAL_APP" rev-parse -q --verify "refs/tags/$PARKED_TAG" >/dev/null 2>&1; then
  PARKED_COMMIT="$(git -C "$LOCAL_APP" rev-list -n1 "$PARKED_TAG")"
  if git -C "$LOCAL_APP" merge-base --is-ancestor "$PARKED_COMMIT" HEAD 2>/dev/null; then
    if [ "${DEPLOY_ALLOW_PARKED:-0}" != "1" ]; then
      echo "      ❌ ABORT: HEAD contains parked commit ${PARKED_COMMIT:0:9} (tag $PARKED_TAG)."
      echo "         A whole-tree rsync would ship parked code to prod, breaking the park."
      echo "         Resolve the park, or set DEPLOY_ALLOW_PARKED=1 to override deliberately."
      exit 1
    fi
    echo "      ⚠️  DEPLOY_ALLOW_PARKED=1 set — shipping parked commit ${PARKED_COMMIT:0:9} consciously."
  else
    echo "      OK — no parked commit in HEAD."
  fi
else
  echo "      OK — no $PARKED_TAG tag present."
fi

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
# Deterministic restart: delete all PM2 processes, then start fresh from
# ecosystem.config.cjs. Closes two failure modes:
#   1. pm2 6.0.14 'pm2 start <config>' behavior against existing same-named
#      processes is undocumented (may update-in-place, may duplicate, may
#      error). Forcing 'pm2 delete all' first guarantees a known clean state.
#   2. Recovers from the 2026-06-02 dump.pm2 silent truncation: the new
#      'pm2 save' after the start writes a fresh dump matching reality.
# Brief gap: ~5-30s while apps stop and restart (pathological cases can
# run longer if a service is slow to shut down). profile-api's Chrome
# respawns via its own 120s health check after profile-api itself comes up.
echo "[6/6] Restarting application..."
ssh "$SERVER" "cd $REMOTE_APP && pm2 delete all 2>/dev/null || true && pm2 start ecosystem.config.cjs && pm2 save"

echo ""
echo "=== Deploy complete ==="
echo "App is live at: http://188.245.110.34:3001"
echo ""
echo "Useful commands:"
echo "  ssh hetzner 'pm2 logs content-pipeline-v2'    # View logs"
echo "  ssh hetzner 'pm2 status'                       # Check status"
echo "  ssh hetzner 'curl localhost:3001/api/health'   # Health check"
