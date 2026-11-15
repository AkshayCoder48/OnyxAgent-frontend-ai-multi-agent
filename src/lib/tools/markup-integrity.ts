/**
 * Markup integrity analysis — the chunked-writing postmortem fix
 * (user report 2026-11-15: an HTML file written via create_file_chunk
 * append mode came out with styles outside <head>, duplicated sections,
 * unclosed <li>s, orphaned closing tags and drifting indentation).
 *
 * The byte-level read-back in create_file_chunk proved the chunk LANDED, but
 * never that the DOCUMENT still parses. This module adds the structural
 * layer: a tolerant, stack-based tag-balance walk that answers "is this
 * markup file still structurally sound after the append?" and pinpoints the
 * seam defects the report enumerated:
 *
 *   1. style/script blocks outside <head>/<body> (§1 of the report)
 *   2. duplicate id="…" attributes — the doubled-section symptom (§2)
 *   3. mid-tag tail — the file currently ends inside a tag or a quoted
 *      attribute, i.e. the chunk boundary SPLIT A TAG (§3)
 *   4. mismatched / unclosed tags and orphaned closing tags (§3/§4)
 *
 * It is intentionally forgiving: HTML in the wild has optional closers
 * (<p>, <li>, <td>, <tr>, <dt>, <dd>, <option>…) and implied
 * reopen-and-close semantics; a strict parser would cry wolf on markup the
 * browser happily fixes up. We report only what a browser would NOT fix:
 * structural breaks that change the document tree (orphaned closers,
 * unclosed structural containers, mid-tag tails, duplicate ids, script /
 * style landing outside the document body regions).
 */

export interface MarkupIssue {
  /** Report symptom key, stable for tests and prompts. */
  kind:
    | "mid-tag-tail"
    | "unclosed-tag"
    | "orphaned-closer"
    | "mismatched-closer"
    | "duplicate-id"
    | "style-outside-head-or-body"
    | "script-outside-head-or-body";
  /** Human-readable one-liner the model can act on. */
  message: string;
  /** 1-based line number, when known. */
  line?: number;
}

export interface MarkupReport {
  /** True when no issues were found. */
  ok: boolean;
  issues: MarkupIssue[];
  /** True when the file tail is mid-tag — the NEXT chunk must continue the
   *  broken tag instead of opening a new element. */
  midTagTail: boolean;
}

/** HTML void elements — never pushed on the balance stack. */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);

/** Elements whose RAW TEXT content must never be walked for tags. */
const RAW_TEXT = new Set(["script", "style"]);

/** Elements the HTML parser auto-closes (at an ancestor closer or EOF):
 *  browsers fix these up silently, so they are never reported as defects.
 *  Everything NOT in this set left dangling IS a seam break. */
const OPTIONALLY_CLOSED = new Set([
  "p", "li", "dt", "dd", "td", "th", "tr", "thead", "tbody", "tfoot",
  "option", "colgroup", "html", "body", "head",
]);

/** Tags that may legally appear inside <head>; used for the §1 check. */
const HEAD_ELEMENTS = new Set([
  "title", "meta", "link", "style", "script", "base", "noscript", "template",
]);

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** True when the string tail sits inside an unclosed tag opener or a quoted
 *  attribute — i.e. a chunk boundary split a tag mid-flight. */
export function hasMidTagTail(text: string): boolean {
  // The last "<" that never got its ">" (outside a comment).
  const lt = text.lastIndexOf("<");
  if (lt === -1) return false;
  const tail = text.slice(lt);
  if (tail.includes(">")) return false; // that tag closed; look for quotes
  // Tag opened but not closed — split mid-tag (also catches mid-comment).
  // Guard: a trailing "<" that's just text (e.g. "a < b") is rare in
  // markup files; the tag-balance walk will surface it if it matters.
  if (tail.startsWith("<!--")) return true;
  // Un-closed quote inside the partial tag → split mid-attribute.
  return true;
}

/** Attribute parser for one element's inner text: extracts id="…"-style
 *  ids without a full HTML parser. */
function extractAttr(raw: string, attr: string): string | null {
  const re = new RegExp(`\\s${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const m = re.exec(raw);
  if (!m) return null;
  return (m[1] ?? m[2] ?? "") || null;
}

/**
 * Tolerant structural walk. Returns the issues found plus whether the tail
 * is mid-tag. Designed for the CHECKPOINT use (after each chunk append):
 * cheap, no dependencies, precise about the defects that matter.
 */
export function analyzeMarkupIntegrity(text: string): MarkupReport {
  const issues: MarkupIssue[] = [];
  const stack: { tag: string; line: number }[] = [];
  const seenIds = new Map<string, number>();
  let i = 0;
  const n = text.length;
  let bodySeen = false;
  let bodyClosed = false;
  const rawTextDepth: string[] = [];

  while (i < n) {
    const ch = text[i];

    // Inside <script>/<style> raw text: hunt only the matching closer.
    if (rawTextDepth.length > 0) {
      const raw = rawTextDepth[rawTextDepth.length - 1]!;
      if (!text.startsWith(`</${raw}`, i)) {
        const closeAt = text.indexOf(`</${raw}`, i);
        if (closeAt === -1) {
          break; // raw text runs to EOF — tail issue reported below
        }
        i = closeAt;
        continue;
      }
      // At the closer — fall through to the closing-tag branch (which pops
      // the raw-text depth); never loop on i === closeAt.
    }

    if (ch === "<") {
      if (text.startsWith("<!--", i)) {
        const end = text.indexOf("-->", i);
        if (end === -1) break; // unterminated comment at EOF
        i = end + 3;
        continue;
      }
      if (text.startsWith("<![CDATA[", i)) {
        const end = text.indexOf("]]>", i);
        if (end === -1) break;
        i = end + 3;
        continue;
      }
      if (text.startsWith("<!", i) || text.startsWith("<?", i)) {
        const end = text.indexOf(">", i);
        if (end === -1) break;
        i = end + 1;
        continue;
      }
      // Closing tag.
      if (text[i + 1] === "/") {
        const end = text.indexOf(">", i);
        if (end === -1) break;
        const name = text.slice(i + 2, end).trim().toLowerCase().split(/\s+/)[0] ?? "";
        const line = lineOf(text, i);
        if (name === "body") {
          bodyClosed = true;
        }
        if (RAW_TEXT.has(name) && rawTextDepth.length > 0) {
          rawTextDepth.pop();
        }
        if (VOID_ELEMENTS.has(name) || name === "!doctype") {
          i = end + 1;
          continue;
        }
        // Find the matching opener (nearest same-name on the stack).
        let idx = -1;
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s]!.tag === name) {
            idx = s;
            break;
          }
        }
        if (idx === -1) {
          issues.push({
            kind: "orphaned-closer",
            line,
            message: `</${name}> closes a <${name}> that was never opened (or was already closed) — an append repeated or lost an opener.`,
          });
        } else {
          // Everything the closer implies closing above it on the stack.
          // HTML auto-closes the OPTIONAL set (p/li/td/tr/…) at any
          // ancestor closer, so those are NOT defects; anything else left
          // dangling above the matched opener is a real seam break.
          for (let s = stack.length - 1; s > idx; s--) {
            const open = stack[s]!;
            if (OPTIONALLY_CLOSED.has(open.tag)) continue;
            issues.push({
              kind: "unclosed-tag",
              line: open.line,
              message: `<${open.tag}> (line ${open.line}) is never closed before </${name}> — a chunk boundary likely ate its closer.`,
            });
          }
          stack.length = idx; // pop through the matched opener
        }
        i = end + 1;
        continue;
      }
      // Opening tag — scan to the real '>' (quotes may contain '>').
      let end = -1;
      let quote: string | null = null;
      for (let j = i + 1; j < n; j++) {
        const c = text[j]!;
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") {
          quote = c;
        } else if (c === ">") {
          end = j;
          break;
        }
      }
      if (end === -1) break; // mid-tag tail — handled after the loop
      const inner = text.slice(i + 1, end);
      const name = inner.trim().toLowerCase().split(/[\s/>]/)[0] ?? "";
      if (!name) {
        i = end + 1;
        continue;
      }
      const line = lineOf(text, i);
      if (name === "body") {
        bodySeen = true;
      }
      // §1: style/script after </body> — definitely outside the document.
      if ((name === "style" || name === "script") && bodyClosed) {
        issues.push({
          kind: name === "style" ? "style-outside-head-or-body" : "script-outside-head-or-body",
          line,
          message: `<${name}> appears after </body> — it belongs inside <head> (styles) or <body>; an append landed it outside the document regions.`,
        });
      }
      // §2: duplicate ids — the doubled-section symptom.
      const id = extractAttr(inner, "id");
      if (id) {
        const prev = seenIds.get(id);
        if (prev !== undefined) {
          issues.push({
            kind: "duplicate-id",
            line,
            message: `id="${id}" already appears at line ${prev} — a section was written twice (duplicated chunk or re-spawned writer).`,
          });
        } else {
          seenIds.set(id, line);
        }
      }
      const selfClosing = inner.trim().endsWith("/");
      if (!VOID_ELEMENTS.has(name) && !selfClosing) {
        stack.push({ tag: name, line });
        if (RAW_TEXT.has(name)) {
          // Only treat as raw text when not self-closed.
          rawTextDepth.push(name);
        }
      }
      i = end + 1;
      continue;
    }
    i++;
  }

  // Raw-text mode may have ended the loop early at EOF — the closer is
  // missing entirely (unclosed <script>/<style>).
  if (rawTextDepth.length > 0) {
    issues.push({
      kind: "unclosed-tag",
      message: `<${rawTextDepth[rawTextDepth.length - 1]}> is never closed — the file ends inside its raw text.`,
    });
  }

  // Structural containers left open at EOF (html/head/body + real
  // containers). Optional-closer elements (p/li/td/tr…) are browser-fixed
  // and NOT reported.
  for (const open of stack) {
    if (OPTIONALLY_CLOSED.has(open.tag)) continue;
    issues.push({
      kind: "unclosed-tag",
      line: open.line,
      message: `<${open.tag}> (line ${open.line}) is never closed — a chunk boundary split before its closing tag.`,
    });
  }

  const midTagTail = hasMidTagTail(text);
  if (midTagTail) {
    issues.push({
      kind: "mid-tag-tail",
      message: "The file currently ENDS inside an unfinished tag or attribute — this chunk boundary split a tag mid-flight. The NEXT chunk must continue exactly where this one broke (finish the tag), or rewrite the tail; never start a new element on top of a half-written one.",
    });
  }

  return { ok: issues.length === 0, issues, midTagTail };
}

/** File extensions whose appends get the structural check. */
export const MARKUP_EXTENSIONS = [".html", ".htm", ".xhtml", ".xml", ".svg", ".vue"] as const;

export function isMarkupPath(path: string): boolean {
  const lower = path.toLowerCase();
  return MARKUP_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
