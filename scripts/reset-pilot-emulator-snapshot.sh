#!/usr/bin/env bash
# Remediation-plan Wave A / finding #69: the EXPLICIT, deliberately-separate way to discard the
# persistent pilot emulator's snapshot (emulator-data/pilot/, written by scripts/pilot-emulator.sh).
#
# A normal restart of scripts/pilot-emulator.sh RESTORES the snapshot - it never deletes it. Data is
# only ever lost here, through this script, run on purpose, with the explicit --yes flag. Without
# --yes this is a safe, non-destructive dry run that only reports what would be deleted.
set -euo pipefail

cd "$(dirname "$0")/.."

SNAPSHOT_DIR="emulator-data/pilot"

if [ ! -d "$SNAPSHOT_DIR" ] || [ -z "$(ls -A "$SNAPSHOT_DIR" 2>/dev/null)" ]; then
  echo "No pilot snapshot exists at $SNAPSHOT_DIR - nothing to reset."
  exit 0
fi

SIZE=$(du -sh "$SNAPSHOT_DIR" 2>/dev/null | cut -f1)

if [ "${1:-}" != "--yes" ]; then
  cat <<EOF
DRY RUN (no --yes given, nothing was deleted):
  Would permanently delete: $SNAPSHOT_DIR ($SIZE)
  This can contain real business/KYC data from a real-data pilot run.

To actually reset (irreversible - the pilot emulator will start EMPTY next time):
  scripts/reset-pilot-emulator-snapshot.sh --yes
EOF
  exit 0
fi

# Make sure nothing is actively using it before deleting.
if pgrep -f "firebase emulators:start.*firebase.private.json" >/dev/null 2>&1; then
  echo "Refusing to reset: the pilot emulator appears to be running. Stop it first (a normal Ctrl-C/SIGTERM), then re-run this script." >&2
  exit 1
fi

rm -rf "$SNAPSHOT_DIR"
echo "Pilot emulator snapshot reset: $SNAPSHOT_DIR ($SIZE) deleted. The next scripts/pilot-emulator.sh run starts empty."
