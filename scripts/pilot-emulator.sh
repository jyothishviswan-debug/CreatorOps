#!/usr/bin/env bash
# Remediation-plan Wave A / finding #69: a PERSISTENT local emulator profile for real-data pilot work.
#
# Problem this fixes: `firebase emulators:start` (with or without --config firebase.private.json) is
# in-memory only. A routine restart of the process - a machine reboot, a crashed terminal, closing the
# session - silently discards everything, with no warning. That is exactly what erased an entire real-data
# pilot's worth of work earlier in this program (real Partner, real Agreement, real Campaigns/Assignments/
# Content/Analytics) with nothing to restore from.
#
# This script always starts the SAME private-port config (firebase.private.json) with both
#   --import=<snapshot dir>       load whatever was last exported, if anything
#   --export-on-exit=<snapshot dir>   write the current state back out on a normal (Ctrl-C/SIGTERM) stop
# so a NORMAL restart of this exact script RESTORES the pilot's last state instead of wiping it. Data
# only disappears via the separate, explicitly-named reset-pilot-emulator-snapshot.sh script - never as
# a side effect of stopping and restarting this one.
#
# The snapshot directory is private and gitignored (emulator-data/ is already in .gitignore) - it is
# never committed, never part of any build artifact, and is NOT safe to share or upload as-is: real
# pilot data can include real KYC/PAN/Aadhaar/bank values and real business/campaign content. Treat the
# directory the same way you would treat a database backup containing real customer data.
set -euo pipefail

cd "$(dirname "$0")/.."

SNAPSHOT_DIR="emulator-data/pilot"
mkdir -p "$SNAPSHOT_DIR"

if [ -n "$(ls -A "$SNAPSHOT_DIR" 2>/dev/null)" ]; then
  RESTORE_NOTE="restoring the pilot's PREVIOUS state from $SNAPSHOT_DIR"
else
  RESTORE_NOTE="no prior snapshot found - starting from an empty emulator (first run, or the snapshot was explicitly reset)"
fi

cat <<EOF

================================================================================
 CreatorOps PILOT emulator (persistent, private-port profile)
================================================================================
 Snapshot directory : $SNAPSHOT_DIR   (gitignored - never committed, never shared)
 This run           : $RESTORE_NOTE
 On a normal stop    : the current state is written back to $SNAPSHOT_DIR
                        (a normal Ctrl-C/SIGTERM restart RESTORES, it does not wipe)

 WARNING: this snapshot can contain REAL business data once you run a real
 pilot through it - real KYC/PAN/Aadhaar/bank values, real Agreement terms,
 real Campaign/content data. Treat it like a database backup with real
 customer data in it: never commit it, never upload it, never share the
 directory outside this machine.

 To deliberately DISCARD the snapshot (not a normal restart - an explicit,
 separate action): scripts/reset-pilot-emulator-snapshot.sh --yes
================================================================================

EOF

exec firebase emulators:start --project demo-creatorops --config firebase.private.json --import="$SNAPSHOT_DIR" --export-on-exit="$SNAPSHOT_DIR"
