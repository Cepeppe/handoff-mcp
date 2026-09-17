// Bundles the server into the single CommonJS file that `bin` points at and that the
// Single Executable Application of T-009 embeds (TECHNICAL-DESIGN §5.1).
//
// CommonJS on purpose: Node's SEA only supports a CJS main script, and the MCP SDK is
// consumed through the bundle rather than resolved at run time, so the published package
// has no runtime dependency tree to install.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as esbuild from 'esbuild';

import {
  BUNDLE_NOTICES,
  METAFILE,
  bundledPackages,
  renderBundleNotices,
  writeText,
} from './third-party-notices.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));

const result = await esbuild.build({
  // The metafile's input paths are relative to this, and third-party-notices.mjs reads them.
  absWorkingDir: repoRoot,
  entryPoints: [join(repoRoot, 'src', 'main.ts')],
  outfile: join(repoRoot, 'dist', 'handoff-mcp.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: 'external',
  metafile: true,
  logLevel: 'info',
  // `bin` points at this file, and npm decides how to launch a bin from its first line: with
  // no shebang the shim it generates executes the file itself, so `npx baton-handoff-mcp`
  // hands a CommonJS bundle to `/bin/sh` (a screen of syntax errors) or to cmd.exe (silence
  // and exit 0). Node strips the line, including inside the SEA blob that embeds this file.
  banner: { js: '#!/usr/bin/env node' },
  define: {
    // Consumed by src/main.ts: the version to print, and the flag that tells the entry
    // module it is the bundle and may start the CLI.
    __HANDOFF_MCP_VERSION__: JSON.stringify(pkg.version),
    __HANDOFF_MCP_CLI_ENTRY__: 'true',
  },
});

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.error(`bundled dist/handoff-mcp.cjs (${bytes} bytes) for node22`);

// The bundle redistributes the packages it inlines, so their notices ship beside it; the
// metafile stays for build-sea.mjs, whose executables carry the same packages.
await writeFile(join(repoRoot, METAFILE), JSON.stringify(result.metafile));
const packages = bundledPackages(result.metafile, repoRoot);
writeText(join(repoRoot, BUNDLE_NOTICES), renderBundleNotices(packages));
console.error(`wrote ${BUNDLE_NOTICES} (${packages.length} bundled packages)`);
