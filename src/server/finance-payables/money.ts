// Step 15C: deterministic, minor-unit-safe money math for the proration + tax calculation.
//
// EVERY function here operates on integers only (minor units and integer counts / basis points).
// No IEEE-754 float ever touches a money amount - all division is done in BigInt so the same
// input always produces the same output on every runtime, forever. That is what "deterministic
// rounding" means in this module: not just "a rule is documented", but "float non-determinism is
// structurally impossible".
//
// THE ROUNDING RULE (applies to every function below): HALF-UP, ties away from zero. For a
// non-negative numerator and a positive denominator this is the ordinary "round half up" a Finance
// reader expects (0.5 minor units rounds up, not to even). Proration and tax bases in this module
// are always non-negative, so "ties away from zero" and "ties up" coincide; there is no negative
// input path to disambiguate.
//
// Both helpers are pure integer division dressed up as float-free rounding:
//   roundedDiv(n, d)        = floor((n + d/2) / d), computed without ever forming n/d as a float.
//   percentBpsOfMinor(a, r) = roundedDiv(a * r, 10_000)

// Half-up integer division of two non-negative BigInts. `denominator` must be > 0.
// (BigInt literals like `0n` need an ES2020+ compile target; this repo targets ES2017, so every
// BigInt is constructed with BigInt(...) instead - functionally identical, just target-portable.)
const ZERO = BigInt(0);
const TWO = BigInt(2);

function roundedDivBigInt(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= ZERO) throw new Error("roundedDivBigInt: denominator must be positive.");
  if (numerator < ZERO) throw new Error("roundedDivBigInt: numerator must be non-negative.");
  // floor((numerator + denominator/2) / denominator), entirely in integer arithmetic: scale by 2
  // first so "denominator/2" never truncates a fraction away.
  return (numerator * TWO + denominator) / (denominator * TWO);
}

// The canonical monthly-analytics proration (Step 15C section 4):
//   basePayable = fixedAmountMinor / requiredCount * cappedActualCount
// computed as ONE integer division (fixedAmountMinor * cappedActualCount / requiredCount) so a
// single half-up rounding step applies to the whole formula, never two compounding roundings.
// `requiredCount` must be a positive integer; `cappedActualCount` must be a non-negative integer
// no greater than `requiredCount` (the caller applies the cap - section 5 - before calling this).
export function prorateMinor(fixedAmountMinor: number, cappedActualCount: number, requiredCount: number): number {
  if (!Number.isInteger(fixedAmountMinor) || fixedAmountMinor < 0) throw new Error("prorateMinor: fixedAmountMinor must be a non-negative integer.");
  if (!Number.isInteger(requiredCount) || requiredCount <= 0) throw new Error("prorateMinor: requiredCount must be a positive integer.");
  if (!Number.isInteger(cappedActualCount) || cappedActualCount < 0 || cappedActualCount > requiredCount) {
    throw new Error("prorateMinor: cappedActualCount must be a non-negative integer no greater than requiredCount.");
  }
  const result = roundedDivBigInt(BigInt(fixedAmountMinor) * BigInt(cappedActualCount), BigInt(requiredCount));
  return Number(result);
}

// A tax/percentage amount from a basis in minor units and a rate in basis points (1/100 of a
// percent; 1000 bps = 10%). Half-up rounded to the nearest whole minor unit.
export function percentBpsOfMinor(basisMinor: number, rateBps: number): number {
  if (!Number.isInteger(basisMinor) || basisMinor < 0) throw new Error("percentBpsOfMinor: basisMinor must be a non-negative integer.");
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) throw new Error("percentBpsOfMinor: rateBps must be an integer in [0, 10000].");
  const result = roundedDivBigInt(BigInt(basisMinor) * BigInt(rateBps), BigInt(10_000));
  return Number(result);
}
