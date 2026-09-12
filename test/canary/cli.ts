/**
 * The command line of `pnpm canary` (T-023, T-066, T-074, T-069, T-072, T-081): which
 * scenarios to run, of which agent.
 *
 * `--agent <id>` keeps one agent's scenarios — `canary.yml` runs each agent in its own job with
 * its own credential, and Cursor and Copilot are run by hand with `--agent cursor` and
 * `--agent copilot` — `--list` prints what exists, and any other argument that does not start
 * with `--` is a scenario id. Pure, so the unit suite pins it.
 */

/** The agents the canary knows how to run. */
export const CANARY_AGENTS = [
  'claude-code',
  'codex',
  'opencode',
  'cursor',
  'copilot',
  'kilo-code',
] as const;

export type CanaryAgent = (typeof CANARY_AGENTS)[number];

export interface CanaryArguments {
  readonly list: boolean;
  readonly agent: CanaryAgent | undefined;
  readonly wanted: readonly string[];
  /** Set when an argument cannot be used; the driver prints it and exits 2. */
  readonly error: string | undefined;
}

export function parseCanaryArguments(argv: readonly string[]): CanaryArguments {
  let list = false;
  let agent: CanaryAgent | undefined;
  let error: string | undefined;
  const wanted: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === '--list') {
      list = true;
      continue;
    }
    if (argument === '--agent' || argument.startsWith('--agent=')) {
      let value: string | undefined;
      if (argument === '--agent') {
        index += 1;
        value = argv[index];
      } else {
        value = argument.slice('--agent='.length);
      }
      const known = CANARY_AGENTS.find((candidate) => candidate === value);
      if (known === undefined) {
        error = `no agent named ${String(value)}; the agents are ${CANARY_AGENTS.join(', ')}`;
      } else {
        agent = known;
      }
      continue;
    }
    if (argument.startsWith('--')) continue;
    wanted.push(argument);
  }

  return { list, agent, wanted, error };
}
