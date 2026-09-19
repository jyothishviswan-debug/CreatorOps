// Step 12C.1: the one shared, dependency-free http(s) URL check - pure, so
// both the trusted server schema (createAssignment's resourceLinks) and the
// browser dialog's own client-side pre-check use exactly the same rule and
// can never drift apart. Deliberately strict: an absolute http:// or
// https:// URL with a real host and no whitespace anywhere in it. Anything
// else (javascript:, data:, file:, relative paths, bare hosts) is rejected.
export function isHttpUrl(value: string): boolean {
  if (value.length === 0 || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}
