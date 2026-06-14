# Signal Collector (Sirius 🐺) — Memory Index

- [Intel crawlers](intel-crawlers.md) — X/Telegram/Discord intel tools: methods, feasibility verdicts, nitter-fetch gotcha, ToS flags
- [Intel output locations](intel-output-locations.md) — where crawler JSON lives (gitignored), record schema, scp path gotcha
- [Research @0xyunss](research-0xyunss.md) — deep-dive on builder of competitor @meridian_agent: profit/strategy/tech intel + report location
- [Research Telegram community](research-telegram-community.md) — Agent Meridian TG channel+group deep-dive: changelog, top 5 issues, PnL-vs-SOL gap, alpha=noise
- [Research Discord community](research-discord-community.md) — MeteoraIDN guild: bot-feed structure, DEAD consumption path (404 + inactive listener), selfbot rate-limit ToS reality
- [Research @Gardvori](research-gardvori.md) — ID creator publicly tutorializing @0xyunss DLMM bot ("Hermes" multi-subagent) + RTK + free owl-alpha + bengbeng.fun wallet-data feed
- [Research bengbeng.fun + LPAgent](research-bengbeng-lpagent.md) — tool-ecosystem crawl: bengbeng "For AI Agent" .json (client-side, manual), LPAgent smart-LP ALL 403/WAF-walled — on-chain mining stays primary
- [Intel digest pipeline](intel-digest-pipeline.md) — auto-learn digest: staleness guard, crawl-before-digest (child_process), dedup-vs-existing; deploy=git-pull-cron, systemd wiring
- [Research t.me/hesz_journal](research-hesz-journal.md) — Hesz/@villainyouall solo LP/DLMM beginner journal; web-preview full-history crawler (no session); guide=file attachment NOT in preview; verdict one-off read
- [Cross-ref endpoint shape mismatch](crossref-endpoint-shape-mismatch.md) — dlmm.datapi vs pool-discovery-api: volume/fees = window-OBJECTS not scalars; no fee_active_tvl_ratio; volumeScalar fix + open fee/TVL gate choke
- [saveToInbox candidate shape](saveinbox-candidate-shape.md) — LAST wall before judge: saveToInbox read flat names, real shape = condensePool nested base.mint/pool; parser Pool/Token line ordering trap; fictional-shape test hid it
- [solscan-trending keyless Jupiter](solscan-trending-keyless-jupiter.md) — revived dead Birdeye-paid source w/ keyless Jupiter toptraded primary; call-site-wiring trap (resolver added but not wired)
- [Three dead sources diagnosis](three-dead-sources-diagnosis.md) — solscan=FIXED keyless; discord=not-a-bug (event-driven, listener-dependent); native=thin by design (don't loosen floors)
- [Sourcing breadth audit](sourcing-breadth-audit.md) — we pull page_size=50 (ceiling 1000, 20x headroom); NO pagination; universe=114,516 pools; real choke = our filter matches only 3, not page_size
