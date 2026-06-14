---
name: vps-swap-2gb-and-discord-pid-trap
description: VPS now has 2GB swap (anti-OOM) + discord-listener orphan-kill TRAP — the "orphan" PID was a legit systemd MainPID
metadata:
  type: project
---

**2026-06-04 hardening on root@124.156.202.109 (OpenCloudOS, 3.6Gi RAM).**

## ACTION 1 — 2GB swap added (DONE, reversible)
VPS had Swap=0B (OOM-kill risk for LIVE bot). Added cushion:
- `/swapfile` 2GB via `fallocate` (worked, no dd fallback needed), `chmod 600`, `mkswap`, `swapon`.
- Persisted `/etc/fstab`: `/swapfile none swap sw 0 0` (was zero swap entries — no dup).
- `vm.swappiness=10` via `/etc/sysctl.d/99-meridian-swappiness.conf` (was 60). Swap = last-resort cushion, RAM stays primary.
- After: `free -h` Swap 2.0Gi (0B used), available ~1.6Gi. Disk 25G free of 60G (60% used) — safe margin.
- **Reverse:** `swapoff /swapfile && rm /swapfile` + delete fstab line + rm the sysctl.d file.

**Why:** swap=0 = OOM-kill could nuke a trade mid-flight on LIVE money. **How to apply:** swap is a safety net only; if RAM pressure shows real swap *usage* climbing, that's a separate leak to investigate, not normal.

## ACTION 2 — ABORTED (discord-listener "orphan" was NOT an orphan)
Spec asked to reap an orphan node (~90MB, PID 983879) from an INACTIVE `discord-listener.service`. **Did NOT kill — it was a legit MainPID.** The [[feedback-orphan-detection]] lesson held exactly:
- `discord-listener.service` IS not-found/inactive — BUT the real unit is **`meridian-discord-listener.service`** (name mismatch). Same binary `/opt/meridian/discord-listener/index.js`, different unit name.
- PID 983879: PPID 1 (detached-looking) BUT `/proc/983879/cgroup` = `/system.slice/meridian-discord-listener.service`, and `systemctl show` → MainPID=983879, ActiveState=active, SubState=running, enabled, up 5d since 2026-05-30 21:31:23 CST.
- This matches [[deploy-2026-05-30-discord-listener-enabled]] — listener was deliberately re-enabled as Path A signal source. Killing it would have taken down a live signal feed.

**How to apply:** NEVER trust "service inactive + PPID 1" alone. Always cross-check `/proc/<PID>/cgroup` AND `systemctl show <unit> -p MainPID -p ActiveState`. On this host the discord listener unit is `meridian-discord-listener.service`, NOT `discord-listener.service`. If a future task again calls it "discord-listener" and "orphan", re-verify the cgroup before any kill.

meridian.service + meridian-signal-runner.service confirmed active and untouched throughout. No restart, no config/.env/flag touch.
