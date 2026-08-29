/**
 * Deterministic structural equality for JSON-compatible values.
 *
 * Object key order is ignored, array order is significant, and no coercion or
 * subset matching is performed. Own keys are compared explicitly so a missing
 * property differs from a present property (including one whose value is
 * `undefined` in an in-memory test double).
 */
export function jsonStructurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }

    return left.every((value, index) => jsonStructurallyEqual(value, right[index]));
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      jsonStructurallyEqual(leftRecord[key], rightRecord[key]),
  );
}
