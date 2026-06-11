import { config } from "./config.js";

const ADDRESS_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const SIGNAL_TOKEN_RE = /\b[A-Za-z0-9]{25,70}(?:pump|bonk|moon|uniP)\b/g;

function firstNumber(pattern, text) {
  const match = text.match(pattern);
  if (!match) return null;
  const raw = match[1].replace(/,/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function compactAddress(value) {
  if (!value) return null;
  return value.length > 16 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

export function parseSignalMessage(message) {
  const text = String(message || "");
  const addresses = [
    ...new Set([
      ...[...text.matchAll(ADDRESS_RE)].map((m) => m[0]),
      ...[...text.matchAll(SIGNAL_TOKEN_RE)].map((m) => m[0]),
    ]),
  ];
  // WALL-10 (Sirius 2026-06-11): structured screener signals carry BOTH a
  // `Pool: <poolAddr>` and a `Token: <mint>` line, and Pool appears FIRST. The
  // old `addresses[0]` heuristic therefore picked the POOL address as the token
  // mint → the enricher then queried Jupiter/Meteora for a pool address as if it
  // were a token, which fails (or, worse, mis-identifies the asset). When an
  // explicit `Token:` line carries a base58 address, that IS the token mint —
  // prefer it over positional/suffix heuristics. The `Pool:` line address is the
  // pool, never the token, so we also exclude it from token-address selection.
  const tokenLineAddr = (text.match(/Token\s*:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/i) || [])[1] || null;
  const poolLineAddr = (text.match(/Pool\s*:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/i) || [])[1] || null;
  const tokenAddress =
    tokenLineAddr ||
    addresses.find((a) => /pump$|bonk$|moon$|uniP$/i.test(a) && a !== poolLineAddr) ||
    addresses.find((a) => a !== poolLineAddr) ||
    addresses[0] ||
    null;
  const recipientAddress = addresses.find((a) => a !== tokenAddress) || null;

  const nameMatch = text.match(/(?:Name|Token Name)\s*:\s*([^\n(]+)(?:\(([^)]+)\))?/i);
  const tokenLineMatch = text.match(/Token\s*:\s*([^\n]+)/i);
  const mcap = firstNumber(/Mcap\s*:\s*\$?\s*([\d,.]+)\s*K/i, text);
  const mcapRaw = firstNumber(/Mcap\s*:\s*\$?\s*([\d,.]+)/i, text);
  const vol5m = firstNumber(/Vol\s*5m\s*:\s*\$?\s*([\d,.]+)\s*K/i, text);
  const vol5mRaw = firstNumber(/Vol\s*5m\s*:\s*\$?\s*([\d,.]+)/i, text);
  const distributedSol = firstNumber(/Distributed\s*:\s*([\d,.]+)\s*SOL/i, text);
  const recipientPct = firstNumber(/Recipient\s*:[^\n]*\(([\d,.]+)%\)/i, text);
  const typeMatch = text.match(/Type\s*:\s*([^\n]+)/i);

  return {
    source: "manual",
    name: nameMatch?.[1]?.trim() || null,
    symbol: nameMatch?.[2]?.trim() || null,
    tokenLine: tokenLineMatch?.[1]?.trim() || null,
    tokenAddress,
    tokenAddressShort: compactAddress(tokenAddress),
    mcapUsd: mcap != null ? mcap * 1000 : mcapRaw,
    vol5mUsd: vol5m != null ? vol5m * 1000 : vol5mRaw,
    distributedSol,
    recipientAddress,
    recipientAddressShort: compactAddress(recipientAddress),
    recipientPct,
    type: typeMatch?.[1]?.trim() || null,
    raw: text.trim(),
  };
}

// Cassiopeia 👁️ — scorer with two profiles:
//   (A) Legacy Discord-LP profile: text carries vol5mUsd + distributedSol.
//   (B) Enriched profile: Sirius enricher filled mcapUsd, vol24h, organicScore,
//       holders, liquidityUsd, top10Pct, bundlersPct, riskLevel from live APIs.
//       Used for KOL/Telegram signals that are bare CAs.
//
// Profile selection:
//   - If config.internalAgents.useEnrichedScoring === false → ALWAYS use legacy
//     (full backward-compat rollback path).
//   - Else if signal.enriched === true AND signal lacks native Discord LP fields
//     (no distributedSol AND parser-supplied vol5mUsd missing) → use enriched.
//   - Else → use legacy (Discord LP, hybrid signals with both fields).
//
// `signal-results.jsonl` rows remain interpretable: same shape { score, decision,
// reasons }; reasons strings may differ but field set is identical.
function scoreEnrichedProfile(signal) {
  const reasons = [];
  let score = 0;
  const e = signal.enrichment || {};

  // Hard fails — Cassiopeia VETO regardless of any positive component.
  const maxBundlePct = Number(config?.screening?.maxBundlePct ?? 30);
  const maxTop10Pct  = Number(config?.screening?.maxTop10Pct ?? 60);
  if (e.bundlersPct != null && e.bundlersPct > maxBundlePct) {
    return { score: 0, decision: "skip", reasons: [`bundlers ${e.bundlersPct}% > max ${maxBundlePct}%`] };
  }
  if (e.top10Pct != null && e.top10Pct > maxTop10Pct) {
    return { score: 0, decision: "skip", reasons: [`top10 ${e.top10Pct}% > max ${maxTop10Pct}%`] };
  }
  const mcap = signal.mcapUsd ?? e.mcapUsd;
  if (mcap != null && mcap > 50_000_000) {
    return { score: 0, decision: "skip", reasons: ["mcap too late stage (>50M)"] };
  }
  if (mcap != null && mcap < 1_000) {
    return { score: 0, decision: "skip", reasons: ["mcap implausibly low (<1k) — likely scam/stale"] };
  }

  // Base
  if (signal.tokenAddress) score += 15;
  else reasons.push("no token address");

  // Mcap band (same signal band as legacy) — defaults widened 2026-06-11 to 50k/2M.
  const signalMinMcap = Number(config?.screening?.signalMinMcap ?? 50_000);
  const signalMaxMcap = Number(config?.screening?.signalMaxMcap ?? 2_000_000);
  if (mcap != null && mcap >= signalMinMcap && mcap <= signalMaxMcap) score += 20;
  else reasons.push("mcap outside early signal band");

  // Vol24h → 5m proxy. vol24h / 288 ≈ avg 5-min slice. Conservative threshold 200 USD.
  const vol24h = e.volume24h ?? null;
  if (vol24h != null && vol24h / 288 >= 200) score += 20;
  else reasons.push("24h volume too low (proxied 5m < 200 USD)");

  // Quality signals
  if (e.organicScore != null && e.organicScore >= 60) score += 15;
  else reasons.push("organic score < 60 or missing");

  if (e.holders != null && e.holders >= 200) score += 10;
  else reasons.push("holders < 200 or missing");

  if (e.liquidityUsd != null && e.liquidityUsd >= 10_000) score += 10;
  else reasons.push("liquidity < 10k or missing");

  if (e.top10Pct != null && e.top10Pct <= 60) score += 5;
  if (e.riskLevel === "LOW" || e.riskLevel === "MEDIUM") score += 5;

  // Decision threshold same as legacy: 55. Max possible enriched ≈ 100.
  const decision = score >= 55 ? "watch" : "skip";
  return { score, decision, reasons };
}

function scoreLegacyProfile(signal) {
  const reasons = [];
  let score = 0;

  if (signal.tokenAddress) score += 15;
  else reasons.push("no token address");

  // Signal-mode mcap band intentionally diverges from pool-discovery `minMcap` (default 150k).
  // Signal sources (Discord alpha, KOL bundles) surface earlier-stage opportunities — so the
  // signal mcap floor is lower than the conservative pool-screen floor used by Hunter.
  // Pool-discovery keeps 150k floor via config.screening.minMcap; signal-mode uses
  // config.screening.signalMinMcap / signalMaxMcap (defaults 50k / 2M after the 2026-06-11
  // widening — old 5k/80k band rejected the real quality zone: yunus $100k-1M, PARQ $922k).
  const signalMinMcap = Number(config?.screening?.signalMinMcap ?? 50_000);
  const signalMaxMcap = Number(config?.screening?.signalMaxMcap ?? 2_000_000);
  if (signal.mcapUsd != null && signal.mcapUsd >= signalMinMcap && signal.mcapUsd <= signalMaxMcap) score += 20;
  else reasons.push("mcap outside early signal band");

  if (signal.vol5mUsd != null && signal.vol5mUsd >= 1_000) score += 20;
  else reasons.push("5m volume too low or missing");

  if (signal.distributedSol != null && signal.distributedSol >= 0.2) score += 15;
  else reasons.push("distributed SOL too low or missing");

  if (signal.recipientPct != null && signal.recipientPct <= 100) score += 5;
  if (signal.type && !/rug|honeypot|scam/i.test(signal.type)) score += 5;

  const decision = score >= 55 ? "watch" : "skip";
  return { score, decision, reasons };
}

export function scoreParsedSignal(signal) {
  const useEnriched = config?.internalAgents?.useEnrichedScoring !== false;
  // Detect "native Discord LP shape": parser-extracted vol5m AND distributedSol present.
  // Enricher only writes vol5mUsd as a proxy when parser saw nothing — so if
  // distributedSol is set, the signal genuinely came from a Discord LP message.
  const hasDiscordLPFields = signal?.distributedSol != null;

  if (useEnriched && signal?.enriched === true && !hasDiscordLPFields) {
    return scoreEnrichedProfile(signal);
  }
  return scoreLegacyProfile(signal);
}
