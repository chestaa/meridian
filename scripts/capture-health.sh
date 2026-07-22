#!/usr/bin/env bash
# capture-health.sh — Draco 🐉
#
# Output-FRESHNESS heartbeat. This is the specific guard against a silent
# stale-data repeat (the 18-day-stale-screener class of failure): we do NOT
# trust "the timer is enabled" — we verify the capture is actually WRITING.
#
# Checks (any FAILURE reason = unhealthy/page; DEGRADED notes never page):
#   A/B) tier1 liveness + freshness — MANIFEST-FIRST (2026-07-22, Draco).
#      The old logic keyed purely on plain-.jsonl file existence/mtime. That
#      proxy breaks two ways that both hard-paged FALSELY:
#        1. Sustained upstream 429: the sweep runs but captures 0 rows, so
#           today's utcDay file is never created; meanwhile the rotate timer
#           gzips yesterday's file. Result: `ls tier1/*.jsonl` is EMPTY and
#           check A fired `no_tier1_capture_file_at_all` → page. (This is the
#           "belum ada file hari ini karena 429" spam this revision kills.)
#        2. Recovery after rotate: capture writes 1000 rows to today's plain
#           .jsonl, then the rotate timer gzips it → again no plain .jsonl →
#           false page even though capture is HEALTHY.
#      The manifest (`manifest.jsonl`, one line per sweep) is the authoritative
#      liveness signal, so we classify tier1 from the LAST tier1 sweep entry:
#        - No tier1 sweep in > FULL_STALE  → the sweep PROCESS/timer is dead →
#          genuine silent death → PAGE.
#        - Recent sweep, sources_degraded non-empty (e.g. Pool Discovery 429) →
#          alive-but-blocked-upstream, not restart-actionable here → non-paging
#          NOTE, escalate ONE page only if sustained > 6h.
#        - Recent sweep, pools_captured > 0 → capture IS writing; a missing/
#          stale/gzipped plain .jsonl is just rotation → non-paging NOTE.
#        - Recent sweep, 0 captured, NO degradation reported → silent
#          zero-capture (a real failure this heartbeat exists to catch) → PAGE.
#      The plain-file existence/mtime is retained only as the base_reason label
#      for the genuine-death page; the manifest decides paging.
#   C) 0-rows-while-API-reachable: if the newest plain tier1 file has 0 data
#      rows AND the Meteora API is reachable AND we are NOT in a known upstream
#      degradation, that's a silent failure (not an outage) → unhealthy.
#
# Aligned to Cassiopeia's capture-logger.js layout:
#   /var/lib/meridian-capture/tier1/YYYY-MM-DD.jsonl   (hourly full sweep)
#   /var/lib/meridian-capture/tier2/YYYY-MM-DD.jsonl   (15-min watchlist)
#   /var/lib/meridian-capture/manifest.jsonl           (per-sweep log)
#
# Emits capture-freshness.json into the status worktree (committed + pushed)
# so Polaris sees freshness via the status branch with NO SSH. Alerts via
# the existing meridian-notify path on unhealthy.
set -uo pipefail

CAP_DIR=/var/lib/meridian-capture
WORKTREE=/opt/meridian/.git-worktrees/status
OUT="$WORKTREE/capture-freshness.json"
LOCKFILE=/opt/meridian/.git-worktrees/.snapshot.lock
NOW=$(date -u +%s)
API_PROBE="https://dlmm-api.meteora.ag/pair/all_with_pagination?page=0&limit=1"

# tunables (seconds)
# tier1 (full):  cadence 60min -> stale if > 2x = 120min
# tier2 (watch): cadence 15min. A watchlist of 1 pool means a SINGLE transient
#   detail-fetch miss (pool_not_found / apiError) writes 0 rows that cycle and
#   freezes the file mtime. 2x (30min) false-alarmed on one missed cycle, so
#   tier2 uses 3x (45min) — tolerates one transient single-pool miss, still
#   catches a genuine multi-cycle stall. SEPARATELY, an EMPTY watchlist (tier1
#   passed=0) means tier2 has nothing to write by design -> NOT a failure, the
#   staleness check is skipped entirely (see watchlist-size guard below).
FULL_STALE=$((120*60))
WATCH_STALE=$((45*60))

# Upstream-degradation escalation (see check A/B).
DEGRADED_SINCE_STAMP="$CAP_DIR/.tier1-upstream-degraded-since"
ESCALATED_STAMP="$CAP_DIR/.tier1-upstream-escalated-at"
ESCALATE_AFTER=$((6*3600))     # sustained upstream degradation before ONE page
ESCALATE_THROTTLE=$((6*3600))  # min gap between escalation pages

status="ok"
reasons=()          # FAILURE reasons only (drive unhealthy + Telegram alert)
notes=()            # informational, never trip an alert (e.g. expected-idle skips)
upstream_degraded=false   # script-scope so check C can read it (defense-in-depth)

# Newest UNCOMPRESSED tier1/tier2 files (the rotate timer gzips old days; an
# active day is plain .jsonl). ls -t orders by mtime so [0] is the live file.
# NOTE: tier1 existence/freshness is now judged MANIFEST-FIRST (below); this
# plain-file lookup only supplies the human-readable base_reason label and the
# check-C row count.
newest_full=$(ls -t "$CAP_DIR"/tier1/*.jsonl 2>/dev/null | head -1)
newest_watch=$(ls -t "$CAP_DIR"/tier2/*.jsonl 2>/dev/null | head -1)

# helper: age of newest line in a file (mtime proxy; row write = mtime bump)
file_age() { [ -f "$1" ] && echo $(( NOW - $(stat -c %Y "$1") )) || echo -1; }

af=$(file_age "$newest_full")

# --- A/B) tier1 liveness + freshness (MANIFEST-FIRST) -----------------------
# Determine whether the plain-file view thinks tier1 is "not writing", and
# capture a base_reason label for the genuine-death page. The manifest then
# decides whether that is a real failure (page) or expected (429 / rotation).
tier1_not_writing=false
base_reason=""
if [ -z "$newest_full" ]; then
  tier1_not_writing=true; base_reason="no_tier1_capture_file_at_all"
elif [ ! -s "$newest_full" ]; then
  tier1_not_writing=true; base_reason="newest_tier1_empty:$(basename "$newest_full")"
elif [ "$af" -ge 0 ] && [ "$af" -gt "$FULL_STALE" ]; then
  tier1_not_writing=true; base_reason="tier1_stale_${af}s_gt_${FULL_STALE}s"
fi

if [ "$tier1_not_writing" = true ]; then
  # Read the LAST tier1 sweep from the manifest — the authoritative liveness signal.
  last_tier1=$(grep '"tier":"tier1"' "$CAP_DIR/manifest.jsonl" 2>/dev/null | tail -1)
  last_tier1_ms=$(echo "$last_tier1" | grep -oE '"sweep_ts":[0-9]+' | grep -oE '[0-9]+$')
  [ -z "$last_tier1_ms" ] && last_tier1_ms=0
  last_tier1_age=$(( NOW - last_tier1_ms/1000 ))
  last_captured=$(echo "$last_tier1" | grep -oE '"pools_captured":[0-9]+' | grep -oE '[0-9]+$')
  [ -z "$last_captured" ] && last_captured=0
  sweep_recent=false
  [ "$last_tier1_ms" -gt 0 ] && [ "$last_tier1_age" -lt "$FULL_STALE" ] && sweep_recent=true
  if [ "$sweep_recent" = true ] && echo "$last_tier1" | grep -qE '"sources_degraded":\[".+"\]'; then
    upstream_degraded=true
  fi

  if [ "$sweep_recent" != true ]; then
    # No tier1 sweep logged within the staleness window → the sweep timer/
    # service itself is dead (or the manifest stopped being written). This is
    # the genuine silent-death class the heartbeat exists to catch → PAGE.
    status="stale"; reasons+=("${base_reason};no_recent_tier1_sweep_ts")
  elif [ "$upstream_degraded" = true ]; then
    # Sweep alive but blocked upstream (429). Not restart-actionable here →
    # non-paging note; escalate ONE page only if sustained > 6h.
    [ -f "$DEGRADED_SINCE_STAMP" ] || echo "$NOW" > "$DEGRADED_SINCE_STAMP"
    degraded_since=$(cat "$DEGRADED_SINCE_STAMP" 2>/dev/null || echo "$NOW")
    degraded_dur=$(( NOW - degraded_since ))
    if [ "$degraded_dur" -gt "$ESCALATE_AFTER" ]; then
      last_esc=$(cat "$ESCALATED_STAMP" 2>/dev/null || echo 0)
      if [ $(( NOW - last_esc )) -gt "$ESCALATE_THROTTLE" ]; then
        status="stale"
        reasons+=("tier1_upstream_degraded_sustained_${degraded_dur}s_needs_apikey_or_backoff")
        echo "$NOW" > "$ESCALATED_STAMP"
      else
        [ "$status" = "ok" ] && status="degraded"
        notes+=("${base_reason}_upstream_degraded_escalated_nonpaging")
      fi
    else
      [ "$status" = "ok" ] && status="degraded"
      notes+=("${base_reason}_upstream_degraded_nonpaging_dur_${degraded_dur}s")
    fi
  elif [ "$last_captured" -gt 0 ]; then
    # Recent sweep DID capture rows → capture is healthy; the missing/stale
    # plain .jsonl is just the rotate timer having gzipped the active file.
    # Non-paging note (the recovery-after-rotate false-page fix).
    [ "$status" = "ok" ] && status="degraded"
    notes+=("${base_reason}_but_recent_sweep_captured_${last_captured}_file_rotated")
  else
    # Recent sweep, 0 captured, NO degradation reported → silent zero-capture
    # (a real failure, not an upstream outage) → PAGE.
    status="stale"; reasons+=("${base_reason};recent_sweep_zero_capture_no_degradation")
  fi
else
  # tier1 writing a fresh plain file normally → clear upstream stamps (recovery).
  rm -f "$DEGRADED_SINCE_STAMP" "$ESCALATED_STAMP" 2>/dev/null || true
fi

# Current watchlist size drives whether tier2 is EXPECTED to be writing.
# capture-logger.js rebuilds <CAP_DIR>/watchlist.json each tier1 sweep from the
# pools that PASSED the gate; when tier1 passed=0 the watchlist is empty and the
# next tier2 sweep writes 0 rows -> file mtime frozen BY DESIGN, not a failure.
# No jq on this host, so count "pool-address-looking" array entries cheaply.
WATCHLIST_FILE="$CAP_DIR/watchlist.json"
if [ -f "$WATCHLIST_FILE" ]; then
  watchlist_size=$(grep -oE '"[1-9A-HJ-NP-Za-km-z]{32,44}"' "$WATCHLIST_FILE" 2>/dev/null | wc -l | tr -d ' ')
else
  watchlist_size=0
fi
[ -z "$watchlist_size" ] && watchlist_size=0

aw=$(file_age "$newest_watch")
if [ "$watchlist_size" -eq 0 ]; then
  # Empty watchlist -> tier2 legitimately idle. Do NOT flag staleness (this was
  # the false-positive Telegram-spam source: ~7 alerts/day on quiet-market
  # cycles where tier1 passed=0).
  notes+=("tier2_watchlist_empty_skip_stale_check")
elif [ "$aw" -ge 0 ] && [ "$aw" -gt "$WATCH_STALE" ]; then
  # Non-empty watchlist AND tier2 still hasn't written in >3x cadence = a
  # genuine stall (the failure class this heartbeat exists to catch).
  status="stale"; reasons+=("tier2_stale_${aw}s_gt_${WATCH_STALE}s_watchlist=${watchlist_size}")
fi

# --- C) 0-rows-while-API-reachable ---
# Row count of the NEWEST plain tier1 file. capture-logger appends per-row, so
# it never pre-creates an empty day file; a 0-row newest file therefore means a
# silently-dead sweep -> unhealthy. GUARD: skip during a known upstream
# degradation (upstream_degraded) so a 429 window does not double-page here.
api_reachable=false
if curl -fsS --max-time 15 "$API_PROBE" >/dev/null 2>&1; then api_reachable=true; fi
if [ -n "$newest_full" ] && [ -f "$newest_full" ]; then
  rows=$(wc -l < "$newest_full" 2>/dev/null || echo 0)
else
  rows=0
fi
if [ "$rows" -eq 0 ] && [ "$api_reachable" = true ] && [ "$upstream_degraded" != true ] && [ -n "$newest_full" ]; then
  status="stale"; reasons+=("zero_rows_while_api_reachable")
fi

reasons_json=$(printf '%s\n' "${reasons[@]:-}" | sed '/^$/d' | \
  awk 'BEGIN{printf "["} {printf "%s\"%s\"", (NR>1?",":""), $0} END{printf "]"}')
notes_json=$(printf '%s\n' "${notes[@]:-}" | sed '/^$/d' | \
  awk 'BEGIN{printf "["} {printf "%s\"%s\"", (NR>1?",":""), $0} END{printf "]"}')

cat > "$OUT" <<EOF
{
  "ts": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "status": "$status",
  "newest_tier1_file": "$(basename "${newest_full:-none}")",
  "newest_tier1_age_sec": $af,
  "newest_tier2_file": "$(basename "${newest_watch:-none}")",
  "newest_tier2_age_sec": $aw,
  "newest_tier1_rows": $rows,
  "watchlist_size": $watchlist_size,
  "api_reachable": $api_reachable,
  "upstream_degraded": $upstream_degraded,
  "tier1_stale_threshold_sec": $FULL_STALE,
  "tier2_stale_threshold_sec": $WATCH_STALE,
  "reasons": $reasons_json,
  "notes": $notes_json
}
EOF

# Publish freshness to status branch (own file, independent of Sirius builder).
if [ -d "$WORKTREE" ]; then
  cd "$WORKTREE"
  git add capture-freshness.json 2>/dev/null || true
  if ! git diff --cached --quiet 2>/dev/null; then
    git -c user.name=meridian-capture -c user.email=capture@meridian.local \
        commit -q -m "capture-freshness: $status $(date -u +%H:%M:%SZ)" || true
    flock -w 30 "$LOCKFILE" git push --force-with-lease origin status 2>/dev/null \
      || { git fetch origin status 2>/dev/null || true; \
           flock -w 30 "$LOCKFILE" git push --force-with-lease origin status 2>/dev/null || true; }
  fi
fi

# Page ONLY when there are hard failure reasons. A "degraded" status (upstream
# 429 downgrade / benign rotation) is informational and exits 0 so systemd does
# NOT fire OnFailure.
if [ "${#reasons[@]}" -gt 0 ]; then
  echo "[capture-health] UNHEALTHY: ${reasons[*]}"
  # Non-zero exit => systemd marks failed => OnFailure fires Telegram alert.
  exit 1
fi
if [ "$status" = "degraded" ]; then
  echo "[capture-health] DEGRADED (non-paging): ${notes[*]:-}"
  exit 0
fi
echo "[capture-health] ok (tier1_age=${af}s rows=$rows watchlist=$watchlist_size tier2_age=${aw}s api=$api_reachable)"
