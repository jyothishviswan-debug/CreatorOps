import { extractText, getDocumentProxy } from "unpdf";

// Step 14A: local, deterministic PDF text extraction (unpdf = pdf.js without a
// browser). NO OCR, NO cloud calls. This wrapper NEVER throws to its caller:
// every failure mode of a hostile / malformed / encrypted upload maps to a
// typed { ok: false, reason }.
//
// Bounds (a contract is a few pages; anything far larger is not one):
//   - MAX_PDF_PAGES: more pages than this is rejected (`too_many_pages`), not
//     silently truncated - a partial read of a long document could hide the
//     clauses that matter.
//   - MAX_EXTRACTED_CHARS: a cap on total normalized text kept; the excess is
//     dropped and flagged (`truncated.chars`) so the classifier can warn.
//   - PDF_PARSE_TIMEOUT_MS: parse/extract is raced against this timer. pdf.js
//     runs in-process, so a synchronous CPU-bound loop inside it cannot be
//     pre-empted by a timer; the guard bounds slow-async work and lets us
//     release the document. The 10 MB / page bounds are the primary defence.

export const PARSER_VERSION = "unpdf@1.8.1+rules-1";

export const MAX_PDF_PAGES = 60;
export const MAX_EXTRACTED_CHARS = 400_000;
export const PDF_PARSE_TIMEOUT_MS = 20_000;

// Below this many NON-WHITESPACE characters in the whole document we treat the
// PDF as having no text layer (a scan, or an image-only export). A scanned
// contract typically yields 0; a stray page number or footer stays well below
// 40, while any real agreement carries hundreds of characters per page.
export const MIN_EXTRACTABLE_CHARS = 40;

export type PdfTextFailureReason = "unreadable_pdf" | "encrypted" | "too_many_pages" | "timeout" | "no_extractable_text";

export type PdfTextResult =
  | {
      ok: true;
      // One entry per PDF page (index 0 = page 1), normalized. Pages past the
      // character cap are "" so indexes always equal page numbers - 1.
      pages: string[];
      pageCount: number;
      // Total normalized characters kept (whitespace included).
      totalChars: number;
      truncated: { chars: boolean };
    }
  | { ok: false; reason: PdfTextFailureReason; pageCount?: number };

// Normalization keeps line structure (the field extractors are line/label
// anchored) but removes noise: control chars, NULs, soft hyphens, zero-width
// chars, odd spaces, trailing/leading blanks and runs of blank lines.
const CONTROL_AND_INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B-\u200D\uFEFF]/g;
const ODD_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000\t]/g;

export function normalizePageText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_AND_INVISIBLE, "")
    .replace(ODD_SPACES, " ")
    .split("\n")
    .map((line) => line.replace(/ {2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function countNonWhitespace(text: string): number {
  return text.replace(/\s/g, "").length;
}

class TimeoutSignal {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutSignal()), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isEncryptedError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "PasswordException";
}

// isEvalSupported:false stops pdf.js compiling font programs with `new Function`
// (a hardening choice for untrusted uploads); verbosity 0 silences its console
// warnings. Both are real pdf.js getDocument options that unpdf's narrower
// DocumentInitParameters typing does not list, hence the cast.
const PDFJS_OPTIONS = { isEvalSupported: false, verbosity: 0 } as unknown as NonNullable<Parameters<typeof getDocumentProxy>[1]>;

type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

export async function extractPdfText(bytes: Uint8Array, options?: { timeoutMs?: number; maxPages?: number; maxChars?: number }): Promise<PdfTextResult> {
  const timeoutMs = options?.timeoutMs ?? PDF_PARSE_TIMEOUT_MS;
  const maxPages = options?.maxPages ?? MAX_PDF_PAGES;
  const maxChars = options?.maxChars ?? MAX_EXTRACTED_CHARS;

  const holder: { document: PdfDocument | null } = { document: null };
  try {
    return await withTimeout(
      (async (): Promise<PdfTextResult> => {
        // pdf.js takes ownership of (detaches) the buffer it is given: pass a copy.
        const document = await getDocumentProxy(new Uint8Array(bytes), PDFJS_OPTIONS);
        holder.document = document;
        const pageCount = document.numPages;
        if (pageCount > maxPages) return { ok: false, reason: "too_many_pages", pageCount };

        const extracted = await extractText(document, { mergePages: false });
        const pages: string[] = [];
        let remaining = maxChars;
        let charsTruncated = false;
        let totalChars = 0;
        for (let index = 0; index < pageCount; index++) {
          let text = normalizePageText(extracted.text[index] ?? "");
          if (text.length > remaining) {
            text = text.slice(0, Math.max(0, remaining));
            charsTruncated = true;
          }
          remaining -= text.length;
          totalChars += text.length;
          pages.push(text);
        }

        const meaningful = pages.reduce((sum, page) => sum + countNonWhitespace(page), 0);
        if (meaningful < MIN_EXTRACTABLE_CHARS) return { ok: false, reason: "no_extractable_text", pageCount };
        return { ok: true, pages, pageCount, totalChars, truncated: { chars: charsTruncated } };
      })(),
      timeoutMs,
    );
  } catch (error) {
    if (error instanceof TimeoutSignal) return { ok: false, reason: "timeout" };
    if (isEncryptedError(error)) return { ok: false, reason: "encrypted" };
    // Anything else (InvalidPDFException, MissingPDFException, FormatError,
    // parse crashes inside pdf.js...) is an unreadable file. The message is
    // deliberately dropped: it can echo document content.
    return { ok: false, reason: "unreadable_pdf" };
  } finally {
    // Release pdf.js resources (worker port, buffers). Best-effort: a failure
    // here must never turn into an exception for the caller.
    try {
      void holder.document?.loadingTask.destroy().catch(() => undefined);
    } catch {
      // ignore
    }
  }
}
