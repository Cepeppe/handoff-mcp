/**
 * The schema check the fake app applies to every line it receives (TECHNICAL-DESIGN §6.3).
 *
 * The app "validates every incoming message against `channel.v1.schema.json`; violations
 * close the connection". That sentence is the reason this double exists at all: a server
 * that quietly sends a field the schema does not declare would be served by a permissive
 * fake and refused by the real app, and the defect would only surface in T-042.
 *
 * The validator is built exactly as `test/contract/channel.test.ts` builds it — the three
 * public schemas registered first, so the relative `$ref`s of the channel schema resolve
 * against their `$id`s without fetching anything — and it is memoised, because compiling
 * it costs more than every replay in this folder put together.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

/** The repository root, from this file. Every path below is relative to it. */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** `fixtures/channel/`, the golden sequences both doubles replay (§11.3). */
export const GOLDEN_DIR = join(REPO_ROOT, 'fixtures', 'channel');

const CHANNEL_SCHEMA_PATH = join(REPO_ROOT, 'protocol', 'channel', 'channel.v1.schema.json');

const BASE = 'https://raw.githubusercontent.com/Cepeppe/handoff-mcp/main/';

/** The `$id` of the channel schema, which is how ajv is asked for it back. */
export const CHANNEL_SCHEMA_ID = `${BASE}protocol/channel/channel.v1.schema.json`;

/** The published schemas the channel schema references (§6.3: register all three). */
const PUBLIC_SCHEMAS = ['handoff-spec', 'handoff-outcome', 'handoff-runbook'] as const;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function compile(): ValidateFunction {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  for (const name of PUBLIC_SCHEMAS) {
    ajv.addSchema(readJson(join(REPO_ROOT, 'schemas', `${name}.v1.schema.json`)) as AnySchema);
  }
  ajv.addSchema(readJson(CHANNEL_SCHEMA_PATH) as AnySchema);
  const validate = ajv.getSchema(CHANNEL_SCHEMA_ID);
  if (validate === undefined) throw new Error(`schema not registered: ${CHANNEL_SCHEMA_ID}`);
  return validate;
}

let memoised: ValidateFunction | undefined;

/** The compiled channel schema, built once per process. */
export function channelValidator(): ValidateFunction {
  memoised ??= compile();
  return memoised;
}

function explain(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? ''}`)
    .slice(0, 6)
    .join('; ');
}

/**
 * `undefined` when the message is valid, otherwise why it is not — short enough to be the
 * reason a connection was closed and long enough to find the field.
 */
export function channelViolation(message: unknown): string | undefined {
  const validate = channelValidator();
  return validate(message) ? undefined : explain(validate.errors);
}
