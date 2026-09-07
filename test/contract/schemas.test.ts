/**
 * Contract test for the three public schemas (TECHNICAL-DESIGN §4.2, §4.3, §4.5).
 *
 * The fixtures are the contract: every later implementation, in TypeScript here and in
 * Rust in the app, must accept and reject exactly the same files. Semantic rules that a
 * schema cannot express (S2-S6, §4.2) are marked `"schema_valid": true` in the expected
 * file and are only asserted to be schema-valid here; the rule itself is asserted by the
 * validation pipeline.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCHEMAS = join(ROOT, 'schemas');
const FIXTURES = join(ROOT, 'fixtures');

const SCHEMA_BASE = 'https://raw.githubusercontent.com/Cepeppe/handoff-mcp/main/schemas/';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/** Fixture files, without the `.expected.json` companions. */
function fixtureFiles(dir: string): string[] {
  return readdirSync(join(FIXTURES, dir))
    .filter((name) => name.endsWith('.json') && !name.endsWith('.expected.json'))
    .sort();
}

function explain(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`).join('; ');
}

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const file of ['handoff-spec', 'handoff-outcome', 'handoff-runbook']) {
  ajv.addSchema(readJson(join(SCHEMAS, `${file}.v1.schema.json`)) as AnySchema);
}

function compiled(name: string): ValidateFunction {
  const validate = ajv.getSchema(`${SCHEMA_BASE}${name}.v1.schema.json`);
  if (!validate) throw new Error(`schema not registered: ${name}`);
  return validate;
}

const validateSpec = compiled('handoff-spec');
const validateOutcome = compiled('handoff-outcome');
const validateRunbook = compiled('handoff-runbook');

/** What an invalid spec fixture must make a validator report (T-013 asserts the exact path). */
interface ExpectedProblem {
  path: string;
  code: 'SPEC_INVALID' | 'SPEC_VERSION_UNSUPPORTED';
  schema_valid?: boolean;
}

interface MutableSpec {
  spec_version: number;
  goal: string;
  where: string;
  url?: string;
  why_human: string;
  values: Record<string, string | string[]>;
  secrets?: Record<string, string>;
  steps: { text: string; url?: string; values?: string[]; warning?: string }[];
  verify?: string;
  lang?: string;
}

const baseSpec = (): MutableSpec => ({
  spec_version: 1,
  goal: 'Register the Stripe webhook for payment events',
  where: 'Stripe Dashboard → Developers → Webhooks',
  why_human: 'Requires access to the production Stripe account.',
  values: {},
  steps: [{ text: 'Click Add destination and paste the endpoint URL.' }],
});

/** A string of exactly n characters. */
const str = (n: number): string => 'x'.repeat(n);

describe('schemas', () => {
  it.each(['handoff-spec', 'handoff-outcome', 'handoff-runbook'])(
    '%s.v1 is a 2020-12 schema with a stable $id',
    (name) => {
      const schema = readJson(join(SCHEMAS, `${name}.v1.schema.json`)) as {
        $schema: string;
        $id: string;
      };
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(schema.$id).toBe(`${SCHEMA_BASE}${name}.v1.schema.json`);
    },
  );

  it('compiles all three in ajv strict mode', () => {
    for (const validate of [validateSpec, validateOutcome, validateRunbook]) {
      expect(typeof validate).toBe('function');
    }
  });
});

describe('spec fixtures', () => {
  const valid = fixtureFiles('specs/valid');
  const invalid = fixtureFiles('specs/invalid');

  it('ships at least 8 valid and 16 invalid specs', () => {
    expect(valid.length).toBeGreaterThanOrEqual(8);
    expect(invalid.length).toBeGreaterThanOrEqual(16);
  });

  it.each(valid)('accepts %s', (name) => {
    const ok = validateSpec(readJson(join(FIXTURES, 'specs/valid', name)));
    expect(explain(validateSpec.errors)).toBe('');
    expect(ok).toBe(true);
  });

  it.each(invalid)('rejects %s', (name) => {
    const expected = readJson(
      join(FIXTURES, 'specs/invalid', name.replace(/\.json$/, '.expected.json')),
    ) as ExpectedProblem;

    expect(expected.path.length).toBeGreaterThan(0);
    expect(['SPEC_INVALID', 'SPEC_VERSION_UNSUPPORTED']).toContain(expected.code);

    const ok = validateSpec(readJson(join(FIXTURES, 'specs/invalid', name)));
    if (expected.schema_valid === true) {
      // A semantic rule catches this one; the schema alone must still accept it.
      expect(explain(validateSpec.errors)).toBe('');
      expect(ok).toBe(true);
    } else {
      expect(ok).toBe(false);
    }
  });

  it.each(invalid)('reports %s at the expected path', (name) => {
    const expected = readJson(
      join(FIXTURES, 'specs/invalid', name.replace(/\.json$/, '.expected.json')),
    ) as ExpectedProblem;
    if (expected.schema_valid === true) return;

    validateSpec(readJson(join(FIXTURES, 'specs/invalid', name)));
    // The expected path is a display path (§4.7.5); as a JSON pointer it must be one of
    // the places ajv reported, so that T-013 can translate ajv errors into it.
    const pointer = `/${expected.path.replaceAll('[', '.').replaceAll(']', '').split('.').join('/')}`;
    const reported = (validateSpec.errors ?? []).flatMap((e) => {
      // ajv points at the containing object for a missing or unknown field; the display
      // path names the field itself.
      const params = e.params as { additionalProperty?: string; missingProperty?: string };
      const named = params.additionalProperty ?? params.missingProperty;
      return named === undefined
        ? [e.instancePath]
        : [e.instancePath, `${e.instancePath}/${named}`];
    });
    expect(reported).toContain(pointer);
  });

  it('covers both error codes and every semantic rule that needs a schema-valid fixture', () => {
    const expectations = invalid.map(
      (name) =>
        readJson(
          join(FIXTURES, 'specs/invalid', name.replace(/\.json$/, '.expected.json')),
        ) as ExpectedProblem,
    );
    expect(expectations.filter((e) => e.code === 'SPEC_VERSION_UNSUPPORTED')).toHaveLength(1);
    expect(expectations.filter((e) => e.schema_valid === true).length).toBeGreaterThanOrEqual(4);
  });
});

describe('spec limits', () => {
  it.each<[string, (spec: MutableSpec) => void]>([
    ['goal of 300 characters', (s) => (s.goal = str(300))],
    ['where of 300 characters', (s) => (s.where = str(300))],
    ['why_human of 1000 characters', (s) => (s.why_human = str(1000))],
    ['url of 2048 characters', (s) => (s.url = `https://example.com/${str(2028)}`)],
    ['verify of 4000 characters', (s) => (s.verify = str(4000))],
    ['a regional language tag', (s) => (s.lang = 'pt-BR')],
    [
      '50 values',
      (s) => {
        for (let i = 1; i <= 50; i += 1) s.values[`value_${String(i)}`] = 'v';
      },
    ],
    ['a value name of 64 characters', (s) => (s.values[`v${str(63)}`] = 'v')],
    ['a value of 4096 characters', (s) => (s.values['endpoint_url'] = str(4096))],
    [
      'a list of 100 values',
      (s) => (s.values['events'] = Array.from({ length: 100 }, (_, i) => `event.${String(i)}`)),
    ],
    ['a list item of 4096 characters', (s) => (s.values['events'] = [str(4096)])],
    [
      '20 secrets',
      (s) => {
        s.secrets = {};
        for (let i = 1; i <= 20; i += 1) s.secrets[`SECRET_${String(i)}`] = '.env';
      },
    ],
    ['a secret name of 128 characters', (s) => (s.secrets = { [str(128)]: '.env' })],
    ['a secret destination of 1024 characters', (s) => (s.secrets = { TOKEN: str(1024) })],
    [
      '50 steps',
      (s) => (s.steps = Array.from({ length: 50 }, (_, i) => ({ text: `Step ${String(i)}.` }))),
    ],
    ['a step text of 2000 characters', (s) => (s.steps[0] = { text: str(2000) })],
    [
      'a step warning of 300 characters',
      (s) => (s.steps[0] = { text: 'Delete the record.', warning: str(300) }),
    ],
    [
      '20 keys in a step',
      (s) => {
        const names = Array.from({ length: 20 }, (_, i) => `value_${String(i)}`);
        for (const name of names) s.values[name] = 'v';
        s.steps[0] = { text: 'Fill the form.', values: names };
      },
    ],
    ['an empty value, as a draft spec has', (s) => (s.values['endpoint_url'] = '')],
  ])('accepts %s', (_label, mutate) => {
    const spec = baseSpec();
    mutate(spec);
    const ok = validateSpec(spec);
    expect(explain(validateSpec.errors)).toBe('');
    expect(ok).toBe(true);
  });
});

describe('outcome fixtures', () => {
  const files = fixtureFiles('outcomes');

  it('ships one outcome per status', () => {
    const schema = readJson(join(SCHEMAS, 'handoff-outcome.v1.schema.json')) as {
      properties: { status: { enum: string[] } };
    };
    const statuses = files.map(
      (name) => (readJson(join(FIXTURES, 'outcomes', name)) as { status: string }).status,
    );
    expect(schema.properties.status.enum).toHaveLength(14);
    expect([...statuses].sort()).toEqual([...schema.properties.status.enum].sort());
  });

  it.each(files)('accepts %s', (name) => {
    const ok = validateOutcome(readJson(join(FIXTURES, 'outcomes', name)));
    expect(explain(validateOutcome.errors)).toBe('');
    expect(ok).toBe(true);
  });

  it('carries a draft spec that the spec schema accepts', () => {
    const outcome = readJson(join(FIXTURES, 'outcomes', 'runbook-match.json')) as {
      runbooks: { draft_spec: unknown }[];
    };
    const draft = outcome.runbooks[0]?.draft_spec;
    const ok = validateSpec(draft);
    expect(explain(validateSpec.errors)).toBe('');
    expect(ok).toBe(true);
  });
});

describe('runbook fixtures', () => {
  const valid = fixtureFiles('runbooks/valid');
  const invalid = fixtureFiles('runbooks/invalid');

  it('ships at least 3 valid and 4 invalid runbooks', () => {
    expect(valid.length).toBeGreaterThanOrEqual(3);
    expect(invalid.length).toBeGreaterThanOrEqual(4);
  });

  it.each(valid)('accepts %s', (name) => {
    const ok = validateRunbook(readJson(join(FIXTURES, 'runbooks/valid', name)));
    expect(explain(validateRunbook.errors)).toBe('');
    expect(ok).toBe(true);
  });

  it.each(invalid)('rejects %s', (name) => {
    expect(validateRunbook(readJson(join(FIXTURES, 'runbooks/invalid', name)))).toBe(false);
  });
});
