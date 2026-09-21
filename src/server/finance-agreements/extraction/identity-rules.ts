import { findIndianMobiles, findStates, verhoeffIsValid } from "./parsers";
import { addFieldWarning, emit, findProposal, pickAndEmit, warn, type RuleContext } from "./rule-context";
import { cleanValueText, finderCandidates, isPlaceholder, labelLines, labeledFinder, regexFinder, type Candidate, type DocText } from "./text-utils";

// Step 14A: label/format-anchored rules for counterparty contact facts and
// identity fields. Contact/address facts appear for BOTH parties of a contract,
// so they are capped at MEDIUM; identity values are restricted (their values and
// snippets never leave the restricted record - see extraction-result.ts).

// Text after a name label stops at the next inline label ("... PAN: X") or a
// "(hereinafter ...)" recital.
const NEXT_INLINE_LABEL = /\s+(?:PAN|GSTIN|GST|E-?mail|Phone|Mobile|Contact|Aadhaar|Aadhar|IFSC|Address|Account|Bank|PIN)\b\s*(?:no\.?|number)?\s*[:\-]/i;

function cleanName(tail: string): string | null {
  let text = tail.split(NEXT_INLINE_LABEL)[0]!;
  text = text.replace(/\(\s*hereinafter[^)]*\)?/i, "").replace(/\bhereinafter\b.*$/i, "").replace(/\s*\([^)]*\)\s*$/, (paren) => (/^\s*\(\s*(?:the\s+)?(?:collaborator|partner|vendor|creator)\s*\)\s*$/i.test(paren) ? "" : paren));
  text = cleanValueText(text);
  if (text.length < 2 || text.length > 150 || isPlaceholder(text) || !/[A-Za-z]{2,}/.test(text) || text.includes("@")) return null;
  return text;
}

function nameCandidates(doc: DocText, labelSource: string): Candidate<string>[] {
  const out: Candidate<string>[] = [];
  for (const row of labelLines(doc, labelSource, { nextLine: false })) {
    const name = cleanName(row.tail);
    if (name) out.push({ value: name, key: name.toLowerCase(), page: row.line.page, index: row.line.start, length: row.line.text.length, labeled: true });
  }
  return out;
}

const COUNTERPARTY_LABEL = String.raw`(?:collaborator|partner|vendor|creator|influencer|service\s+provider|page\s+owner|channel\s+owner)(?:'s)?\s+(?:legal\s+|full\s+|registered\s+)?name|name\s+of\s+(?:the\s+)?(?:collaborator|partner|vendor|creator|influencer|service\s+provider|second\s+party|party\s+b|firm|agency)|legal\s+name|registered\s+name|(?:agency|firm)\s+name|second\s+party|party\s+b`;

export function extractCounterpartyName(ctx: RuleContext): void {
  pickAndEmit(ctx, "counterpartyName", nameCandidates(ctx.doc, COUNTERPARTY_LABEL), { labeledConfidence: "MEDIUM", unlabeledConfidence: null, cap: "MEDIUM", extraWarnings: ["verify_party_attribution"] });
}

export function extractContactNumber(ctx: RuleContext): void {
  const finder = (region: string) => findIndianMobiles(region).map((m) => ({ value: m.e164, key: m.e164, index: m.index, length: m.length }));
  const labeled = labeledFinder(ctx.doc, String.raw`(?:mobile|phone|contact|cell|tel(?:ephone)?|whatsapp|mob)(?:\s*(?:no|number|num))?`, finder, { window: 60, nextLine: true });
  // Unlabeled numbers only count with an explicit +91/91 country prefix.
  const prefixed = finderCandidates(ctx.doc, (region) => findIndianMobiles(region).filter((m) => m.prefixed).map((m) => ({ value: m.e164, key: m.e164, index: m.index, length: m.length })));
  pickAndEmit(ctx, "contactNumber", [...labeled, ...prefixed], { labeledConfidence: "MEDIUM", unlabeledConfidence: "LOW", cap: "MEDIUM", extraWarnings: ["verify_party_attribution"] });
}

const EMAIL_FINDER = regexFinder(/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}/g, (m) => ({ value: m[0].toLowerCase(), key: m[0].toLowerCase() }));

export function extractEmail(ctx: RuleContext): void {
  const labeled = labeledFinder(ctx.doc, String.raw`e-?mail(?:\s*(?:id|address))?|mail\s*id`, EMAIL_FINDER, { window: 90, nextLine: true });
  pickAndEmit(ctx, "emailAddress", [...labeled, ...finderCandidates(ctx.doc, EMAIL_FINDER)], { labeledConfidence: "MEDIUM", unlabeledConfidence: "LOW", cap: "MEDIUM", extraWarnings: ["verify_party_attribution"] });
}

// --- Address / PIN / state ------------------------------------------------------------

const ADDRESS_LABEL = String.raw`(?:registered\s+|correspondence\s+|residential\s+|office\s+|permanent\s+|billing\s+|communication\s+)?address(?:\s+of\s+(?:the\s+)?(?:collaborator|partner|vendor|party|creator))?`;
const ANY_LABEL_LINE = /^[A-Za-z][A-Za-z /.&'()-]{1,32}\s*[:：]\s*\S/;
const MAX_ADDRESS_LINES = 4;
const MAX_ADDRESS_CHARS = 300;

type AddressBlock = { text: string; page: number; index: number; length: number };

function addressBlocks(doc: DocText): AddressBlock[] {
  const blocks: AddressBlock[] = [];
  for (const row of labelLines(doc, ADDRESS_LABEL, { nextLine: true })) {
    const parts = [row.tail];
    let last = row.line;
    for (let i = row.line.lineIndex + 1; parts.length < MAX_ADDRESS_LINES && i < doc.lines.length; i++) {
      const next = doc.lines[i]!;
      if (next.page !== row.line.page || !next.text || ANY_LABEL_LINE.test(next.text) || next.text.length > 120 || next.text.includes("@")) break;
      parts.push(next.text);
      last = next;
    }
    const text = cleanValueText(parts.map((part) => part.replace(/[,\s]+$/, "")).join(", ")).slice(0, MAX_ADDRESS_CHARS);
    if (text.length < 10 || isPlaceholder(text) || !/[A-Za-z]{3,}/.test(text) || !/[\d,]/.test(text)) continue;
    blocks.push({ text, page: row.line.page, index: row.line.start, length: last.start + last.text.length - row.line.start });
  }
  return blocks;
}

function derivedPin(text: string): string | null {
  const m = /(?:^|[\s,-])([1-9]\d{2}\s?\d{3})\s*[.,]?$/.exec(text);
  return m ? m[1]!.replace(/\s/g, "") : null;
}

export function extractAddressPinState(ctx: RuleContext): void {
  const blocks = addressBlocks(ctx.doc);
  const addressCandidates: Candidate<string>[] = blocks.map((b) => ({ value: b.text, key: b.text.toLowerCase(), page: b.page, index: b.index, length: b.length, labeled: true }));
  const chosenAddress = pickAndEmit(ctx, "address", addressCandidates, { labeledConfidence: "MEDIUM", unlabeledConfidence: null, cap: "MEDIUM", extraWarnings: ["verify_party_attribution"] });

  // PIN: label-anchored first; else only the trailing PIN of the chosen address block.
  const pinFinder = regexFinder(/(?<!\d)([1-9]\d{5})(?!\d)/g, (m) => ({ value: m[1]!, key: m[1]! }));
  const labeledPins = labeledFinder(ctx.doc, String.raw`pin(?:\s*code)?|postal\s+code|zip(?:\s*code)?`, pinFinder, { window: 40, nextLine: true });
  const picked = pickAndEmit(ctx, "pinCode", labeledPins, { labeledConfidence: "MEDIUM", unlabeledConfidence: null, cap: "MEDIUM", extraWarnings: ["verify_party_attribution"] });
  if (!picked && chosenAddress) {
    const pin = derivedPin(chosenAddress.value);
    if (pin) emit(ctx, "pinCode", pin, chosenAddress, "LOW", ["derived_from_address", "verify_party_attribution"]);
  }

  // State: label-anchored ("State: Karnataka"); else a single canonical state inside the chosen address.
  const stateCandidates: Candidate<string>[] = [];
  let statePresentButNotCanonical = false;
  for (const row of labelLines(ctx.doc, String.raw`state(?:\s+of\s+residence)?`, { nextLine: false })) {
    const states = findStates(row.tail);
    if (states.length > 0) stateCandidates.push({ value: states[0]!, key: states[0]!, page: row.line.page, index: row.line.start, length: row.line.text.length, labeled: true });
    else if (!isPlaceholder(row.tail)) statePresentButNotCanonical = true;
  }
  const pickedState = pickAndEmit(ctx, "state", stateCandidates, { labeledConfidence: "MEDIUM", unlabeledConfidence: null, cap: "MEDIUM", extraWarnings: ["verify_party_attribution"] });
  if (!pickedState && chosenAddress) {
    const inAddress = findStates(chosenAddress.value);
    if (inAddress.length === 1) emit(ctx, "state", inAddress[0]!, chosenAddress, "LOW", ["derived_from_address", "verify_party_attribution"]);
  }
  if (!pickedState && statePresentButNotCanonical && !findProposal(ctx, "state")) warn(ctx, "state_not_in_canonical_list", "state");
}

// --- Identity (restricted) ---------------------------------------------------------------

// State-code prefix of a real GSTIN: 01-38, 97 (other territory), 99 (centre).
function validGstStateCode(code: string): boolean {
  const n = Number(code);
  return (n >= 1 && n <= 38) || n === 97 || n === 99;
}

const GSTIN_FINDER = regexFinder(/(?<![A-Za-z0-9])(\d{2})([A-Z]{5}\d{4}[A-Z])([1-9A-Z])Z([0-9A-Z])(?![A-Za-z0-9])/gi, (m) => (validGstStateCode(m[1]!) ? { value: m[0].toUpperCase(), key: m[0].toUpperCase() } : null));
const PAN_FINDER = regexFinder(/(?<![A-Za-z0-9])[A-Z]{3}[ABCFGHJKLPTE][A-Z]\d{4}[A-Z](?![A-Za-z0-9])/gi, (m) => ({ value: m[0].toUpperCase(), key: m[0].toUpperCase() }));
const IFSC_FINDER = regexFinder(/(?<![A-Za-z0-9])[A-Z]{4}0[A-Z0-9]{6}(?![A-Za-z0-9])/gi, (m) => ({ value: m[0].toUpperCase(), key: m[0].toUpperCase() }));

export function extractGstin(ctx: RuleContext): void {
  const labeled = labeledFinder(ctx.doc, String.raw`gst(?:in)?|gst\s+identification\s+number`, GSTIN_FINDER, { window: 80, nextLine: true });
  pickAndEmit(ctx, "gstin", [...labeled, ...finderCandidates(ctx.doc, GSTIN_FINDER)], { labeledConfidence: "HIGH", unlabeledConfidence: "MEDIUM", extraWarnings: ["verify_party_attribution"] });
}

export function extractPan(ctx: RuleContext): void {
  const labeled = labeledFinder(ctx.doc, String.raw`pan(?:\s*(?:no|number|card))?|permanent\s+account\s+number`, PAN_FINDER, { window: 60, nextLine: true });
  pickAndEmit(ctx, "panNumber", [...labeled, ...finderCandidates(ctx.doc, PAN_FINDER)], { labeledConfidence: "HIGH", unlabeledConfidence: "LOW", extraWarnings: ["verify_party_attribution"] });
  // Cross-check: a GSTIN embeds the holder's PAN (characters 3-12).
  const pan = findProposal(ctx, "panNumber");
  const gstin = findProposal(ctx, "gstin");
  if (pan && gstin && gstin.normalizedValue.slice(2, 12) !== pan.normalizedValue) {
    addFieldWarning(ctx, "panNumber", "pan_gstin_mismatch");
    addFieldWarning(ctx, "gstin", "pan_gstin_mismatch");
  }
}

export function extractPanHolderName(ctx: RuleContext): void {
  const label = String.raw`name\s+(?:as\s+per|on|in)\s+(?:the\s+)?pan(?:\s+card)?|pan\s+(?:card\s+)?holder(?:'?s)?(?:\s+name)?|name\s+of\s+(?:the\s+)?pan\s+(?:card\s+)?holder`;
  pickAndEmit(ctx, "panHolderName", nameCandidates(ctx.doc, label), { labeledConfidence: "MEDIUM", unlabeledConfidence: null, cap: "MEDIUM" });
}

const AADHAAR_FINDER = (region: string) => {
  const out: Array<{ value: string; key: string; index: number; length: number; masked: boolean }> = [];
  for (const m of region.matchAll(/(?<![A-Za-z0-9])([2-9]\d{3})[ -]?(\d{4})[ -]?(\d{4})(?!\d)/g)) {
    const digits = `${m[1]}${m[2]}${m[3]}`;
    out.push({ value: digits, key: digits, index: m.index!, length: m[0].length, masked: false });
  }
  for (const m of region.matchAll(/(?<![A-Za-z0-9])(?:[Xx*]{4}[ -]?[Xx*]{4}|[Xx*]{8})[ -]?(\d{4})(?!\d)/g)) {
    out.push({ value: `XXXXXXXX${m[1]}`, key: `XXXXXXXX${m[1]}`, index: m.index!, length: m[0].length, masked: true });
  }
  return out.sort((a, b) => a.index - b.index);
};

export function extractAadhaar(ctx: RuleContext): void {
  // Label-anchored ONLY: a bare 12-digit number is never assumed to be Aadhaar.
  const labeled = labeledFinder(ctx.doc, String.raw`aadhaar|aadhar|adhaar|uidai|uid(?:\s*(?:no|number))?`, AADHAAR_FINDER, { window: 60, nextLine: true });
  const picked = pickAndEmit(ctx, "aadhaarNumber", labeled, { labeledConfidence: "HIGH", unlabeledConfidence: null });
  const proposal = findProposal(ctx, "aadhaarNumber");
  if (!picked || !proposal) return;
  if (/^X{8}\d{4}$/.test(proposal.normalizedValue)) {
    proposal.confidence = "LOW";
    proposal.warnings.push("aadhaar_masked");
  } else if (!verhoeffIsValid(proposal.normalizedValue)) {
    if (proposal.confidence === "HIGH") proposal.confidence = "MEDIUM";
    proposal.warnings.push("aadhaar_checksum_invalid");
  }
}

const ACCOUNT_LABEL = String.raw`(?:bank\s+|savings?\s+|current\s+)*(?:account|a\/c|acct)\s*(?:number|no|num|#)`;
const ACCOUNT_FINDER = regexFinder(/(?<![\d])(\d(?:[ -]?\d){8,17})(?![\d])/g, (m) => {
  const digits = m[1]!.replace(/[ -]/g, "");
  return digits.length >= 9 && digits.length <= 18 ? { value: digits, key: digits } : null;
});

export function extractBankAccount(ctx: RuleContext): void {
  const labeled = labeledFinder(ctx.doc, ACCOUNT_LABEL, ACCOUNT_FINDER, { window: 60, nextLine: true });
  pickAndEmit(ctx, "bankAccountNumber", labeled, { labeledConfidence: "HIGH", unlabeledConfidence: null, extraWarnings: ["verify_party_attribution"] });
}

export function extractIfsc(ctx: RuleContext): void {
  const labeled = labeledFinder(ctx.doc, String.raw`ifsc(?:\s*code)?|ifs\s*code`, IFSC_FINDER, { window: 50, nextLine: true });
  pickAndEmit(ctx, "ifsc", [...labeled, ...finderCandidates(ctx.doc, IFSC_FINDER)], { labeledConfidence: "HIGH", unlabeledConfidence: "MEDIUM", extraWarnings: ["verify_party_attribution"] });
}
