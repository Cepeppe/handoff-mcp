/**
 * The canary probe: what the server records about the agent that launched it (T-023,
 * TECHNICAL-DESIGN §11.1 DD-34, §11.5 "assumption canaries", Appendix B A-01..A-09,
 * A-23, A-24).
 *
 * **It is off unless `HANDOFF_CANARY=1`.** With the variable unset — every ordinary run,
 * every test of this repository, every installed server — `createCanaryProbe` returns
 * `undefined`, the tool list is the three tools of §4.7 and nothing is written anywhere.
 * The probe exists because half of Appendix B can only be observed from inside the
 * process the agent starts: whether the `env` block of the MCP entry arrived (A-02),
 * which `clientInfo` the handshake carried (A-08), whether `CLAUDE_PROJECT_DIR` is set
 * for a server and not only for a hook (A-24), whether registration really precedes the
 * first tool call (A-01), and whether a tool call that outlives the agent's timeout is
 * cancelled (A-03, A-04, A-09). None of that is visible in the agent's transcript, and
 * none of it may depend on the model having behaved.
 *
 * **It records names and shapes, never values.** A variable of the user's environment can
 * hold anything, so the probe reports which names were set and what the server resolved
 * from them (the agent id, the timeout in milliseconds and where it came from) and never
 * the strings themselves. That is the same rule as R-19 for the logger, for the same
 * reason.
 *
 * **It never throws.** A canary that can break a session is worse than no canary: every
 * write is wrapped, and a failure to record is silent. The file is NDJSON under
 * `<HANDOFF_HOME>/canary/`, and the harness of `test/canary/` points `HANDOFF_HOME` at a
 * temporary directory per run, so a probe run leaves nothing behind in `~/.handoff/`.
 *
 * It adds two tools. `sleep_ms` is the one §11.5 asks for by name: "a test tool sleeping
 * past the configured value is cancelled" is the only way to measure a tool timeout that
 * the agent applies to *our* server entry rather than to a stand-in. `image_probe` (T-066)
 * returns one small image of a single colour drawn at random, and the model is asked to name
 * it: whether an image block of a tool result reaches the model (A-07) is decided by the
 * agent, and naming a colour it was never shown is a one-in-six guess.
 */
import { randomInt } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

/** The test tool of §11.5. Registered only while the probe is on. */
export const CANARY_TOOL_NAME = 'sleep_ms';

/** The image probe of A-07 (T-066). Registered only while the probe is on. */
export const CANARY_IMAGE_TOOL_NAME = 'image_probe';

/**
 * The colours `image_probe` paints, one per call. Six far-apart ones, named the way a model
 * names them, so that a right answer means the pixels arrived and a wrong one cannot be a
 * matter of shade.
 */
export const CANARY_IMAGE_COLOURS = {
  red: [220, 30, 30],
  green: [30, 160, 60],
  blue: [30, 70, 220],
  yellow: [245, 210, 20],
  black: [0, 0, 0],
  white: [255, 255, 255],
} as const satisfies Record<string, readonly [number, number, number]>;

export type CanaryImageColour = keyof typeof CANARY_IMAGE_COLOURS;

/** The side of the square `image_probe` returns, in pixels. */
export const CANARY_IMAGE_SIZE_PX = 64;

/** `<HANDOFF_HOME>/canary/` — the probe writes here and nowhere else. */
export const CANARY_DIR_NAME = 'canary';

/** The NDJSON file the harness reads back. One observation per line. */
export const CANARY_OBSERVATIONS_FILE = 'observations.jsonl';

/**
 * What the probe reports the presence of (A-02, A-23, A-24).
 *
 * `HANDOFF_PROBE` and `HANDOFF_PROBE_TOKEN` are canary-only names, deliberately absent
 * from `ENV_VAR_NAMES`: the pair exists to measure A-23, where the second name contains
 * `TOKEN` and the first does not, so a server that declared them would be a server that
 * fails the rule the declaration list enforces. `CLAUDECODE` is the agent's own marker and
 * is here because the harness has to clear it before it may run at all — recording it
 * proves the child got a fresh one rather than ours.
 *
 * `USERDOMAIN` and `USERNAME` are the two Windows names the pipe is derived from (§5.8,
 * DD-26). They are not the MCP entry's to set but the agent's to pass on, and an agent that
 * starts its servers with a cleaned environment — Codex does (T-066) — would move the
 * server's endpoint away from the app's without either side noticing.
 *
 * `WORKSPACE_FOLDER_PATHS` and `VSCODE_PID` are what an editor tells the servers its
 * extension host starts (T-069): where the workspace is, and which process the editor is.
 * They decide the project folder and the session identity of a session an editor started.
 */
export const CANARY_PROBE_ENV_NAMES: readonly string[] = [
  'HANDOFF_AGENT',
  'HANDOFF_TOOL_TIMEOUT_MS',
  'MCP_TOOL_TIMEOUT',
  'CLAUDE_PROJECT_DIR',
  'CLAUDECODE',
  'HANDOFF_PROBE',
  'HANDOFF_PROBE_TOKEN',
  'USERDOMAIN',
  'USERNAME',
  'WORKSPACE_FOLDER_PATHS',
  'VSCODE_PID',
];

/** The longest sleep the probe will honour: past this it is a hung session, not a probe. */
export const CANARY_MAX_SLEEP_MS = 600_000;

/** How a `sleep_ms` call ended. `aborted` is the observation A-03, A-04 and A-09 want. */
export type SleepOutcome = 'completed' | 'aborted';

/** One line of the observation file. `at` is the instant, `event` the kind. */
export interface CanaryObservation {
  readonly at: string;
  readonly event: string;
  readonly [field: string]: unknown;
}

export interface CanaryProbe {
  /** Where the observations go, so a test can read them without recomputing the path. */
  readonly file: string;
  /** Appends one observation. Never throws, never blocks on anything but the write. */
  record(event: string, fields?: Readonly<Record<string, unknown>>): void;
  /** The extra tools `tools/list` reports while the probe is on. */
  tools(): Tool[];
  /** Whether a `tools/call` name belongs to the probe rather than to the contract. */
  handles(name: string): boolean;
  /** Runs a probe tool. The signal is the SDK's, aborted by an MCP cancellation. */
  call(name: string, args: unknown, signal: AbortSignal): Promise<CallToolResult>;
}

/** What the probe needs to exist: the switch, the folder, and an injectable clock. */
export interface CanaryProbeOptions {
  /** `config.canary`: `HANDOFF_CANARY=1` and nothing else turns the probe on. */
  readonly enabled: boolean;
  /** `config.home`: `HANDOFF_HOME` or `~/.handoff` (§4.1). */
  readonly home: string;
  /** Injected by the tests so an observation's `at` is not the wall clock. */
  readonly now?: () => Date;
  /** Injected by the tests so `image_probe` paints a known colour. */
  readonly pickColour?: () => CanaryImageColour;
}

/** The input of `sleep_ms`, as narrow as the schema below. */
function readSleepMs(args: unknown): number | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const value = (args as { ms?: unknown }).ms;
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  if (value < 0 || value > CANARY_MAX_SLEEP_MS) return undefined;
  return value;
}

/**
 * Waits `ms`, or until the call is cancelled, and says which happened and after how long.
 *
 * The elapsed time is the measurement: with `MCP_TOOL_TIMEOUT` set to ten seconds and a
 * sleep of thirty, `aborted` after roughly ten thousand milliseconds is A-03 holding, and
 * `completed` after thirty thousand is A-03 failing.
 */
export function sleepUntilAborted(
  ms: number,
  signal: AbortSignal,
  now: () => number = Date.now,
): Promise<{ outcome: SleepOutcome; waited_ms: number }> {
  const started = now();
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ outcome: 'aborted', waited_ms: now() - started });
      return;
    }
    const finish = (outcome: SleepOutcome): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ outcome, waited_ms: now() - started });
    };
    const onAbort = (): void => {
      finish('aborted');
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      finish('completed');
    }, ms);
  });
}

/** The eight bytes every PNG file starts with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The CRC-32 table of the PNG specification, built once. */
const CRC_TABLE: readonly number[] = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, and the CRC of type and data. */
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * A square PNG of one colour, `size` pixels a side: truecolour, eight bits per channel, no
 * filter. Written out by hand because it is twenty lines, and an image codec in the
 * dependency graph of a server that never draws anything else would be the larger change.
 */
export function solidPng(
  size: number,
  [red, green, blue]: readonly [number, number, number],
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type 2, truecolour; compression, filter and interlace stay 0
  const row = Buffer.alloc(1 + size * 3); // filter byte 0, then one RGB triple per pixel
  for (let x = 0; x < size; x += 1) {
    row[1 + x * 3] = red;
    row[2 + x * 3] = green;
    row[3 + x * 3] = blue;
  }
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const COLOUR_NAMES = Object.keys(CANARY_IMAGE_COLOURS) as CanaryImageColour[];

function randomColour(): CanaryImageColour {
  return COLOUR_NAMES[randomInt(COLOUR_NAMES.length)] ?? 'red';
}

/**
 * The probe, or `undefined` when `HANDOFF_CANARY` is not `1`.
 *
 * Every caller treats `undefined` as "no canary" with an optional chain, so the ordinary
 * path costs one comparison per tool call and nothing else.
 */
export function createCanaryProbe(options: CanaryProbeOptions): CanaryProbe | undefined {
  if (!options.enabled) return undefined;

  const now = options.now ?? ((): Date => new Date());
  const pickColour = options.pickColour ?? randomColour;
  const directory = join(options.home, CANARY_DIR_NAME);
  const file = join(directory, CANARY_OBSERVATIONS_FILE);

  const record = (event: string, fields: Readonly<Record<string, unknown>> = {}): void => {
    const observation: CanaryObservation = { at: now().toISOString(), event, ...fields };
    try {
      mkdirSync(directory, { recursive: true });
      appendFileSync(file, `${JSON.stringify(observation)}\n`, 'utf8');
    } catch {
      // A canary that can fail a session is not a canary. The harness notices the missing
      // line instead, which is the failure it is there to report.
    }
  };

  const sleepTool: Tool = {
    name: CANARY_TOOL_NAME,
    description:
      'Canary probe: sleeps for the given number of milliseconds and reports whether it ' +
      'was allowed to finish. Registered only when HANDOFF_CANARY=1.',
    inputSchema: {
      type: 'object',
      properties: {
        ms: {
          type: 'integer',
          minimum: 0,
          maximum: CANARY_MAX_SLEEP_MS,
          description: 'How long to sleep, in milliseconds.',
        },
      },
      required: ['ms'],
      additionalProperties: false,
    },
  };

  const imageTool: Tool = {
    name: CANARY_IMAGE_TOOL_NAME,
    description:
      'Canary probe: returns one small image of a single solid colour. Registered only ' +
      'when HANDOFF_CANARY=1.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  };

  return {
    file,
    record,
    tools: () => [sleepTool, imageTool],
    handles: (name) => name === CANARY_TOOL_NAME || name === CANARY_IMAGE_TOOL_NAME,
    call: async (name, args, signal) => {
      if (name === CANARY_IMAGE_TOOL_NAME) {
        const colour = pickColour();
        record('image_probe', { colour });
        return {
          content: [
            {
              type: 'text',
              text: 'Canary image probe: the image below is a single solid colour.',
            },
            {
              type: 'image',
              data: solidPng(CANARY_IMAGE_SIZE_PX, CANARY_IMAGE_COLOURS[colour]).toString('base64'),
              mimeType: 'image/png',
            },
          ],
        };
      }
      if (name !== CANARY_TOOL_NAME) {
        return { isError: true, content: [{ type: 'text', text: `no canary tool ${name}` }] };
      }
      const ms = readSleepMs(args);
      if (ms === undefined) {
        record('sleep_rejected');
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `sleep_ms takes ms: an integer between 0 and ${String(CANARY_MAX_SLEEP_MS)}`,
            },
          ],
        };
      }
      record('sleep_start', { requested_ms: ms });
      const result = await sleepUntilAborted(ms, signal);
      record('sleep_end', {
        requested_ms: ms,
        outcome: result.outcome,
        waited_ms: result.waited_ms,
      });
      return {
        content: [
          { type: 'text', text: `slept ${String(result.waited_ms)} ms (${result.outcome})` },
        ],
      };
    },
  };
}
