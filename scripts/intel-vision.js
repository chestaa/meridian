/**
 * intel-vision.js — OPT-IN image reader for intel crawlers (charts/screenshots).
 *
 * Sirius 🐺 — Signal Collector.
 *
 * Uses the EXISTING OpenRouter key (OPENROUTER_API_KEY / LLM_API_KEY) via the
 * `openai` SDK already in deps. Vision IS feasible cheaply — verified 2026-05-30:
 *   FREE:  google/gemma-4-31b-it:free, qwen3-vl family (very cheap)
 *   CHEAP: qwen/qwen3-vl-8b-instruct ($0.08/Mtok), gemini-2.5-flash-lite ($0.10)
 *
 * GATED: only runs when INTEL_VISION=1 so we never spend LLM budget without
 * Bro's explicit go-ahead (cost-visibility discipline). Default model is the
 * FREE gemma; override with INTEL_VISION_MODEL.
 *
 * NOTE: This sends image URLs to the model. Nitter /pic/ URLs are proxied —
 * if a model can't fetch them, set INTEL_VISION_MODEL to one that accepts
 * URL image inputs, or extend to base64 download (not done here to keep it lean).
 */
import OpenAI from "openai";
import "dotenv/config";

const MODEL = process.env.INTEL_VISION_MODEL || "google/gemma-4-31b-it:free";
const API_KEY = process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY;
const BASE_URL = process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1";

const PROMPT =
  "You are reading an image attached to a crypto/trading social post. " +
  "If it is a chart, screenshot, PnL screen, dashboard, or terminal, describe " +
  "concisely the KEY intel: token/pair, price action, PnL numbers, % change, " +
  "any DLMM/LP/Meridian/bot references, errors, or notable text. " +
  "If it is not informative (meme/avatar), say 'no actionable intel'. " +
  "Reply in <=40 words.";

let client = null;
function getClient() {
  if (!API_KEY) throw new Error("OPENROUTER_API_KEY / LLM_API_KEY not set — cannot run vision");
  if (!client) client = new OpenAI({ apiKey: API_KEY, baseURL: BASE_URL });
  return client;
}

/**
 * Caption a list of image URLs in the context of the post text.
 * Returns [{ url, caption }] — best-effort; per-image failure is non-fatal.
 */
export async function captionImages(imageUrls, postText = "") {
  const out = [];
  for (const url of imageUrls.slice(0, 4)) { // cap 4 imgs/post to bound spend
    try {
      const res = await getClient().chat.completions.create({
        model: MODEL,
        max_tokens: 120,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: `${PROMPT}\n\nPost text for context: ${(postText || "").slice(0, 300)}` },
            { type: "image_url", image_url: { url } },
          ],
        }],
      });
      const caption = res.choices?.[0]?.message?.content?.trim() || "(empty)";
      out.push({ url, caption });
    } catch (e) {
      out.push({ url, caption: null, error: e.message });
    }
  }
  return out;
}
