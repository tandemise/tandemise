# Contributing to Tandemise

Thanks for your interest in Tandemise. This guide covers how changes get from a
branch to a release.

## Ground rules

- Be kind. Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- Report security problems privately. See [SECURITY.md](SECURITY.md) and never open a public issue for them.
- For anything bigger than a small fix, open an issue first so the design can be agreed before you write code.
  `MVP.md` and `docs/adr/` explain how the system is meant to work.

## Development setup

Tandemise needs **Node 22** (see `.nvmrc`). Development happens on macOS and
Linux; only the native helper for macOS app control (`native/macos-helper`,
`packages/desktop-control`) needs macOS. Windows installers are built in CI
but the app has not been driven on a real Windows machine yet.

```bash
nvm use
npm ci
npm run build
npm run daemon    # tandemd
npm run desktop   # Electron app
```

On macOS the Dock takes an app's name from its bundle, and the development app
runs Electron's own `Electron.app`. So `npm ci` runs `scripts/dev-bundle-name.mjs`
as a `postinstall` step, which renames that bundle to Tandemise and gives it the
Tandemise icon. If the Dock still says "Electron" (for example after
`npm ci --ignore-scripts`), run `npm run dev:bundle-name` and restart the app.

`@tandemise/terminal` uses `node-pty`, a native module. On Linux `npm ci` needs
build tools to compile it: `g++`, `make` and `python3` (on Debian or Ubuntu,
`sudo apt install build-essential python3`). macOS needs the Xcode command line
tools.

## Before you open a pull request

Run what CI runs:

```bash
npm run ci
```

That runs, in order:

| Step | What it fails on |
| --- | --- |
| `npm run build` | a TypeScript error in any package or app |
| `npm run check:boundaries` | a `packages/*` import that is undeclared or goes to an equal or higher layer; a provider module (`electron`, `better-sqlite3`, `child_process`, …) in a core package; a renderer value import of a `@tandemise/*` package that is not a listed pure subpath or a UI package; `@tandemise/design` importing anything outside itself (`react` only under `src/react/`); `apps/relay` importing beyond its allowlist; `packages/application` importing the coordination store instead of `@tandemise/coordination/rules`. It does not read the desktop's main process or the daemon. |
| `npm run check:design` | the design system rules in `docs/DESIGN_SYSTEM.md`: stale emitted tokens or a contrast pairing below its ratio, a colour literal outside `tokens.ts`, an undefined or fallback `var()`, a React component of `@tandemise/design` with no Storybook story, a token name Tailwind keeps for itself, a native `title` attribute in the renderer (use `Tooltip`) |
| `npm run check:licenses` | a dependency whose license does not fit Apache-2.0 |
| `npm run check:windows-hide` | a `node:child_process` call in `apps/*/src` or `packages/*/src` without `windowsHide: true` |
| `npm run -w @tandemise/desktop typecheck` | a type error in the desktop app |
| `npm run check:offline` | any offline end-to-end check in `scratch/` (the list is `OFFLINE_CHECKS` in `scripts/run-checks.mjs`). It includes `version-check`: every `apps/*` and `packages/*` package must be listed in `release-please-config.json` and be at the manifest's version. |

`node scripts/run-checks.mjs <name>` runs one offline check. The checks that
need a signed-in runtime, a browser or macOS permissions are listed in
`docs/QUICKSTART.md`; run the ones that cover your change by hand.
`p3-contributions-check` needs a global git identity (CI sets one); do not
change your own global git config just to make it pass locally.

A change to `packages/design` also needs the Storybook job, which CI runs
separately. WCAG 2.1 AA is the minimum for every component, in light and dark:

```bash
npm run -w @tandemise/design storybook:typecheck
npm run -w @tandemise/design storybook:build
npm run -w @tandemise/design storybook:a11y      # axe and play functions on every story, light and dark
```

`storybook:a11y` drives a local Chrome or Chromium (set `CHROME_PATH` to pick
one). On `main`, CI publishes the Storybook to
https://tandemise.github.io/tandemise/.

### Proving it in the real app

UI and behaviour changes are proven in the real window, not only by the checks
above. Each feature has a real-app acceptance suite under `scratch/acceptance/`:
a fresh `TANDEMISE_HOME`, the daemon from your build, `electron-vite dev` driven
over CDP, and evidence (`REPORT.md`, screenshots) written to the suite's folder
or to `docs/superpowers/evidence/`. Run `npm run build` first.

| Suite | Proves |
| --- | --- |
| `scratch/acceptance/integrated/run-all.mjs` | the pivot end to end: intake → Board → Start → hold → pull request → tracker → who's working on what |
| `scratch/acceptance/p0/run-all.mjs` | a mission with your agents, every decision made in the window ([README](scratch/acceptance/p0/README.md)) |
| `scratch/acceptance/hold/run-all.mjs` | hold and interact; with `claude` on `PATH`, one scenario also on real Claude Code |
| `scratch/acceptance/brain/run-all.mjs` | two installations sharing one brain |
| `scratch/acceptance/intake/run-all.mjs` | intake into the tracker and closing the loop (`--real-youtrack` is opt-in) |
| `scratch/acceptance/planner/run-all.mjs` | lanes, "Why these steps", the ship step and its merge decision |
| `scratch/acceptance/relay/run-all.mjs` | two windows and one relay |
| `scratch/acceptance/a11y/run-all.mjs` | WCAG 2.1 AA: every screen and state in light and dark under axe, structure, names, a keyboard pass, reflow and text spacing (CI: "Accessibility (desktop)") |
| `p3`, `p3-evals`, `p5` … `p16`, `about`, `daemon-retry`, `plan-fit`, `replan` | the earlier features, one suite each |

Most suites take `--keep-going` and `--only=<ids>`. `p0`, `integrated`, `hold`,
`brain`, `intake`, `planner` and `relay` also take `--keep-painting` (or
`ACCEPTANCE_KEEP_PAINTING=1`): on a machine whose display goes idle during the
run, an undriven window stops painting and a scenario that waits for a frame
(the hold terminal) stalls, so the suite asks the window for a tiny screenshot
once a second. `scratch/desktop-live-check.mjs` is the smallest example of the
pattern.

The optional team relay (`apps/relay`) is checked by `relay-check` (the server
from its build: invites, racing claims, the stream, take-over, the webhook
mailbox and its limits, the CLI) and `coordination-daemon-check` (one relay and
two daemons, online and offline). `npm run check:boundaries` holds
`apps/relay/src` to `@tandemise/api-contract/relay`, `@tandemise/coordination`,
`ws`, `better-sqlite3`, `zod` and `node:*`, so it can move to its own repository
mechanically. Its real-app acceptance is `node scratch/acceptance/relay/run-all.mjs`
(two windows); its Docker image is built in CI.

The desktop app meets WCAG 2.1 AA (`docs/DESIGN_SYSTEM.md`, "Accessibility").
A UI change is checked in the real window by
`node scratch/acceptance/a11y/run-all.mjs --keep-painting` (every screen and
state in light and dark: axe-core's A+AA rules, one `main` and one `h1`, named
controls, a keyboard pass, reflow at 320 CSS px and text spacing; `--only=inbox`
for one screen). CI runs it as "Accessibility (desktop)" under xvfb.

## Branches, pull requests and commits

- `main` is protected. Every change lands through a pull request that passes CI.
- Pull requests are **squash-merged**. The PR title becomes the commit on `main`,
  so it must follow [Conventional Commits](https://www.conventionalcommits.org/):

  ```
  <type>(<optional scope>): <lowercase subject>
  ```

  | Type | Use it for | Release effect |
  |---|---|---|
  | `feat` | a user-visible capability | minor bump (patch while < 1.0) |
  | `fix` | a bug fix | patch bump |
  | `perf` | a performance improvement | patch bump |
  | `refactor`, `docs`, `test`, `build`, `ci`, `chore` | everything else | no release on its own |

  Add `!` after the type (`feat(api)!: ...`) or a `BREAKING CHANGE:` footer for
  breaking changes.
- Keep pull requests focused. One concern per PR makes review and the changelog clearer.
- Keep the branch up to date with `main` before merging.

## Repository settings

`main` is guarded by the ruleset in `.github/rulesets/main.json`: no direct
pushes, force pushes or deletion; changes arrive by squash-merged pull request
with resolved conversations and passing `Build & typecheck`, `Offline checks` and
`Conventional PR title` checks. Admins can bypass only through a pull request.
To change it, edit the file and re-apply it:

```bash
gh api -X PUT repos/tandemise/tandemise/rulesets/<id> --input .github/rulesets/main.json
```

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please).

1. Every merge to `main` updates an open **release PR** (`chore(main): release x.y.z`)
   that bumps the version and writes `CHANGELOG.md` from the commit history.
2. Merging that PR tags `vx.y.z` and publishes a GitHub Release.

3. The same workflow then runs **Desktop packages** (`.github/workflows/desktop-packages.yml`),
   which builds the installers on Linux, macOS and Windows runners and attaches
   them to that release.

The whole monorepo shares one version. All `@tandemise/*` packages, the daemon
and the desktop app move together. Never edit versions or `CHANGELOG.md` by hand.

## Packaging the desktop app

The installers are built with [electron-builder](https://www.electron.build/)
(`apps/desktop/electron-builder.config.mjs`):

| Platform | Targets | Built on |
| --- | --- | --- |
| Linux | AppImage, .deb (x64) | `ubuntu-latest` |
| macOS | .dmg, arm64 and x64 | `macos-latest` |
| Windows | NSIS installer (x64) | `windows-latest` |

To build this platform's installers locally:

```bash
npm ci
npm run build
npm run -w @tandemise/desktop package                     # every target for this OS
npm run -w @tandemise/desktop package -- --linux AppImage # just one
```

They land in `apps/desktop/release/` (git-ignored). Each platform is built on
its own OS: the daemon's native modules are picked per platform, so there is no
cross-building (macOS builds both arches on one Mac).

How it fits together:

- **The app carries its daemon.** electron-builder's `afterPack` hook runs
  `apps/desktop/scripts/stage-daemon.mjs`, which copies `apps/daemon/dist`, the
  `dist/` of every `@tandemise/*` package it reaches and the exact third-party
  modules the lockfile installed into `resources/daemon/`, keeps only the target's
  native binaries, and (on the target's own OS and arch) loads them under
  Electron's Node as a check. `node apps/desktop/scripts/stage-daemon.mjs` runs it
  on its own.
- **No system Node.** A packaged app starts that daemon with its own Electron
  binary in Node mode (`ELECTRON_RUN_AS_NODE=1`; Electron 44 embeds Node 24),
  never a `node` from `PATH` (`bundledDaemonNode` in
  `apps/desktop/src/main/node-runtime.ts`). Electron's `runAsNode` fuse must
  therefore stay enabled. A checkout still runs `apps/daemon/dist/main.js` on
  your own Node 22+, as before.
- **Native modules need no rebuild.** `better-sqlite3` (13+) and `node-pty` (1.x)
  are N-API addons, so the same binary loads under Node 22 and Electron 44. What
  must match is the platform and CPU: better-sqlite3 ships prebuilt binaries for
  all of them; node-pty ships them for macOS and Windows and is compiled by
  `npm ci` on Linux.
- **The daemon's children do not inherit Node mode.** The daemon drops
  `ELECTRON_RUN_AS_NODE` from its environment at startup and sets it only where it
  runs its own binary again (`ownNodeEnv` in `@tandemise/shared`): the MCP server
  it gives an agent, the fake runtime's session.
- **The desktop bundle has no `node_modules`.** electron-vite bundles everything
  the main process, preload and renderer use, which is why the desktop's packages
  are all `devDependencies`.
- **No console windows on Windows.** Every `node:child_process` call in
  `apps/*/src` and `packages/*/src` passes `windowsHide: true`;
  `npm run check:windows-hide` (part of `npm run ci`) fails on one that does not.
- **One app at a time.** A packaged app takes Electron's single-instance lock;
  opening it again focuses the window already open. Development runs skip the
  lock so test harnesses can run windows side by side.

The real-app check for a packaged build is `scratch/packaged-live-check.mjs`:
it starts the build with no `node` on `PATH` and a fresh `TANDEMISE_HOME`, and
drives the window over CDP through connecting, creating a project and typing
into a hold terminal:

```bash
node scratch/packaged-live-check.mjs --packaged apps/desktop/release/Tandemise-<version>-linux-x86_64.AppImage
node scratch/packaged-live-check.mjs --packaged … --simulate-upgrade   # an older daemon is running first
```

### Signing and notarization

Unsigned builds work, so every signing input is optional and the build skips
signing when it is absent. macOS builds are then ad-hoc signed (Gatekeeper warns
on first open) and Windows builds are unsigned (SmartScreen warns). To sign,
the repository owner adds these **Actions secrets** (Settings → Secrets and
variables → Actions). They are never committed.

| Secret | What it is |
| --- | --- |
| `MAC_CSC_LINK` | Developer ID Application certificate with its private key, exported as `.p12`, base64-encoded (`base64 -i cert.p12`) |
| `MAC_CSC_KEY_PASSWORD` | The `.p12` export password |
| `APPLE_ID` | Apple ID of an Apple Developer Program member, for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password for that Apple ID (appleid.apple.com) |
| `APPLE_TEAM_ID` | The 10-character Team ID |
| `WIN_CSC_LINK` | Windows Authenticode code-signing certificate, `.pfx`, base64-encoded |
| `WIN_CSC_KEY_PASSWORD` | The `.pfx` password |

Notarization runs only when all three `APPLE_*` secrets are present. The macOS
hardened-runtime entitlements are in `apps/desktop/build/entitlements.mac.plist`:
`allow-jit` (V8) and `disable-library-validation` (the daemon's native addons
are not signed by our team); `allow-unsigned-executable-memory` is not granted.
A Windows certificate kept in a cloud HSM (Azure Trusted Signing and the like)
needs electron-builder's `win.azureSignOptions` instead of `WIN_CSC_LINK`.

Each matrix leg sees only its own platform's secrets, `release-please.yml`
passes exactly these seven by name (no `secrets: inherit`), the build legs run
with a read-only token that is not persisted in the checkout, and only the
`attach` job, which runs no repository code, may write to the release - and
only after all three platforms built.

To rebuild the installers of an existing release by hand, run **Actions →
Desktop packages → Run workflow** with its tag (e.g. `v0.10.0`); with no tag the
installers are only kept as workflow artifacts.

### Accepted risk: the `runAsNode` fuse stays enabled

The app runs its daemon as `Tandemise ELECTRON_RUN_AS_NODE=1 main.js`, so
Electron's `runAsNode` fuse cannot be turned off. With it on, anything that can
already run programs as the person can also start the signed Tandemise binary as
a plain Node interpreter, and that Node inherits the app's signature and its
entitlements (on macOS, JIT and loading unsigned libraries) - a way to run
arbitrary code under Tandemise's identity, for example past an allowlist that
trusts signed apps. It gives nothing to someone who cannot already run code on
the machine. The alternatives (shipping a separate Node binary to sign and
notarize, or bundling the daemon into a utility process) cost more than this
risk for a local-first developer tool, so it is accepted; revisit it if
Tandemise is ever distributed under a policy that relies on signed-app
allowlists. The other fuses keep their defaults.

### Upgrades

The daemon outlives the window, so after an update an old daemon may still be
running. A packaged app compares the version in `daemon.json` (also in
`GET /v1/health`) with its own; when they differ, it says "Tandemise was
updated; restarting its background service…", stops the old daemon with
`POST /v1/daemon/shutdown` (the same coordinated shutdown as SIGTERM, and the
only clean one on Windows), waits for it to exit, and starts its own. A checkout
never stops a daemon. Checks: `scratch/daemon-upgrade-check.mjs` (offline) and
`scratch/packaged-live-check.mjs --simulate-upgrade`.

On Windows the NSIS installer, before it upgrades or uninstalls, runs
electron-builder's "is the app running?" check, which finds every
`Tandemise.exe` - including the daemon, which is the same binary - asks the
person to close Tandemise, and then ends those processes. That stop is not the
coordinated shutdown: work in flight is reconciled by the daemon's crash
recovery on its next start, as after any crash. Not yet observed on a real
Windows machine.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
