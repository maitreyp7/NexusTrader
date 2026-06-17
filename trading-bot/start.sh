#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# start.sh — Start the ORB bot as a background daemon
#
# Usage:
#   ./start.sh          — start in background (survives terminal close)
#   ./start.sh --once   — run one pre-market check then exit (debugging)
#
# Logs are written to logs/bot.log (stdout + stderr combined).
# To follow live: tail -f logs/bot.log
# To stop: ./stop.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PID_FILE="$SCRIPT_DIR/logs/bot.pid"
LOG_FILE="$SCRIPT_DIR/logs/bot.log"
DISCORD_WEBHOOK=$(grep DISCORD_WEBHOOK_URL .env | cut -d '=' -f2-)

mkdir -p logs

# ── Check if already running ──────────────────────────────────────────────────
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Bot is already running (PID $OLD_PID)."
    echo "Use ./stop.sh to stop it first."
    exit 1
  else
    echo "Stale PID file found — cleaning up."
    rm -f "$PID_FILE"
  fi
fi

# ── Kill any orphaned instances ───────────────────────────────────────────────
ORPHANS=$(pgrep -f "tsx src/index.ts" 2>/dev/null || true)
if [ -n "$ORPHANS" ]; then
  echo "Killing orphaned bot processes: $ORPHANS"
  echo "$ORPHANS" | xargs kill 2>/dev/null || true
  sleep 1
fi

# ── Launch with auto-restart loop ─────────────────────────────────────────────
# The inner while loop restarts the bot if it crashes.
# Each restart is logged and a Discord alert is sent.
# caffeinate is tied to each bot process via -w so it always matches the live PID.

(
  RESTART_COUNT=0

  while true; do
    if [ $RESTART_COUNT -gt 0 ]; then
      MSG="**ORB Bot Restarted** (crash #$RESTART_COUNT) — $(date '+%Y-%m-%d %H:%M:%S %Z')"
      echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') [DAEMON] $MSG" >> "$LOG_FILE"
      if [ -n "$DISCORD_WEBHOOK" ]; then
        curl -s -X POST "$DISCORD_WEBHOOK" \
          -H "Content-Type: application/json" \
          -d "{\"content\": \"$MSG\"}" > /dev/null 2>&1 || true
      fi
      # Back off a bit before restarting to avoid crash loops
      sleep 10
    fi

    RESTART_COUNT=$((RESTART_COUNT + 1))
    echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') [DAEMON] Starting bot (attempt $RESTART_COUNT)..." >> "$LOG_FILE"

    npx tsx src/index.ts "$@" >> "$LOG_FILE" 2>&1 &
    BOT_PID=$!

    # Tie caffeinate to this exact bot process — exits automatically when bot exits
    caffeinate -isw $BOT_PID &
    CAFFEINATE_PID=$!
    echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') [DAEMON] caffeinate started (PID $CAFFEINATE_PID) watching bot PID $BOT_PID — Mac will stay awake" >> "$LOG_FILE"

    wait $BOT_PID
    EXIT_CODE=$?
    echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') [DAEMON] Bot exited with code $EXIT_CODE — restarting..." >> "$LOG_FILE"
  done
) &

DAEMON_PID=$!
echo $DAEMON_PID > "$PID_FILE"

echo ""
echo "Bot started in background (PID $DAEMON_PID)."
echo "Logs: tail -f logs/bot.log"
echo "Stop: ./stop.sh"
echo ""
