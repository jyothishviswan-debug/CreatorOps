import { cleanValueText, sentenceHit, sentencesOf, type DocLine, type DocText, type Sentence } from "./text-utils";

// Step 14A: PARTY-ROLE resolution. Many contracts declare the two sides as "1st Party" / "2nd Party" (or "Client" /
// "Service Provider", "Company" / "Vendor", etc.) instead of a "Collaborator Name:" label, and later address notices
// with "For the Client:" / "For the Service Provider:" lines. This module recognizes the OPERATOR side (the platform's
// own side) versus the COUNTERPARTY side (the other side) from a fixed set of role-word aliases, so a fact written
// INSIDE a party's own declaration - or an explicit "For the <role>:" notice line - can be ATTRIBUTED to the right
// side, rather than falling back to the generic "several distinct values, could be either party" downgrade that
// still applies whenever nothing in the text names a role at all.

export type PartySide = "operator" | "counterparty";

// The operator is CreatorOps' own counterpart in the agreement (never CreatorOps itself - a THIRD party to every one
// of these contracts); the counterparty is the other side, whatever noun the contract gives it.
export const OPERATOR_ROLE_WORDS = String.raw`1st\s+Party|First\s+Party|Client|Company|Principal`;
export const COUNTERPARTY_ROLE_WORDS = String.raw`2nd\s+Party|Second\s+Party|Service\s+Provider|Collaborator|Vendor|Consultant|Contractor|Partner|Influencer|Talent`;

const OPERATOR_WORD_RE = new RegExp(String.raw`^(?:${OPERATOR_ROLE_WORDS})$`, "i");
const COUNTERPARTY_WORD_RE = new RegExp(String.raw`^(?:${COUNTERPARTY_ROLE_WORDS})$`, "i");

function sideOf(word: string): PartySide | null {
  if (OPERATOR_WORD_RE.test(word)) return "operator";
  if (COUNTERPARTY_WORD_RE.test(word)) return "counterparty";
  return null;
}

// --- Party declarations ("1st Party: X, a company ...", "2nd Party: Y S/o Z, ... PIN ... PAN ... Aadhar ...") -------
//
// The recital that names the parties routinely bundles several clauses into ONE line-wrapped sentence, so this reads
// from sentencesOf (line-wrap tolerant) rather than doc.lines.

const ROLE_LABEL = new RegExp(String.raw`\b(?:${OPERATOR_ROLE_WORDS}|${COUNTERPARTY_ROLE_WORDS})\b\s*:`, "gi");
const FOR_THE_PREFIX = /for\s+the\s*$/i; // "For the Client:" is a notice label (see findForRoleLines), not a declaration
const RELATION_MARK = /\s+(?:S\/o|D\/o|W\/o|C\/o)\b/i;
const MAX_DECLARED_NAME_CHARS = 150;

export type PartyDeclaration = { side: PartySide; name: string; page: number; index: number; length: number; sentence: Sentence };

function nameFromTail(tail: string): string {
  const commaIndex = tail.indexOf(",");
  let name = commaIndex >= 0 ? tail.slice(0, commaIndex) : tail;
  const relation = RELATION_MARK.exec(name);
  if (relation) name = name.slice(0, relation.index);
  return cleanValueText(name);
}

// Every "<role label>: <name...>" declaration found anywhere in the document (order of appearance).
export function findPartyDeclarations(doc: DocText): PartyDeclaration[] {
  const out: PartyDeclaration[] = [];
  for (const sentence of sentencesOf(doc)) {
    for (const m of sentence.flat.matchAll(ROLE_LABEL)) {
      const before = sentence.flat.slice(Math.max(0, m.index! - 12), m.index!);
      if (FOR_THE_PREFIX.test(before)) continue; // a notice label, not a party declaration
      const word = m[0].replace(/\s*:$/, "").trim();
      const side = sideOf(word);
      if (!side) continue;
      const from = m.index! + m[0].length;
      const tail = sentence.flat.slice(from, from + MAX_DECLARED_NAME_CHARS);
      const name = nameFromTail(tail);
      if (name.length < 2 || name.length > MAX_DECLARED_NAME_CHARS || !/[A-Za-z]{2,}/.test(name) || name.includes("@")) continue;
      const hit = sentenceHit(sentence, from, Math.max(1, name.length));
      out.push({ side, name, page: hit.page, index: hit.index, length: hit.length, sentence });
    }
  }
  return out;
}

export function declarationContaining(declarations: readonly PartyDeclaration[], page: number, index: number): PartyDeclaration | undefined {
  return declarations.find((d) => d.sentence.page === page && index >= d.sentence.index && index < d.sentence.index + d.sentence.length);
}

// --- "permanent address at ..., PIN ..." embedded in a counterparty's own declaration sentence -----------------------

const DECLARED_ADDRESS = new RegExp(String.raw`\baddress\s+at\s+(?<addr>[\s\S]+?),?\s*PIN\s*:?\s*(?<pin>\d{3}\s?\d{3})\b`, "i");

export type DeclaredAddress = { text: string; page: number; index: number; length: number; pin: string; pinPage: number; pinIndex: number; pinLength: number };

// Reads the address + PIN embedded in the SAME sentence as a party declaration (a natural-person party block written
// as "... with a permanent address at <street>, ..., PIN: <code>, having PAN ..."). Null when the sentence has no such
// phrase (an entity party's "registered office at ..." is deliberately NOT read here - see the module comment).
export function declaredAddressOf(declaration: PartyDeclaration): DeclaredAddress | null {
  const m = DECLARED_ADDRESS.exec(declaration.sentence.flat);
  if (!m?.groups?.addr || !m.groups.pin) return null;
  const addrFlat = m.groups.addr;
  const addrStart = m.index! + m[0].indexOf(addrFlat);
  const addrHit = sentenceHit(declaration.sentence, addrStart, addrFlat.length);
  const pinFlat = m.groups.pin;
  const pinStart = m.index! + m[0].lastIndexOf(pinFlat);
  const pinHit = sentenceHit(declaration.sentence, pinStart, pinFlat.length);
  const text = cleanValueText(addrFlat.replace(/,\s*$/, ""));
  if (text.length < 10) return null;
  return { text, page: addrHit.page, index: addrHit.index, length: addrHit.length, pin: pinFlat.replace(/\s/g, ""), pinPage: pinHit.page, pinIndex: pinHit.index, pinLength: pinHit.length };
}

// --- "For the <role>:" notice labels (email / postal address) --------------------------------------------------------

// Tolerates a stray "." before the colon ("For the Client.:", seen in real contracts) and an empty tail (the value is
// then the block of lines that follows, e.g. a name + address, exactly like a label whose value is "on the next line").
const FOR_ROLE_LINE = new RegExp(String.raw`^\s*for\s+the\s+(?<role>${OPERATOR_ROLE_WORDS}|${COUNTERPARTY_ROLE_WORDS})\b\s*\.?\s*:?\s*(?<tail>.*)$`, "i");
const LABELISH_LINE = /^[A-Za-z][A-Za-z /.&'()-]{1,40}[:：]\s*\S/;
const MAX_ROLE_CONTINUATION_LINES = 4;

export type RoleLine = { side: PartySide; page: number; index: number; length: number; text: string };

// Every "For the <role>: ..." line, with its value (same line, or the following lines when the label ends its own line).
export function findForRoleLines(doc: DocText): RoleLine[] {
  const out: RoleLine[] = [];
  for (const line of doc.lines) {
    const m = FOR_ROLE_LINE.exec(line.text);
    if (!m?.groups) continue;
    const side = sideOf(m.groups.role!);
    if (!side) continue;
    const tail = (m.groups.tail ?? "").trim();
    if (tail) {
      out.push({ side, page: line.page, index: line.start, length: line.text.length, text: cleanValueText(tail) });
      continue;
    }
    const parts: string[] = [];
    let last: DocLine = line;
    for (let i = line.lineIndex + 1; parts.length < MAX_ROLE_CONTINUATION_LINES && i < doc.lines.length; i++) {
      const next = doc.lines[i]!;
      if (next.page !== line.page || !next.text || FOR_ROLE_LINE.test(next.text) || LABELISH_LINE.test(next.text)) break;
      parts.push(next.text);
      last = next;
      if (/\bpin\b/i.test(next.text)) break; // a PIN conventionally closes a mailing-address block
    }
    if (parts.length === 0) continue;
    out.push({ side, page: line.page, index: line.start, length: last.start + last.text.length - line.start, text: cleanValueText(parts.join(", ")) });
  }
  return out;
}

// --- Zones: the union of every declaration's sentence span and every "For the <role>:" line's value span, for a
// cheap "was this hit found inside a known party's own text" check (used to EXCLUDE the operator's facts from a
// counterparty-only field, per the module contract above - never the reverse). ----------------------------------------

export type PartyZone = { side: PartySide; page: number; start: number; end: number };

export function partyZones(doc: DocText): PartyZone[] {
  const zones: PartyZone[] = [];
  for (const d of findPartyDeclarations(doc)) zones.push({ side: d.side, page: d.sentence.page, start: d.sentence.index, end: d.sentence.index + d.sentence.length });
  for (const l of findForRoleLines(doc)) zones.push({ side: l.side, page: l.page, start: l.index, end: l.index + l.length });
  return zones;
}

export function inZoneOfRole(zones: readonly PartyZone[], side: PartySide, page: number, index: number): boolean {
  return zones.some((z) => z.side === side && z.page === page && index >= z.start && index < z.end);
}
