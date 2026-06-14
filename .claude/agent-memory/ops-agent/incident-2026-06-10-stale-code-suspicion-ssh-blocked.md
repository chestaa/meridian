---
name: incident-2026-06-10-stale-code-suspicion-ssh-blocked
description: 2026-06-10 Cassiopeia integrity check — VPS suspected running stale pre-2026-05-30 code (Billy-SOL emitted removed reject string); verification BLOCKED by absent SSH material
metadata:
  type: project
---

2026-06-10 URGENT integrity check (Cassiopeia, routed via Polaris): VPS log showed
reject reason `no_smart_money_low_organic_in_live` firing for Billy-SOL on 2026-06-10,
but that string was REMOVED from code at commit 255ec69 (2026-05-30). Current origin/main
(HEAD f019ae1) physically cannot emit it. Suspicion: **VPS running stale pre-2026-05-30
code** → post-255ec69 safety (rug gates, TVL/MC gate, fee/TVL floor) maybe NOT active on
live money.

**LOCAL repo verification (DONE, confirms premise):**
- `no_smart_money_low_organic*` → ZERO matches anywhere in tree (string gone).
- String history: INTRODUCED 218156c (2026-05-19), REMOVED 255ec69 (2026-05-30). Confirmed via `git log -S`.
- POST-255ec69 safety ALL present in local tools/screening.js: rug gates
  (mint_authority_not_renounced:258, freeze:262, liquidity_removal_rugpull:265),
  TVL/MC gate (tvlMcapGateRejectReason:313-323, live-gated config.dryRun===false @1272).

**VPS-side verification: BLOCKED.** SSH material ABSENT this session — `Test-Path
$env:USERPROFILE\.ssh` = False (entire dir gone, same as 2026-06-04 disappearance per
[[reference-vps-ssh-canonical-path]]). Cannot run on VPS: `git rev-parse HEAD`, the
grep smoking-gun, `systemctl show ActiveEnterTimestamp`, autopull cron log, `git status`.
Did NOT fabricate — reported blocked.

**Why:** determines whether LIVE money bot runs correct safety code. If VPS HEAD < 255ec69
OR process not restarted since (in-memory stale even if files pulled), rug/TVL-MC/fee-TVL
gates may be inert → catastrophic risk exposure.

**How to apply:** Once SSH restored (Bro re-provisions ~/.ssh/meridian_vps_ed25519), run the
6 read-only checks: (1) `git rev-parse HEAD` vs f019ae1, (2) grep the removed string on VPS
files (PRESENT=stale confirmed), (3) `systemctl show meridian.service -p
ActiveEnterTimestamp,ExecMainStartTimestamp` vs commit dates (file-pulled-but-not-restarted
case), (4) exact Billy-SOL log line timestamp (real 06-10 vs old 05-27→05-30 window =
false alarm), (5) grep rug+tvlMcap gates on VPS, (6) `git status` for dirty/detached/conflict
blocking autopull + check meridian-autopull cron log. NO auto-fix — report, Polaris routes,
Bro authorizes (live money). A file-resync alone is insufficient if process needs restart.
