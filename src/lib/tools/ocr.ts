// OCR Tool — ocr_document (images AND PDFs) using the freeocr.ai API.
//
// MERGE NOTE (tool-count cap): the two former OCR tools (ocr_image and
// ocr_pdf) were merged into this single `ocr_document` tool. The document
// kind is inferred from the source (URL suffix or the data-URI mime type).
// Result shapes are preserved exactly.
//
// The API accepts:
//   - POST multipart/form-data with `image` field (file upload)
//   - POST application/json with `image_url` field
//
// Returns: { text: string } — the extracted text.
//
// No API key required — the freeocr.ai service is free.

import { registerTool } from "./registry";
import type { ToolResult } from "@/types";

/**
 * Call the freeocr.ai OCR API with a document URL.
 *
 * @param sourceUrl - URL of the image/PDF to OCR (https://...)
 * @returns extracted text
 */
async function ocrFromUrl(sourceUrl: string): Promise<string> {
  const res = await fetch("https://freeocr.ai/api/v1/ocr", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ image_url: sourceUrl }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OCR API HTTP ${res.status}: ${errText.slice(0, 200) || res.statusText}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(`OCR API error: ${data.error}`);
  }

  return data.text || "";
}

/**
 * Call the freeocr.ai OCR API with a base64-encoded document (image or PDF).
 * freeocr.ai uses the 'image' multipart field for all file types.
 *
 * @param base64Data - base64 data URI (e.g. "data:image/png;base64,iVBOR..." or "data:application/pdf;base64,JVBERi...")
 * @param filename - filename for the multipart upload ("image" or "document.pdf")
 * @returns extracted text
 */
async function ocrFromBase64(base64Data: string, filename: string): Promise<string> {
  const base64Match = base64Data.match(/^data:([^;]+);base64,(.+)$/);
  if (!base64Match) {
    throw new Error("Invalid base64 data URI format. Expected: data:image/png;base64,... or data:application/pdf;base64,...");
  }

  const mimeType = base64Match[1]!;
  const base64 = base64Match[2]!;
  // Convert base64 to binary
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType });
  const file = new File([blob], filename, { type: mimeType });

  const formData = new FormData();
  formData.append("image", file);

  const res = await fetch("https://freeocr.ai/api/v1/ocr", {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OCR API HTTP ${res.status}: ${errText.slice(0, 200) || res.statusText}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(`OCR API error: ${data.error}`);
  }

  return data.text || "";
}

// ---- ocr_document tool (was ocr_image + ocr_pdf) ----
registerTool(
  "ocr_document",
  "Extract text from an image OR a PDF using OCR (Optical Character Recognition). Use this when the user wants to read text from a screenshot, photo, scanned document, any image containing text, or a scanned/PDF document without selectable text. Supports PNG, JPEG, GIF, WebP, BMP, and PDF. For large PDFs, only the first few pages are processed. Provide the source as a URL or a base64 data URI — the document kind is detected automatically.",
  {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL of the image or PDF to extract text from (e.g. 'https://example.com/screenshot.png' or 'https://example.com/document.pdf')",
      },
      base64: {
        type: "string",
        description: "Base64 data URI of the document (e.g. 'data:image/png;base64,iVBOR...' or 'data:application/pdf;base64,JVBERi...'). Use this when the file is already loaded in memory.",
      },
    },
    additionalProperties: false,
  },
  async (args): Promise<ToolResult> => {
    const url = args.url as string | undefined;
    const base64 = args.base64 as string | undefined;

    if (!url && !base64) {
      return {
        success: false,
        output: null,
        error: "Either 'url' or 'base64' must be provided.",
      };
    }

    // Detect the document kind from the source (for messages + multipart filename).
    const isPdf =
      (base64 ? base64.startsWith("data:application/pdf") : false) ||
      (url ? /\.pdf(\?|$)/i.test(url) : false);

    try {
      let text: string;
      if (url) {
        text = await ocrFromUrl(url);
      } else {
        text = await ocrFromBase64(base64!, isPdf ? "document.pdf" : "image");
      }

      if (!text || !text.trim()) {
        return {
          success: true,
          output: {
            text: "",
            message: isPdf
              ? "No text was detected in the PDF."
              : "No text was detected in the image.",
          },
        };
      }

      return {
        success: true,
        output: {
          text,
          char_count: text.length,
        },
      };
    } catch (e) {
      return {
        success: false,
        output: null,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
  false,
  "general",
);
