/**
 * An overlay for the Codex scenarios that need one listening (T-066): `test/fake-app`,
 * scripted, loaded through esbuild.
 *
 * The canary runs under Node's own type stripping, and `test/fake-app` cannot be loaded that
 * way: it imports `src/` without extensions and JSON without import attributes, which only a
 * bundler resolves. So the harness asks esbuild for one CommonJS file of it, with
 * `import.meta.url` pinned to the folder its sources live in — the two modules that read it
 * locate the scenarios, the goldens and the channel schema from there — and loads that. The
 * double is then exactly the one the integration suites use: every line either way checked
 * against the channel schema, and a scenario that is the same queue of actions.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import type * as FakeAppModule from '../../../fake-app/index.ts';
import { REPO_ROOT } from '../../runner.ts';
import type { CanaryApp } from './runner.ts';

type FakeAppExports = typeof FakeAppModule;

let loading: Promise<FakeAppExports> | undefined;

/** Bundles and loads `test/fake-app`, once per process. */
export function loadFakeApp(): Promise<FakeAppExports> {
  loading ??= bundleFakeApp();
  return loading;
}

async function bundleFakeApp(): Promise<FakeAppExports> {
  const entry = join(REPO_ROOT, 'test', 'fake-app', 'index.ts');
  const folder = mkdtempSync(join(tmpdir(), 'handoff-canary-fake-app-'));
  const outfile = join(folder, 'fake-app.cjs');
  try {
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      outfile,
      logLevel: 'error',
      define: { 'import.meta.url': JSON.stringify(pathToFileURL(entry).href) },
    });
    const load = createRequire(import.meta.url);
    return load(outfile) as FakeAppExports;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** A hand-written `fake-app` scenario: a name, the reason it exists, and its queue of actions. */
export interface AppScript {
  readonly name: string;
  readonly why: string;
  readonly actions: readonly unknown[];
}

/** Starts `fake-app` on `home` with a hand-written scenario, for the length of one run. */
export async function startScriptedApp(home: string, script: AppScript): Promise<CanaryApp> {
  const fake = await loadFakeApp();
  const scenario = fake.parseScenario(
    { scenario: script.name, why: script.why, actions: script.actions },
    script.name,
  );
  const app = await fake.FakeApp.start({ scenario, home });
  return {
    transcript: () => ({
      received: app.received(),
      sent: [...app.sent],
      violations: [...app.violations],
      remaining: app.remaining().length,
    }),
    stop: () => app.stop(),
  };
}
