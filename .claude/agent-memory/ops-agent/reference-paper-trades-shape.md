---
name: reference-paper-trades-shape
description: paper-trades.json is object with `trades` key, not bare array
metadata:
  type: reference
---

`/opt/meridian/paper-trades.json` shape: `{ trades: [...] }`. Survey scripts that do `JSON.parse(...).filter(...)` will TypeError. Always coerce: `const d = Array.isArray(raw) ? raw : (raw.trades || Object.values(raw))`.
