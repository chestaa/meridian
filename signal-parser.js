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
  const tokenAddress = addresses.find((a) => /pump$|bonk$|moon$|uniP$/i.test(a)) || addresses[0] || null;
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

export function scoreParsedSignal(signal) {
  const reasons = [];
  let score = 0;

  if (signal.tokenAddress) score += 15;
  else reasons.push("no token address");

  // Signal-mode mcap band intentionally diverges from pool-discovery `minMcap` (default 150k).
  // Signal sources (Discord alpha, KOL bundles) surface earlier-stage opportunities — so the
  // signal mcap floor is much lower than the conservative pool-screen floor used by Hunter.
  // Pool-discovery mode keeps the 150k floor via config.screening.minMcap; signal-mode
  // uses config.screening.signalMinMcap / signalMaxMcap (defaults 5k / 80k).
  const signalMinMcap = Number(config?.screening?.signalMinMcap ?? 5_000);
  const signalMaxMcap = Number(config?.screening?.signalMaxMcap ?? 80_000);
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
