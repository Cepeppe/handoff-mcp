/**
 * Renders a canary report as Markdown (T-023, TECHNICAL-DESIGN §11.5).
 *
 * `pnpm canary` writes `test/canary/results/last-run.json`; this turns it into the table
 * that goes into a job summary and into the body of the issue `canary.yml` opens. It is a
 * separate script rather than a flag of the driver because the workflow renders reports it
 * did not produce — one per runner, downloaded as artifacts.
 *
 * It prints assertions and measured facts and **never the transcript**: a transcript is a
 * conversation with a model, and an issue in this repository is public.
 *
 * Usage: `node build/canary-report.mjs [report.json]`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_REPORT = join(ROOT, 'test', 'canary', 'results', 'last-run.json');

const file = process.argv[2] ?? DEFAULT_REPORT;

let report;
try {
  report = JSON.parse(readFileSync(file, 'utf8'));
} catch (cause) {
  process.stdout.write(`No canary report at \`${file}\` (${cause.message}).\n`);
  process.exit(0);
}

const out = [];
const say = (line = '') => out.push(line);

const failed = report.scenarios.filter((scenario) => scenario.verdict !== 'passed');
// Codex reports tokens, not a price: a total over scenarios that reported none would be a
// confident $0.0000, so the cost is printed only when at least one scenario had one.
const priced = report.scenarios.filter((scenario) => typeof scenario.costUsd === 'number');
const cost = priced.reduce((total, scenario) => total + scenario.costUsd, 0);

const models =
  `model \`${report.model}\`` +
  (typeof report.codex_model === 'string' ? ` · codex model \`${report.codex_model}\`` : '');
say(
  `**${report.scenarios.length - failed.length}/${report.scenarios.length} scenarios passed** ` +
    `· ${report.platform} · ${models} · $${cost.toFixed(4)} · ${report.generated_at}`,
);
say();
say('| Scenario | Covers | Verdict | Duration |');
say('| --- | --- | --- | --- |');
for (const scenario of report.scenarios) {
  const duration = `${Math.round(scenario.durationMs / 1000)}s`;
  const attempts = scenario.attempts > 1 ? ` (${scenario.attempts} attempts)` : '';
  say(
    `| \`${scenario.id}\` | ${scenario.covers.join(', ')} | ` +
      `${scenario.verdict}${attempts} | ${duration} |`,
  );
}

for (const scenario of report.scenarios) {
  const notable = scenario.assertions.filter((assertion) => !assertion.ok);
  if (notable.length === 0) continue;
  say();
  say(`### \`${scenario.id}\` — ${scenario.title}`);
  for (const assertion of notable) {
    const kind = assertion.informational === true ? 'note' : assertion.kind;
    say(`- **[${kind}] ${assertion.id}** ${assertion.what}`);
    if (assertion.detail !== undefined) say(`  - observed: ${assertion.detail}`);
  }
}

say();
say('<details><summary>Measured facts</summary>');
say();
for (const scenario of report.scenarios) {
  if (Object.keys(scenario.facts).length === 0) continue;
  say(`\`${scenario.id}\``);
  say();
  say('```json');
  say(JSON.stringify(scenario.facts, null, 2));
  say('```');
  say();
}
say('</details>');

process.stdout.write(`${out.join('\n')}\n`);
