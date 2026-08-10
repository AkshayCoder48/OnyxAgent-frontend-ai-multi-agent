// OCR Tools — ocr_image and ocr_pdf using freeocr.ai API.
//
// These tools let the AI extract text from images and PDFs. They call the
// freeocr.ai API (https://freeocr.ai/api/v1/ocr) which provides free OCR
// powered by Tesseract.
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
 * Call the freeocr.ai OCR API with an image URL.
 *
 * @param imageUrl - URL of the image to OCR (https://...)
 * @returns extracted text
 */
async function ocrImageUrl(imageUrl: string): Promise<string> {
  const res = await fetch("https://freeocr.ai/api/v1/ocr", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ image_url: imageUrl }),
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
 * Call the freeocr.ai OCR API with a base64-encoded image.
 *
 * @param base64Data - base64 data URI (e.g. "data:image/png;base64,iVBOR...")
 * @returns extracted text
 */
async function ocrImageBase64(base64Data: string): Promise<string> {
  // freeocr.ai accepts multipart form data with the image file
  // Convert base64 to a Blob
  const base64Match = base64Data.match(/^data:([^;]+);base64,(.+)$/);
  if (!base64Match) {
    throw new Error("Invalid base64 data URI format. Expected: data:image/png;base64,...");
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
  const file = new File([blob], "image", { type: mimeType });

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

// ---- ocr_image tool ----
registerTool(
  "ocr_image",
  "Extract text from an image using OCR (Optical Character Recognition). Use this when the user wants to read text from a screenshot, photo, scanned document, or any image containing text. Supports PNG, JPEG, GIF, WebP, and BMP formats. The image can be provided as a URL or base64 data URI.",
  {
    type: "object",
    properties: {
      image_url: {
        type: "string",
        description: "URL of the image to extract text from (e.g. 'https://example.com/screenshot.png')",
      },
      image_base64: {
        type: "string",
        description: "Base64 data URI of the image (e.g. 'data:image/png;base64,iVBOR...'). Use this when the image is already loaded in memory.",
      },
    },
    additionalProperties: false,
  },
  async (args): Promise<ToolResult> => {
    const imageUrl = args.image_url as string | undefined;
    const imageBase64 = args.image_base64 as string | undefined;

    if (!imageUrl && !imageBase64) {
      return {
        success: false,
        output: null,
        error: "Either 'image_url' or 'image_base64' must be provided.",
      };
    }

    try {
      let text: string;
      if (imageUrl) {
        text = await ocrImageUrl(imageUrl);
      } else {
        text = await ocrImageBase64(imageBase64!);
      }

      if (!text || !text.trim()) {
        return {
          success: true,
          output: {
            text: "",
            message: "No text was detected in the image.",
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

// ---- ocr_pdf tool ----
registerTool(
  "ocr_pdf",
  "Extract text from a PDF document using OCR. Use this when the user wants to read text from a scanned PDF, or a PDF that doesn't have selectable text. The PDF can be provided as a URL or base64 data URI. For large PDFs, only the first few pages are processed.",
  {
    type: "object",
    properties: {
      pdf_url: {
        type: "string",
        description: "URL of the PDF to extract text from (e.g. 'https://example.com/document.pdf')",
      },
      pdf_base64: {
        type: "string",
        description: "Base64 data URI of the PDF (e.g. 'data:application/pdf;base64,JVBERi...'). Use this when the PDF is already loaded in memory.",
      },
    },
    additionalProperties: false,
  },
  async (args): Promise<ToolResult> => {
    const pdfUrl = args.pdf_url as string | undefined;
    const pdfBase64 = args.pdf_base64 as string | undefined;

    if (!pdfUrl && !pdfBase64) {
      return {
        success: false,
        output: null,
        error: "Either 'pdf_url' or 'pdf_base64' must be provided.",
      };
    }

    try {
      let text: string;

      if (pdfBase64) {
        // Convert base64 PDF to file and send to OCR API
        const base64Match = pdfBase64.match(/^data:([^;]+);base64,(.+)$/);
        if (!base64Match) {
          throw new Error("Invalid base64 data URI format. Expected: data:application/pdf;base64,...");
        }

        const mimeType = base64Match[1]!;
        const base64 = base64Match[2]!;
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: mimeType });
        const file = new File([blob], "document.pdf", { type: mimeType });

        const formData = new FormData();
        formData.append("image", file); // freeocr.ai uses 'image' field for all file types

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
        text = data.text || "";
      } else {
        // Send PDF URL to OCR API
        const res = await fetch("https://freeocr.ai/api/v1/ocr", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image_url: pdfUrl }),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new Error(`OCR API HTTP ${res.status}: ${errText.slice(0, 200) || res.statusText}`);
        }

        const data = await res.json();
        if (data.error) {
          throw new Error(`OCR API error: ${data.error}`);
        }
        text = data.text || "";
      }

      if (!text || !text.trim()) {
        return {
          success: true,
          output: {
            text: "",
            message: "No text was detected in the PDF.",
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
