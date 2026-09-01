"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

export type TokenType = "keyword" | "string" | "comment" | "function" | "tag" | "plain";

interface Token {
  type: TokenType;
  value: string;
}

const TOKEN_COLORS: Record<TokenType, string> = {
  keyword: "#E39B6E",
  string: "#C9B78E",
  comment: "#8A7E6C",
  function: "#EAD9BE",
  tag: "#E39B6E",
  plain: "#E9E0CE",
};

const KEYWORDS =
  "import|from|export|default|function|return|const|let|var|if|else|for|while|new|class|extends|async|await|typeof|type|interface|as|null|true|false|undefined";

// Order matters: comments, strings, keywords, function calls, JSX tags.
function tokenize(code: string): Token[] {
  const pattern = new RegExp(
    "(\\/\\/[^\\n]*)" +
      "|(\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`)" +
      `|(\\b(?:${KEYWORDS})\\b)` +
      "|([A-Za-z_$][\\w$]*(?=\\s*\\())" +
      "|(<\\/?[A-Za-z][\\w.]*)",
    "g",
  );
  const tokens: Token[] = [];
  let last = 0;
  for (const match of code.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ type: "plain", value: code.slice(last, index) });
    const [full, comment, str, keyword, fn, tag] = match;
    if (comment !== undefined) tokens.push({ type: "comment", value: full });
    else if (str !== undefined) tokens.push({ type: "string", value: full });
    else if (keyword !== undefined) tokens.push({ type: "keyword", value: full });
    else if (fn !== undefined) tokens.push({ type: "function", value: full });
    else if (tag !== undefined) tokens.push({ type: "tag", value: full });
    last = index + full.length;
  }
  if (last < code.length) tokens.push({ type: "plain", value: code.slice(last) });
  return tokens;
}

interface CodeBlockProps {
  code: string;
  language: string;
  filename: string;
}

export function CodeBlock({ code, filename }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const tokens = tokenize(code);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable (permissions or non-secure context); ignore silently.
    }
  };

  return (
    <div className="overflow-hidden rounded-xl bg-code text-left shadow-[0_2px_10px_rgba(26,26,26,0.08)]">
      <div className="flex items-center bg-code-header py-1.5 pl-4 pr-2">
        <span className="truncate font-mono text-xs text-[#C9B78E]/90">{filename}</span>
        <button
          type="button"
          onClick={onCopy}
          aria-label={copied ? "Code copied" : `Copy ${filename}`}
          className="ml-auto flex h-8 items-center gap-1.5 rounded-md px-2 font-mono text-[11px] text-[#8A7E6C] transition-colors hover:text-[#F4ECE1]"
        >
          {copied ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="terra-scroll overflow-x-auto p-4 font-mono text-[12.5px] leading-[1.7]">
        <code>
          {tokens.map((token, i) => (
            <span key={i} style={{ color: TOKEN_COLORS[token.type] }}>
              {token.value}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
