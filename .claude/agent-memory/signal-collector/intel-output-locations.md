---
name: intel-output-locations
description: Where Sirius intel crawler output lives, and that it is gitignored
metadata:
  type: reference
---

Intel crawler output dirs (created 2026-05-30):
- `intel/x/<handle>_<stamp>.json` — X/Twitter
- `intel/telegram/meridian_<stamp>.json` — Telegram (stores only intel-bearing records to keep file lean; ~1.3MB for 945 records)
- `intel/discord/meridian_<stamp>.json` — Discord
- `intel/images/` — reserved for downloaded images (not yet used)

All `intel/*` paths are **gitignored** (crawled social/chat content, kept out of git). Files generated on VPS must be `scp`'d back to view locally — use forward-slash dest paths (`c:/1. Personal DIkta/Meridian/intel/...`), backslash paths get mangled by scp.

Record schema = output of `buildIntelRecord()` in [[intel-crawlers]]: intel_id, platform, source, author, url, timestamp, text, topics[], topic_hits{}, spread{mentions,telegram_links,urls}, metadata{mentioned_addresses, images, image_intel}.
