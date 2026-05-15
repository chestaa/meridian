import "dotenv/config";
import OpenAI from "openai";
import { config } from "./config.js";
import { recordLlmUsage } from "./llm-usage.js";
import { assertWithinBudget, BudgetExceededError, getBudgetStatus } from "./cost-guard.js";
import { notifyBudgetExceeded } from "./telegram.js";

const apiKey = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY;

const client = apiKey ? new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey,
  timeout: 120_000,
}) : null;

const judgeTool = {
  type: "function",
  function: {
    name: "judge_signal",
    description: "Return a strict DLMM trading signal judgment.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        decision: { type: "string", enum: ["enter", "watch", "skip"] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        reason: { type: "string" },
        maxPositionSol: { type: "number" },
      },
      required: ["decision", "confidence", "reason", "maxPositionSol"],
    },
  },
};

export async function judgeSignalWithLlm(signal, preScore, options = {}) {
  if (!client) {
    return {
      model: null,
      ok: false,
      decision: "skip",
      confidence: 0,
      maxPositionSol: 0,
      reason: "LLM API key missing",
      usage: null,
      latencyMs: 0,
    };
  }

  const model = options.model || config.llm.screeningModel;
  const started = Date.now();

  // Cost guard — hard daily/weekly USD cap (Lyra audit G1 + G2).
  try {
    assertWithinBudget();
  } catch (error) {
    if (error instanceof BudgetExceededError) {
      // Vega fix #1 — loud, dedicated Telegram alert (12h throttled in helper).
      // Wrapped: alert failure must NOT escalate the budget error.
      try {
        await notifyBudgetExceeded({ status: getBudgetStatus(), caller: "signal-judge.js" });
      } catch (_alertErr) {
        // swallow — caller already returns a skip object below
      }
      return {
        model,
        ok: false,
        decision: "skip",
        confidence: 0,
        maxPositionSol: 0,
        reason: `Budget cap reached (${error.details?.scope || "?"}): ${error.message}`,
        usage: null,
        latencyMs: 0,
        budgetExceeded: true,
      };
    }
    throw error;
  }

  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content: [
          "You are a cautious Solana DLMM signal judge.",
          "This is dry-run unless explicitly stated otherwise.",
          "Prefer skip when distribution, holders, or liquidity quality is unclear.",
          "Never recommend more than 0.05 SOL for a first live probe.",
          "Use the tool exactly once.",
        ].join(" "),
      },
      {
        role: "user",
        content: JSON.stringify({ signal, deterministicScore: preScore }, null, 2),
      },
    ],
    tools: [judgeTool],
    tool_choice: { type: "function", function: { name: "judge_signal" } },
    temperature: 0.1,
    max_tokens: 512,
  });

  const toolCall = response.choices?.[0]?.message?.tool_calls?.[0];
  const args = toolCall?.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};

  // Closes audit gap G1 — signal-judge calls were previously invisible to llm-usage.json.
  recordLlmUsage({
    agentType: "SIGNAL_JUDGE",
    model,
    step: 1,
    finishReason: response.choices?.[0]?.finish_reason || null,
    toolCalls: toolCall ? 1 : 0,
    usage: response.usage || {},
  });

  return {
    model,
    ok: Boolean(toolCall),
    decision: args.decision || "skip",
    confidence: Number(args.confidence || 0),
    maxPositionSol: Math.min(Number(args.maxPositionSol || 0), 0.05),
    reason: args.reason || "No reason returned",
    usage: response.usage || null,
    latencyMs: Date.now() - started,
  };
}

export function formatSignalJudgment({ signal, preScore, llm }) {
  return [
    `Signal: ${signal.name || signal.symbol || signal.tokenAddressShort || "unknown"}`,
    `Token: ${signal.tokenAddressShort || signal.tokenLine || "n/a"}`,
    `Mcap: ${signal.mcapUsd != null ? `$${Math.round(signal.mcapUsd).toLocaleString("en-US")}` : "n/a"} | Vol 5m: ${signal.vol5mUsd != null ? `$${Math.round(signal.vol5mUsd).toLocaleString("en-US")}` : "n/a"}`,
    `Distributed: ${signal.distributedSol ?? "n/a"} SOL | Recipient: ${signal.recipientPct ?? "n/a"}%`,
    `Pre-score: ${preScore.score}/75 => ${preScore.decision}`,
    `LLM: ${llm.decision.toUpperCase()} (${Math.round(llm.confidence * 100)}%) | max ${llm.maxPositionSol} SOL`,
    `Reason: ${llm.reason}`,
    llm.usage?.cost != null ? `LLM cost: $${Number(llm.usage.cost).toFixed(8)} | ${llm.latencyMs}ms` : null,
  ].filter(Boolean).join("\n");
}
