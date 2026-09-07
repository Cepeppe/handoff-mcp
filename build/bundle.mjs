// Bundles the server into the single CommonJS file that `bin` points at and that the
// Single Executable Application of T-009 embeds (TECHNICAL-DESIGN §5.1).
//
// CommonJS on purpose: Node's SEA only supports a CJS main script, and the MCP SDK is
// consumed through the bundle rather than resolved at run time, so the published package
// has no runtime dependency tree to install.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as esbuild from 'esbuild';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));

const result = await esbuild.build({
  entryPoints: [join(repoRoot, 'src', 'main.ts')],
  outfile: join(repoRoot, 'dist', 'handoff-mcp.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: 'external',
  metafile: true,
  logLevel: 'info',
  define: {
    // Consumed by src/main.ts: the version to print, and the flag that tells the entry
    // module it is the bundle and may start the CLI.
    __HANDOFF_MCP_VERSION__: JSON.stringify(pkg.version),
    __HANDOFF_MCP_CLI_ENTRY__: 'true',
  },
});

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.error(`bundled dist/handoff-mcp.cjs (${bytes} bytes) for node22`);
