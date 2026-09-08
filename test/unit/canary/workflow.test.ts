/**
 * Guards `canary.yml` (T-023, TECHNICAL-DESIGN §11.5, `TASKS.md` §0.4 items 3, 7 and 9).
 *
 * The workflow is read as text, the way `test/unit/release.test.ts` reads the release
 * pipeline, because the things that can go quietly wrong in it are decisions written there
 * and nowhere else: a schedule that starts spending Claude usage unattended, a macOS leg
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
  it('is dispatch-only while no secret is provisioned (§0.4 item 9)', () => {
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

  it('keeps macOS opt-in and its label an input, never a literal (§0.4 item 7, T-009)', () => {
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
  it('compares the npm dist-tag against the pinned file (A-22)', () => {
    expect(workflow).toContain('npm view @anthropic-ai/claude-code dist-tags.latest');
    expect(workflow).toContain('test/canary/last-claude-version');
  });

  it('installs the version it just resolved, rather than latest', () => {
    expect(workflow).toContain(
      'npm install --global @anthropic-ai/claude-code@${{ needs.plan.outputs.published }}',
    );
  });

  it('runs the canaries through the package script, over the built bundle', () => {
    expect(packageJson.scripts['canary']).toBe('node test/canary/main.ts');
    expect(workflow).toContain('run: pnpm build');
    expect(workflow).toContain('run: pnpm canary');
  });

  it('opens an issue only on a failure, and asks for the permission that needs', () => {
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
