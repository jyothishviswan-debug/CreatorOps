import { isRestrictedExtractedField, type ExtractedFieldKey, type ExtractedFieldProposal, type ExtractedFieldValueMap, type ExtractionConfidence, type ExtractionWarning } from "./extraction-types";
import { byPosition, capConfidence, snippetAt, uniqueByKey, type Candidate, type DocText } from "./text-utils";

// Step 14A: shared plumbing for the rule modules: the emit/pick helpers that
// turn candidate matches into proposals under ONE confidence policy.
//
// Confidence policy (coarse, heuristic):
//   HIGH   label-anchored AND a strict format AND a single distinct value.
//   MEDIUM label-anchored with looser text, or a strict format with no label
//          (a lone, unlabeled but format-specific match), or a field whose
//          party attribution can be wrong (contact / address facts appear for
//          BOTH parties) - those are capped at MEDIUM.
//   LOW    more than one distinct label-anchored value (first one proposed),
//          or a rule that could not fully validate (e.g. zero amount).
//   Ambiguous UNLABELED values (several distinct matches, no label) are OMITTED
//   with a document-level warning - never guessed.

export type RuleContext = {
  doc: DocText;
  fields: ExtractedFieldProposal[];
  warnings: ExtractionWarning[];
};

export function createContext(doc: DocText): RuleContext {
  return { doc, fields: [], warnings: [] };
}

export type Hit = { page: number; index: number; length: number };

export function emit<K extends ExtractedFieldKey>(
  ctx: RuleContext,
  fieldKey: K,
  normalizedValue: ExtractedFieldValueMap[K],
  hit: Hit,
  confidence: ExtractionConfidence,
  warnings: string[] = [],
): void {
  const proposal = {
    fieldKey,
    normalizedValue,
    rawSnippet: snippetAt(ctx.doc, hit.page, hit.index, hit.length),
    page: hit.page,
    confidence,
    warnings: [...new Set(warnings)],
    requiresHumanConfirmation: true,
    restricted: isRestrictedExtractedField(fieldKey),
  } as ExtractedFieldProposal;
  ctx.fields.push(proposal);
}

export function warn(ctx: RuleContext, code: string, fieldKey?: ExtractedFieldKey, page?: number): void {
  ctx.warnings.push({ code, ...(fieldKey ? { fieldKey } : {}), ...(page ? { page } : {}) });
}

export type PickOptions = {
  // Confidence for a lone label-anchored candidate.
  labeledConfidence: ExtractionConfidence;
  // Confidence for a lone UNLABELED candidate; null = unlabeled never counts.
  unlabeledConfidence: ExtractionConfidence | null;
  // Upper bound (party-attribution-sensitive fields cap at MEDIUM).
  cap?: ExtractionConfidence;
  // Extra machine-code warnings to attach to whatever is emitted.
  extraWarnings?: string[];
};

// Applies the policy to one field's candidates and emits at most one proposal.
export function pickAndEmit<K extends ExtractedFieldKey>(ctx: RuleContext, fieldKey: K, candidates: Candidate<ExtractedFieldValueMap[K]>[], options: PickOptions): Candidate<ExtractedFieldValueMap[K]> | null {
  const sorted = [...candidates].sort(byPosition);
  const labeled = uniqueByKey(sorted.filter((candidate) => candidate.labeled));
  const unlabeled = uniqueByKey(sorted.filter((candidate) => !candidate.labeled));
  const cap = options.cap ?? "HIGH";
  const warnings = [...(options.extraWarnings ?? [])];

  if (labeled.length > 0) {
    const chosen = labeled[0]!;
    let confidence = options.labeledConfidence;
    if (labeled.length > 1) {
      confidence = "LOW";
      warnings.push("multiple_distinct_values_found");
    }
    if (unlabeled.some((candidate) => candidate.key !== chosen.key)) warnings.push("other_similar_values_in_document");
    emit(ctx, fieldKey, chosen.value, chosen, capConfidence(chosen.cap ? capConfidence(confidence, chosen.cap) : confidence, cap), [...warnings, ...(chosen.warnings ?? [])]);
    return chosen;
  }

  if (unlabeled.length === 0 || options.unlabeledConfidence === null) return null;
  if (unlabeled.length > 1) {
    warn(ctx, "ambiguous_value_omitted", fieldKey, unlabeled[0]!.page);
    return null;
  }
  const chosen = unlabeled[0]!;
  emit(ctx, fieldKey, chosen.value, chosen, capConfidence(chosen.cap ? capConfidence(options.unlabeledConfidence, chosen.cap) : options.unlabeledConfidence, cap), [...warnings, ...(chosen.warnings ?? []), "no_label_found"]);
  return chosen;
}

// Adds a machine-code warning to an already-emitted proposal (cross-checks).
export function addFieldWarning(ctx: RuleContext, fieldKey: ExtractedFieldKey, code: string): void {
  const proposal = ctx.fields.find((field) => field.fieldKey === fieldKey);
  if (proposal && !proposal.warnings.includes(code)) proposal.warnings.push(code);
}

export function findProposal<K extends ExtractedFieldKey>(ctx: RuleContext, fieldKey: K): Extract<ExtractedFieldProposal, { fieldKey: K }> | undefined {
  return ctx.fields.find((field) => field.fieldKey === fieldKey) as Extract<ExtractedFieldProposal, { fieldKey: K }> | undefined;
}
