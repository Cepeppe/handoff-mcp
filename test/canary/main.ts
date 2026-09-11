/**
 * The canary driver: `pnpm canary` (T-023, T-066, T-074, T-069, TECHNICAL-DESIGN §11.5).
 *
 * It runs the scenarios of `scenarios/` against Claude Code, those of `agents/codex/` against
 * Codex, those of `agents/opencode/` against OpenCode and those of `agents/cursor/` against
 * Cursor's editor and its CLI, classifies each run, retries a model failure exactly once,
 * prints a report on stderr and writes the whole thing — assertions and measured facts — to
 * `test/canary/results/last-run.json`, which is git-ignored and is what
 * `docs/agent-facts.md` is written from.
 *
 * Usage:
 *
 * ```
 * pnpm build && pnpm canary                 # every scenario of every agent
 * pnpm canary -- --agent opencode           # one agent's scenarios
 * pnpm canary -- observe codex-observe      # only these
 * pnpm canary -- --list                     # what exists, without running anything
 * ```
 *
 * Environment: `HANDOFF_CANARY_MODEL` pins the Claude model (default `sonnet`),
 * `HANDOFF_CANARY_CODEX_MODEL` the Codex one (default `gpt-5.6-luna`),
 * `HANDOFF_CANARY_OPENCODE_MODEL` the OpenCode one (default a free OpenRouter model, see
 * `agents/opencode/workspace.ts`), `HANDOFF_CANARY_CURSOR_MODEL` the Cursor one (default
 * `auto`), `HANDOFF_CANARY_CODEX`, `HANDOFF_CANARY_OPENCODE` and `HANDOFF_CANARY_CURSOR` name
 * the program when it is not the one on `PATH`, `HANDOFF_CANARY_CURSOR_EDITOR` names Cursor's
 * editor when it is not where it installs itself, and `HANDOFF_CANARY_KEEP=1` keeps each run's
 * temporary project so a failure can be read by hand.
 *
 * The Cursor scenarios are run by hand and rarely: each CLI run spends one of the account's
 * requests (T-068), and the editor's opens a Cursor window for the seconds it takes.
 *
 * Exit codes: **0** every scenario passed · **1** at least one failed · **2** the harness
 * could not run (no bundle, no agent, an unknown scenario id or agent).
 *
 * These runs cost real usage of the agents, so nothing here retries more than §11.5 allows
 * and no scenario asks for more turns than it needs.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CODEX_SCENARIOS } from './agents/codex/index.ts';
import { runCodex } from './agents/codex/runner.ts';
import { CODEX_DEFAULT_MODEL } from './agents/codex/workspace.ts';
import { CURSOR_SCENARIOS, runCursorScenario } from './agents/cursor/index.ts';
import { CURSOR_DEFAULT_MODEL } from './agents/cursor/workspace.ts';
import { OPENCODE_SCENARIOS } from './agents/opencode/index.ts';
import { runOpenCode } from './agents/opencode/runner.ts';
import { OPENCODE_DEFAULT_MODEL } from './agents/opencode/workspace.ts';
import { classify, reported, shouldRetry, type Assertion, type RunVerdict } from './classify.ts';
import { parseCanaryArguments, type CanaryAgent } from './cli.ts';
import { DEFAULT_MODEL, REPO_ROOT, SERVER_BUNDLE, runClaude, type CanaryRun } from './runner.ts';
import { SCENARIOS } from './scenarios/index.ts';

/** Where the report is written. Git-ignored: it names a machine and a moment. */
export const RESULTS_FILE = join(REPO_ROOT, 'test', 'canary', 'results', 'last-run.json');

/** The file the workflow compares the registry's dist-tag against. */
export const LAST_VERSION_FILE = join(REPO_ROOT, 'test', 'canary', 'last-claude-version');

/** How the report names each agent. */
const AGENT_NAMES: Readonly<Record<CanaryAgent, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
};

/** One scenario of any agent, as the driver runs it. */
interface Runnable {
  readonly agent: CanaryAgent;
  readonly id: string;
  readonly title: string;
  readonly covers: readonly string[];
  run(): Promise<CanaryRun>;
  check(run: CanaryRun): Assertion[];
  facts(run: CanaryRun): Record<string, unknown>;
}

const RUNNABLES: readonly Runnable[] = [
  ...SCENARIOS.map((scenario): Runnable => ({
    agent: 'claude-code',
    id: scenario.id,
    title: scenario.title,
    covers: scenario.covers,
    run: () => runClaude(scenario.options),
    check: (run) => scenario.check(run),
    facts: (run) => scenario.facts?.(run) ?? {},
  })),
  ...CODEX_SCENARIOS.map((scenario): Runnable => ({
    agent: 'codex',
    id: scenario.id,
    title: scenario.title,
    covers: scenario.covers,
    run: () => runCodex(scenario.options),
    check: (run) => scenario.check(run),
    facts: (run) => scenario.facts?.(run) ?? {},
  })),
  ...OPENCODE_SCENARIOS.map((scenario): Runnable => ({
    agent: 'opencode',
    id: scenario.id,
    title: scenario.title,
    covers: scenario.covers,
    run: () => runOpenCode(scenario.options),
    check: (run) => scenario.check(run),
    facts: (run) => scenario.facts?.(run) ?? {},
  })),
  ...CURSOR_SCENARIOS.map((scenario): Runnable => ({
    agent: 'cursor',
    id: scenario.id,
    title: scenario.title,
    covers: scenario.covers,
    run: () => runCursorScenario(scenario),
    check: (run) => scenario.check(run),
    facts: (run) => scenario.facts?.(run) ?? {},
  })),
];

interface ScenarioReport {
  readonly id: string;
  readonly agent: CanaryAgent;
  readonly title: string;
  readonly covers: readonly string[];
  readonly verdict: RunVerdict;
  readonly attempts: number;
  readonly durationMs: number;
  readonly costUsd: number | null;
  readonly assertions: readonly Assertion[];
  readonly facts: Record<string, unknown>;
}

function line(text: string): void {
  process.stderr.write(`${text}\n`);
}

/** Runs one scenario, with §11.5's single retry for a model failure and nothing more. */
async function runScenario(scenario: Runnable): Promise<ScenarioReport> {
  let attempt = 0;
  let run: CanaryRun;
  let assertions: Assertion[];
  let verdict: RunVerdict;

  do {
    attempt += 1;
    if (attempt > 1) line(`    model failure, retrying once (§11.5)`);
    run = await scenario.run();
    assertions = scenario.check(run);
    verdict = classify(assertions);
  } while (shouldRetry(verdict, attempt));

  return {
    id: scenario.id,
    agent: scenario.agent,
    title: scenario.title,
    covers: scenario.covers,
    verdict,
    attempts: attempt,
    durationMs: run.durationMs,
    costUsd: typeof run.result?.total_cost_usd === 'number' ? run.result.total_cost_usd : null,
    assertions,
    facts: scenario.facts(run),
  };
}

function report(scenario: ScenarioReport): void {
  const mark = scenario.verdict === 'passed' ? 'PASS' : scenario.verdict.toUpperCase();
  line(
    `  ${mark.padEnd(8)} ${scenario.id} · ${String(Math.round(scenario.durationMs / 1000))}s` +
      (scenario.costUsd === null ? '' : ` · $${scenario.costUsd.toFixed(4)}`) +
      (scenario.attempts > 1 ? ` · ${String(scenario.attempts)} attempts` : ''),
  );
  for (const assertion of scenario.assertions) {
    if (assertion.ok) continue;
    const kind = assertion.informational === true ? 'note' : assertion.kind;
    line(`             [${kind}] ${assertion.id}: ${assertion.what}`);
    if (assertion.detail !== undefined) line(`               ${assertion.detail}`);
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseCanaryArguments(argv);
  if (args.error !== undefined) {
    line(`canary: ${args.error}`);
    return 2;
  }
  const pool =
    args.agent === undefined
      ? RUNNABLES
      : RUNNABLES.filter((scenario) => scenario.agent === args.agent);

  if (args.list) {
    for (const scenario of pool) {
      line(`${scenario.id.padEnd(26)} ${scenario.agent.padEnd(12)} ${scenario.covers.join(', ')}`);
    }
    return 0;
  }

  if (!existsSync(SERVER_BUNDLE)) {
    line(`canary: ${SERVER_BUNDLE} is missing. Run pnpm build first.`);
    return 2;
  }

  const unknown = args.wanted.filter((id) => !pool.some((scenario) => scenario.id === id));
  if (unknown.length > 0) {
    line(`canary: no scenario named ${unknown.join(', ')}. Try --list.`);
    return 2;
  }

  const scenarios =
    args.wanted.length === 0 ? pool : pool.filter((scenario) => args.wanted.includes(scenario.id));
  const agents = [...new Set(scenarios.map((scenario) => scenario.agent))];

  line(
    `canary: ${String(scenarios.length)} scenarios against the real ` +
      agents.map((agent) => AGENT_NAMES[agent]).join(' and '),
  );
  const reports: ScenarioReport[] = [];
  for (const scenario of scenarios) {
    line(`  ...      ${scenario.id}`);
    try {
      const result = await runScenario(scenario);
      reports.push(result);
      report(result);
    } catch (cause) {
      line(`  ERROR    ${scenario.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
      return 2;
    }
  }

  const document = {
    generated_at: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    model: process.env['HANDOFF_CANARY_MODEL'] ?? DEFAULT_MODEL,
    ...(agents.includes('codex')
      ? { codex_model: process.env['HANDOFF_CANARY_CODEX_MODEL'] ?? CODEX_DEFAULT_MODEL }
      : {}),
    ...(agents.includes('opencode')
      ? {
          opencode_model: process.env['HANDOFF_CANARY_OPENCODE_MODEL'] ?? OPENCODE_DEFAULT_MODEL,
        }
      : {}),
    ...(agents.includes('cursor')
      ? { cursor_model: process.env['HANDOFF_CANARY_CURSOR_MODEL'] ?? CURSOR_DEFAULT_MODEL }
      : {}),
    scenarios: reports,
    failed: reported(reports.flatMap((scenario) => scenario.assertions)).length,
  };
  mkdirSync(join(REPO_ROOT, 'test', 'canary', 'results'), { recursive: true });
  writeFileSync(RESULTS_FILE, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  const failed = reports.filter((scenario) => scenario.verdict !== 'passed');
  // Codex reports tokens, not a price: a total over runs that reported none would read as a
  // confident $0.0000, so a cost is printed only when at least one run had one.
  const priced = reports.filter((scenario) => scenario.costUsd !== null);
  const cost = priced.reduce((total, scenario) => total + (scenario.costUsd ?? 0), 0);
  line(
    `canary: ${String(reports.length - failed.length)}/${String(reports.length)} passed, ` +
      (priced.length === 0 ? '' : `$${cost.toFixed(4)} · `) +
      'report in test/canary/results/last-run.json',
  );
  return failed.length === 0 ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
