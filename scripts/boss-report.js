import { getPaperTradeSummary } from "../paper-trades.js";
import { getLlmUsageSummary } from "../llm-usage.js";

const paper = getPaperTradeSummary();
const usage = getLlmUsageSummary({ hours: 24 });

console.log(JSON.stringify({
  generated_at: new Date().toISOString(),
  llm_usage_24h: usage,
  paper_trades: paper,
}, null, 2));
