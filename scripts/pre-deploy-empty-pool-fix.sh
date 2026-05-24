#!/bin/bash
# Pre-deploy: tag both repos, write decision_log entries, print rollback recipe.
#
# Run before ./deploy.sh when shipping the empty-pool bug fix.
# After this script succeeds, you can paste the printed rollback commands
# if the deploy goes sideways.
set -e

DATE=$(date +%Y-%m-%d)
TAG="pre-empty-pool-fix-${DATE}"

SUPABASE_URL=https://zgfvgghfkkbrbiunsgry.supabase.co

if [ -z "$SUPABASE_ANON_KEY" ]; then
  echo "ERROR: SUPABASE_ANON_KEY env var not set. Set it in your shell profile."
  exit 1
fi

# ---- Tag skeleton ----
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-v2
SKELETON_TAG_REF=$(git rev-parse HEAD)
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "WARN: skeleton already has tag $TAG — skipping create"
else
  git tag -a "$TAG" -m "Pre-deploy snapshot before empty-pool-fix rollout" "$SKELETON_TAG_REF"
  git push origin "$TAG"
fi

# ---- Tag modules ----
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-modules-v2
MODULES_TAG_REF=$(git rev-parse HEAD)
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "WARN: modules already has tag $TAG — skipping create"
else
  git tag -a "$TAG" -m "Pre-deploy snapshot before empty-pool-fix rollout" "$MODULES_TAG_REF"
  git push origin "$TAG"
fi

# ---- Write decision_log entries ----
for proj in content-pipeline-v2 content-pipeline-modules-v2; do
  curl -s -X POST "$SUPABASE_URL/rest/v1/decision_log" \
    -H "apikey: $SUPABASE_ANON_KEY" \
    -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"project_name\":\"$proj\",\"entry_type\":\"decision\",\"summary\":\"Pre-deploy snapshot for empty-pool-fix rollout\",\"decision_made\":\"Tagged $TAG on both repos before rsync deploy. Rollback recipe printed.\",\"source\":\"manual\"}" \
    > /dev/null
done

echo ""
echo "=== Pre-deploy snapshot complete ==="
echo "Skeleton tagged: $SKELETON_TAG_REF as $TAG"
echo "Modules tagged:  $MODULES_TAG_REF as $TAG"
echo ""
echo "ROLLBACK COMMANDS (if deploy fails):"
echo ""
echo "  cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-v2"
echo "  git reset --hard $TAG"
echo "  cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-modules-v2"
echo "  git reset --hard $TAG"
echo "  cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-v2"
echo "  ./deploy.sh   # re-rsyncs the rolled-back state"
echo ""
echo "  ssh hetzner 'pm2 logs pipeline-api --lines 50 --err --nostream'   # post-rollback health check"
