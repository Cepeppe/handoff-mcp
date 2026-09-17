# Building the standalone executables (SEA)

`handoff-mcp` ships as a **Node Single Executable Application**: one file per platform that
contains the Node runtime and the bundled server, so nothing has to be installed on the
machine that runs it. This document is the procedure, the measured facts behind it, and
what to do if a platform stops working.

The npm package is the other distribution and is unaffected: it ships the same bundle with
a `bin` entry for users who already have Node.

## The route

```
src/**.ts
  └─ build/bundle.mjs      esbuild → dist/handoff-mcp.cjs   (one CommonJS file)
       └─ node --experimental-sea-config build/sea/sea-config.json
            └─ dist/sea/handoff-mcp.blob                    (preparation blob)
                 └─ copy of this node binary + postject injection
                      └─ dist/sea/handoff-mcp-<ver>-<platform>[.exe]
```

`build/sea/build-sea.mjs` runs all of it. The asset names are the ones the release
publishes: `handoff-mcp-<ver>-darwin-arm64`, `handoff-mcp-<ver>-darwin-x64`,
`handoff-mcp-<ver>-win32-x64.exe`.

Beside each one it writes `handoff-mcp-<ver>-<platform>-notices.md`, which the release
publishes too: the licence of the Node.js binary it copied, then the licences of the npm
packages the bundle inlines, as `build/bundle.mjs` read them from the metafile of the bundle
(`build/third-party-notices.mjs`). The Node.js licence comes from beside the binary, where the
official archives and `actions/setup-node` put it, or else from the tag of the same version in
`nodejs/node`; a build in CI that can read neither fails, a local one links to it instead.

## Node version

**Node 24**, pinned in `.node-version` and read from there by every workflow
(`node-version-file: .node-version`). The line was chosen over 22 because it is the current
LTS line, it is what the development machine runs, and its SEA implementation is the one
receiving fixes; the 22 line still works if a downgrade is ever needed, and
`engines.node >= 22` keeps the npm package usable there.

The runtime inside the executable is the runtime of the machine that built it. Building the
three assets therefore means three machines (or three CI runners): the blob is injected into
the Node binary of the builder, so **there is no cross-building**. `build-sea.mjs` refuses
`--host` outside `--print-target` for that reason.

## Build it

Everything is driven by two scripts:

```bash
pnpm build:sea     # pnpm build, then the blob, the copy and the injection
pnpm smoke:sea     # runs the produced binary the way a user's machine would
```

`pnpm smoke:sea` takes an optional path; without it, it smokes the asset of the host
platform. It checks `--version`, that `--help` lists the five subcommands, that an unknown
subcommand exits 2, and that `serve` answers an MCP `initialize` over stdio.

### Windows

```bash
pnpm build:sea
pnpm smoke:sea
```

One step is not optional and is done by the script: the official `node.exe` is
Authenticode-signed, and injecting the blob leaves that signature **corrupted**. Windows
application-control policies then refuse to start the file — on the development machine,
with Smart App Control enforced, the injected binary died with
_"Un criterio di controllo dell'applicazione ha bloccato il file"_ (`os error 4551`) on
every attempt, while the same binary built after removing the signature ran immediately.
The script therefore calls `signtool remove /s` on the copy before injecting.

`signtool.exe` comes with the Windows SDK and is not on `PATH`; it is found under
`C:\Program Files (x86)\Windows Kits\10\bin\<sdk>\x64\`. Set `SIGNTOOL` to override the
search. If it cannot be found the build still produces a binary and warns: that file runs
where no application-control policy is enforced (the GitHub runners, most machines) but is
not shippable.

Signing the result with a real certificate is deferred (T-076, T-077).

### macOS

```bash
pnpm build:sea
pnpm smoke:sea
```

macOS refuses to run a Mach-O whose signature no longer covers its content, so the script
removes the signature before the injection (`codesign --remove-signature`), injects with
`--macho-segment-name NODE_SEA`, and ad-hoc signs the result (`codesign --sign -`). The
ad-hoc signature is enough to run and to test locally; it is **not** what ships.

**Entitlements for T-060.** The shipped binary is signed and notarized as part of the app
bundle (§3.5: it is a Tauri external binary). Node's V8 needs a hardened-runtime exception
for its JIT, so the app's signing step must carry:

| Entitlement                                              | Why                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| `com.apple.security.cs.allow-jit`                        | V8 allocates executable memory                                            |
| `com.apple.security.cs.allow-unsigned-executable-memory` | needed by V8 on top of the above                                          |
| `com.apple.security.cs.disable-library-validation`       | only if a dependency of the bundle fails validation; try without it first |

The macOS legs of `sea.yml` are dispatch-only while macOS is deferred, so those
entitlements are unverified against real notarization: that is assumption **A-12**, and
T-060 closes it. What is verified is the half A-12 can be verified without a Mac: both
darwin assets build, ad-hoc sign and pass the smoke test on GitHub runners.

**The Intel runner label moves.** `macos-13` no longer receives a runner — a job asking for
it stays queued until it times out, with no error to read. The `darwin-x64` leg therefore
takes its label from the `macos_x64_runner` dispatch input, currently `macos-15-intel`. If
that one is retired too, dispatch with the current label rather than editing the workflow.

## Known limitations

- **Size.** Measured on 2026-09-07 with Node 24.18.0: 88.4 MB for `win32-x64`, 115.4 MB for
  `darwin-arm64`, 117.7 MB for `darwin-x64`. The design's estimate of 90–110 MB holds for
  Windows and is a little low for macOS. It is the Node runtime; the server bundle itself
  is a few kilobytes. Compression is not applied: the file is a real executable and the app
  bundles exactly one copy.
- **Experimental banner.** Node prints _"Single executable application is an experimental
  feature"_ on stderr at every start unless it is suppressed. `sea-config.json` sets
  `disableExperimentalSEAWarning: true`, which matters more than cosmetics here: the server
  talks MCP on stdout and any surprise on stderr ends up in the agent's logs.
- **Paths inside `sea-config.json` are relative to the current working directory**, not to
  the configuration file. `build-sea.mjs` always runs Node from the repository root; a
  `cd build/sea && node --experimental-sea-config sea-config.json` writes the blob in the
  wrong place, or fails.
- **No snapshot, no code cache.** `useSnapshot` and `useCodeCache` stay `false`. The code
  cache is tied to the exact V8 build and buys startup time we do not need.
- **The bundle must stay a single CommonJS file.** SEA runs one script and resolves nothing
  at run time. Adding a dependency that must be `require`d from disk breaks the executable
  and not the tests, so it would only show up here.

## If a platform fails (R-04)

The fallback recorded in the risk register is: **ship the Node runtime and the script
inside the app bundle, behind the same fixed launcher path** (§3.5, SRV-25). The user still
installs nothing, the path written into the agent configuration does not change, and only
the layout inside the bundle differs. It costs a second file to sign and roughly the same
number of megabytes.

Before falling back, check in this order:

1. Does `node --experimental-sea-config` still accept the configuration? New keys and
   renamed ones are the usual break between Node lines.
2. Does `postject` still find the sentinel fuse? It is
   `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2` and it lives in `build-sea.mjs`.
3. On Windows, is the signature removed before injection? See above.
4. On macOS, is the failure in signing, in notarization, or at run time under the hardened
   runtime? Only the last one is a reason to fall back; the first two are entitlements.

Record the outcome in the task that hit it and tell the owner: the decision between the SEA
route and the R-04 fallback belongs to the release pipeline (T-011) and to the macOS
signing pipeline (T-060).
