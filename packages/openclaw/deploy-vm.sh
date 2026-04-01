#!/usr/bin/env bash
# Deploy @agenthifive/openclaw plugin to the local VirtualBox VM.
#
# Usage: bash deploy-vm.sh [-e integration|vps]
#
# Environments:
#   integration  (default) — app-integration.agenthifive.com
#   vps                    — ah5.agenthifive.it
#
# Steps:
#   1. Build + pack both plugin and setup tarballs
#   2. Generate fresh bootstrap secret via AH5 API
#   3. SCP tarballs to VM
#   4. Stop gateway, clean config, uninstall old plugin, remove old tarballs
#   5. Install plugin from new tarball
#   6. Run setup --mode reconnect from setup tarball
#   7. Start gateway + verify

set -euo pipefail

# --- Parse flags ---
ENVIRONMENT="integration"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -e|--environment)
      ENVIRONMENT="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: bash deploy-vm.sh [-e integration|vps]" >&2
      exit 1
      ;;
  esac
done

# --- Environment config ---
case "$ENVIRONMENT" in
  integration)
    AH5_BASE_URL="https://app-integration.agenthifive.com"
    AH5_PERSONAL_TOKEN="ah5p_lejiTpJLZq2MiLKkwxi_0FussLNULWTVT7_ed7V3hXw"
    AH5_AGENT_ID="f729a53d-35cc-4782-8116-b63d81975386"
    ;;
  vps)
    AH5_BASE_URL="https://ah5.agenthifive.it"
    AH5_PERSONAL_TOKEN="ah5p_EfzlFyVRTGFNKqeUu-KpUXSQI9yY8P9jkFwjVwuDjgY"
    AH5_AGENT_ID="a145df5b-a9f5-4434-b454-08a42707c668"
    ;;
  *)
    echo "Unknown environment: $ENVIRONMENT (expected: integration, vps)" >&2
    exit 1
    ;;
esac

echo "=== Environment: $ENVIRONMENT ($AH5_BASE_URL) ==="

# --- Config ---
VM_USER="osboxes"
VM_HOST="172.29.192.1"
VM_PORT="2222"
VM_SSH="ssh -p $VM_PORT $VM_USER@$VM_HOST"
VM_SCP="scp -P $VM_PORT"

DEFAULT_MODEL="anthropic/claude-sonnet-4-6"

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PLUGIN_DIR="$REPO_DIR/packages/openclaw"
SETUP_DIR="$REPO_DIR/packages/openclaw-setup"

# --- 1. Build + pack both packages ---
echo "=== 1. Build + pack ==="

rm -f /tmp/agenthifive-agenthifive-*.tgz /tmp/agenthifive-openclaw-setup-*.tgz

cd "$PLUGIN_DIR"
pnpm build
PLUGIN_TARBALL=$(pnpm pack --pack-destination /tmp 2>&1 | tail -1)
PLUGIN_TARBALL_NAME=$(basename "$PLUGIN_TARBALL")
echo "  plugin:  $PLUGIN_TARBALL"

cd "$SETUP_DIR"
pnpm build
SETUP_TARBALL=$(pnpm pack --pack-destination /tmp 2>&1 | tail -1)
SETUP_TARBALL_NAME=$(basename "$SETUP_TARBALL")
echo "  setup:   $SETUP_TARBALL"

# --- 2. Generate bootstrap secret ---
echo "=== 2. Generate bootstrap secret ==="
BOOTSTRAP_SECRET=$(curl -sfL -X POST \
  "$AH5_BASE_URL/v1/agents/$AH5_AGENT_ID/bootstrap-secret" \
  -H "Authorization: Bearer $AH5_PERSONAL_TOKEN" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['bootstrapSecret'])")
echo "  got: ${BOOTSTRAP_SECRET:0:10}..."

# --- 3. Upload tarballs ---
echo "=== 3. Upload tarballs ==="
$VM_SCP "$PLUGIN_TARBALL" "$VM_USER@$VM_HOST:/home/osboxes/$PLUGIN_TARBALL_NAME"
$VM_SCP "$SETUP_TARBALL" "$VM_USER@$VM_HOST:/home/osboxes/$SETUP_TARBALL_NAME"

# --- 4-7. Remote deploy ---
echo "=== 4. Deploy on VM ==="
$VM_SSH bash -s -- "$PLUGIN_TARBALL_NAME" "$SETUP_TARBALL_NAME" "$BOOTSTRAP_SECRET" "$AH5_BASE_URL" "$DEFAULT_MODEL" <<'REMOTE'
set -euo pipefail
source ~/.nvm/nvm.sh

PLUGIN_TARBALL_NAME="$1"
SETUP_TARBALL_NAME="$2"
BOOTSTRAP_SECRET="$3"
AH5_BASE_URL="$4"
DEFAULT_MODEL="$5"

SETUP_TARBALL="/home/osboxes/$SETUP_TARBALL_NAME"

echo "  [4] Stopping gateway..."
openclaw gateway stop 2>/dev/null || true
sleep 2

echo "  [4] Removing old tarballs..."
find /home/osboxes -maxdepth 1 -name 'agenthifive-agenthifive-*.tgz' ! -name "$PLUGIN_TARBALL_NAME" -delete
find /home/osboxes -maxdepth 1 -name 'agenthifive-openclaw-setup-*.tgz' ! -name "$SETUP_TARBALL_NAME" -delete

echo "  [5] Removing AH5 config entries..."
npx --package="$SETUP_TARBALL" ah5-setup --mode remove --non-interactive 2>/dev/null || true

echo "  [5] Uninstalling old plugin..."
openclaw plugins uninstall agenthifive --force 2>/dev/null || true

echo "  [5] Installing plugin from tarball..."
openclaw plugins install "/home/osboxes/$PLUGIN_TARBALL_NAME"

echo "  [6] Running setup (reconnect)..."
npx --package="$SETUP_TARBALL" ah5-setup \
  --mode reconnect \
  --base-url "$AH5_BASE_URL" \
  --bootstrap-secret "$BOOTSTRAP_SECRET" \
  --default-model "$DEFAULT_MODEL" \
  --non-interactive \
  --skip-plugin-install

echo "  [7] Starting gateway..."
openclaw gateway start

echo "  Done!"
REMOTE

# --- Verify ---
echo "=== 5. Verify ==="
LOCAL_HASH=$(cd "$PLUGIN_DIR" && find dist -name "*.js" -type f | LC_ALL=C sort | while read f; do sha256sum "$f"; done | cut -d' ' -f1 | sha256sum | cut -d' ' -f1)
REMOTE_HASH=$($VM_SSH "cd /home/osboxes/.openclaw/extensions/agenthifive && find dist -name '*.js' -type f | LC_ALL=C sort | while read f; do sha256sum \"\$f\"; done | cut -d' ' -f1 | sha256sum | cut -d' ' -f1")
REMOTE_VERSION=$($VM_SSH "source ~/.nvm/nvm.sh && node -e \"console.log(require('/home/osboxes/.openclaw/extensions/agenthifive/package.json').version)\"")

echo "  local  dist hash: ${LOCAL_HASH:0:12}..."
echo "  remote dist hash: ${REMOTE_HASH:0:12}..."
echo "  remote version:   $REMOTE_VERSION"

if [ "$LOCAL_HASH" = "$REMOTE_HASH" ]; then
  echo "  MATCH — deployed code is identical to local build"
else
  echo "  MISMATCH — something went wrong, remote differs from local"
  exit 1
fi

echo ""
echo "=== Deploy complete ==="
