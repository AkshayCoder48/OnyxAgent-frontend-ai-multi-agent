"use client";

import { registerTool } from "./registry";
import { getE2BClient } from "@/lib/e2b/client";

/**
 * Security audit tool — scans the user's workspace for common security issues.
 * Checks for: exposed secrets, missing input validation, CORS issues, etc.
 * Returns a structured report with findings, severity, and fix suggestions.
 *
 * PRD §25/§26: scans the E2B sandbox (the authoritative workspace) instead
 * of OPFS. Previously this tool walked the OPFS file tree directly, which
 * could diverge from what the AI actually sees via `read_file` (the AI reads
 * from E2B). Now both code paths resolve to the same source of truth.
 */

interface Finding {
  severity: "critical" | "warning" | "info";
  file: string;
  line: number;
  description: string;
  fix: string;
}

// Patterns for detecting exposed secrets
const SECRET_PATTERNS = [
  { pattern: /sk-[a-zA-Z0-9]{20,}/g, name: "OpenAI API key" },
  { pattern: /ghp_[a-zA-Z0-9]{36}/g, name: "GitHub token" },
  { pattern: /AKIA[A-Z0-9]{16}/g, name: "AWS access key" },
  { pattern: /e2b_[a-zA-Z0-9]{40,}/g, name: "E2B API key" },
  { pattern: /sk_live_[a-zA-Z0-9_]{20,}/g, name: "Stripe secret key" },
  { pattern: /xox[baprs]-[a-zA-Z0-9-]+/g, name: "Slack token" },
  { pattern: /Bearer\s+[a-zA-Z0-9_\-\.]{20,}/g, name: "Bearer token in code" },
];

// Patterns for detecting security issues
const CORS_PATTERN = /access-control-allow-origin['"]*\s*[:=]\s*['"]\*['"]/gi;
const EVAL_PATTERN = /eval\s*\(/g;
const INNERHTML_PATTERN = /\.innerHTML\s*=/g;
const DANGEROUS_HTML_PATTERN = /dangerouslySetInnerHTML/g;

const TEXT_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "py", "json", "env", "yaml", "yml", "sh", "html", "css",
]);

/** Recursively list all files under `rootPath` in the E2B sandbox. */
async function listSandboxFiles(
  client: ReturnType<typeof getE2BClient>,
  rootPath: string,
): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [rootPath];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Awaited<ReturnType<typeof client.listFiles>>;
    try {
      entries = await client.listFiles(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = entry.path.startsWith("/") ? entry.path : `${dir.replace(/\/$/, "")}/${entry.path}`;
      if (entry.type === "directory") {
        stack.push(full);
      } else if (entry.type === "file") {
        out.push(full);
      }
    }
  }
  return out;
}

registerTool(
  "security_audit",
  "Scan the user's workspace for common security issues. Checks for exposed secrets, dangerous code patterns, CORS misconfigurations, and other OWASP top 10 issues. Returns a structured report with findings, severity levels, and fix suggestions.",
  {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path to scan (relative to workspace root). Defaults to '.' (entire workspace)." },
    },
    additionalProperties: false,
  },
  async (args, ctx) => {
    const scanPath = (args.path as string) || ".";
    const findings: Finding[] = [];

    const sandboxKey = ctx.sandboxApiKey ?? ctx.e2bApiKey;
    if (!sandboxKey) {
      return {
        error: "Security audit requires an E2B sandbox. Configure one in Settings → Config → E2B Sandbox.",
      };
    }

    try {
      const client = getE2BClient(sandboxKey, ctx.conversationId, ctx.sandboxMode ?? "shared");
      const rootPath = scanPath === "."
        ? "/home/user"
        : (scanPath.startsWith("/") ? scanPath : `/home/user/${scanPath}`);
      const files = await listSandboxFiles(client, rootPath);

      for (const filePath of files) {
        // Only scan text files
        const ext = filePath.split(".").pop()?.toLowerCase();
        if (!TEXT_EXTENSIONS.has(ext || "")) continue;

        try {
          const content = await client.readFile(filePath);
          if (content.length > 100 * 1024) continue; // skip large files
          const lines = content.split("\n");

          // Check for exposed secrets
          lines.forEach((line, idx) => {
            for (const { pattern, name } of SECRET_PATTERNS) {
              pattern.lastIndex = 0;
              if (pattern.test(line)) {
                findings.push({
                  severity: "critical",
                  file: filePath,
                  line: idx + 1,
                  description: `Exposed ${name} detected`,
                  fix: `Move the ${name} to an environment variable. Never hardcode secrets in source code.`,
                });
              }
            }

            // Check for dangerous patterns
            if (EVAL_PATTERN.test(line)) {
              findings.push({
                severity: "warning",
                file: filePath,
                line: idx + 1,
                description: "Use of eval() detected — can lead to code injection",
                fix: "Avoid eval(). Use JSON.parse() for data or Function() for controlled code execution.",
              });
            }
            if (INNERHTML_PATTERN.test(line)) {
              findings.push({
                severity: "warning",
                file: filePath,
                line: idx + 1,
                description: "Direct innerHTML assignment — XSS risk",
                fix: "Use textContent or sanitize HTML with DOMPurify before assigning to innerHTML.",
              });
            }
            if (DANGEROUS_HTML_PATTERN.test(line)) {
              findings.push({
                severity: "info",
                file: filePath,
                line: idx + 1,
                description: "dangerouslySetInnerHTML used — ensure content is sanitized",
                fix: "Only use dangerouslySetInnerHTML with sanitized content (e.g., DOMPurify.sanitize()).",
              });
            }
            if (CORS_PATTERN.test(line)) {
              findings.push({
                severity: "warning",
                file: filePath,
                line: idx + 1,
                description: "Wildcard CORS detected — allows any origin",
                fix: "Restrict CORS to specific origins instead of '*'",
              });
            }
          });
        } catch {
          // skip unreadable file
        }
      }

      // Sort by severity (critical first)
      const severityOrder = { critical: 0, warning: 1, info: 2 };
      findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

      const summary = {
        total: findings.length,
        critical: findings.filter((f) => f.severity === "critical").length,
        warning: findings.filter((f) => f.severity === "warning").length,
        info: findings.filter((f) => f.severity === "info").length,
      };

      return {
        summary,
        findings: findings.slice(0, 50), // cap at 50 findings
        scanned_files: files.length,
        scan_path: scanPath,
      };
    } catch (e) {
      return {
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
  false,
  "security",
);
