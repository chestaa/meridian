---
name: counterfactual-data-sources
description: How to run counterfactual "would-be PnL" studies on Cassiopeia-blocked pools — where addresses live and which price API works
metadata:
  type: reference
---

For counterfactual gate-validation studies (did a blocked pool pump or dump after rejection):

**Rejection logs (which pools, why, when):** VPS `journalctl -u meridian`, grep for `Risk filter: dropped`, `Live overlay: dropped`, `SAFETY_BLOCK`. Carries symbol + reason + timestamp + sometimes an 8-char short pool ID (e.g. RICH=`5hiLgyyb`, BUFFDON=`CbyQSD5n`, HOPPY=`2RWndXkx`, 250=`BUG9jJ6M`).

**Gap:** Risk-dropped pools are filtered BEFORE the LLM sees full candidate objects, so full mint/pool addresses are NOT in journal or `logs/agent-*.log`. pool-memory.json only has DEPLOYED pools, not rejected ones. Resolve full addresses via DexScreener instead.

**Price/outcome data:** DexScreener public API works with no key, best for this.
- Resolve mint: `https://api.dexscreener.com/latest/dex/search?q=<SYM>%20SOL` then match the 8-char short pool ID against `pairAddress` prefix, or match age_h to rejection window.
- Per-token granular changes: `https://api.dexscreener.com/latest/dex/tokens/<mint>` gives priceChange m5/h1/h6/h24, liquidity.usd, fdv, volume.h24, pairCreatedAt.
- Birdeye (key in VPS `.env` BIRDEYE_API_KEY) and OKX are unreliable for these fresh micro-caps — OKX returned "unavailable" for most blocked tokens in logs.

**Caveat:** DexScreener h24 only approximates the rejection→now delta when rejection was ~24h ago. For multi-day-old rejections it understates drawdown. State this in conservative estimates. See [[telegram-reporting-inventory]] for VPS access context; SSH path in [[vps-ssh-canonical-path]].
