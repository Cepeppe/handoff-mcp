/**
 * The server as an MCP client sees it (TECHNICAL-DESIGN §4.7, §5.2, §5.3).
 *
 * Everything here runs over the SDK's in-memory transport, so the assertions are made on
 * what actually crosses the protocol: the tool list a client is shown, and the results of
 * real `tools/call` requests. The client is asked for `tools/list` before every call on
 * purpose — that is what makes it compile the declared `outputSchema` and validate the
 * `structuredContent` of every answer against it, which is the only way to find out that
 * a schema an agent cannot resolve would have been registered.
 *
 * The channel is `NullChannel` throughout, because it is `NullChannel` in the product
 * until T-020: this is the text-mode server in full.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import { readConfig } from '../../../src/config';
import type { HandoffErrorPayload } from '../../../src/format';
import { createLogger } from '../../../src/log';
import {
  ANNOTATIONS,
  TOOL_DESCRIPTIONS,
  TOOL_INPUT_SCHEMAS,
  TOOL_NAMES,
} from '../../../src/mcp/generated/contract';
import { OUTCOME_OUTPUT_SCHEMA, RUNBOOKS_OUTPUT_SCHEMA } from '../../../src/mcp/outcome';
import { NullChannel } from '../../../src/mcp/port';
import { createServer, SERVER_NAME } from '../../../src/mcp/server';
import type { Outcome } from '../../../src/mcp/outcome';
import { RunbookStore } from '../../../src/runbooks';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const VERSION = '0.1.0-test';

const stripeSpec = JSON.parse(
  readFileSync(join(REPO, 'fixtures/specs/valid/stripe-webhook.json'), 'utf8'),
) as Record<string, unknown>;

const textModeFixture = JSON.parse(
  readFileSync(join(REPO, 'fixtures/outcomes/text-mode.json'), 'utf8'),
) as Outcome;

/** A spec whose only value is a certain secret, so masking has something to hide. */
const secretSpec = {
  spec_version: 1,
  goal: 'Put the Stripe test key in the environment file',
  where: 'Local project',
  why_human: 'Only the account owner can read the key from the dashboard.',
  values: { api_key: 'sk_test_0123456789abcdefgh' },
  steps: [{ text: 'Paste the key into .env.', values: ['api_key'] }],
};

const temporary: string[] = [];

/** A folder that exists only for one test. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-mcp-t017-'));
  temporary.push(dir);
  return dir;
}

/** A runbook folder holding the named fixtures, or nothing at all. */
function runbookFolder(...names: readonly string[]): string {
  const dir = scratch();
  for (const name of names) {
    cpSync(join(REPO, 'fixtures/runbooks/valid', name), join(dir, name));
  }
  return dir;
}

interface Session {
  readonly client: Client;
  readonly tools: Tool[];
  readonly logs: string[];
  close: () => Promise<void>;
}

/**
 * A connected client and server, with `tools/list` already done so the client validates
 * every later result against the declared output schema.
 */
async function connect(options: { runbookRoot?: string; agent?: string } = {}): Promise<Session> {
  const logs: string[] = [];
  const server = createServer({
    config: readConfig(options.agent === undefined ? {} : { HANDOFF_AGENT: options.agent }, REPO),
    version: VERSION,
    channel: NullChannel,
    runbooks: new RunbookStore([options.runbookRoot ?? join(scratch(), 'absent')], {
      warn: (line) => logs.push(line),
    }),
    logger: createLogger('debug', (line) => logs.push(line)),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'handoff-mcp-test-client', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const { tools } = await client.listTools();
  return {
    client,
    tools,
    logs,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** The outcome an answer carries, asserted to be a result rather than an error. */
function outcomeOf(result: CallToolResult): Outcome {
  expect(result.isError, JSON.stringify(result.content)).toBe(false);
  const outcome = JSON.parse((result.content[0] as { text: string }).text) as Outcome;
  expect(result.structuredContent).toEqual(outcome);
  return outcome;
}

/** The catalogue error an answer carries, asserted to be an error rather than a result. */
function errorOf(result: CallToolResult): HandoffErrorPayload['error'] {
  expect(result.isError, JSON.stringify(result.content)).toBe(true);
  const payload = JSON.parse((result.content[0] as { text: string }).text) as HandoffErrorPayload;
  return payload.error;
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the tool list', () => {
  it('registers the three tools with the generated contract, verbatim', async () => {
    const session = await connect();
    try {
      expect(session.tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
      for (const tool of session.tools) {
        const name = tool.name as (typeof TOOL_NAMES)[number];
        expect(tool.description).toBe(TOOL_DESCRIPTIONS[name]);
        expect(tool.annotations).toEqual(ANNOTATIONS[name]);
        expect(tool.inputSchema).toEqual(TOOL_INPUT_SCHEMAS[name]);
      }
    } finally {
      await session.close();
    }
  });

  it('declares the outcome schema for the two tools that return one, and the search shape for the third', async () => {
    const session = await connect();
    try {
      const outputs = new Map(session.tools.map((tool) => [tool.name, tool.outputSchema]));
      expect(outputs.get('handoff_to_user')).toEqual(OUTCOME_OUTPUT_SCHEMA);
      expect(outputs.get('handoff_verify')).toEqual(OUTCOME_OUTPUT_SCHEMA);
      expect(outputs.get('handoff_runbooks')).toEqual(RUNBOOKS_OUTPUT_SCHEMA);
    } finally {
      await session.close();
    }
  });

  it('answers initialize with the executable name and the version it was built with', async () => {
    const session = await connect();
    try {
      expect(session.client.getServerVersion()).toMatchObject({
        name: SERVER_NAME,
        version: VERSION,
      });
    } finally {
      await session.close();
    }
  });

  it('resolves the capability row from HANDOFF_AGENT at initialize', async () => {
    const session = await connect({ agent: 'claude-code' });
    try {
      expect(session.logs.some((line) => line.includes('session_initialized'))).toBe(true);
      expect(session.logs.some((line) => line.includes('agent_id=claude-code'))).toBe(true);
    } finally {
      await session.close();
    }
  });
});

describe('handoff_to_user, open', () => {
  it('refuses an invalid spec with SPEC_INVALID and every problem at once', async () => {
    const session = await connect();
    try {
      const result = (await session.client.callTool({
        name: 'handoff_to_user',
        arguments: { spec: { spec_version: 1, goal: '   ', where: 'x' } },
      })) as CallToolResult;
      const error = errorOf(result);
      expect(error.code).toBe('SPEC_INVALID');
      expect(error.problems.length).toBeGreaterThan(1);
      expect(error.problems.map((problem) => problem.path)).toContain('goal');
    } finally {
      await session.close();
    }
  });

  it('refuses a call that is not exactly one shape', async () => {
    const session = await connect();
    try {
      const result = (await session.client.callTool({
        name: 'handoff_to_user',
        arguments: { spec: stripeSpec, resume: 'hf_7k3m9p2q4r' },
      })) as CallToolResult;
      const error = errorOf(result);
      expect(error.code).toBe('SHAPE_AMBIGUOUS');
      expect(error.problems[0]?.fix).toContain('Send exactly one shape');
    } finally {
      await session.close();
    }
  });

  it('returns runbook_match instead of opening when a runbook already covers the work', async () => {
    const session = await connect({ runbookRoot: runbookFolder('stripe-webhook.json') });
    try {
      const result = (await session.client.callTool({
        name: 'handoff_to_user',
        arguments: { spec: stripeSpec },
      })) as CallToolResult;
      const outcome = outcomeOf(result);

      expect(outcome.status).toBe('runbook_match');
      expect(outcome.handoff_id).toBeNull();
      expect(outcome.spec_text).toBeNull();
      expect(outcome.runbooks).toHaveLength(1);
      expect(outcome.runbooks[0]?.trust).toBe('verified');
      expect(outcome.runbooks[0]?.matched_words.length).toBeGreaterThan(0);
      expect(outcome.instruction).toContain('ignore_runbook set to true');
    } finally {
      await session.close();
    }
  });

  it('skips the safety net on ignore_runbook and falls through to text mode', async () => {
    const session = await connect({ runbookRoot: runbookFolder('stripe-webhook.json') });
    try {
      const result = (await session.client.callTool({
        name: 'handoff_to_user',
        arguments: { spec: stripeSpec, ignore_runbook: true },
      })) as CallToolResult;
      expect(outcomeOf(result).status).toBe('text_mode');
    } finally {
      await session.close();
    }
  });

  it('never lets a bad runbook file stop a handoff from opening (FM-19)', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'broken.json'), '{ not json', 'utf8');
    const session = await connect({ runbookRoot: dir });
    try {
      const result = (await session.client.callTool({
        name: 'handoff_to_user',
        arguments: { spec: stripeSpec },
      })) as CallToolResult;
      expect(outcomeOf(result).status).toBe('text_mode');
      expect(session.logs.some((line) => line.includes('skipping runbook'))).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('never lets an unreadable runbook folder stop a handoff from opening either', async () => {
    // The safety net reads with `readForSafetyNet`, which swallows the folder problem the
    // tool reports as RUNBOOKS_UNREADABLE: a permissions problem on a folder of recipes
    // must never be the reason a handoff cannot be opened (§5.10, FM-19).
    const dir = scratch();
    const notAFolder = join(dir, 'runbooks');
    writeFileSync(notAFolder, 'this is a file where a folder was expected', 'utf8');
    const session = await connect({ runbookRoot: notAFolder });
    try {
      const result = (await session.client.callTool({
        name: 'handoff_to_user',
        arguments: { spec: stripeSpec },
      })) as CallToolResult;
      expect(outcomeOf(result).status).toBe('text_mode');
    } finally {
      await session.close();
    }
  });

  it('hands the spec back as the published text_mode outcome, byte for byte', async () => {
    const session = await connect();
    try {
      const result = (await session.client.callTool({
        name: 'handoff_to_user',
        arguments: { spec: stripeSpec },
      })) as CallToolResult;
      expect(outcomeOf(result)).toEqual(textModeFixture);
    } finally {
      await session.close();
    }
  });

  it('reports and masks a value the certain detector matched (DET-04, §5.9)', async () => {
    const session = await connect();
    try {
      const result = (await session.client.callTool({
        name: 'handoff_to_user',
        arguments: { spec: secretSpec },
      })) as CallToolResult;
      const outcome = outcomeOf(result);

      expect(outcome.secret_treated).toEqual([{ location: 'values.api_key', kind: 'api_key' }]);
      expect(outcome.spec_text).toContain('[treated as secret: api_key]');
      expect(outcome.spec_text).not.toContain(secretSpec.values.api_key);
      expect(JSON.stringify(outcome)).not.toContain(secretSpec.values.api_key);
    } finally {
      await session.close();
    }
  });

  it('names the app in the instruction and says the app is not reachable', async () => {
    const session = await connect();
    try {
      const result = (await session.client.callTool({
        name: 'handoff_to_user',
        arguments: { spec: stripeSpec },
      })) as CallToolResult;
      const outcome = outcomeOf(result);
      expect(outcome.app_reachable).toBe(false);
      expect(outcome.handoff_id).toBeNull();
      expect(outcome.instruction).toContain('The overlay app is not running.');
    } finally {
      await session.close();
    }
  });
});

describe('the calls that need the app', () => {
  it.each<[string, string, Record<string, unknown>]>([
    ['a continue', 'handoff_to_user', { handoff_id: 'hf_7k3m9p2q4r', reply: 'yes' }],
    ['a resume', 'handoff_to_user', { resume: 'hf_7k3m9p2q4r' }],
    [
      'a verification report',
      'handoff_verify',
      { handoff_id: 'hf_7k3m9p2q4r', verify: { ok: true, detail: 'the webhook answers 200' } },
    ],
  ])('answers APP_DISCONNECTED to %s', async (_name, tool, args) => {
    const session = await connect();
    try {
      const result = (await session.client.callTool({
        name: tool,
        arguments: args,
      })) as CallToolResult;
      const error = errorOf(result);
      expect(error.code).toBe('APP_DISCONNECTED');
      expect(error.problems[0]?.fix).toContain('Retry in a few seconds with the same handoff_id');
    } finally {
      await session.close();
    }
  });
});

describe('handoff_runbooks', () => {
  it('answers with the matching runbooks and their draft specs', async () => {
    const session = await connect({ runbookRoot: runbookFolder('stripe-webhook.json') });
    try {
      const result = (await session.client.callTool({
        name: 'handoff_runbooks',
        arguments: {
          where: 'Stripe Dashboard → Developers → Webhooks',
          goal: 'Register the Stripe webhook for payment events',
        },
      })) as CallToolResult;
      expect(result.isError).toBe(false);

      const answer = result.structuredContent as { runbooks: { draft_spec: unknown }[] };
      expect(answer.runbooks).toHaveLength(1);
      expect(answer.runbooks[0]?.draft_spec).toMatchObject({ spec_version: 1 });
    } finally {
      await session.close();
    }
  });

  it('answers an empty list when the folder is not there', async () => {
    const session = await connect();
    try {
      const result = (await session.client.callTool({
        name: 'handoff_runbooks',
        arguments: { where: 'anywhere', goal: 'anything at all' },
      })) as CallToolResult;
      expect(result.structuredContent).toEqual({ runbooks: [] });
    } finally {
      await session.close();
    }
  });

  it('answers RUNBOOKS_UNREADABLE when it was asked to look and could not', async () => {
    const dir = scratch();
    const notAFolder = join(dir, 'runbooks');
    writeFileSync(notAFolder, 'this is a file where a folder was expected', 'utf8');
    const session = await connect({ runbookRoot: notAFolder });
    try {
      const result = (await session.client.callTool({
        name: 'handoff_runbooks',
        arguments: { where: 'anywhere', goal: 'anything at all' },
      })) as CallToolResult;
      expect(errorOf(result).code).toBe('RUNBOOKS_UNREADABLE');
    } finally {
      await session.close();
    }
  });

  it('refuses arguments the registered input schema does not accept, at the protocol level', async () => {
    const session = await connect();
    try {
      await expect(
        session.client.callTool({ name: 'handoff_runbooks', arguments: { where: 'x' } }),
      ).rejects.toThrow(/handoff_runbooks: goal must be a string/u);
    } finally {
      await session.close();
    }
  });
});

describe('a tool this server does not have', () => {
  it('is a protocol error, not a catalogue error', async () => {
    const session = await connect();
    try {
      await expect(
        session.client.callTool({ name: 'handoff_to_nobody', arguments: {} }),
      ).rejects.toThrow(/no tool named handoff_to_nobody/u);
    } finally {
      await session.close();
    }
  });
});
