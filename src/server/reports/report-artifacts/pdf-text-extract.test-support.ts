// TEST-SUPPORT ONLY - never imported from production code. Reports PDF Composition &
// Management-Publication Polish (spec section 25: "extract PDF text ... assert no raw UUID/internal-ref
// pattern; assert no [DRAFT]; assert no full actor scope; assert no partnerRef; assert no
// views_standard; assert no renderer verification; assert no bounded, single-Partner"). pdf-lib has no
// high-level text-extraction API; this reads the same low-level structures pdf-renderer.ts itself
// writes with (a `<hex>` string immediately followed by a `Tj` operator inside each page's own content
// stream - pdf-lib always draws text this way for the StandardFonts this renderer uses, never a `TJ`
// array or a literal `(...)`-parenthesized string) and reconstructs the plain ASCII text that was
// actually drawn on each page, so a test can assert on real rendered PDF CONTENT rather than only on
// section-model inputs.
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";

function hexToAscii(hex: string): string {
  let out = "";
  for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

const TJ_HEX_PATTERN = /<([0-9A-Fa-f]+)>\s*Tj/g;

// Per-page variant (used to assert WHICH page a piece of text landed on - e.g. "does a heading share a
// page with its own body content" - not just whether it appears anywhere in the document).
export async function extractPdfPagesText(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const pagesText: string[] = [];
  for (const page of doc.getPages()) {
    const parts: string[] = [];
    const contents = page.node.Contents();
    if (contents) {
      const streamRefs = contents instanceof PDFArray ? contents.asArray() : [contents];
      for (const refOrStream of streamRefs) {
        const stream = "objectNumber" in refOrStream ? doc.context.lookup(refOrStream) : refOrStream;
        if (!(stream instanceof PDFRawStream)) continue;
        const decoded = decodePDFRawStream(stream).decode();
        const streamText = Buffer.from(decoded).toString("latin1");
        for (const match of streamText.matchAll(TJ_HEX_PATTERN)) parts.push(hexToAscii(match[1]!));
      }
    }
    // A single space between every drawn text fragment is enough for substring/regex assertions - this
    // is NOT meant to reconstruct exact reading-order prose, only to make "does this string appear
    // anywhere on this page" testable.
    pagesText.push(parts.join(" "));
  }
  return pagesText;
}

export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  return (await extractPdfPagesText(bytes)).join(" ");
}
