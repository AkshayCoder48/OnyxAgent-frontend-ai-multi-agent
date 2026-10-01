# Task E — Real image inspection (inspect_image + /api/vision + shared resolver)

Task ID: E · Agent: image-inspection-main · Status: COMPLETE

Scope: Runtime PRD §49–§54, §57–§59, §110–§116, §120–§123 (image GENERATION §55–56 retracted — nothing built).
Untouched (per instructions): database-panel.tsx, code-database-store.ts, tool-results/database.tsx, preview files, background-turn.ts, runtime.ts, request-scoping.ts, local_chats.ts, browser-tool-bridge.ts. Task D's in-flight edits to database-panel.tsx were present in the working tree the whole time — never touched.

## Files (all mine)

- NEW `src/app/api/vision/route.ts` — server-side vision route (z-ai-web-dev-sdk, backend-only).
- NEW `src/lib/tools/image-sources.ts` — shared resolver + pure helpers.
- NEW `src/lib/tools/inspect_image.ts` — the tool (category "general", no approval).
- NEW `src/components/chat/tool-results/image-inspection.tsx` — renderer (+ parser).
- EDIT `src/lib/tools/image_preview.ts` — optional `path` arg (§54).
- EDIT `src/lib/tools/index.ts` — `import "./inspect_image";` after image_preview.
- EDIT `src/components/chat/tool-call-card.tsx` — 3 tiny edits (import, simple-card inline block, technical dispatch branch).
- EDIT `src/lib/agent-friendly-steps.ts` — RULES entry + name-gated `source` detail branch.

## Resolver precedence (resolveImageSource)

`data:image/…;base64,…` → uploads registry (exact name, `getUploadByName`) → E2B sandbox path (`readFilesBatch`, one round-trip; bare filenames ALSO try `uploads/<name>` — the mirror) → `http(s)://` (browser fetch). http/data URLs short-circuit (no registry/sandbox hop). Uploads-stage MISS (no record / unreadable OPFS bytes) falls through to sandbox; a sniff/size FAILURE on canonical upload bytes is a final honest answer (no sandbox retry — same bytes would be mirrored).

- §57: `sniffImageMime(bytes)` — PNG \x89PNG, JPEG \xFF\xD8\xFF, GIF GIF8, WebP RIFF…WEBP, BMP BM. Extensions NEVER trusted; extensionless sandbox paths still attempted then sniffed. Data-URL declared mime vs sniff mismatch → sniffed mime wins (data URL rebuilt label-keeping image/jpg).
- §116: `normalizeSandboxPath` strips `/home/user/`, leading `/`/`./`, drops `.`/empty segments, rejects any `..` SEGMENT (null). Note: per-segment (not e2b_files' blunt substring) — `a..b.png` reads, `../x` and `a/../../b.png` never do (verified by direct function tests). Reads bounded to sandbox FS (§115); host FS never touched.
- §58: `ensureVisionSizedDataUrl` — >4 MB decoded → canvas downscale (long edge ≤1568, JPEG 0.85); >7 MB base64 even after → honest throw. Never a placeholder. Display path (preview_image) keeps ORIGINAL bytes.
- Hard resolver cap: 12 MB decoded ("too large" reason). `estimateDataUrlBytes` is exact (floor(unpadded·3/4) — verified vs atob).
- E2B stage: `ensureFreshSandboxForCtx(ctx)` (same as e2b_files/code_web_session) → `getE2BClient(apiKey, null, "shared")`.

## Result payload shapes

- inspect_image SUCCESS: `{ kind: "image_inspection", source, url: <possibly-downscaled data URL>, alt: source, description }` — the runtime JSON-stringifies the return value into the model-visible tool-result message (single-value pattern; NO separate data channel exists — verified in runtime.ts: `fullResultStr = typeof result === "string" ? result : JSON.stringify(result)`, no truncation), so the description lands in the model context for the next round, and the same object is what the card renders (live UI gets the stringified form; persisted parts keep the object — parser handles both).
- inspect_image FAILURE (§114): `{ error: "Image unavailable", path, reason }` with a REAL reason (registry miss + sandbox error text / not-an-image magic-byte verdict / too large + limits / vision call failed + HTTP status + server message). Renders via the generic card (no kind → parse returns null → falls through).
- preview_image: unchanged contract `{ kind: "image_preview", url, alt }`; new: when `url`/`base64` absent and `path` present → resolve via the SAME resolver, display-only (no vision call). Errors: plain `{ error: "Image unavailable — <reason> (source: <path>)" }` (existing preview_image error style).

## Vision route contract (/api/vision)

POST `{ prompt: string, imageDataUrl: string }` → 200 `{ description }` | 400/502 `{ error }`.
Validation: prompt non-empty ≤4000 chars; data URL must match `^data:image/(png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/=]+$` (case-insensitive) and be ≤7 MiB total. `runtime="nodejs"`, `dynamic="force-dynamic"`, `maxDuration=120`. SDK: `ZAI.create()` → `chat.completions.createVision({ messages:[{role:"user",content:[{type:"text",text},{type:"image_url",image_url:{url}}]}], thinking:{type:"disabled"} })`. NOTE: the SDK typings mark `model` required but the SDK's own README §3.2 + bundled CLI omit it (server default model) — body is cast to `CreateChatCompletionVisionBody` for that typings gap only. Empty description → 502 (never claim a view that didn't happen, §123). Image payload NEVER logged (only capped error messages + statuses).

## Rendering (§54/§111)

`tool-results/image-inspection.tsx`: `parseImageInspectionResult` (string→JSON.parse / object as-is, gates on `kind === "image_inspection"` + url string) + `ImageInspectionResult` (internal parse, null-render for unparsable): header (Eye icon + "Image inspection" + mono source), lazy `<img>` (max-h 420px) with mono source figcaption, description in a scrollable (max-h-64, custom scrollbar) block. Wired into tool-call-card with the SMALLEST diff: 1 import, 1 inline block in SimpleToolCallCard (`name === "inspect_image" && isCompleted`), 1 dispatch branch in TechnicalToolCallCard. hasSpecialRenderer/friendlyName/autoExpand untouched (technical-mode icon stays generic — deliberate minimal-diff).

Friendly steps: `inspect_image: { past: "Inspected an image", present: "Inspecting an image", icon: ImageIcon }` + detail = source (domain for URLs, clipped basename for paths, none for data URLs) — branch is gated on `toolCall.name === "inspect_image"` so move_file (which also has a `source` arg) is unchanged. agent-step-captions.ts untouched ("Inspecting an image" already there).

## Verification

- `bunx tsc --noEmit` clean (0 errors). `bun run lint`: 0 errors; 0 NEW warnings from my files (31 pre-existing baseline; the +3 seen at one point are Task D's in-flight database-panel.tsx / conversation-sidebar.tsx warnings, not mine).
- Route functionally smoke-tested by importing the module directly under bun (dev server unreachable from this shell's namespace — curl to :3000 gets no route, Caddy :81 → 502): bad JSON → 400; `{}` → 400; text/plain data URL → 400; 4001-char prompt → 400; a REAL 1×1 PNG → 200 `{"description":"The image is a solid, uniform light pink (or pale rose) color…"}` — the vision backend genuinely described the bytes end-to-end.
- Pure parts verified by direct tests: sniff (all 5 formats + text/null), normalizeSandboxPath (14 cases incl. traversal rejections), estimateDataUrlBytes exact vs atob, data-URL resolve (valid png ok; "png" containing text honestly rejected by magic bytes).
- E2B/OPFS paths NOT smoke-testable without a live sandbox/user session — code follows the exact patterns of e2b_files.ts / registry.ts (`ensureFreshSandboxForCtx` + `getE2BClient(…, null, "shared")` + `readFilesBatch`; `getUploadByName` + `readUploadBytes`).
- dev.log tail clean (no compile errors).

## Caveats for next agents

1. The model-visible inspect_image result includes the (downscaled) base64 data URL — in-pattern with preview_image base64 and manage_web_session screenshot dataUrls (runtime does NO truncation by design), but a large image costs context tokens in the next round. If that ever needs fixing, it's a runtime-level mechanism (e.g. payload elision), NOT a tool-level hack.
2. `normalizeSandboxPath` rejects `..` per-segment (stricter-correct than e2b_files' substring rule) — a file literally named `..foo` or `a..b.png` is readable HERE but not via e2b_files' safePath. Intentional.
3. SVG images are out of scope by mandate (route accepts png/jpeg/jpg/gif/webp/bmp only); an .svg in the sandbox honestly fails with "not a recognized image".
4. The friendly-detail source branch is name-gated to inspect_image only — if another tool grows a `source` arg later, extend deliberately.
5. preview_image `path` resolution makes a sandbox round-trip when the name isn't an upload — fine, but remember it needs an E2B key for sandbox paths (honest error otherwise).
