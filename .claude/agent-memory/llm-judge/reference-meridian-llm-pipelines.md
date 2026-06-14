---
name: reference-meridian-llm-pipelines
description: The three LLM-call pipelines in Meridian, their input data-type, and which are safe vs unsafe to compress/modify
metadata:
  type: reference
---

Meridian has 3 distinct LLM-call sites, all DeepSeek V4 Flash via OpenRouter (OpenAI-compatible). Classified by input data-type for compression/prompt-engineering safety:

1. **intel-digest** (`scripts/intel-digest.js`) — FREE-TEXT corpus. Reads crawled X/Telegram/Discord JSONs, builds a bounded round-robin corpus (hard cap `MAX_INPUT_CHARS` = MAX_INPUT_TOKENS*4, default 8k tok; per-record text sliced to 320 chars; max 60 records/platform). 1 run/day, advisory-only, never touches money/config. Output schema-enforced via OpenRouter structured outputs (`RESPONSE_JSON_SCHEMA`). **Safest to compress** (free text) but input already tiny+capped → low payoff.

2. **SCREENER** (`agent.js` routing) — STRUCTURED candidate JSON + system prompt. Gate logic / numeric thresholds. Schema-critical. **Unsafe to lossy-compress** — corrupting a number or key can flip a gate.

3. **Orion judge** (`agents/orion.js`) — STRUCTURED single-candidate + decision schema, emits PASS/SKIP verdict. **Unsafe to lossy-compress** — verdict must not degrade; capital-preservation discipline.

Rule of thumb (Bro's framing, Orion agrees): compression/aggressive prompt rewriting is SAFE for free-text input, RISKY for structured/schema-critical prompts. When in doubt, don't touch the structured paths.

See [[reference-headroom-tool]] for the Headroom evaluation that used this classification.
