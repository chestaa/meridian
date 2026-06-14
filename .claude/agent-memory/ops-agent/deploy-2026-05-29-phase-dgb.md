---
name: deploy-2026-05-29-phase-dgb
description: Phase D+G+B deploy — Solscan/Pumpfun sources + multi-source crossval, flags OFF default, VPS token age bumped 24h/720h
metadata:
  type: project
---

Phase D+G+B deployed 2026-05-29. Commit `b24ff35` "Phase D+G+B: Solscan + Pumpfun sources + multi-source crossval (flags OFF default)" — 9 files, +1139/-5. Pushed main, VPS `/opt/meridian` auto-pulled to b24ff35.

New code: tools/sources/{solscan-trending,pumpfun-graduated,meteora-crossref}.js, screening.js merge+tag+score-bonus+hard-gate, config.js 3 new flag keys, pool-memory.js recordSignalSighting (cap 50). Tests on VPS: solscan 5/5, pumpfun 6/6, crossval 10/10 PASS.

VPS user-config.json (gitignored) token age bumped via sed: `minTokenAgeHours` 8→24, `maxTokenAgeHours` null→720. Backup at `/opt/meridian/.bak-phaseDGB-2026-05-29-userconfig.json`.

**Why:** Additive source plumbing — Bro activates use* flags after observation per Lyra cost discipline.
**How to apply:** New flags useSolscanTrending / usePumpfunGraduated / requireMultiSourceConfirm are ABSENT from VPS user-config.json → fall back to code default `?? false` in config.js (~line 101-106). All OFF. Do NOT enable without Bro. meridian.service active, Mode LIVE, model deepseek/deepseek-v4-flash. Follows [[deploy-2026-05-29-phase-aj]].

**SSH gotcha:** Default `ssh root@124.156.202.109` gets Permission denied — must pass explicit key. Canonical key path on this Windows host is `/c/Users/Pradikta Andrianto/.ssh/meridian_vps_ed25519` (note space in path → quote it; `~` expansion breaks in Bash tool). No ~/.ssh/config Host entry exists. See [[reference-vps-ssh-canonical-path]]. PQ key-exchange warning from server is cosmetic, ignore.
