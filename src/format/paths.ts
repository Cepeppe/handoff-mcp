/**
 * Display paths (TECHNICAL-DESIGN §4.7.5, `schemas/README.md`).
 *
 * A problem cites the offending location in the notation the design uses in its error
 * texts — `goal`, `steps[0].text`, `values.events[0]` — which is the JSON pointer of the
 * location written with dots and brackets, indexed from 0 like the document itself. The
 * 1-based step numbers an agent sees elsewhere are the overlay's counter, not this.
 */

/** Undoes the two escapes a JSON pointer segment can carry (RFC 6901). */
function unescapeSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

/** True for a pointer segment that indexes an array. */
function isIndex(segment: string): boolean {
  return /^(?:0|[1-9][0-9]*)$/.test(segment);
}

/**
 * Turns an ajv `instancePath` into a display path.
 *
 * `root` is prepended, so the same rules can report on a spec (root `''`, giving `goal`)
 * and on a bare step array (root `'replacement_steps'`, giving `replacement_steps[0].text`).
 */
export function displayPath(instancePath: string, root = ''): string {
  let path = root;
  for (const raw of instancePath.split('/').slice(1)) {
    path = childPath(path, isIndex(raw) ? Number(raw) : unescapeSegment(raw));
  }
  return path;
}

/** Appends one field name or one array index to a display path. */
export function childPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${String(key)}]`;
  return parent === '' ? key : `${parent}.${key}`;
}
