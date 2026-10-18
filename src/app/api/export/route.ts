import { NextRequest, NextResponse } from "next/server";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/export — render a conversation as PDF / DOCX / Markdown.
//
// SERVER-ONLY heavy deps: `pdfmake` and `docx` are imported ONLY here (Node
// runtime). Never import them from a client component — bundle size.
//
// The POST body is the shared `ExportPayload` contract
// (`src/lib/export/types.ts`) — the client collects it from Dexie via
// `src/lib/export/collect.ts` and streams it here; the route itself is
// stateless and never touches the database, so long conversations are only
// bounded by the 15 MB body guard below.
//
// It contains conversation messages ONLY — the collector drops system-role
// messages (and this route filters them AGAIN defensively, so even a
// hand-crafted payload can't smuggle system-prompt text into a file).
// ─────────────────────────────────────────────────────────────────────────────

import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import pdfmakeModule from "pdfmake";
import vfsFonts from "pdfmake/build/vfs_fonts";
import {
  AlignmentType,
  Document as DocxDocument,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  TableOfContents,
  TextRun,
} from "docx";

import { buildMarkdownExport, exportTitle, speakerLabel } from "@/lib/export/markdown";
import { CODE_OMITTED_PLACEHOLDER, splitCodeSegments } from "@/lib/export/segments";
import { formatExportDuration, formatExportTimestamp } from "@/lib/export/format";
import type { ExportLayout, ExportMessage, ExportPayload } from "@/lib/export/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Request-body guard (~15 MB of JSON ≈ far beyond any real chat export). */
const MAX_BODY_CHARS = 15 * 1024 * 1024;

/* ---------------------------------------------------------------------------
 * pdfmake singleton wiring (server).
 *
 * The `pdfmake` main entry is a singleton instance whose in-memory virtual
 * file system starts EMPTY on the server. We inject the bundled Roboto
 * base64 files (from `pdfmake/build/vfs_fonts`) once and register:
 *  - Roboto — the default document font (embedded, subset);
 *  - Courier — a pdfkit STANDARD 14 font (non-embedded, AFM-measured) used
 *    for monospace code blocks.
 *
 * LATIN-SCRIPT LIMITATION (documented, not stripped): the default vfs ships
 * Roboto with Latin / Latin-Extended / Greek / Cyrillic coverage. CJK,
 * Arabic, Devanagari and other scripts are NOT covered and render as blank
 * glyphs. Message content is passed through untouched — nothing is stripped
 * or transliterated — this note is the honest statement of that limit.
 * ------------------------------------------------------------------------- */

interface PdfMakeVirtualFs {
  writeFileSync(name: string, content: string, encoding?: string): void;
  existsSync(name: string): boolean;
}
interface PdfMakeServer {
  createPdf(def: TDocumentDefinitions): { getBuffer(): Promise<Buffer> };
  addFonts(fonts: Record<string, Record<string, string>>): void;
  setUrlAccessPolicy(cb: (url: string) => boolean): void;
  virtualfs: PdfMakeVirtualFs;
}

const pdfmake = pdfmakeModule as unknown as PdfMakeServer;

let pdfFontsReady = false;
function ensurePdfFonts(): void {
  if (pdfFontsReady) return;
  for (const [name, data] of Object.entries(vfsFonts)) {
    pdfmake.virtualfs.writeFileSync(name, data, "base64");
  }
  pdfmake.addFonts({
    Roboto: {
      normal: "Roboto-Regular.ttf",
      bold: "Roboto-Medium.ttf",
      italics: "Roboto-Italic.ttf",
      bolditalics: "Roboto-MediumItalic.ttf",
    },
    Courier: {
      normal: "Courier",
      bold: "Courier-Bold",
      italics: "Courier-Oblique",
      bolditalics: "Courier-BoldOblique",
    },
  });
  // Export documents reference no external URLs — deny everything up front.
  pdfmake.setUrlAccessPolicy(() => false);
  pdfFontsReady = true;
}

/* ---------------------------------------------------------------------------
 * Shared visual tokens.
 * ------------------------------------------------------------------------- */

const COLORS = {
  title: "#1C1917", // stone-900
  body: "#292524", // stone-800
  user: "#B45309", // amber-700 — distinct USER label
  assistant: "#0D9488", // teal-700 — distinct ASSISTANT label
  meta: "#78716C", // stone-500
  rule: "#E7E5E4", // stone-200
  codeBg: "#F4F4F5", // zinc-100 — shaded code blocks
  toolBg: "#FAFAF9", // stone-50 — tool activity block
  ok: "#15803D", // green-700 — completed
  fail: "#B91C1C", // red-700 — failed
  band: "#F1EAE2", // warm professional header band
  bandSub: "#57534E", // stone-600
  footer: "#A8A29E", // stone-400
} as const;

const STATUS_LABEL = { completed: "Completed", failed: "Failed" } as const;

/* ---------------------------------------------------------------------------
 * PDF builder (pdfmake).
 * ------------------------------------------------------------------------- */

interface PdfLayoutPreset {
  baseSize: number;
  lead: number;
  margins: [number, number, number, number];
  labelSize: number;
  metaSize: number;
  codeSize: number;
  labelFont: "Roboto" | "Courier";
  bodyFont: "Roboto";
  headerBand: boolean;
  rule: boolean;
  numberMessages: boolean;
  afterMessage: number;
}

const PDF_LAYOUTS: Record<ExportLayout, PdfLayoutPreset> = {
  // Airy spacing, light rules between messages.
  clean: {
    baseSize: 11, lead: 1.35, margins: [60, 68, 60, 68],
    labelSize: 10.5, metaSize: 9, codeSize: 9,
    labelFont: "Roboto", bodyFont: "Roboto",
    headerBand: false, rule: true, numberMessages: false, afterMessage: 14,
  },
  // Header band with title/date/project, report styling, "X / Y" footer.
  professional: {
    baseSize: 11, lead: 1.3, margins: [64, 60, 64, 66],
    labelSize: 10.5, metaSize: 9, codeSize: 9,
    labelFont: "Roboto", bodyFont: "Roboto",
    headerBand: true, rule: true, numberMessages: false, afterMessage: 12,
  },
  // Tight leading, smaller font, more content per page.
  compact: {
    baseSize: 9, lead: 1.15, margins: [42, 46, 42, 46],
    labelSize: 9, metaSize: 8, codeSize: 8,
    labelFont: "Roboto", bodyFont: "Roboto",
    headerBand: false, rule: false, numberMessages: false, afterMessage: 8,
  },
  // Monospace-forward, code on shaded blocks, `[003] USER` numbering.
  technical: {
    baseSize: 10, lead: 1.3, margins: [54, 60, 54, 60],
    labelSize: 10, metaSize: 8.5, codeSize: 9,
    labelFont: "Courier", bodyFont: "Roboto",
    headerBand: false, rule: true, numberMessages: true, afterMessage: 12,
  },
};

/** A4 width (pt) minus side margins — used for full-width rules/bands. */
function contentWidth(preset: PdfLayoutPreset): number {
  return 595.28 - preset.margins[0] - preset.margins[2];
}

/** Single-cell shaded table — the pdfmake way to get a filled block. */
function shadedBlock(stack: Content[], fill: string, margins: [number, number]): Content {
  return {
    table: { widths: ["*"], body: [[{ stack }]] },
    layout: {
      fillColor: () => fill,
      hLineWidth: () => 0,
      vLineWidth: () => 0,
      paddingTop: () => 7,
      paddingBottom: () => 7,
      paddingLeft: () => 10,
      paddingRight: () => 10,
    },
    margin: margins,
  };
}

/** Code block — monospace, preserved line breaks, WRAPPED (never clipped). */
function pdfCodeBlock(code: string, preset: PdfLayoutPreset): Content {
  return shadedBlock(
    [{ text: code, font: "Courier", fontSize: preset.codeSize, lineHeight: 1.25, color: COLORS.body }],
    COLORS.codeBg,
    [0, 2, 0, 8],
  );
}

/** Tool Activity block — compact per-tool lines + optional result excerpt. */
function pdfToolActivity(message: ExportMessage, preset: PdfLayoutPreset, include: boolean): Content | null {
  if (!include) return null;
  const calls = message.tool_calls ?? [];
  if (calls.length === 0) return null;
  const stack: Content[] = [
    {
      text: "TOOL ACTIVITY",
      bold: true,
      fontSize: preset.metaSize - 0.5,
      color: COLORS.bandSub,
      characterSpacing: 0.6,
    },
  ];
  for (const call of calls) {
    const line: Content = {
      text: [
        { text: call.tool_name, bold: true, fontSize: preset.baseSize - 1 },
        {
          text: ` — ${STATUS_LABEL[call.status]}`,
          color: call.status === "completed" ? COLORS.ok : COLORS.fail,
          fontSize: preset.baseSize - 1,
        },
      ],
      margin: [0, 4, 0, 0],
    };
    stack.push(line);
    const duration = formatExportDuration(call.duration_ms);
    if (duration) {
      stack.push({
        text: duration,
        color: COLORS.meta,
        fontSize: preset.metaSize,
        margin: [0, 1, 0, 0],
      });
    }
    if (call.result_summary) {
      stack.push({
        text: `“${call.result_summary}”`,
        color: COLORS.meta,
        fontSize: preset.metaSize,
        italics: true,
        margin: [0, 1, 0, 2],
      });
    }
  }
  return shadedBlock(stack, COLORS.toolBg, [0, 2, 0, 8]);
}

function buildPdfDocDefinition(payload: ExportPayload): TDocumentDefinitions {
  const { conversation, layout, options } = payload;
  const preset = PDF_LAYOUTS[layout];
  const title = exportTitle(conversation, options);
  const content: Content[] = [];

  // ── Title + metadata (header band on the professional layout) ───────────
  const metaLines: string[] = [];
  if (options.projectName) metaLines.push(`Project: ${options.projectName}`);
  metaLines.push(`Exported: ${options.exportDate}`);
  if (options.includeTimestamps) {
    metaLines.push(`Conversation started: ${formatExportTimestamp(conversation.created_at)}`);
  }
  metaLines.push(`Messages: ${conversation.messages.length}`);

  if (preset.headerBand) {
    content.push(
      shadedBlock(
        [
          { text: title, bold: true, fontSize: 20, color: COLORS.title, lineHeight: 1.15 },
          ...metaLines.map((line) => ({
            text: line,
            fontSize: 9.5,
            color: COLORS.bandSub,
            margin: [0, 3, 0, 0],
          })),
        ],
        COLORS.band,
        [0, 0, 0, 18],
      ),
    );
  } else {
    content.push(
      { text: title, bold: true, fontSize: 20, color: COLORS.title, lineHeight: 1.15 },
      ...metaLines.map((line) => ({
        text: line,
        fontSize: 9,
        color: COLORS.meta,
        margin: [0, 2, 0, 0],
      })),
      { text: "", margin: [0, 4, 0, 0] },
    );
    content.push({
      canvas: [{ type: "line", x1: 0, y1: 0, x2: contentWidth(preset), y2: 0, lineWidth: 1, lineColor: COLORS.rule }],
      margin: [0, 6, 0, 14],
    });
  }

  // ── Table of contents (auto page numbers via pdfmake's toc fill) ────────
  if (options.includeToc) {
    content.push({
      toc: {
        title: { text: "Table of Contents", bold: true, fontSize: 13, color: COLORS.title },
      },
      margin: [0, 0, 0, 16],
    });
  }

  // ── Messages ─────────────────────────────────────────────────────────────
  conversation.messages.forEach((message, index) => {
    if (index > 0 && preset.rule) {
      content.push({
        canvas: [{ type: "line", x1: 0, y1: 0, x2: contentWidth(preset), y2: 0, lineWidth: 0.5, lineColor: COLORS.rule }],
        margin: [0, 4, 0, preset.afterMessage],
      });
    } else if (index > 0) {
      content.push({ text: "", margin: [0, preset.afterMessage / 2, 0, preset.afterMessage / 2] });
    }

    const label = speakerLabel(message.role);
    const labelColor = message.role === "user" ? COLORS.user : COLORS.assistant;
    // Speaker label + metadata live in ONE paragraph so a page break can
    // never orphan the label from its timestamp/model line.
    const labelTexts: Content[] = [];
    if (preset.numberMessages) {
      labelTexts.push({
        text: `[${String(index + 1).padStart(3, "0")}] `,
        font: preset.labelFont,
        bold: true,
        color: labelColor,
        fontSize: preset.labelSize,
      });
    }
    labelTexts.push({
      text: options.includeSpeakers ? label : (options.includeTimestamps ? "—" : "·"),
      font: preset.labelFont,
      bold: true,
      color: labelColor,
      fontSize: preset.labelSize,
      // Even with speakers off, keep the row in the TOC.
      ...(options.includeToc ? { tocItem: true } : {}),
    });
    const metaParts: string[] = [];
    if (options.includeTimestamps) metaParts.push(formatExportTimestamp(message.created_at));
    if (message.role === "assistant" && message.model_name) metaParts.push(message.model_name);
    if (metaParts.length > 0) {
      labelTexts.push({
        text: `   ${metaParts.join(" · ")}`,
        font: preset.bodyFont,
        color: COLORS.meta,
        fontSize: preset.metaSize,
      });
    }
    content.push({
      text: labelTexts,
      margin: [0, 2, 0, 5],
      ...(options.includeToc ? { tocItem: true } : {}),
    });

    // Referenced file names.
    if (options.includeFileNames && (message.file_names ?? []).length > 0) {
      content.push({
        text: `Files: ${(message.file_names ?? []).join(", ")}`,
        italics: true,
        color: COLORS.meta,
        fontSize: preset.metaSize,
        margin: [0, 0, 0, 4],
      });
    }

    // Body — alternating prose / code segments (code blocks wrapped, never cut).
    for (const segment of splitCodeSegments(message.content)) {
      if (segment.type === "code") {
        if (options.includeCode) {
          content.push(pdfCodeBlock(segment.text, preset));
        } else {
          content.push({
            text: CODE_OMITTED_PLACEHOLDER,
            italics: true,
            color: COLORS.meta,
            fontSize: preset.baseSize - 1,
            margin: [0, 2, 0, 8],
          });
        }
      } else if (segment.text.trim().length > 0) {
        content.push({
          text: segment.text,
          font: preset.bodyFont,
          fontSize: preset.baseSize,
          lineHeight: preset.lead,
          color: COLORS.body,
          margin: [0, 0, 0, 6],
        });
      }
    }

    // Tool activity summary.
    const toolBlock = pdfToolActivity(message, preset, options.includeToolCalls);
    if (toolBlock) content.push(toolBlock);
  });

  const useFooter = options.pageNumbers;
  return {
    pageSize: "A4",
    pageMargins: preset.margins,
    defaultStyle: { font: "Roboto", fontSize: preset.baseSize, lineHeight: preset.lead, color: COLORS.body },
    ...(useFooter
      ? {
          footer: (currentPage: number, pageCount: number): Content => ({
            // Professional layout spec: page numbers rendered as "X / Y".
            text: `${currentPage} / ${pageCount}`,
            alignment: "center",
            fontSize: 8.5,
            color: COLORS.footer,
            font: layout === "technical" ? "Courier" : "Roboto",
          }),
        }
      : {}),
    content,
    info: {
      title,
      subject: "Conversation export",
      creator: "OnyxAgent",
    },
  };
}

async function buildPdf(payload: ExportPayload): Promise<Buffer> {
  ensurePdfFonts();
  const doc = pdfmake.createPdf(buildPdfDocDefinition(payload));
  return doc.getBuffer();
}

/* ---------------------------------------------------------------------------
 * DOCX builder (docx lib) — editable headings, real TOC field, metadata.
 * ------------------------------------------------------------------------- */

const DOCX_META_COLOR = "78716C";
const DOCX_USER_COLOR = "B45309";
const DOCX_ASSISTANT_COLOR = "0D9488";
const DOCX_CODE_BG = "F4F4F5";
const DOCX_TOOL_BG = "FAFAF9";
const DOCX_OK = "15803D";
const DOCX_FAIL = "B91C1C";

function docxTextParagraphs(text: string): Paragraph[] {
  // Preserve the author's paragraph structure: split on newlines; collapse
  // runs of blank lines into a single empty paragraph.
  const lines = text.split("\n");
  const paragraphs: Paragraph[] = [];
  let pendingBlank = false;
  for (const line of lines) {
    if (line.trim().length === 0) {
      pendingBlank = paragraphs.length > 0;
      continue;
    }
    if (pendingBlank) {
      paragraphs.push(new Paragraph({ text: "" }));
      pendingBlank = false;
    }
    paragraphs.push(new Paragraph({ children: [new TextRun({ text: line })], spacing: { after: 120 } }));
  }
  return paragraphs;
}

function docxCodeBlock(code: string): Paragraph {
  const lines = code.split("\n");
  const runs = lines.map(
    (line, i) =>
      new TextRun({
        text: line,
        font: "Courier New",
        size: 18, // 9pt
        break: i === 0 ? undefined : 1,
      }),
  );
  return new Paragraph({
    children: runs,
    shading: { type: ShadingType.CLEAR, fill: DOCX_CODE_BG },
    spacing: { before: 80, after: 160, line: 260 },
  });
}

function docxToolActivity(message: ExportMessage, include: boolean): Paragraph[] {
  if (!include) return [];
  const calls = message.tool_calls ?? [];
  if (calls.length === 0) return [];
  const out: Paragraph[] = [
    new Paragraph({
      shading: { type: ShadingType.CLEAR, fill: DOCX_TOOL_BG },
      children: [new TextRun({ text: "TOOL ACTIVITY", bold: true, size: 15, color: "57534E" })],
      spacing: { before: 80, after: 40 },
    }),
  ];
  for (const call of calls) {
    out.push(
      new Paragraph({
        shading: { type: ShadingType.CLEAR, fill: DOCX_TOOL_BG },
        children: [
          new TextRun({ text: call.tool_name, bold: true, size: 20 }),
          new TextRun({
            text: ` — ${STATUS_LABEL[call.status]}`,
            bold: true,
            size: 20,
            color: call.status === "completed" ? DOCX_OK : DOCX_FAIL,
          }),
          ...(call.duration_ms != null
            ? [new TextRun({ text: ` · ${formatExportDuration(call.duration_ms)}`, size: 20, color: DOCX_META_COLOR })]
            : []),
        ],
        spacing: { after: 20 },
      }),
    );
    if (call.result_summary) {
      out.push(
        new Paragraph({
          shading: { type: ShadingType.CLEAR, fill: DOCX_TOOL_BG },
          children: [new TextRun({ text: `“${call.result_summary}”`, italics: true, size: 18, color: DOCX_META_COLOR })],
          spacing: { after: 40 },
        }),
      );
    }
  }
  return out;
}

async function buildDocx(payload: ExportPayload): Promise<Buffer> {
  const { conversation, layout, options } = payload;
  const title = exportTitle(conversation, options);
  const mono = layout === "technical";

  const children: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: title, bold: true })],
    }),
  ];

  const metaLines: string[] = [];
  if (options.projectName) metaLines.push(`Project: ${options.projectName}`);
  metaLines.push(`Exported: ${options.exportDate}`);
  if (options.includeTimestamps) {
    metaLines.push(`Conversation started: ${formatExportTimestamp(conversation.created_at)}`);
  }
  metaLines.push(`Messages: ${conversation.messages.length}`);
  children.push(
    ...metaLines.map(
      (line) =>
        new Paragraph({
          children: [new TextRun({ text: line, size: 18, color: DOCX_META_COLOR })],
          spacing: { after: 40 },
        }),
    ),
  );

  if (options.includeToc) {
    children.push(
      new TableOfContents("Table of Contents", {
        hyperlink: true,
        headingStyleRange: "1-2",
      }),
    );
  }

  conversation.messages.forEach((message, index) => {
    const label = speakerLabel(message.role);
    const heading =
      mono ? `[${String(index + 1).padStart(3, "0")}] ${label}` : label;
    const metaParts: string[] = [];
    if (options.includeTimestamps) metaParts.push(formatExportTimestamp(message.created_at));
    if (message.role === "assistant" && message.model_name) metaParts.push(message.model_name);

    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [
          new TextRun({
            text: heading,
            bold: true,
            color: message.role === "user" ? DOCX_USER_COLOR : DOCX_ASSISTANT_COLOR,
            font: mono ? "Consolas" : undefined,
          }),
          ...(options.includeSpeakers && metaParts.length > 0
            ? [new TextRun({ text: `   ${metaParts.join(" · ")}`, size: 17, color: DOCX_META_COLOR })]
            : []),
        ],
        spacing: { before: 240, after: 80 },
      }),
    );

    if (options.includeFileNames && (message.file_names ?? []).length > 0) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `Files: ${(message.file_names ?? []).join(", ")}`,
              italics: true,
              size: 18,
              color: DOCX_META_COLOR,
            }),
          ],
          spacing: { after: 80 },
        }),
      );
    }

    for (const segment of splitCodeSegments(message.content)) {
      if (segment.type === "code") {
        children.push(
          options.includeCode
            ? docxCodeBlock(segment.text)
            : new Paragraph({
                children: [
                  new TextRun({ text: CODE_OMITTED_PLACEHOLDER, italics: true, size: 18, color: DOCX_META_COLOR }),
                ],
                spacing: { after: 160 },
              }),
        );
      } else if (segment.text.trim().length > 0) {
        children.push(...docxTextParagraphs(segment.text));
      }
    }

    children.push(...docxToolActivity(message, options.includeToolCalls));
  });

  const doc = new DocxDocument({
    title,
    subject: "Conversation export",
    creator: "OnyxAgent",
    description: `OnyxAgent conversation export — ${conversation.messages.length} messages — exported ${options.exportDate}`,
    styles: {
      default: {
        document: { run: { font: "Calibri", size: 21 } },
      },
    },
    sections: [
      {
        properties: {},
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}

/* ---------------------------------------------------------------------------
 * Request validation — lenient on option defaults, strict on shapes.
 * ------------------------------------------------------------------------- */

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asClampedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

interface ValidationOk {
  ok: true;
  payload: ExportPayload;
}
interface ValidationError {
  ok: false;
  error: string;
}

function validatePayload(body: unknown): ValidationOk | ValidationError {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object." };
  }
  const b = body as Record<string, unknown>;

  const format = b.format;
  if (format !== "pdf" && format !== "docx" && format !== "md") {
    return { ok: false, error: `Invalid format "${String(format)}". Supported formats: pdf, docx, md.` };
  }
  const layout = b.layout;
  if (layout !== "clean" && layout !== "professional" && layout !== "compact" && layout !== "technical") {
    return {
      ok: false,
      error: `Invalid layout "${String(layout)}". Supported layouts: clean, professional, compact, technical.`,
    };
  }

  const rawOptions = (b.options ?? {}) as Record<string, unknown>;
  const options = {
    title: asClampedString(rawOptions.title, 300),
    includeTimestamps: asBoolean(rawOptions.includeTimestamps, true),
    includeSpeakers: asBoolean(rawOptions.includeSpeakers, true),
    includeToolCalls: asBoolean(rawOptions.includeToolCalls, true),
    includeCode: asBoolean(rawOptions.includeCode, true),
    includeFileNames: asBoolean(rawOptions.includeFileNames, true),
    includeToc: asBoolean(rawOptions.includeToc, false),
    pageNumbers: asBoolean(rawOptions.pageNumbers, false),
    projectName:
      rawOptions.projectName == null ? null : asClampedString(rawOptions.projectName, 200) ?? null,
    exportDate: asClampedString(rawOptions.exportDate, 40) ?? "",
  };

  const rawConversation = b.conversation;
  if (typeof rawConversation !== "object" || rawConversation === null) {
    return { ok: false, error: "Missing conversation object." };
  }
  const c = rawConversation as Record<string, unknown>;
  if (!Array.isArray(c.messages)) {
    return { ok: false, error: "conversation.messages must be an array." };
  }

  const messages: ExportMessage[] = [];
  for (const raw of c.messages) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, error: "Each message must be an object." };
    }
    const m = raw as Record<string, unknown>;
    // Defensive: system messages are NEVER exported, whatever the client sent.
    if (m.role === "system") continue;
    if (m.role !== "user" && m.role !== "assistant") {
      return { ok: false, error: `Invalid message role "${String(m.role)}".` };
    }
    const toolCalls = Array.isArray(m.tool_calls)
      ? m.tool_calls
          .filter(
            (t): t is Record<string, unknown> =>
              typeof t === "object" && t !== null && typeof (t as Record<string, unknown>).tool_name === "string",
          )
          .filter((t) => t.status === "completed" || t.status === "failed")
          .map((t) => ({
            tool_name: asClampedString(t.tool_name, 120) ?? "",
            status: t.status as "completed" | "failed",
            ...(typeof t.duration_ms === "number" && Number.isFinite(t.duration_ms)
              ? { duration_ms: t.duration_ms }
              : {}),
            ...(typeof t.result_summary === "string"
              ? { result_summary: t.result_summary.slice(0, 200) }
              : {}),
          }))
      : [];
    messages.push({
      id: typeof m.id === "string" ? m.id : `msg-${messages.length}`,
      role: m.role,
      content: typeof m.content === "string" ? m.content : "",
      created_at: typeof m.created_at === "string" ? m.created_at : "",
      ...(typeof m.model_name === "string" ? { model_name: asClampedString(m.model_name, 120) } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(Array.isArray(m.file_names)
        ? {
            file_names: m.file_names
              .filter((n): n is string => typeof n === "string")
              .map((n) => n.slice(0, 200)),
          }
        : {}),
    });
  }

  return {
    ok: true,
    payload: {
      format,
      layout,
      options,
      conversation: {
        title: asClampedString(c.title, 300) ?? "Conversation",
        created_at: typeof c.created_at === "string" ? c.created_at : "",
        messages,
      },
    },
  };
}

/* ---------------------------------------------------------------------------
 * Filename + response helpers.
 * ------------------------------------------------------------------------- */

const EXTENSIONS: Record<ExportPayload["format"], string> = {
  pdf: "pdf",
  docx: "docx",
  md: "md",
};

const CONTENT_TYPES: Record<ExportPayload["format"], string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  md: "text/markdown; charset=utf-8",
};

/** ASCII-safe filename stem derived from the title. */
function safeFileBase(title: string): string {
  const base = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining marks from the fold
    .replace(/[^a-zA-Z0-9-_ ]+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "conversation";
}

function attachmentHeader(title: string, format: ExportPayload["format"]): string {
  const ext = EXTENSIONS[format];
  const ascii = `${safeFileBase(title)}.${ext}`;
  // RFC 5987 extended name — preserves the full Unicode title where supported.
  const utf8 = encodeURIComponent(`${title.slice(0, 80)}.${ext}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

function errorResponse(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/* ---------------------------------------------------------------------------
 * Route handler.
 * ------------------------------------------------------------------------- */

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Size guard (before parsing) ──────────────────────────────────────────
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_CHARS) {
    return errorResponse(
      413,
      "The conversation is too large to export (payload exceeds 15 MB). Try exporting fewer messages.",
    );
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return errorResponse(400, "Could not read the request body.");
  }
  if (raw.length > MAX_BODY_CHARS) {
    return errorResponse(
      413,
      "The conversation is too large to export (payload exceeds 15 MB). Try exporting fewer messages.",
    );
  }

  // ── Parse + validate ─────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return errorResponse(400, "Request body must be valid JSON.");
  }
  const validated = validatePayload(body);
  if (!validated.ok) {
    return errorResponse(400, validated.error);
  }
  const payload = validated.payload;

  // ── Generate ─────────────────────────────────────────────────────────────
  try {
    const title = exportTitle(payload.conversation, payload.options);
    const headers = {
      "Content-Type": CONTENT_TYPES[payload.format],
      "Content-Disposition": attachmentHeader(title, payload.format),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };

    if (payload.format === "md") {
      const md = buildMarkdownExport(payload.conversation, payload.layout, payload.options);
      return new NextResponse(md, { headers });
    }

    if (payload.format === "pdf") {
      const buffer = await buildPdf(payload);
      // Copy into a plain Uint8Array BodyInit (Buffer typing + safety).
      return new NextResponse(new Uint8Array(buffer), { headers });
    }

    const buffer = await buildDocx(payload);
    return new NextResponse(new Uint8Array(buffer), { headers });
  } catch (err) {
    console.error("[api/export] generation failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(500, `Export failed: ${message}`);
  }
}
