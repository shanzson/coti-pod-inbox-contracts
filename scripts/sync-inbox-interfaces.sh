#!/usr/bin/env bash
# Sync stable inbox-facing APIs from this repo into coti-contracts under contracts/pod/
# (the path consumers import — e.g. `import "../IInbox.sol"` from privacy/, mpc/, etc.).
#
# Layout:
#   contracts/IInbox.sol              → contracts/pod/IInbox.sol
#   contracts/IInboxMiner.sol         → contracts/pod/IInboxMiner.sol
#   contracts/InboxUser.sol           → contracts/pod/InboxUser.sol
#   contracts/InboxUserCotiTestnet.sol→ contracts/pod/InboxUserCotiTestnet.sol
#   contracts/fee/IInboxFeeManager.sol→ contracts/pod/fee/IInboxFeeManager.sol
#   contracts/mpccodec/MpcAbiCodec.sol→ contracts/pod/mpccodec/MpcAbiCodec.sol
#
# Usage:
#   ./scripts/sync-inbox-interfaces.sh /path/to/coti-contracts
#   TARGET=/path/to/coti-contracts ./scripts/sync-inbox-interfaces.sh
#
# Do not edit synced files in coti-contracts by hand — change here and re-run sync.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_ROOT="${1:-${TARGET:-}}"

if [[ -z "$TARGET_ROOT" ]]; then
  echo "Usage: $0 <path-to-coti-contracts>" >&2
  exit 1
fi

POD_DEST="${TARGET_ROOT}/contracts/pod"
mkdir -p "${POD_DEST}/fee" "${POD_DEST}/mpccodec"

# source_rel → dest_rel (under TARGET_ROOT)
declare -a SYNC_PAIRS=(
  "contracts/IInbox.sol:contracts/pod/IInbox.sol"
  "contracts/IInboxMiner.sol:contracts/pod/IInboxMiner.sol"
  "contracts/InboxUser.sol:contracts/pod/InboxUser.sol"
  "contracts/InboxUserCotiTestnet.sol:contracts/pod/InboxUserCotiTestnet.sol"
  "contracts/fee/IInboxFeeManager.sol:contracts/pod/fee/IInboxFeeManager.sol"
  "contracts/mpccodec/MpcAbiCodec.sol:contracts/pod/mpccodec/MpcAbiCodec.sol"
)

for pair in "${SYNC_PAIRS[@]}"; do
  src_rel="${pair%%:*}"
  dest_rel="${pair##*:}"
  src="${REPO_ROOT}/${src_rel}"
  dest="${TARGET_ROOT}/${dest_rel}"
  if [[ ! -f "$src" ]]; then
    echo "Missing source: ${src}" >&2
    exit 1
  fi
  cp "$src" "$dest"
  echo "  ${src_rel} → ${dest_rel}"
done

# MpcAbiCodec: rewrite imports for coti-contracts layout (pod/mpccodec/ → utils/mpc/).
CODEC="${POD_DEST}/mpccodec/MpcAbiCodec.sol"
sed -i 's|import "../utils/mpc/MpcCore.sol"|import "../../utils/mpc/MpcCore.sol"|g' "${CODEC}"
sed -i 's|import "../../utils/mpc/MpcCore.sol"|import "../../utils/mpc/MpcCore.sol"|g' "${CODEC}"
# Keep IInbox as sibling under pod/
sed -i 's|import "../IInbox.sol"|import "../IInbox.sol"|g' "${CODEC}"

# Remove mistaken legacy destination if present (old sync wrote to contracts/pod/inbox/).
if [[ -d "${POD_DEST}/inbox" ]]; then
  echo "Removing obsolete ${POD_DEST}/inbox/ (consumers import contracts/pod/, not pod/inbox/)"
  rm -rf "${POD_DEST}/inbox"
fi

MANIFEST="${POD_DEST}/SYNC_MANIFEST.json"
python3 - "$REPO_ROOT" "$MANIFEST" "${SYNC_PAIRS[@]}" <<'PY'
import hashlib, json, os, subprocess, sys
from datetime import datetime, timezone

repo_root, manifest_path = sys.argv[1], sys.argv[2]
pairs = sys.argv[3:]

def git_sha(root):
    try:
        return subprocess.check_output(["git", "-C", root, "rev-parse", "HEAD"], text=True).strip()
    except Exception:
        return "unknown"

entries = []
for pair in pairs:
    src_rel, dest_rel = pair.split(":", 1)
    path = os.path.join(repo_root, src_rel)
    with open(path, "rb") as f:
        h = hashlib.sha256(f.read()).hexdigest()
    entries.append({"source": src_rel, "dest": dest_rel, "sha256": h})

doc = {
    "syncedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "sourceRepo": "coti-pod-inbox-contracts",
    "sourceCommit": git_sha(repo_root),
    "destRoot": "contracts/pod",
    "files": entries,
}
with open(manifest_path, "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
print(f"Wrote {manifest_path} ({len(entries)} files)")
PY

echo "Synced inbox interfaces to ${POD_DEST}/ (consumer import path)"
