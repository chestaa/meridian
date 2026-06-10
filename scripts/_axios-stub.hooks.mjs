/**
 * ESM resolve/load hooks: serve the bare `axios` specifier from an in-memory stub.
 *
 * Why: discord-listener/pre-checks.js does a top-level `import axios` (used by
 * resolvePool/rugCheck/deployerCheck — NOT by feesCheck). axios is a real
 * discord-listener dependency installed on the VPS but absent in this dev sandbox,
 * so importing the module to unit-test feesCheck() would ERR_MODULE_NOT_FOUND.
 * These hooks let the module load without installing packages or touching node_modules.
 * The feesCheck test stubs global.fetch and never calls any axios path.
 *
 * Usage: node --import ./scripts/_register-axios-stub.mjs scripts/test-pre-checks-fees.js
 */
const STUB_URL = "node-axios-stub:default";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "axios") {
    return { url: STUB_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === STUB_URL) {
    const src = `
      const noop = () => Promise.reject(new Error("axios stub: network disabled in tests"));
      const axios = { get: noop, post: noop, create: () => axios };
      export default axios;
    `;
    return { format: "module", source: src, shortCircuit: true };
  }
  return nextLoad(url, context);
}
