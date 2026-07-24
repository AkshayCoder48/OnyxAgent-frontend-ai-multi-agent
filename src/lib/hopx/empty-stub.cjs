// Browser stub for Node-only modules imported (but never used at runtime in
// the browser) by @hopx-ai/sdk. The SDK imports `tar`, `glob`, `fs`, `path`,
// `os`, `http`, `https`, `crypto`, `ws`, `form-data` at the top level even
// though the browser code path only uses axios's XHR adapter and the
// `Sandbox.create` / `files.*` / `commands.*` / `runCode` HTTP calls. We
// alias these modules to this stub via `next.config.ts`'s
// `turbopack.resolveAlias` + webpack `resolve.fallback` so the SDK bundles
// for the browser. Any code path that actually calls one of the stubbed APIs
// will throw `Error: <module> is not available in the browser` — which is
// the desired behaviour for features the browser can't support (e.g. local
// file uploads from the user's disk, Template building).

// We export via CommonJS so any `import { unlink } from "fs"` /
// `import * as tar from "tar"` shape resolves to a Proxy that returns a
// throwing function for any property access. ESM named exports can't be
// dynamic, so we use module.exports with a Proxy instead.

function throwingFn(name) {
  return function () {
    throw new Error(
      name +
        " is not available in the browser. This Hopx SDK feature requires a Node runtime.",
    );
  };
}

module.exports = new Proxy(
  function () {},
  {
    get: function (_target, prop) {
      if (prop === "__esModule") return true;
      if (prop === "default") return throwingFn("hopx-stub:default");
      if (prop === "then") return undefined; // Avoid thenable detection.
      return throwingFn("hopx-stub:" + String(prop));
    },
    apply: function () {
      throw new Error(
        "hopx-stub is not available in the browser. This Hopx SDK feature requires a Node runtime.",
      );
    },
  },
);
