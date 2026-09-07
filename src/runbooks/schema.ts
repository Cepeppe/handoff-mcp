/**
 * The runbook schema, compiled (TECHNICAL-DESIGN §4.5, §5.10).
 *
 * `schemas/handoff-runbook.v1.schema.json` is bundled into the executable rather than read
 * from disk, for the same reason as the spec schema and the pattern file: the single-file
 * build has no package directory to read from at run time.
 *
 * Unlike the spec schema this one uses `format: date-time`, so `ajv-formats` is registered:
 * without it a date field would be accepted as any string and a runbook with a nonsense
 * `last_verified_at` would take part in the ranking (§4.5.3) with an unusable key.
 *
 * `allErrors` is off on purpose. A file that fails is skipped with one warning naming it
 * (FM-19), never repaired and never reported to the agent, so the first problem is the
 * whole of what the warning can usefully say.
 */
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { AnySchemaObject, ValidateFunction } from 'ajv';

import runbookSchema from '../../schemas/handoff-runbook.v1.schema.json';

const ajv = new Ajv2020({ strict: true, allErrors: false });
addFormats(ajv);

/** Validates a whole runbook document. */
export const validateRunbookSchema: ValidateFunction = ajv.compile(
  runbookSchema as AnySchemaObject,
);

/**
 * The highest `runbook_version` this server understands.
 *
 * The version check runs before the schema, so a file written by a newer app is skipped
 * with "written by a newer version" instead of a list of unknown fields (§5.10).
 */
export const SUPPORTED_RUNBOOK_VERSION: number = runbookSchema.properties.runbook_version.const;
