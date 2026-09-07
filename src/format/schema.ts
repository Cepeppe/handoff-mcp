/**
 * Schema loading and the facts derived from it (TECHNICAL-DESIGN §5.4).
 *
 * `schemas/handoff-spec.v1.schema.json` is bundled into the executable rather than read
 * from disk, for the same reason as the pattern file: the single-file build has no package
 * directory to read from at run time.
 *
 * Everything this module publishes is read *out of the schema* — the supported version, the
 * allowed field names, the URL pattern, the key rules — so that changing the schema changes
 * the messages with it and no limit is ever written twice.
 */
import Ajv2020 from 'ajv/dist/2020.js';
import type { AnySchemaObject, ValidateFunction } from 'ajv';

import specSchema from '../../schemas/handoff-spec.v1.schema.json';

/**
 * `allErrors` so that one call reports everything that is wrong (§5.4), `strict` so that a
 * mistyped keyword in the schema is a build failure rather than a silently ignored rule.
 */
const ajv = new Ajv2020({ strict: true, allErrors: true });

/** Validates a whole spec document. */
export const validateSpecSchema: ValidateFunction = ajv.compile(specSchema as AnySchemaObject);

/**
 * Validates a bare array of steps against the same `$defs/step` and the same bounds the
 * spec puts on `steps`, so replacement steps (T-020) cannot be laxer than the steps of the
 * spec they replace.
 */
export const validateStepArraySchema: ValidateFunction = ajv.compile({
  $schema: specSchema.$schema,
  type: 'array',
  minItems: specSchema.properties.steps.minItems,
  maxItems: specSchema.properties.steps.maxItems,
  items: { $ref: '#/$defs/step' },
  $defs: specSchema.$defs,
} as AnySchemaObject);

/** The highest `spec_version` this server understands (S1 compares against it). */
export const SUPPORTED_SPEC_VERSION: number = specSchema.properties.spec_version.const;

/** The pattern that closes the URL scheme list, used to recognise an S5 violation. */
export const URL_PATTERN: string = specSchema.$defs.url.pattern;

/**
 * The closed scheme list as it is written in the S5 fix text (SPEC-07, SPEC-08).
 *
 * The schema pattern above is what validates; this list is what the message says. A unit
 * test keeps the two in step, because a scheme added to one and not to the other would be
 * either unusable or invisible.
 */
export const ALLOWED_URL_SCHEMES: readonly string[] = [
  'http',
  'https',
  'ms-settings:',
  'x-apple.systempreferences:',
];

/** The pattern a key of `values` must match, used to decide what a message may echo. */
export const VALUE_NAME_PATTERN: string = specSchema.$defs.value_name.pattern;

/** Field names the spec allows at the top level, in schema order. */
export const ROOT_FIELDS: readonly string[] = Object.keys(specSchema.properties);

/** Field names a spec cannot omit. */
export const REQUIRED_ROOT_FIELDS: readonly string[] = specSchema.required;

/** Field names a step allows, in schema order. */
export const STEP_FIELDS: readonly string[] = Object.keys(specSchema.$defs.step.properties);

/** Objects that close their field list, addressed by the pointer of the object itself. */
export type ClosedObject = 'root' | 'step';

/** Which document the pointers of a validation run refer to. */
export type Document = 'spec' | 'steps';

/** Which closed object an ajv `instancePath` points at, or null when it points elsewhere. */
export function closedObjectAt(instancePath: string, document: Document): ClosedObject | null {
  if (document === 'steps') return /^\/(?:0|[1-9][0-9]*)$/.test(instancePath) ? 'step' : null;
  if (instancePath === '') return 'root';
  return /^\/steps\/(?:0|[1-9][0-9]*)$/.test(instancePath) ? 'step' : null;
}

/** The field names allowed inside that object. */
export function allowedFields(object: ClosedObject): readonly string[] {
  return object === 'root' ? ROOT_FIELDS : STEP_FIELDS;
}

/**
 * How the keys of an open map are constrained, phrased for a fix text.
 *
 * `values` and `secrets` are the two objects whose keys the user names; the rule comes from
 * their `propertyNames` subschema.
 */
export function describeKeyRule(mapName: string): string {
  const rules =
    mapName === 'values'
      ? `it must match the pattern ${specSchema.$defs.value_name.pattern}`
      : `it must be ${String(specSchema.properties.secrets.propertyNames.minLength)} to ${String(
          specSchema.properties.secrets.propertyNames.maxLength,
        )} characters long`;
  return `Rename the key: ${rules}.`;
}
