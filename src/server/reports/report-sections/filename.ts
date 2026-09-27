// Reports Final-Master (spec sections 2/18/19/24): safe, deterministic artifact filenames. Never
// derived from user-supplied free text (a report title/template id/version/format are all
// server-controlled constants) - so a filename can never carry a path separator, a restricted
// value, or anything that needs sanitizing at download time.
import type { ReportArtifactFormat } from "../types";

const FILE_EXTENSION_BY_FORMAT: Record<ReportArtifactFormat, string> = { pdf: "pdf", xlsx: "xlsx", csv: "csv" };
const SAFE_FILENAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,120}\.(pdf|xlsx|csv)$/;

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function buildSafeArtifactFilename(params: { templateTitle: string; version: number; format: ReportArtifactFormat }): string {
  const slug = slugify(params.templateTitle) || "report";
  const filename = `${slug}-v${params.version}.${FILE_EXTENSION_BY_FORMAT[params.format]}`;
  if (!SAFE_FILENAME_PATTERN.test(filename)) {
    // Defensive fallback - should be unreachable given the slugify() bound above, but never emit an
    // unvalidated filename.
    return `report-v${params.version}.${FILE_EXTENSION_BY_FORMAT[params.format]}`;
  }
  return filename;
}

export function isSafeArtifactFilename(filename: string): boolean {
  return SAFE_FILENAME_PATTERN.test(filename);
}
