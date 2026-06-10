/**
 * --import entrypoint that registers the axios stub hooks (see _axios-stub.hooks.mjs).
 * Usage: node --import ./scripts/_register-axios-stub.mjs scripts/test-pre-checks-fees.js
 */
import { register } from "node:module";
register("./_axios-stub.hooks.mjs", import.meta.url);
