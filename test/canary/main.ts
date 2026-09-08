/**
 * The canary driver: `pnpm canary` (T-023, TECHNICAL-DESIGN §11.5).
 *
 * It runs the scenarios of `scenarios/`, classifies each run, retries a model failure
 * exactly once, prints a report on stderr and writes the whole thing — assertions and
 * measured facts — to `test/canary/results/last-run.json`, which is git-ignored and is what
 * `docs/agent-facts.md` is written from.
 *
 * Usage:
 *
 * ```
 * pnpm build && pnpm canary                 # every scenario
 * pnpm canary -- observe e2e-08-text-mode   # only these
 * pnpm canary -- --list                     # what exists, without running anything
 * ```
 *
 * Environment: `HANDOFF_CANARY_MODEL` pins the model (default `sonnet`),
 * `HANDOFF_CANARY_KEEP=1` keeps each run's temporary project so a failure can be read by
 * hand.
 *
 * Exit codes: **0** every scenario passed · **1** at least one failed · **2** the harness
 * could not run (no bundle, no `claude`, an unknown scenario id).
 *
 * These runs cost real Claude usage, so nothing here retries more than §11.5 allows and no
 * scenario asks for more turns than it needs.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { classify, reported, shouldRetry, type Assertion, type RunVerdict } from './classify.ts';
import { REPO_ROOT, SERVER_BUNDLE, runClaude, type CanaryRun } from './runner.ts';
import { SCENARIOS, type Scenario } from './scenarios/index.ts';

/** Where the report is written. Git-ignored: it names a machine and a moment. */
export const RESULTS_FILE = join(REPO_ROOT, 'test', 'canary', 'results', 'last-run.json');

/** The file the workflow compares the registry's dist-tag against. */
export const LAST_VERSION_FILE = join(REPO_ROOT, 'test', 'canary', 'last-claude-version');

interface ScenarioReport {
  readonly id: string;
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
async function runScenario(scenario: Scenario): Promise<ScenarioReport> {
  let attempt = 0;
  let run: CanaryRun;
  let assertions: Assertion[];
  let verdict: RunVerdict;

  do {
    attempt += 1;
    if (attempt > 1) line(`    model failure, retrying once (§11.5)`);
    run = await runClaude(scenario.options);
    assertions = scenario.check(run);
    verdict = classify(assertions);
  } while (shouldRetry(verdict, attempt));

  return {
    id: scenario.id,
    title: scenario.title,
    covers: scenario.covers,
    verdict,
    attempts: attempt,
    durationMs: run.durationMs,
    costUsd: typeof run.result?.total_cost_usd === 'number' ? run.result.total_cost_usd : null,
    assertions,
    facts: scenario.facts?.(run) ?? {},
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
  const wanted = argv.filter((argument) => !argument.startsWith('--'));

  if (argv.includes('--list')) {
    for (const scenario of SCENARIOS) {
      line(`${scenario.id.padEnd(24)} ${scenario.covers.join(', ')}`);
    }
    return 0;
  }

  if (!existsSync(SERVER_BUNDLE)) {
    line(`canary: ${SERVER_BUNDLE} is missing. Run pnpm build first.`);
    return 2;
  }

  const unknown = wanted.filter((id) => !SCENARIOS.some((scenario) => scenario.id === id));
  if (unknown.length > 0) {
    line(`canary: no scenario named ${unknown.join(', ')}. Try --list.`);
    return 2;
  }

  const scenarios =
    wanted.length === 0 ? SCENARIOS : SCENARIOS.filter((scenario) => wanted.includes(scenario.id));

  line(`canary: ${String(scenarios.length)} scenarios against the real Claude Code`);
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
    model: process.env['HANDOFF_CANARY_MODEL'] ?? 'sonnet',
    scenarios: reports,
    failed: reported(reports.flatMap((scenario) => scenario.assertions)).length,
  };
  mkdirSync(join(REPO_ROOT, 'test', 'canary', 'results'), { recursive: true });
  writeFileSync(RESULTS_FILE, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  const failed = reports.filter((scenario) => scenario.verdict !== 'passed');
  const cost = reports.reduce((total, scenario) => total + (scenario.costUsd ?? 0), 0);
  line(
    `canary: ${String(reports.length - failed.length)}/${String(reports.length)} passed, ` +
      `$${cost.toFixed(4)} · report in test/canary/results/last-run.json`,
  );
  return failed.length === 0 ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
