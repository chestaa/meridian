---
name: caveman-install-2026-05-28
description: Caveman Claude Code skill installed 2026-05-28 alongside RTK 0.40.0; hooks wired in global ~/.claude/settings.json, default mode lite
metadata:
  type: project
---

Caveman skill installed via `npx -y github:JuliusBrussee/caveman` on 2026-05-28 (auto-mode blocked `irm|iex`, so downloaded then ran).

**Why:** Bro Dikta authorized per Sirius research — caveman compresses LLM response output ~65%, complementary to RTK (which compresses tool_result input).

**How to apply:** Both layers active simultaneously. Don't mistake caveman hooks for RTK hooks. If conversation feels terse/stylized, that's caveman lite mode working as intended — preserves sign-offs and risk nuance.

**Artifacts (Windows):**
- Plugin: `~/.claude/plugins/marketplaces/caveman/` + `~/.claude/plugins/cache/caveman/`
- Hooks: `~/.claude/hooks/caveman-{config,activate,mode-tracker,stats,statusline.ps1}.js`
- Default mode config: `%APPDATA%\caveman\config.json` = `{"defaultMode":"lite"}`
- MCP proxy: `caveman-shrink` registered (stdio, project-scope)
- Settings.json backup pre-install: `c:\1. Personal DIkta\Meridian\.claude\settings.json.bak.pre-caveman` (project-level, not the modified global one)

**Hooks wired in ~/.claude/settings.json (global):**
- PreToolUse Bash: still `rtk hook claude` (RTK untouched)
- SessionStart: caveman-activate.js
- UserPromptSubmit: caveman-mode-tracker.js
- statusLine: caveman-statusline.ps1

**Rollback:** `npx -y github:JuliusBrussee/caveman -- --uninstall`

**Open gap noted (NOT modified):** RTK config at `%APPDATA%\rtk\config.toml` is default — no exclude_commands patterns for `.env*`, `user-config.json`, `*private*`, `*wallet*`, `vps-key`, `*ed25519*`. Bro should decide separately whether to harden. Currently RTK filters by path/glob inside its filters, but no command-level deny-list for secret reads. Link: [[reference-vps-ssh-canonical-path]]
