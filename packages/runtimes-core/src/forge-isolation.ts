import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Keeps the person's code-host credentials out of a worker's shell (#147).
 *
 * A worker with a shell could run `gh pr create`, `gh api` or `curl` against
 * GitHub with the person's own sign-in, and nothing would ask or record it:
 * the tool broker, its approvals and the policy engine only see calls made
 * through the broker. So the runtime's environment carries no usable
 * GitHub credential:
 *
 * - token variables (`GH_TOKEN`, `GITHUB_TOKEN`, the enterprise ones) are
 *   removed;
 * - `gh` gets an empty config directory of the run's own (`GH_CONFIG_DIR`),
 *   so it is signed out and never prompts;
 * - git's credential helpers are cleared, its prompts and askpass programs
 *   switched off, and ssh runs without the agent or any key, so a push or an
 *   authenticated fetch fails instead of borrowing the person's login.
 *
 * The one exception is a step granted `git.push`: the factory's code steps
 * push their branch so the broker's `github.pr.create` (approved and
 * recorded) can open the pull request. Such a step keeps the person's git
 * credentials, and only git's: `gh` stays signed out, and a helper that asks
 * `gh` for the git credential with the person's real config is appended
 * (the run's own `gh` cannot answer it). That credential is readable by
 * whoever can run git in that shell; the docs say so.
 *
 * The daemon's own `gh` and git calls (the broker, the ship step) run with
 * the daemon's environment and are untouched.
 *
 * Defence in depth, not a sandbox: a worker runs as the person, so a process
 * set on finding the person's files can still read them. The real boundary
 * is the execution target's isolation.
 */

/** Variables that carry a code-host token, removed from every worker. */
export const FORGE_TOKEN_ENV: readonly string[] = [
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GITHUB_PAT',
];

/** Variables through which git or ssh would borrow a credential, removed unless the step may push. */
export const GIT_CREDENTIAL_ENV: readonly string[] = [
  'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND',
];

export interface ForgeIsolation {
  /** Variables to set, over whatever the runtime inherits. */
  readonly set: Readonly<Record<string, string>>;
  /** Variables to remove after everything else, so nothing inherited brings them back. */
  readonly unset: readonly string[];
  /** In words, for the run's log. */
  readonly summary: string;
}

/** Where the person's own `gh` keeps its sign-in, as `gh` itself would find it; null when there is none. */
export function personGhConfigDir(source: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = source['GH_CONFIG_DIR'];
  const candidates = [
    explicit,
    source['XDG_CONFIG_HOME'] === undefined ? undefined : join(source['XDG_CONFIG_HOME'], 'gh'),
    join(source['HOME'] ?? homedir(), '.config', 'gh'),
  ];
  for (const dir of candidates) if (dir !== undefined && dir !== '' && existsSync(dir)) return dir;
  return null;
}

/** POSIX shell single-quoting, for a path inside a helper command. */
function quote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

export function forgeIsolation(input: {
  /** The run's own empty `gh` config directory, beside its TANDEMISE_HOME. */
  readonly ghConfigDir: string;
  /** The step was granted `git.push`. */
  readonly push: boolean;
  readonly source?: NodeJS.ProcessEnv;
}): ForgeIsolation {
  const source = input.source ?? process.env;
  const ghDir = input.ghConfigDir;
  mkdirSync(ghDir, { recursive: true });
  const set: Record<string, string> = {
    GH_CONFIG_DIR: ghDir,
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  if (!input.push) {
    // An empty value resets the helper list; config from the environment is read last, so it wins.
    set['GIT_CONFIG_COUNT'] = '1';
    set['GIT_CONFIG_KEY_0'] = 'credential.helper';
    set['GIT_CONFIG_VALUE_0'] = '';
    set['GIT_SSH_COMMAND'] = 'ssh -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile=/dev/null';
    return {
      set,
      unset: [...FORGE_TOKEN_ENV, ...GIT_CREDENTIAL_ENV.filter((n) => n !== 'GIT_SSH_COMMAND')],
      summary: 'no GitHub credentials: gh is signed out, git cannot authenticate',
    };
  }
  const person = personGhConfigDir(source);
  if (person !== null) {
    // After the person's own helpers, which may ask the (now signed-out) gh first and get nothing.
    set['GIT_CONFIG_COUNT'] = '1';
    set['GIT_CONFIG_KEY_0'] = 'credential.helper';
    set['GIT_CONFIG_VALUE_0'] = `!GH_CONFIG_DIR=${quote(person)} gh auth git-credential`;
  }
  return {
    set,
    unset: [...FORGE_TOKEN_ENV],
    summary: 'gh is signed out; git keeps your credentials because this step may push',
  };
}

/** Applies an isolation to an environment: its unsets last, so nothing inherited survives them. */
export function applyForgeIsolation(env: NodeJS.ProcessEnv, isolation: ForgeIsolation): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, ...isolation.set };
  for (const name of isolation.unset) delete out[name];
  return out;
}
