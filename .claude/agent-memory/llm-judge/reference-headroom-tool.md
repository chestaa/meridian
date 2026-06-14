---
name: reference-headroom-tool
description: Headroom LLM-context-compression tool — what it is, npm package, architecture (proxy-required), and Orion's GO/NO-GO verdict per Meridian pipeline
metadata:
  type: reference
---

**Headroom** = LLM context compression tool Bro asked Orion to evaluate (2026-06-06). Verified facts:

- GitHub: `chopratejas/headroom`, ~15k stars, Apache-2.0, **primary language Python** (also Rust `crates/` + a `typescript/` SDK dir). Topics: openai, proxy, mcp, rag, prompt-engineering.
- npm: real package is **`headroom-ai`** (v0.22.4, zero deps, ~476KB, ESM+CJS, ships `.d.ts`). Bare `headroom` on npm = placeholder squat — ignore it.
- **Architecture (load-bearing):** the npm `headroom-ai` is a **thin HTTP CLIENT, not in-process compression.** README: "Requires a running Headroom proxy (`headroom proxy`) or Headroom Cloud API key." Errors are `HeadroomConnectionError`/`mapProxyError(status...)`; client has `baseUrl`/`apiKey`, `proxyStats()`, `_fetch`. So adopting it = run/operate a Python+Rust sidecar proxy (Draco ops surface) OR pay for their cloud (Lyra cost + new egress dependency on money-adjacent path).
- API surface: `compress(messages, opts)` (auto-detects OpenAI/Anthropic/Gemini format, returns `{messages, tokensSaved, compressionRatio}`); adapter `import { withHeadroom } from 'headroom-ai/openai'` wraps an OpenAI client. Compression is MIXED lossy(text ML "Kompress")/lossless(JSON "SmartCrusher"); reversible via CCR. Has modes audit|optimize|simulate (simulate = dry measure, no mutation — useful for benchmarking before trusting).
- Note: package exports `rtkPath` — it interops with RTK (same RTK Bro runs in Claude Code env).

**Orion verdict per pipeline (see [[reference-meridian-llm-pipelines]]):**
- intel-digest corpus (free-text crawl) = the ONLY plausible GO, but blocked on the proxy/cloud dependency for marginal gain (input already hard-capped at MAX_INPUT_CHARS, 1 run/day, ~$0.0015). NOT worth a new sidecar.
- SCREENER candidate JSON + Orion judge = **NO-GO**. Schema/gate-critical structured prompts; lossy compression risks corrupting verdict/gate logic. Capital-preservation > token savings (anti-pattern discipline).
- Overall recommendation to Bro: **NO-GO for now.** Token savings on our pipelines are tiny (bounded inputs, cheap DeepSeek V4 Flash) and don't justify operating a Python/Rust proxy or a paid-cloud dependency on a money-adjacent stack. Revisit only if input sizes grow materially.
- Safer alternatives if compression ever needed: manual prompt trimming (already done via MAX_INPUT_CHARS char-cap + per-record slice in intel-digest), tiktoken-based truncation, or a cheap summary pre-pass with the same model. All in-process, no new dependency.
