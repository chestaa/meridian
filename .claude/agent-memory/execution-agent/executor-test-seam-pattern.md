---
name: executor-test-seam-pattern
description: ESM namespace bindings are non-configurable in Node — use exported __setForTests seams, not Object.defineProperty hacks
metadata:
  type: feedback
---

When writing tests for Meridian agents that need to stub `executeTool` or other module-level imports, do NOT try `Object.defineProperty(moduleNamespace, "name", ...)`. Node ESM bindings are non-configurable and throw `TypeError: Cannot redefine property`.

**Why:** First attempt at scripts/test-vega-deterministic.js used Object.defineProperty to override executeTool on the imported namespace object. Node 24 ESM rejected it with `TypeError: Cannot redefine property: executeTool`. The proven pattern in agents/orion.js (__setClientForTests) is exporting a dedicated setter alongside the production binding, then routing production code through a local `let _executeTool = defaultExecuteTool` variable.

**How to apply:** For any new agent file that depends on a hot-path import (executeTool, getWalletBalances, fetch, etc.), expose two symbols:
1. `let _xxx = defaultXxx;` and route production calls through `_xxx`
2. `export function __setXxxForTests(fn) { _xxx = typeof fn === "function" ? fn : defaultXxx; }`

Tests call `__setXxxForTests(stub)` to inject and `__setXxxForTests(null)` to restore. No cache-busting, no ESM trickery, no Proxy. See agents/vega.js + scripts/test-vega-deterministic.js for the canonical version.

Related: [[vega-pr3-deterministic-deploy]]
