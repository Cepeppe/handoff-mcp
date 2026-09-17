// Writes the third-party notices of what this repository distributes.
//
// `dist/handoff-mcp.cjs` is an esbuild bundle: the npm packages the server imports are copied
// into it, so the package on npm and every executable of a release redistribute them, and
// their licences (MIT, ISC, BSD-3-Clause) ask for their notice to travel with every copy. The
// list is read from the metafile of the bundle rather than from `package.json`, so a package
// is listed exactly when esbuild put some of it in the file, transitive ones included.
//
//   dist/THIRD-PARTY-NOTICES.md                     written by build/bundle.mjs, shipped by
//                                                   `files` in the npm package
//   dist/sea/handoff-mcp-<ver>-<target>-notices.md  written by build/sea/build-sea.mjs, the
//                                                   release asset beside each executable: the
//                                                   same packages, and Node.js, which the
//                                                   executable is a copy of
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Where build/bundle.mjs leaves the metafile, for build/sea/build-sea.mjs to read. */
export const METAFILE = join('dist', 'handoff-mcp.meta.json');

export const BUNDLE_NOTICES = join('dist', 'THIRD-PARTY-NOTICES.md');

const LICENCE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/i;

/** `handoff-mcp-<ver>-<target>-notices.md`, beside the asset `build-sea.mjs` names. */
export function executableNoticesName(version, target) {
  return `handoff-mcp-${version}-${target}-notices.md`;
}

/**
 * The directory of the npm package an input of the metafile belongs to, or `null` for a file
 * of this repository. The last `node_modules/` of the path decides, which is right for pnpm's
 * `.pnpm/<id>/node_modules/<name>` layout and for a package nested inside another.
 */
export function packageDirOf(input, root) {
  const path = input.split('\\').join('/');
  const marker = 'node_modules/';
  const at = path.lastIndexOf(marker);
  if (at === -1) return null;
  const segments = path.slice(at + marker.length).split('/');
  const name = segments[0]?.startsWith('@') ? segments.slice(0, 2) : segments.slice(0, 1);
  return resolve(root, path.slice(0, at + marker.length), ...name);
}

/**
 * Every package esbuild copied into the bundle, one entry per name and version, sorted by
 * name: `{ name, version, license, text }`. A package without a licence file stops the build,
 * because a notice without the text is exactly what the licences do not allow.
 */
export function bundledPackages(metafile, root) {
  const dirs = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const dir = packageDirOf(input, root);
    if (dir !== null) dirs.add(dir);
  }

  const packages = new Map();
  for (const dir of dirs) {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const key = `${manifest.name}@${manifest.version}`;
    if (packages.has(key)) continue;
    const file = readdirSync(dir).find((entry) => LICENCE_FILE.test(entry));
    if (file === undefined) {
      throw new Error(`${key} is in the bundle but has no licence file in ${dir}`);
    }
    packages.set(key, {
      name: manifest.name,
      version: manifest.version,
      license: typeof manifest.license === 'string' ? manifest.license : 'see the text',
      text: readFileSync(join(dir, file), 'utf8'),
    });
  }
  return [...packages.values()].sort(
    (a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'),
  );
}

/** A fenced block whose fence is longer than any run of backticks inside the text. */
function fenced(text) {
  const runs = (text.match(/`+/g) ?? []).map((run) => run.length);
  const fence = '`'.repeat(Math.max(2, ...runs) + 1);
  return `${fence}text\n${text.replace(/\r\n/g, '\n').trimEnd()}\n${fence}`;
}

function section(title, text) {
  return `## ${title}\n\n${fenced(text)}\n`;
}

/** The notices of the npm package: the bundled packages alone. */
export function renderBundleNotices(packages) {
  return [
    '# Third-party notices',
    '',
    '`dist/handoff-mcp.cjs` is a bundle. Besides the code of `handoff-mcp` (MIT, see `LICENSE`),',
    'it contains the npm packages below, each under its own licence, whose text follows.',
    '',
    ...packages.map((pkg) => section(`${pkg.name} ${pkg.version} (${pkg.license})`, pkg.text)),
  ].join('\n');
}

/**
 * The notices of one executable: Node.js, which it is a copy of, then the bundle it runs.
 * `node.text` is `undefined` when the licence could not be read, and the section then says
 * where it is instead; build-sea.mjs only accepts that outside CI.
 */
export function renderExecutableNotices(packages, { asset, node }) {
  const title = `Node.js ${node.version} (MIT, with the licences of its components)`;
  const nodeSection =
    node.text === undefined
      ? `## ${title}\n\nThe licence text of this version is at ${node.source}.\n`
      : section(title, node.text);
  return [
    `# Third-party notices: ${asset}`,
    '',
    `\`${asset}\` is a Node.js single-executable application: a copy of the Node.js binary below,`,
    'carrying the bundle of `handoff-mcp` (MIT). The bundle contains the npm packages listed',
    'after Node.js, each under its own licence, whose text follows.',
    '',
    nodeSection,
    ...packages.map((pkg) => section(`${pkg.name} ${pkg.version} (${pkg.license})`, pkg.text)),
  ].join('\n');
}

/**
 * The licence of the Node.js binary at `execPath`, the one build-sea.mjs copies. The official
 * archives, which `actions/setup-node` installs, carry it beside the binary on Windows and one
 * level up elsewhere; an installation that dropped it (the Windows MSI does) reads it from the
 * tag of the same version. `{ version, source, text }`, with `text` undefined when neither
 * worked.
 */
export async function nodeLicence(execPath, version) {
  for (const candidate of [
    join(dirname(execPath), 'LICENSE'),
    join(dirname(execPath), '..', 'LICENSE'),
  ]) {
    if (existsSync(candidate)) {
      return { version, source: candidate, text: readFileSync(candidate, 'utf8') };
    }
  }
  const source = `https://raw.githubusercontent.com/nodejs/node/${version}/LICENSE`;
  try {
    const response = await fetch(source);
    if (response.ok) return { version, source, text: await response.text() };
  } catch {
    // Offline: the caller decides whether a link is enough.
  }
  return { version, source, text: undefined };
}

/** Writes `text` with exactly one final newline. */
export function writeText(path, text) {
  writeFileSync(path, `${text.trimEnd()}\n`);
}
