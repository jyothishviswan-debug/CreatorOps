// Step 14A test helpers: build tiny but STRUCTURALLY VALID PDFs (correct xref
// offsets) so parser tests exercise a real PDF reader, not string mocks.
// Test-only: nothing in production imports this file.
//
// Limits (deliberate): Helvetica / WinAnsi only. Characters above U+00FF (for
// example the rupee sign) cannot be encoded by the standard font and are
// written as "?" - use "Rs." in synthetic contract text.

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;

function escapePdfString(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (char === "\\" || char === "(" || char === ")") out += `\\${char}`;
    else if (code < 0x20 || code > 0xff) out += "?";
    else out += char;
  }
  return out;
}

function contentStreamFor(lines: string[]): string {
  if (lines.length === 0) return "";
  const parts = ["BT", "/F1 11 Tf", "14 TL", `40 ${PAGE_HEIGHT - 50} Td`];
  for (const line of lines) parts.push(`(${escapePdfString(line)}) Tj`, "T*");
  parts.push("ET");
  return parts.join("\n");
}

type PdfObject = string;

function assemblePdf(objects: PdfObject[], trailerExtra = ""): Buffer {
  // objects[i] is object number i + 1. Everything is latin1 so byte offsets
  // equal string offsets.
  let body = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerExtra} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer, "latin1");
}

function buildDocument(pageContents: string[], extraObjects: PdfObject[] = [], catalogExtra = ""): PdfObject[] {
  // 1 Catalog, 2 Pages, 3 Font, then (page, content) pairs.
  const pageCount = pageContents.length;
  const kids = pageContents.map((_, index) => `${4 + index * 2} 0 R`).join(" ");
  const objects: PdfObject[] = [
    `<< /Type /Catalog /Pages 2 0 R${catalogExtra} >>`,
    `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  pageContents.forEach((content, index) => {
    const contentObjectNumber = 5 + index * 2;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  });
  return [...objects, ...extraObjects];
}

// A valid multi-page text PDF. pagesOfLines[p] are the lines drawn on page p+1.
export function makeTextPdf(pagesOfLines: string[][]): Buffer {
  if (pagesOfLines.length === 0) throw new Error("makeTextPdf needs at least one page.");
  return assemblePdf(buildDocument(pagesOfLines.map(contentStreamFor)));
}

// A valid PDF whose pages draw nothing: the stand-in for a scanned contract
// (no text layer).
export function makeBlankPdf(pages: number): Buffer {
  if (!Number.isInteger(pages) || pages < 1) throw new Error("makeBlankPdf needs at least one page.");
  return assemblePdf(buildDocument(Array.from({ length: pages }, () => "")));
}

// A PDF with a standard-security-handler /Encrypt dictionary and bogus O/U
// values: no reader can open it with the empty password, exactly like a real
// password-protected contract.
export function makeEncryptedPdf(): Buffer {
  const bogus = (fill: string) => `<${fill.repeat(64)}>`;
  const objects = buildDocument([contentStreamFor(["secret"])]);
  objects.push(`<< /Filter /Standard /V 1 /R 2 /O ${bogus("ab")} /U ${bogus("cd")} /P -4 >>`);
  const encryptObjectNumber = objects.length;
  const idHex = "0123456789abcdef0123456789abcdef";
  return assemblePdf(objects, ` /Encrypt ${encryptObjectNumber} 0 R /ID [<${idHex}> <${idHex}>]`);
}

// Starts like a PDF (passes the magic check) but is garbage after that.
export function makeGarbagePdf(sizeBytes = 2048): Buffer {
  const header = Buffer.from("%PDF-1.4\n", "latin1");
  const filler = Buffer.alloc(Math.max(0, sizeBytes - header.length));
  for (let i = 0; i < filler.length; i++) filler[i] = (i * 131 + 17) & 0xff;
  return Buffer.concat([header, filler]);
}

// A real PDF cut off mid-file (no xref/trailer).
export function makeTruncatedPdf(source: Buffer = makeTextPdf([["truncated"]])): Buffer {
  return source.subarray(0, Math.floor(source.length * 0.4));
}

// Bytes that are not a PDF at all.
export function makeNotAPdf(): Buffer {
  return Buffer.from("This is a plain text file, not a PDF.\n", "utf8");
}
