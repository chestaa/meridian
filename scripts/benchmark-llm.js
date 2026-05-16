import "dotenv/config";
import OpenAI from "openai";
import { config } from "../config.js";

const model = process.argv[2] || config.llm.screeningModel || process.env.LLM_MODEL;
const apiKey = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY;

if (!apiKey) {
  console.error("Missing OPENROUTER_API_KEY or LLM_API_KEY");
  process.exit(1);
}

const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey,
  timeout: 120_000,
});

const tool = {
  type: "function",
  function: {
    name: "judge_signal",
    description: "Return a strict trading signal judgment.",
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

const started = Date.now();
const response = await client.chat.completions.create({
  model,
  messages: [
    {
      role: "system",
      content: "You are a cautious DLMM signal judge. Use the tool exactly once. Do not trade live.",
    },
    {
      role: "user",
      content: "Signal: mcap 11.1k, vol5m 29.9k, distributed 0.3202 SOL, recipient 100%, unknown holders. Judge it for dry-run watchlist only.",
    },
  ],
  tools: [tool],
  tool_choice: { type: "function", function: { name: "judge_signal" } },
  temperature: 0.1,
  max_tokens: 512,
});

const message = response.choices?.[0]?.message;
const toolCall = message?.tool_calls?.[0];
let args = null;
if (toolCall?.function?.arguments) {
  args = JSON.parse(toolCall.function.arguments);
}

console.log(JSON.stringify({
  model,
  ok: Boolean(args),
  latencyMs: Date.now() - started,
  finishReason: response.choices?.[0]?.finish_reason,
  usage: response.usage || null,
  toolName: toolCall?.function?.name || null,
  args,
}, null, 2));
