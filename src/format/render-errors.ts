/**
 * Translation of ajv errors into the problems of the error catalogue (§4.7.5, §5.4).
 *
 * ajv says what a validator noticed; an agent needs what to change. Every keyword the spec
 * schema uses is translated here into a `{ path, problem, fix }` written in the display
 * notation of the design, for example `additionalProperties` into "Unknown field `X` at
 * `steps[1]`. Allowed fields: text, url, values, warning."
 *
 * Two groups of ajv errors describe one mistake and are collapsed first, otherwise a single
 * wrong value would come back as three problems:
 *
 * - `propertyNames`: ajv reports the failure of the name subschema *and* the keyword. Only
 *   the keyword survives, since at an object path a string keyword can only come from a
 *   property name.
 * - `anyOf`: ajv reports every branch. The branches whose type did not match are dropped,
 *   which leaves the errors of the branch the author clearly meant; when no branch matched
 *   the type, only the `anyOf` error survives.
 *
 * The limits and field lists quoted in the texts come from ajv's own parameters and from
 * the schema, never from a constant retyped here.
 */
import type { ErrorObject } from 'ajv';

import type { Problem } from './errors';
import { childPath, displayPath } from './paths';
import {
  allowedFields,
  closedObjectAt,
  describeKeyRule,
  URL_PATTERN,
  type ClosedObject,
  type Document,
} from './schema';
import {
  CONTROL_FIELDS,
  controlFieldProblem,
  emptyFieldProblem,
  urlSchemeProblem,
} from './semantic';

/** String keywords that, at the path of an object, can only come from a property name. */
const PROPERTY_NAME_KEYWORDS = new Set(['type', 'maxLength', 'minLength', 'pattern', 'format']);

function param(error: ErrorObject, name: string): unknown {
  return (error.params as Record<string, unknown>)[name];
}

function numberParam(error: ErrorObject, name: string): number {
  const value = param(error, name);
  return typeof value === 'number' ? value : 0;
}

function stringParam(error: ErrorObject, name: string): string {
  const value = param(error, name);
  return typeof value === 'string' ? value : '';
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** The value the pointer addresses, or undefined when the document has nothing there. */
function valueAt(data: unknown, instancePath: string): unknown {
  let current = data;
  for (const raw of instancePath.split('/').slice(1)) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      current = (current as readonly unknown[])[Number(key)];
      continue;
    }
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Drops the property-name failures that a `propertyNames` error already summarises. */
function collapsePropertyNames(errors: readonly ErrorObject[]): ErrorObject[] {
  const anchors = new Set(
    errors.filter((e) => e.keyword === 'propertyNames').map((e) => e.instancePath),
  );
  if (anchors.size === 0) return [...errors];
  return errors.filter(
    (e) =>
      e.keyword === 'propertyNames' ||
      !anchors.has(e.instancePath) ||
      !PROPERTY_NAME_KEYWORDS.has(e.keyword),
  );
}

/** True when the error was raised inside `anyOf` at that instance location. */
function belongsTo(error: ErrorObject, anyOf: ErrorObject): boolean {
  return (
    error.schemaPath.startsWith(`${anyOf.schemaPath}/`) &&
    (error.instancePath === anyOf.instancePath ||
      error.instancePath.startsWith(`${anyOf.instancePath}/`))
  );
}

/** Keeps only the branch of an `anyOf` whose type matched, or the `anyOf` error alone. */
function collapseAnyOf(errors: readonly ErrorObject[]): ErrorObject[] {
  let kept = [...errors];
  for (const anyOf of errors.filter((e) => e.keyword === 'anyOf')) {
    const branchErrors = kept.filter((e) => belongsTo(e, anyOf));
    if (branchErrors.length === 0) continue;

    const branches = new Map<string, ErrorObject[]>();
    for (const error of branchErrors) {
      const branch = error.schemaPath.slice(anyOf.schemaPath.length + 1).split('/')[0] ?? '';
      const bucket = branches.get(branch);
      if (bucket === undefined) branches.set(branch, [error]);
      else bucket.push(error);
    }

    const survivors = new Set(
      [...branches.values()]
        .filter(
          (bucket) =>
            !bucket.some((e) => e.keyword === 'type' && e.instancePath === anyOf.instancePath),
        )
        .flat(),
    );
    const dropAnyOf = survivors.size > 0;
    kept = kept.filter((e) =>
      e === anyOf ? !dropAnyOf : !branchErrors.includes(e) || survivors.has(e),
    );
  }
  return kept;
}

/** How a message names the object a field belongs to. */
function containerLabel(path: string): string {
  return path === '' ? 'the top level' : `\`${path}\``;
}

function unknownFieldProblem(
  container: string,
  field: string,
  object: ClosedObject | null,
): Problem {
  const label = containerLabel(container);
  const allowed = object === null ? '' : ` Allowed fields: ${allowedFields(object).join(', ')}.`;
  return {
    path: childPath(container, field),
    problem: `\`${field}\` is not a field of the format.`,
    fix: `Unknown field \`${field}\` at ${label}.${allowed}`,
  };
}

function requiredProblem(container: string, field: string): Problem {
  const label = containerLabel(container);
  return {
    path: childPath(container, field),
    problem: `Required field \`${field}\` is missing at ${label}.`,
    fix: `Add \`${field}\` at ${label}.`,
  };
}

function typeProblem(path: string, error: ErrorObject, object: ClosedObject | null): Problem {
  const expected = stringParam(error, 'type');
  if (object !== null) {
    return {
      path,
      problem: `\`${path}\` must be an object.`,
      fix:
        object === 'step'
          ? `A step is an object with these fields: ${allowedFields(object).join(', ')}.`
          : `Send an object with these fields: ${allowedFields(object).join(', ')}.`,
    };
  }
  return {
    path,
    problem: `\`${path}\` must be of type ${expected}.`,
    fix: `Send a value of type ${expected}.`,
  };
}

/** One ajv error, translated. `data` is the document, needed to name a rejected scheme. */
function toProblem(error: ErrorObject, data: unknown, options: Required<RenderOptions>): Problem {
  const path = displayPath(error.instancePath, options.root);
  const object = closedObjectAt(error.instancePath, options.document);

  switch (error.keyword) {
    case 'additionalProperties': {
      const field = stringParam(error, 'additionalProperty');
      // A control field inside the spec is S2, not an ordinary unknown field: the agent put
      // it in the wrong place rather than inventing it.
      if (object === 'root' && CONTROL_FIELDS.includes(field)) {
        return controlFieldProblem(field);
      }
      return unknownFieldProblem(path, field, object);
    }

    case 'required':
      return requiredProblem(path, stringParam(error, 'missingProperty'));

    case 'maxLength': {
      const limit = numberParam(error, 'limit');
      return {
        path,
        problem: `\`${path}\` is longer than ${plural(limit, 'character')}.`,
        fix: `Shorten it to at most ${plural(limit, 'character')}.`,
      };
    }

    // minLength is 1 everywhere in this schema, so it is the empty string and nothing else:
    // the same mistake S6 catches once the string is trimmed, and the same sentence.
    case 'minLength':
      return emptyFieldProblem(path);

    case 'maxItems': {
      const limit = numberParam(error, 'limit');
      return {
        path,
        problem: `\`${path}\` has more than ${plural(limit, 'item')}.`,
        fix: `Keep at most ${plural(limit, 'item')}.`,
      };
    }

    case 'minItems': {
      const limit = numberParam(error, 'limit');
      return {
        path,
        problem: `\`${path}\` has fewer than ${plural(limit, 'item')}.`,
        fix: `Provide at least ${plural(limit, 'item')}, or omit the field when it is optional.`,
      };
    }

    case 'maxProperties': {
      const limit = numberParam(error, 'limit');
      return {
        path,
        problem: `\`${path}\` has more than ${plural(limit, 'key')}.`,
        fix: `Keep at most ${plural(limit, 'key')}.`,
      };
    }

    case 'propertyNames': {
      const name = stringParam(error, 'propertyName');
      return {
        path,
        problem: `\`${name}\` is not a valid key of ${path}.`,
        fix: describeKeyRule(path),
      };
    }

    case 'pattern': {
      const pattern = stringParam(error, 'pattern');
      // The only pattern that closes a list rather than describing a shape is the URL one,
      // and the design gives its message: S5.
      if (pattern === URL_PATTERN) {
        const url = valueAt(data, error.instancePath);
        return urlSchemeProblem(path, typeof url === 'string' ? url : '');
      }
      return {
        path,
        problem: `\`${path}\` does not have the expected shape.`,
        fix: `It must match the pattern ${pattern}.`,
      };
    }

    case 'type':
      return typeProblem(path, error, object);

    case 'const': {
      const allowed = JSON.stringify(param(error, 'allowedValue'));
      return {
        path,
        problem: `\`${path}\` must be ${allowed}.`,
        fix: `Set ${path} to ${allowed}.`,
      };
    }

    // `$defs/value` is the only anyOf of the schema: a value is a string or a list of them.
    case 'anyOf':
      return {
        path,
        problem: `\`${path}\` does not have one of the allowed shapes.`,
        fix: 'A value is a string, or a list of strings.',
      };

    default:
      return {
        path,
        problem: error.message ?? 'The value does not match the schema.',
        fix: 'Correct the field so that it matches the published schema.',
      };
  }
}

/** Where the validated document sits, when it is not a whole spec. */
export interface RenderOptions {
  /**
   * Prefixed to every path, so the steps of a continue call are reported where the agent
   * sent them (`replacement_steps[0].text`) rather than where the schema saw them.
   */
  readonly root?: string;
  /** Which document the pointers address; a bare step array is not a spec. */
  readonly document?: Document;
}

/** Every ajv error of one validation, as problems. */
export function renderAjvErrors(
  errors: readonly ErrorObject[],
  data: unknown,
  options: RenderOptions = {},
): Problem[] {
  const resolved: Required<RenderOptions> = {
    root: options.root ?? '',
    document: options.document ?? 'spec',
  };
  return collapseAnyOf(collapsePropertyNames(errors)).map((error) =>
    toProblem(error, data, resolved),
  );
}
