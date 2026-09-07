/**
 * The schemas the three tools register (TECHNICAL-DESIGN §4.3 MCP mapping, §4.7).
 *
 * A tool schema is a promise to every agent that reads it, so it is checked the way the
 * published files are: it must compile on its own, resolve every reference without a
 * network fetch, and accept the fixtures that are published as examples of what the tools
 * return. The registered input schemas belong to T-008 and its generator test; what is new
 * here is the `outputSchema`, which is the published outcome schema with the spec schema
 * bundled into it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { AnySchemaObject, ValidateFunction } from 'ajv';
import { describe, expect, it } from 'vitest';

import { TOOL_INPUT_SCHEMAS, TOOL_NAMES } from '../../src/mcp/generated/contract';
import { OUTCOME_OUTPUT_SCHEMA, RUNBOOKS_OUTPUT_SCHEMA } from '../../src/mcp/outcome';
import { toolDefinitions } from '../../src/mcp/server';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO, path), 'utf8')) as Record<string, unknown>;
}

const outcomeFile = readJson('schemas/handoff-outcome.v1.schema.json');
const specFile = readJson('schemas/handoff-spec.v1.schema.json');

const OUTCOMES_DIR = join(REPO, 'fixtures/outcomes');
const outcomeFixtures = readdirSync(OUTCOMES_DIR).filter((name) => name.endsWith('.json'));

/**
 * A fresh validator per schema, `strict` so a keyword that resolves to nothing is a
 * failure here rather than a surprise in whichever client compiles it, and `ajv-formats`
 * because the outcome schema dates its fields with `date-time`.
 */
function compile(schema: unknown): ValidateFunction {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema as AnySchemaObject);
}

describe('the registered output schemas', () => {
  it('compile on their own, with every reference resolved inside the document', () => {
    expect(() => compile(OUTCOME_OUTPUT_SCHEMA)).not.toThrow();
    expect(() => compile(RUNBOOKS_OUTPUT_SCHEMA)).not.toThrow();
  });

  it('accept every published outcome fixture', () => {
    const validate = compile(OUTCOME_OUTPUT_SCHEMA);
    expect(outcomeFixtures.length).toBe(14);
    for (const name of outcomeFixtures) {
      const fixture = JSON.parse(readFileSync(join(OUTCOMES_DIR, name), 'utf8')) as unknown;
      expect(validate(fixture), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it('accept the runbook search result, draft specs and all', () => {
    const validate = compile(RUNBOOKS_OUTPUT_SCHEMA);
    const match = readJson('fixtures/outcomes/runbook-match.json');
    const answer = { runbooks: match['runbooks'] };
    expect(validate(answer), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ runbooks: [] })).toBe(true);
    expect(validate({})).toBe(false);
    expect(validate({ runbooks: [], extra: 1 })).toBe(false);
  });

  it('are the published outcome schema plus the bundled spec schema, and nothing else', () => {
    const { $defs: bundledDefs, ...bundledBody } = OUTCOME_OUTPUT_SCHEMA as {
      $defs: Record<string, unknown>;
    } & Record<string, unknown>;
    const { $defs: publishedDefs, ...publishedBody } = outcomeFile as {
      $defs: Record<string, unknown>;
    } & Record<string, unknown>;

    expect(bundledBody).toEqual(publishedBody);
    const added = Object.keys(bundledDefs).filter((name) => !(name in publishedDefs));
    expect(added).toEqual(['handoff_spec_v1']);
    for (const name of Object.keys(publishedDefs)) {
      expect(bundledDefs[name]).toEqual(publishedDefs[name]);
    }
    expect(bundledDefs['handoff_spec_v1']).toEqual(specFile);
  });

  it('resolve the draft_spec reference to the embedded copy, not to a URL', () => {
    // The published schema points `draft_spec` at the sibling file by its absolute `$id`.
    // Compiling it alone must fail; compiling the bundle must not. If that ever stops
    // being true the bundling has become decoration.
    const draftSpecRef = (
      (
        (outcomeFile['$defs'] as Record<string, Record<string, Record<string, unknown>>>)[
          'runbook_match'
        ] as unknown as { properties: Record<string, { $ref?: string }> }
      ).properties['draft_spec'] ?? {}
    ).$ref;
    expect(draftSpecRef).toBe(specFile['$id']);
    expect(() => compile(outcomeFile)).toThrow();
    expect(() => compile(OUTCOME_OUTPUT_SCHEMA)).not.toThrow();
  });
});

describe('the tool definitions', () => {
  it('declare a description, an input schema, an output schema and annotations for each tool', () => {
    const tools = toolDefinitions();
    expect(tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(0);
      expect(tool.inputSchema).toEqual(
        TOOL_INPUT_SCHEMAS[tool.name as (typeof TOOL_NAMES)[number]],
      );
      expect(tool.outputSchema).toBeDefined();
      expect(tool.annotations?.title?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('registers input schemas that carry no reference to a file (T-008 inlines them)', () => {
    const externalRefs = (node: unknown): string[] => {
      if (Array.isArray(node)) return node.flatMap(externalRefs);
      if (typeof node !== 'object' || node === null) return [];
      const entries = Object.entries(node as Record<string, unknown>);
      const here = entries
        .filter(([key, value]) => key === '$ref' && typeof value === 'string')
        .map(([, value]) => value as string)
        .filter((ref) => !ref.startsWith('#'));
      return [...here, ...entries.flatMap(([, value]) => externalRefs(value))];
    };
    for (const name of TOOL_NAMES) {
      expect(externalRefs(TOOL_INPUT_SCHEMAS[name])).toEqual([]);
    }
  });
});
