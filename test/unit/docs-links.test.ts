/**
 * Guards the published documentation (REQUIREMENTS NFR-16, TECHNICAL-DESIGN §3.2).
 *
 * Two things are checked here. First, that `build/check-links.mjs` actually catches what it
 * claims to: a green link check that cannot go red is worth nothing, so it is run against a
 * tree built to break it. Second, that the documentation of this repository passes it, and
 * that every page NFR-16 requires exists and is reachable from `docs/index.md` — a page
 * nobody links to is a page nobody reads.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CHECKER = join(ROOT, 'build', 'check-links.mjs');

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(root: string): Run {
  try {
    const stdout = execFileSync(process.execPath, [CHECKER, root], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? -1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

const temporaries: string[] = [];

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'handoff-links-'));
  temporaries.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  return root;
}

afterAll(() => {
  for (const root of temporaries) rmSync(root, { recursive: true, force: true });
});

describe('the checker catches what it claims to', () => {
  it('reports a link to a file that does not exist', () => {
    const root = tree({ 'a.md': '# A\n\n[gone](b.md)\n' });
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('a.md:3: "b.md" does not exist');
  });

  it('reports an anchor no heading produces', () => {
    const root = tree({ 'a.md': '# A\n\n## Real heading\n\n[x](#imaginary-heading)\n' });
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"#imaginary-heading" has no matching heading in this file');
  });

  it('reports a reference definition and a link into a subfolder', () => {
    const root = tree({
      'a.md': '# A\n\n[one][ref] and [two](sub/missing.md)\n\n[ref]: also-missing.md\n',
      'sub/there.md': '# There\n',
    });
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"sub/missing.md" does not exist');
    expect(result.stderr).toContain('"also-missing.md" does not exist');
  });

  it('reports an absolute path, which breaks outside a web root', () => {
    const root = tree({ 'a.md': '# A\n\n[x](/docs/a.md)\n' });
    expect(run(root).stderr).toContain('absolute path');
  });

  it('accepts an anchor whose heading holds code, punctuation or a link', () => {
    const root = tree({
      'a.md': '# A\n\n## 1. `handoff_to_user`\n\n## Values, and the rest\n',
      'b.md': '# B\n\n[x](a.md#1-handoff_to_user) [y](a.md#values-and-the-rest)\n',
    });
    expect(run(root).status).toBe(0);
  });

  it('ignores links inside fenced blocks and inline code, and external ones', () => {
    const root = tree({
      'a.md': [
        '# A',
        '',
        '```md',
        '[not a link](nowhere.md)',
        '```',
        '',
        'Prose about `[nope](nothing.md)` and [real](https://example.invalid/x).',
        '',
        '```',
        '## fenced heading',
        '```',
        '',
      ].join('\n'),
    });
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('0 relative link(s)');
  });

  it('follows a link to a file that is not markdown, and ignores its anchor', () => {
    const root = tree({
      'a.md': '# A\n\n[schema](s.json#/$defs/step) and [gone](t.json)\n',
      's.json': '{}\n',
    });
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"t.json" does not exist');
    expect(result.stderr).not.toContain('s.json');
  });
});

describe('this repository', () => {
  it('has no broken relative link in any markdown file', () => {
    const result = run(ROOT);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/check-links: \d+ relative link\(s\) in \d+ markdown file\(s\)/);
  });

  /** The documents NFR-16 requires, each as its own page (T-022 deliverables). */
  const REQUIRED_PAGES = [
    'index.md',
    'handoff-spec.md',
    'outcome.md',
    'runbook-format.md',
    'tool-contract.md',
    'text-mode.md',
    'channel.md',
    'install-without-app.md',
    'errors.md',
    'versioning.md',
  ] as const;

  const index = readFileSync(join(ROOT, 'docs', 'index.md'), 'utf8');
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

  it.each(REQUIRED_PAGES.filter((page) => page !== 'index.md'))(
    'docs/index.md links to %s',
    (page) => {
      expect(index).toContain(`(${page})`);
    },
  );

  it.each(REQUIRED_PAGES)('README.md links to docs/%s', (page) => {
    expect(readme).toContain(`(docs/${page})`);
  });

  it('states the text-mode limitations NFR-16 asks for (SRV-15)', () => {
    const textMode = readFileSync(join(ROOT, 'docs', 'text-mode.md'), 'utf8');
    expect(textMode).toContain('There is no log.');
    expect(textMode).toContain('There is no "verified" state.');
    expect(textMode).toMatch(/not supported/);
  });

  it('tells a server-only installation to set HANDOFF_AGENT (R-17)', () => {
    const install = readFileSync(join(ROOT, 'docs', 'install-without-app.md'), 'utf8');
    expect(install).toContain('HANDOFF_AGENT');
    expect(install).toContain('baton-handoff-mcp');
    expect(install).toContain('handoff-mcp doctor');
    expect(install).toContain('handoff-mcp validate');
  });

  it('publishes the channel threat model verbatim and its instability notice (SRV-08, SRV-06)', () => {
    const channel = readFileSync(join(ROOT, 'docs', 'channel.md'), 'utf8');
    // The sentence is quoted from SRV-08 and must stay word for word; only the line breaks
    // and the blockquote markers Prettier owns are normalised away.
    const flattened = channel.replace(/^\s*>\s?/gm, '').replace(/\s+/g, ' ');
    expect(flattened).toContain(
      'The token protects against other users of the same machine and against accidental ' +
        'connections. It does not protect against a malicious process already running as the ' +
        "same user; that is the operating system's boundary.",
    );
    expect(flattened).toContain('internal, subject to change without notice');
  });
});
