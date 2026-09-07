// Generates `src/mcp/generated/contract.ts` from `schemas/tool-contract.v1.md`.
//
// The contract document is the single source of the tool descriptions, the per-status
// instruction texts and the error texts (TECHNICAL-DESIGN §3.4, §4.7). The server imports
// them from the generated module and never spells them out in code, so the published
// document and the strings an agent actually receives cannot drift.
//
// Run with `pnpm gen`; `pnpm build` runs it before bundling, and
// `test/unit/contract-gen.test.ts` regenerates into a temporary file and fails on any
// difference from the committed one.
//
// Usage: node build/gen-contract.mjs [--out <path>]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemasDir = join(repoRoot, 'schemas');
const docPath = join(schemasDir, 'tool-contract.v1.md');
const outcomeSchemaPath = join(schemasDir, 'handoff-outcome.v1.schema.json');
const defaultOutPath = join(repoRoot, 'src', 'mcp', 'generated', 'contract.ts');

/** The three tools of REQUIREMENTS §5, in the order the document presents them. */
const TOOL_NAMES = ['handoff_to_user', 'handoff_verify', 'handoff_runbooks'];
const BLOCK_KINDS = ['tool-input', 'tool-description', 'tool-annotations'];
const HOOK_VARIANTS = ['stop_hook', 'no_stop_hook'];
/** The `fix` cell that means "the validator writes one fix per problem". */
const PER_PROBLEM = '(per problem)';
/** Keys of a standalone schema file that make no sense once it is inlined into another. */
const INLINE_DROPS = new Set(['$schema', '$id', 'title', '$defs']);

class ContractError extends Error {}

function fail(message) {
  throw new ContractError(message);
}

// --------------------------------------------------------------------------- parsing

/**
 * Collects the fenced blocks whose info string is `<language> <kind> <name>`, for example
 * "json tool-input handoff_to_user". Blocks with a bare language are examples and ignored.
 */
function parseBlocks(lines) {
  const blocks = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith('```')) continue;
    const parts = lines[i].slice(3).trim().split(/\s+/).filter(Boolean);
    let end = i + 1;
    while (end < lines.length && !lines[end].startsWith('```')) end += 1;
    if (end >= lines.length) fail(`unterminated fenced block opened at line ${i + 1}`);
    if (parts.length === 3) {
      const [, kind, name] = parts;
      if (!BLOCK_KINDS.includes(kind)) fail(`unknown block kind "${kind}" at line ${i + 1}`);
      if (!TOOL_NAMES.includes(name)) fail(`unknown tool "${name}" at line ${i + 1}`);
      const key = `${kind}:${name}`;
      if (blocks.has(key)) fail(`duplicate block ${key}`);
      blocks.set(key, lines.slice(i + 1, end).join('\n'));
    }
    i = end;
  }
  return blocks;
}

function splitRow(row, lineNumber) {
  const trimmed = row.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
    fail(`line ${lineNumber} is not a table row: ${trimmed}`);
  }
  return trimmed
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * Reads the markdown table that follows `<!-- contract-table: <name> -->`. A cell holding a
 * `|` would split into an extra column, so the header check below is also what guarantees
 * that the normative texts survived the table intact.
 */
function parseTable(lines, name, header) {
  const anchor = `<!-- contract-table: ${name} -->`;
  const start = lines.findIndex((line) => line.trim() === anchor);
  if (start < 0) fail(`missing anchor ${anchor}`);

  let i = start + 1;
  while (i < lines.length && lines[i].trim() === '') i += 1;

  const got = splitRow(lines[i], i + 1);
  if (got.join('|') !== header.join('|')) {
    fail(`table "${name}" has header [${got.join(', ')}], expected [${header.join(', ')}]`);
  }
  i += 1;
  const separator = splitRow(lines[i], i + 1);
  if (!separator.every((cell) => /^:?-{3,}:?$/.test(cell))) {
    fail(`table "${name}" has no separator row under its header`);
  }

  const rows = [];
  for (i += 1; i < lines.length && lines[i].trim().startsWith('|'); i += 1) {
    const cells = splitRow(lines[i], i + 1);
    if (cells.length !== header.length) {
      fail(
        `table "${name}", line ${i + 1}: ${cells.length} cells for ${header.length} columns. ` +
          'A "|" inside a normative text is the usual cause.',
      );
    }
    rows.push(Object.fromEntries(header.map((column, n) => [column, cells[n]])));
  }
  if (rows.length === 0) fail(`table "${name}" has no rows`);
  return rows;
}

/** Normative texts are the exact bytes an agent receives: no markdown may hide in them. */
function assertRawText(where, text) {
  if (text === '') fail(`${where} is empty`);
  if (text.includes('`')) fail(`${where} contains a backtick; table cells carry no markdown`);
}

// -------------------------------------------------------------- input schema assembly

/**
 * Resolves the `$ref`s that point at a sibling schema file. The referenced schema is
 * inlined, its `$defs` are hoisted to the root of the tool input schema so that internal
 * `#/$defs/...` references keep resolving, and a `description` written next to the `$ref`
 * overrides the one the file carries.
 */
function makeResolver(loadSchema) {
  const defs = {};

  const hoist = (schema, file) => {
    for (const [name, value] of Object.entries(schema.$defs ?? {})) {
      const existing = defs[name];
      if (existing && JSON.stringify(existing) !== JSON.stringify(value)) {
        fail(`$defs/${name} of ${file} collides with a different definition already hoisted`);
      }
      defs[name] = value;
    }
  };

  const resolve = (node) => {
    if (Array.isArray(node)) return node.map(resolve);
    if (node === null || typeof node !== 'object') return node;

    const ref = node.$ref;
    if (typeof ref !== 'string' || ref.startsWith('#')) {
      return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, resolve(value)]));
    }

    const [file, pointer] = ref.split('#');
    const schema = loadSchema(file);
    hoist(schema, file);
    const siblings = Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => key !== '$ref')
        .map(([key, value]) => [key, resolve(value)]),
    );

    if (pointer) {
      const match = /^\/\$defs\/([A-Za-z0-9_]+)$/.exec(pointer);
      if (!match) fail(`unsupported pointer "${pointer}" in $ref "${ref}"`);
      if (!(match[1] in defs)) fail(`${file} has no $defs/${match[1]} for $ref "${ref}"`);
      return { $ref: `#/$defs/${match[1]}`, ...siblings };
    }

    const body = Object.fromEntries(
      Object.entries(schema).filter(([key]) => !INLINE_DROPS.has(key)),
    );
    return { ...body, ...siblings };
  };

  return { resolve, defs };
}

// -------------------------------------------------------------------------- emission

const quote = (value) => JSON.stringify(value);

function emitUnion(name, values, comment) {
  return `${comment}\nexport type ${name} =\n${values.map((v) => `  | ${quote(v)}`).join('\n')};\n`;
}

function emitRecord(name, type, entries) {
  const body = entries.map(([key, value]) => `  ${quote(key)}: ${value},`).join('\n');
  return `export const ${name}: ${type} = {\n${body}\n};\n`;
}

function buildSource({ tools, statuses, instructions, statusFinal, errors }) {
  const parts = [];

  parts.push(
    [
      '// Generated by build/gen-contract.mjs from schemas/tool-contract.v1.md.',
      '// Do not edit by hand: run `pnpm gen` (also the first step of `pnpm build`).',
      '//',
      '// The contract document is the normative source of these texts (TECHNICAL-DESIGN §4.7);',
      '// this module is how the server reads them, so the two cannot drift.',
      '',
    ].join('\n'),
  );

  parts.push(emitUnion('ToolName', TOOL_NAMES, '/** The three MCP tools the server registers. */'));
  parts.push(
    emitUnion(
      'OutcomeStatus',
      statuses,
      '/** The `status` enum of handoff-outcome.v1: final states and reasons a call returned. */',
    ),
  );
  parts.push(
    emitUnion(
      'ErrorCode',
      errors.map((e) => e.code),
      '/** The error catalogue codes. */',
    ),
  );
  parts.push(
    emitUnion(
      'HookVariant',
      HOOK_VARIANTS,
      '/** Which instruction variant a session gets, from the capability row `stop_hook`. */',
    ),
  );

  parts.push(
    [
      '/** A JSON Schema document, as registered with MCP. */',
      'export type JsonSchema = Readonly<Record<string, unknown>>;',
      '',
      '/** MCP tool annotations (only the hints the design pins down). */',
      'export interface ToolAnnotations {',
      '  readonly title: string;',
      '  readonly readOnlyHint: boolean;',
      '  readonly openWorldHint: boolean;',
      '}',
      '',
      '/** One entry of the error catalogue. */',
      'export interface ErrorText {',
      '  /** One sentence naming what went wrong; travels in `error.message`. */',
      '  readonly message: string;',
      '  /**',
      '   * What the agent should do about it; travels in `error.problems[].fix`.',
      '   * Null when the validator writes a fix per problem, as it does for SPEC_INVALID.',
      '   */',
      '  readonly fix: string | null;',
      '}',
      '',
      '/** The placeholder the server replaces with the handoff_id of the outcome. */',
      "export const ID_PLACEHOLDER = '<id>';",
      '',
    ].join('\n'),
  );

  parts.push(
    `export const TOOL_NAMES: readonly ToolName[] = [\n${TOOL_NAMES.map((n) => `  ${quote(n)},`).join('\n')}\n];\n`,
  );
  parts.push(
    `export const OUTCOME_STATUSES: readonly OutcomeStatus[] = [\n${statuses.map((s) => `  ${quote(s)},`).join('\n')}\n];\n`,
  );
  parts.push(
    `export const ERROR_CODES: readonly ErrorCode[] = [\n${errors.map((e) => `  ${quote(e.code)},`).join('\n')}\n];\n`,
  );

  parts.push(
    emitRecord(
      'TOOL_DESCRIPTIONS',
      'Readonly<Record<ToolName, string>>',
      TOOL_NAMES.map((name) => [name, quote(tools[name].description)]),
    ),
  );
  parts.push(
    emitRecord(
      'TOOL_INPUT_SCHEMAS',
      'Readonly<Record<ToolName, JsonSchema>>',
      TOOL_NAMES.map((name) => [name, JSON.stringify(tools[name].input, null, 2)]),
    ),
  );
  parts.push(
    emitRecord(
      'ANNOTATIONS',
      'Readonly<Record<ToolName, ToolAnnotations>>',
      TOOL_NAMES.map((name) => [name, JSON.stringify(tools[name].annotations, null, 2)]),
    ),
  );
  parts.push(
    emitRecord(
      'STATUS_FINAL',
      'Readonly<Record<OutcomeStatus, boolean>>',
      statuses.map((status) => [status, String(statusFinal[status])]),
    ),
  );
  parts.push(
    emitRecord(
      'INSTRUCTIONS',
      'Readonly<Record<OutcomeStatus, Readonly<Record<HookVariant, string>>>>',
      statuses.map((status) => [
        status,
        `{\n${HOOK_VARIANTS.map((v) => `    ${quote(v)}: ${quote(instructions[status][v])},`).join('\n')}\n  }`,
      ]),
    ),
  );
  parts.push(
    emitRecord(
      'ERROR_TEXTS',
      'Readonly<Record<ErrorCode, ErrorText>>',
      errors.map((entry) => [
        entry.code,
        `{ message: ${quote(entry.message)}, fix: ${entry.fix === null ? 'null' : quote(entry.fix)} }`,
      ]),
    ),
  );

  return parts.join('\n');
}

// ------------------------------------------------------------------------------ main

export async function generateContract() {
  const doc = await readFile(docPath, 'utf8');
  const lines = doc.split('\n');
  const outcomeSchema = JSON.parse(await readFile(outcomeSchemaPath, 'utf8'));
  const statuses = outcomeSchema.properties.status.enum;

  // The only schema file a tool input block may reference. Anything else is a mistake in
  // the document, not a new feature of the generator.
  const referenceable = new Map([
    [
      'handoff-spec.v1.schema.json',
      JSON.parse(await readFile(join(schemasDir, 'handoff-spec.v1.schema.json'), 'utf8')),
    ],
  ]);
  const loadSchema = (file) => referenceable.get(file) ?? fail(`refused to inline "${file}"`);

  const blocks = parseBlocks(lines);
  const tools = {};
  for (const name of TOOL_NAMES) {
    for (const kind of BLOCK_KINDS) {
      if (!blocks.has(`${kind}:${name}`)) fail(`missing "${kind}" block for ${name}`);
    }
    const { resolve, defs } = makeResolver(loadSchema);
    const input = resolve(JSON.parse(blocks.get(`tool-input:${name}`)));
    if (Object.keys(defs).length > 0) input.$defs = defs;

    const annotations = JSON.parse(blocks.get(`tool-annotations:${name}`));
    const annotationKeys = ['title', 'readOnlyHint', 'openWorldHint'];
    if (Object.keys(annotations).join(',') !== annotationKeys.join(',')) {
      fail(`annotations of ${name} must be exactly ${annotationKeys.join(', ')}`);
    }

    const description = blocks.get(`tool-description:${name}`).trim();
    if (description === '') fail(`description of ${name} is empty`);
    tools[name] = { input, annotations, description };
  }

  const instructionRows = parseTable(lines, 'instructions', [
    'status',
    'final',
    'variant',
    'instruction',
  ]);
  const instructions = {};
  const statusFinal = {};
  for (const row of instructionRows) {
    if (!statuses.includes(row.status)) {
      fail(`instruction row for "${row.status}", which is not a status of the outcome schema`);
    }
    if (row.final !== 'yes' && row.final !== 'no') {
      fail(`status ${row.status}: final is "${row.final}", expected yes or no`);
    }
    assertRawText(`instruction of ${row.status}`, row.instruction);

    const isFinal = row.final === 'yes';
    if (row.status in statusFinal && statusFinal[row.status] !== isFinal) {
      fail(`status ${row.status} is both final and not final`);
    }
    statusFinal[row.status] = isFinal;

    if (row.variant !== 'both' && !HOOK_VARIANTS.includes(row.variant)) {
      fail(`status ${row.status}: unknown variant "${row.variant}"`);
    }
    const variants = row.variant === 'both' ? HOOK_VARIANTS : [row.variant];
    instructions[row.status] ??= {};
    for (const variant of variants) {
      if (variant in instructions[row.status]) {
        fail(`status ${row.status} has two instructions for variant ${variant}`);
      }
      instructions[row.status][variant] = row.instruction;
    }
  }
  for (const status of statuses) {
    for (const variant of HOOK_VARIANTS) {
      if (!(instructions[status]?.[variant] ?? '')) {
        fail(`status ${status} has no instruction for variant ${variant}`);
      }
    }
  }

  const errorRows = parseTable(lines, 'errors', ['code', 'message', 'fix']);
  const seen = new Set();
  const errors = errorRows.map((row) => {
    if (!/^[A-Z][A-Z_]*$/.test(row.code)) fail(`"${row.code}" is not an error code`);
    if (seen.has(row.code)) fail(`duplicate error code ${row.code}`);
    seen.add(row.code);
    assertRawText(`message of ${row.code}`, row.message);
    assertRawText(`fix of ${row.code}`, row.fix);
    return {
      code: row.code,
      message: row.message,
      fix: row.fix === PER_PROBLEM ? null : row.fix,
    };
  });

  const source = buildSource({ tools, statuses, instructions, statusFinal, errors });
  const prettierOptions = await resolveConfig(docPath);
  return format(source, { ...prettierOptions, parser: 'typescript' });
}

const flagIndex = process.argv.indexOf('--out');
const outPath = flagIndex === -1 ? defaultOutPath : process.argv[flagIndex + 1];
if (flagIndex !== -1 && !outPath) {
  console.error('gen-contract: --out needs a path');
  process.exit(2);
}

try {
  const contract = await generateContract();
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, contract, 'utf8');
  console.error(`generated ${outPath} (${contract.length} characters)`);
} catch (error) {
  if (error instanceof ContractError) {
    console.error(`gen-contract: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
