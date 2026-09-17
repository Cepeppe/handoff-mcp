/**
 * Guards `canary.yml` (T-023, T-066, TECHNICAL-DESIGN §11.5, implementation decisions 3, 7
 * and 9).
 *
 * The workflow is read as text, the way `test/unit/release.test.ts` reads the release
 * pipeline, because the things that can go quietly wrong in it are decisions written there
 * and nowhere else: a schedule that starts spending agent usage unattended, a macOS leg
 * that starts costing ten times as much on every dispatch, a missing-secret path that goes
 * red instead of skipping, or a version check that stops comparing against the pinned file.
 *
 * The report renderer is exercised for real, on a report this file writes, because the one
 * moment it runs is the moment a canary has already failed.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'canary.yml'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

const temporary: string[] = [];

afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-canary-report-'));
  temporary.push(dir);
  return dir;
}

describe('when it runs', () => {
  it('is dispatch-only while no secret is provisioned (implementation decision 9)', () => {
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/^\s{2}schedule:/mu);
    expect(workflow).not.toMatch(/^\s{2}push:/mu);
    expect(workflow).not.toMatch(/^\s{2}pull_request:/mu);
  });

  it('skips rather than fails when ANTHROPIC_API_KEY is absent (T-024 is deferred)', () => {
    expect(workflow).toContain('ANTHROPIC_API_KEY');
    expect(workflow).toContain('present=false');
    expect(workflow).toMatch(/if: steps\.secret\.outputs\.present == 'true'/u);
  });

  it('skips the Codex job the same way when OPENAI_API_KEY is absent (T-066)', () => {
    expect(workflow).toContain('OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}');
    expect(workflow).toContain('the Codex canaries were skipped (T-066)');
  });

  it('skips the OpenCode job the same way when OPENROUTER_API_KEY is absent (T-074)', () => {
    expect(workflow).toContain('OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}');
    expect(workflow).toContain('the OpenCode canaries were skipped (T-074)');
  });

  it('skips the Kilo Code job the same way when KILO_API_KEY is absent (T-081)', () => {
    expect(workflow).toContain('KILO_API_KEY: ${{ secrets.KILO_API_KEY }}');
    expect(workflow).toContain('the Kilo Code canaries were skipped (T-081)');
  });

  it('keeps macOS opt-in and its label an input, never a literal (implementation decision 7, T-009)', () => {
    expect(workflow).toContain('inputs.macos_runner');
    // A literal label anywhere but the default of the input is the trap T-009 hit.
    expect(workflow).not.toMatch(/runs-on:\s*macos-/u);
    expect(workflow).toMatch(/if \[ "\$WITH_MACOS" = "true" \]/u);
  });

  it('runs only one runner by default, and that runner is Windows', () => {
    expect(workflow).toContain(`list='["windows-latest"]'`);
  });
});

describe('what it checks and reports', () => {
  it('compares each npm dist-tag against its pinned file (A-22)', () => {
    expect(workflow).toContain('npm view @anthropic-ai/claude-code dist-tags.latest');
    expect(workflow).toContain('test/canary/last-claude-version');
    expect(workflow).toContain('npm view @openai/codex dist-tags.latest');
    expect(workflow).toContain('test/canary/last-codex-version');
    expect(readFileSync(join(ROOT, 'test', 'canary', 'last-codex-version'), 'utf8')).toMatch(
      /^\d+\.\d+\.\d+\n$/u,
    );
    expect(workflow).toContain('npm view opencode-ai dist-tags.latest');
    expect(workflow).toContain('test/canary/last-opencode-version');
    expect(readFileSync(join(ROOT, 'test', 'canary', 'last-opencode-version'), 'utf8')).toMatch(
      /^\d+\.\d+\.\d+\n$/u,
    );
    expect(workflow).toContain('npm view @kilocode/cli dist-tags.latest');
    expect(workflow).toContain('test/canary/last-kilo-code-version');
    expect(readFileSync(join(ROOT, 'test', 'canary', 'last-kilo-code-version'), 'utf8')).toMatch(
      /^\d+\.\d+\.\d+\n$/u,
    );
  });

  it('installs the versions it just resolved, rather than latest', () => {
    expect(workflow).toContain(
      'npm install --global @anthropic-ai/claude-code@${{ needs.plan.outputs.published }}',
    );
    expect(workflow).toContain(
      'npm install --global @openai/codex@${{ needs.plan.outputs.codex_published }}',
    );
    expect(workflow).toContain(
      'npm install --global opencode-ai@${{ needs.plan.outputs.opencode_published }}',
    );
    expect(workflow).toContain(
      'npm install --global @kilocode/cli@${{ needs.plan.outputs.kilo_code_published }}',
    );
  });

  it('hands OpenCode its key in the variable its provider reads, never on a command line', () => {
    // OpenCode's OpenRouter provider names OPENROUTER_API_KEY in its own catalogue, so the key
    // goes into the step's environment and no login command ever sees it.
    const job = workflow.slice(workflow.indexOf('  opencode:'), workflow.indexOf('  kilo-code:'));
    expect(job).toContain('OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}');
    expect(job).toContain('HANDOFF_CANARY_OPENCODE_MODEL: ${{ inputs.opencode_model }}');
    expect(job).not.toMatch(/opencode (?:auth|providers) login/u);
  });

  it('hands Kilo Code its key in the variable Kilo reads, never on a command line (T-081)', () => {
    const job = workflow.slice(workflow.indexOf('  kilo-code:'), workflow.indexOf('  issue:'));
    expect(job).toContain('KILO_API_KEY: ${{ secrets.KILO_API_KEY }}');
    expect(job).toContain('HANDOFF_CANARY_KILO_CODE_MODEL: ${{ inputs.kilo_code_model }}');
    expect(job).not.toMatch(/kilo (?:auth|providers) login/u);
  });

  it('logs Codex in from stdin, so the key is never on a command line', () => {
    expect(workflow).toContain('printenv OPENAI_API_KEY | codex login --with-api-key');
  });

  it('runs the canaries through the package script, one agent per job, over the built bundle', () => {
    expect(packageJson.scripts['canary']).toBe('node test/canary/main.ts');
    expect(workflow).toContain('run: pnpm build');
    expect(workflow).toContain('run: pnpm canary -- --agent claude-code');
    expect(workflow).toContain('run: pnpm canary -- --agent codex');
    expect(workflow).toContain('run: pnpm canary -- --agent opencode');
    expect(workflow).toContain('run: pnpm canary -- --agent kilo-code');
  });

  it('keeps one report per agent and runner, so none overwrites another', () => {
    expect(workflow).toContain('name: canary-claude-code-${{ matrix.os }}');
    expect(workflow).toContain('name: canary-codex-${{ matrix.os }}');
    expect(workflow).toContain('name: canary-opencode-${{ matrix.os }}');
    expect(workflow).toContain('name: canary-kilo-code-${{ matrix.os }}');
    expect(workflow).toContain('pattern: canary-*');
  });

  it('opens an issue only on a failure of any agent, and asks for the permission that needs', () => {
    expect(workflow).toContain('needs: [plan, canary, codex, opencode, kilo-code]');
    expect(workflow).toContain('if: failure() && inputs.open_issue');
    expect(workflow).toContain('issues: write');
    expect(workflow).toContain('gh issue create');
  });

  it('keeps the default permission read-only, so only that one job can write', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/mu);
  });
});

describe('the report renderer', () => {
  const report = {
    generated_at: '2026-09-08T11:12:32.029Z',
    platform: 'win32-x64',
    model: 'sonnet',
    failed: 2,
    scenarios: [
      {
        id: 'observe',
        title: 'one prescriptive tool call',
        covers: ['A-02'],
        verdict: 'protocol',
        attempts: 1,
        durationMs: 15_000,
        costUsd: 0.07,
        assertions: [
          { id: 'A-02', what: 'the env block arrives', kind: 'protocol', ok: false, detail: 'no' },
          {
            id: 'A-09',
            what: 'a cancellation arrives',
            kind: 'protocol',
            ok: false,
            informational: true,
          },
          { id: 'A-08', what: 'a client name arrives', kind: 'protocol', ok: true },
        ],
        facts: { client_name: 'claude-code' },
      },
      {
        id: 'e2e-08-text-mode',
        title: 'text mode',
        covers: ['E2E-8'],
        verdict: 'passed',
        attempts: 2,
        durationMs: 9000,
        costUsd: 0.08,
        assertions: [{ id: 'E2E-8', what: 'status is text_mode', kind: 'protocol', ok: true }],
        facts: {},
      },
    ],
  };

  function render(file: string): string {
    return execFileSync(process.execPath, [join(ROOT, 'build', 'canary-report.mjs'), file], {
      encoding: 'utf8',
    });
  }

  it('names the failing assertions, with the observed detail and the kind', () => {
    const file = join(scratch(), 'last-run.json');
    writeFileSync(file, JSON.stringify(report), 'utf8');
    const markdown = render(file);

    expect(markdown).toContain('**1/2 scenarios passed**');
    expect(markdown).toContain('| `observe` | A-02 | protocol | 15s |');
    expect(markdown).toContain('(2 attempts)');
    expect(markdown).toContain('**[protocol] A-02** the env block arrives');
    expect(markdown).toContain('observed: no');
    expect(markdown).toContain('**[note] A-09**');
    expect(markdown).not.toContain('a client name arrives');
  });

  it('names the OpenCode model when OpenCode scenarios ran, and only then (T-074)', () => {
    const file = join(scratch(), 'last-run.json');
    writeFileSync(file, JSON.stringify(report), 'utf8');
    expect(render(file)).not.toContain('opencode model');
    writeFileSync(
      file,
      JSON.stringify({ ...report, opencode_model: 'openrouter/vendor/model:free' }),
      'utf8',
    );
    expect(render(file)).toContain('opencode model `openrouter/vendor/model:free`');
  });

  it('names the Kilo Code model when Kilo Code scenarios ran, and only then (T-081)', () => {
    const file = join(scratch(), 'last-run.json');
    writeFileSync(file, JSON.stringify(report), 'utf8');
    expect(render(file)).not.toContain('kilo-code model');
    writeFileSync(
      file,
      JSON.stringify({ ...report, kilo_code_model: 'kilo/kilo-auto/free' }),
      'utf8',
    );
    expect(render(file)).toContain('kilo-code model `kilo/kilo-auto/free`');
  });

  it('names the Codex model when Codex scenarios ran, and only then', () => {
    const file = join(scratch(), 'last-run.json');
    writeFileSync(file, JSON.stringify(report), 'utf8');
    expect(render(file)).not.toContain('codex model');
    writeFileSync(file, JSON.stringify({ ...report, codex_model: 'gpt-5.6-luna' }), 'utf8');
    expect(render(file)).toContain('codex model `gpt-5.6-luna`');
  });

  it('carries the measured facts and no transcript at all', () => {
    const file = join(scratch(), 'last-run.json');
    writeFileSync(file, JSON.stringify(report), 'utf8');
    const markdown = render(file);
    expect(markdown).toContain('"client_name": "claude-code"');
    expect(markdown).not.toContain('transcript');
  });

  it('says so and exits 0 when there is no report, because it runs in a failure path', () => {
    const markdown = render(join(scratch(), 'missing.json'));
    expect(markdown).toContain('No canary report');
  });
});
