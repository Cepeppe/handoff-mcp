/**
 * Guards the tool contract (TECHNICAL-DESIGN §3.4, §4.7).
 *
 * `schemas/tool-contract.v1.md` is the normative source of the tool descriptions, the
 * per-status instruction texts and the error texts; `src/mcp/generated/contract.ts` is the
 * committed result of running the generator over it. The first test regenerates into a
 * temporary file and compares bytes, so a document edited without regenerating, or a
 * generated file edited by hand, fails CI. The rest assert what the generator cannot know:
 * that the contract covers every status of the outcome schema, that the texts stay usable
 * by an agent, and that the fixtures agree with them.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import type { AnySchema } from 'ajv';
import { describe, expect, it } from 'vitest';

import {
  ANNOTATIONS,
  ERROR_CODES,
  ERROR_TEXTS,
  ID_PLACEHOLDER,
  INSTRUCTIONS,
  OUTCOME_STATUSES,
  STATUS_FINAL,
  TOOL_DESCRIPTIONS,
  TOOL_INPUT_SCHEMAS,
  TOOL_NAMES,
  type ErrorCode,
  type HookVariant,
  type OutcomeStatus,
  type ToolName,
} from '../../src/mcp/generated/contract';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const GENERATOR = join(ROOT, 'build', 'gen-contract.mjs');
const GENERATED = join(ROOT, 'src', 'mcp', 'generated', 'contract.ts');
const SCHEMAS = join(ROOT, 'schemas');
const OUTCOME_FIXTURES = join(ROOT, 'fixtures', 'outcomes');

const HOOK_VARIANTS: readonly HookVariant[] = ['stop_hook', 'no_stop_hook'];
/** The two statuses whose outcome has `handoff_id: null`, so no id can be substituted. */
const WITHOUT_ID: readonly OutcomeStatus[] = ['runbook_match', 'text_mode'];
/** Keys of a standalone schema file that do not survive being inlined into another one. */
const META_KEYS = new Set(['$schema', '$id', 'title', '$defs']);

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/** Walks an unknown JSON value, failing loudly instead of returning undefined silently. */
function at(value: unknown, ...path: string[]): unknown {
  let cursor: unknown = value;
  for (const key of path) {
    if (typeof cursor !== 'object' || cursor === null) {
      throw new Error(`no "${path.join('.')}" in this schema`);
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

const outcomeSchema = readJson(join(SCHEMAS, 'handoff-outcome.v1.schema.json'));
const specSchema = readJson(join(SCHEMAS, 'handoff-spec.v1.schema.json'));
const schemaStatuses = at(outcomeSchema, 'properties', 'status', 'enum') as string[];

const outcomeFixtures = readdirSync(OUTCOME_FIXTURES)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => ({ name, outcome: readJson(join(OUTCOME_FIXTURES, name)) }));

describe('the generated contract is what the document produces', () => {
  it('regenerates byte for byte', { timeout: 30_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-contract-'));
    try {
      const out = join(dir, 'contract.ts');
      execFileSync(process.execPath, [GENERATOR, '--out', out], { stdio: 'pipe' });
      expect(readFileSync(out, 'utf8')).toBe(readFileSync(GENERATED, 'utf8'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('tools', () => {
  it('registers exactly the three tools of the contract', () => {
    expect(TOOL_NAMES).toEqual(['handoff_to_user', 'handoff_verify', 'handoff_runbooks']);
    for (const tool of TOOL_NAMES) {
      expect(TOOL_DESCRIPTIONS[tool].length).toBeGreaterThan(200);
      expect(ANNOTATIONS[tool].title).not.toBe('');
      expect(ANNOTATIONS[tool].openWorldHint).toBe(false);
    }
  });

  it('marks only the search tool read-only', () => {
    const readOnly = TOOL_NAMES.filter((tool) => ANNOTATIONS[tool].readOnlyHint);
    expect(readOnly).toEqual(['handoff_runbooks']);
  });

  it('names the seven fields of handoff_to_user in its input schema', () => {
    const properties = at(TOOL_INPUT_SCHEMAS.handoff_to_user, 'properties') as Record<
      string,
      unknown
    >;
    expect(Object.keys(properties).sort()).toEqual(
      [
        'handoff_id',
        'ignore_runbook',
        'replacement_steps',
        'reply',
        'request_id',
        'resume',
        'spec',
      ].sort(),
    );
  });

  it('inlines the spec schema instead of restating it', () => {
    const spec = at(TOOL_INPUT_SCHEMAS.handoff_to_user, 'properties', 'spec') as Record<
      string,
      unknown
    >;
    const body = Object.entries(specSchema).filter(([key]) => !META_KEYS.has(key));

    expect(Object.keys(spec).sort()).toEqual(body.map(([key]) => key).sort());
    for (const [key, value] of body) {
      // The description written next to the `$ref` deliberately wins over the file's.
      if (key !== 'description') expect(spec[key]).toEqual(value);
    }
    expect(typeof spec['description']).toBe('string');
    expect(at(TOOL_INPUT_SCHEMAS.handoff_to_user, '$defs')).toEqual(specSchema['$defs']);
  });

  it('says what TOOL-09 requires an agent to be told', () => {
    const openTool = TOOL_DESCRIPTIONS.handoff_to_user;
    expect(openTool).toContain('handoff_runbooks(where, goal)');
    expect(openTool).toContain('Never read the values listed in `secrets`');
    expect(openTool).toContain('/mcp reconnect handoff');
    expect(openTool).toContain('`resume`');
    expect(openTool).toContain('already_delivered');
    expect(openTool).toContain('text_mode');
    expect(openTool).toContain('mention the id in your final summary');

    expect(TOOL_DESCRIPTIONS.handoff_verify).toContain('Never invent a result');
    expect(TOOL_DESCRIPTIONS.handoff_runbooks).toContain('~/.handoff/runbooks/');
  });
});

describe('input schemas', () => {
  it.each<ToolName>([...TOOL_NAMES])('compiles %s with Ajv 2020 in strict mode', (tool) => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    expect(() => ajv.compile(TOOL_INPUT_SCHEMAS[tool] as AnySchema)).not.toThrow();
  });

  it('accepts every valid spec fixture through the open shape', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const validate = ajv.compile(TOOL_INPUT_SCHEMAS.handoff_to_user as AnySchema);
    const dir = join(ROOT, 'fixtures', 'specs', 'valid');
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const file of files) {
      expect(validate({ spec: readJson(join(dir, file)) }), file).toBe(true);
    }
  });

  it('rejects a control field smuggled inside the spec', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const validate = ajv.compile(TOOL_INPUT_SCHEMAS.handoff_to_user as AnySchema);
    const spec = readJson(join(ROOT, 'fixtures', 'specs', 'valid', 'minimal.json'));
    expect(validate({ spec: { ...spec, handoff_id: 'hf_7k3m9p2q4r' } })).toBe(false);
    expect(validate({ spec, unknown_control_field: true })).toBe(false);
  });
});

describe('instructions', () => {
  it('covers every status of the outcome schema, in the same order', () => {
    expect([...OUTCOME_STATUSES]).toEqual(schemaStatuses);
    expect(OUTCOME_STATUSES).toHaveLength(14);
  });

  it.each<OutcomeStatus>([...OUTCOME_STATUSES])('gives %s both hook variants', (status) => {
    for (const variant of HOOK_VARIANTS) {
      const text = INSTRUCTIONS[status][variant];
      expect(text.length).toBeGreaterThan(20);
      expect(text).not.toContain('`');
      expect(text.trim()).toBe(text);
    }
  });

  it('mentions the Stop hook only in the variant that has one', () => {
    const hookStatuses = OUTCOME_STATUSES.filter((status) =>
      INSTRUCTIONS[status].stop_hook.includes('Stop hook'),
    );
    expect(hookStatuses).toEqual(['deferred', 'parked']);
    for (const status of hookStatuses) {
      expect(INSTRUCTIONS[status].no_stop_hook).not.toContain('Stop hook');
      expect(INSTRUCTIONS[status].no_stop_hook).toContain('Nothing will remind you');
    }
    for (const status of OUTCOME_STATUSES.filter((s) => !hookStatuses.includes(s))) {
      expect(INSTRUCTIONS[status].stop_hook).toBe(INSTRUCTIONS[status].no_stop_hook);
    }
  });

  it('places the id placeholder exactly where an id exists', () => {
    for (const status of OUTCOME_STATUSES) {
      for (const variant of HOOK_VARIANTS) {
        const text = INSTRUCTIONS[status][variant];
        expect(text.includes(ID_PLACEHOLDER), `${status}/${variant}`).toBe(
          !WITHOUT_ID.includes(status),
        );
      }
    }
  });

  it('marks the five final states', () => {
    const final = OUTCOME_STATUSES.filter((status) => STATUS_FINAL[status]);
    expect(final).toEqual(['confirmed_by_user', 'verified', 'failed', 'not_verified', 'abandoned']);
  });
});

describe('outcome fixtures agree with the contract', () => {
  it('has one fixture per status', () => {
    expect(outcomeFixtures.map(({ outcome }) => outcome['status']).sort()).toEqual(
      [...OUTCOME_STATUSES].sort(),
    );
  });

  it.each(outcomeFixtures.map(({ name }) => name))(
    '%s carries a generated instruction and the right final flag',
    (name) => {
      const fixture = outcomeFixtures.find((entry) => entry.name === name);
      if (!fixture) throw new Error(`no fixture ${name}`);
      const status = fixture.outcome['status'] as OutcomeStatus;
      const id = fixture.outcome['handoff_id'];

      expect(fixture.outcome['final']).toBe(STATUS_FINAL[status]);
      const expected = HOOK_VARIANTS.map((variant) =>
        typeof id === 'string'
          ? INSTRUCTIONS[status][variant].replaceAll(ID_PLACEHOLDER, id)
          : INSTRUCTIONS[status][variant],
      );
      expect(expected).toContain(fixture.outcome['instruction']);
      expect(fixture.outcome['instruction']).not.toContain(ID_PLACEHOLDER);
    },
  );
});

describe('error catalogue', () => {
  it('lists the twelve codes of the design', () => {
    expect([...ERROR_CODES]).toEqual([
      'SPEC_INVALID',
      'SPEC_VERSION_UNSUPPORTED',
      'SHAPE_AMBIGUOUS',
      'HANDOFF_NOT_FOUND',
      'HANDOFF_NOT_WAITING',
      'HANDOFF_FINAL',
      'NO_VERIFY_IN_SPEC',
      'APP_DISCONNECTED',
      'CHANNEL_AUTH_FAILED',
      'PROTOCOL_MISMATCH',
      'RUNBOOKS_UNREADABLE',
      'INTERNAL',
    ]);
  });

  it.each<ErrorCode>([...ERROR_CODES])('gives %s a message', (code) => {
    const entry = ERROR_TEXTS[code];
    expect(entry.message.length).toBeGreaterThan(10);
    expect(entry.message).not.toContain('`');
    expect(entry.fix === null || entry.fix.length > 10).toBe(true);
  });

  it('leaves the fix per problem only for SPEC_INVALID', () => {
    const perProblem = ERROR_CODES.filter((code) => ERROR_TEXTS[code].fix === null);
    expect(perProblem).toEqual(['SPEC_INVALID']);
  });
});
