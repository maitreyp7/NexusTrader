#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# stop.sh — Gracefully stop the ORB bot daemon
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PID_FILE="$SCRIPT_DIR/logs/bot.pid"

# Kill the daemon wrapper process
if [ -f "$PID_FILE" ]; then
  DAEMON_PID=$(cat "$PID_FILE")
  if kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "Stopping daemon (PID $DAEMON_PID)..."
    kill "$DAEMON_PID" 2>/dev/null || true
  else
    echo "Daemon PID $DAEMON_PID not found — may have already stopped."
  fi
  rm -f "$PID_FILE"
else
  echo "No PID file found — bot may not be running."
fi

# Kill any remaining tsx/node bot processes
ORPHANS=$(pgrep -f "tsx src/index.ts" 2>/dev/null || true)
if [ -n "$ORPHANS" ]; then
  echo "Killing remaining bot processes: $ORPHANS"
  echo "$ORPHANS" | xargs kill 2>/dev/null || true
fi

# Release caffeinate so Mac can sleep normally again
CAFE=$(pgrep caffeinate 2>/dev/null || true)
if [ -n "$CAFE" ]; then
  echo "Releasing caffeinate — Mac can sleep again."
  echo "$CAFE" | xargs kill 2>/dev/null || true
fi

echo "Bot stopped."
