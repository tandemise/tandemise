import { ARTIFACT_OUT_DIR, CORE_CAPABILITIES, anyCapabilityMatches } from '@tandemise/domain';
import type { Capability, InteractiveInvocation } from '@tandemise/domain';
import type { RunRequest } from '@tandemise/runtimes-core';
import { isPathInside } from '@tandemise/shared';
import { realpathSync } from 'node:fs';

/** The path with symlinks resolved, or as given when it does not exist (yet). */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export const PERMISSION_MODES = ['default', 'plan', 'acceptEdits', 'bypassPermissions'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * Tools Claude Code must not be offered when the corresponding capability was
 * not granted (MVP.md §19.2).
 *
 * This is defence in depth and a UX affordance, not the security boundary: the
 * boundary is Tandemise's policy layer plus the execution target's isolation. A
 * CLI flag is only as trustworthy as the CLI, so it is used to keep an honest
 * agent inside its lane, never to contain a hostile one.
 */
export const CAPABILITY_TOOL_GUARDS: ReadonlyArray<{ capability: Capability; tools: readonly string[] }> = [
  { capability: CORE_CAPABILITIES.shell, tools: ['Bash', 'BashOutput', 'KillShell'] },
  { capability: CORE_CAPABILITIES.filesystemWrite, tools: ['Edit', 'Write', 'NotebookEdit'] },
];

/**
 * A run that may write artifacts but not the tree still needs a file tool:
 * the artifact hand-off is a file in `.tandemise/out/`. Disallowing Write for
 * every run without `filesystem.write` left each product, design, architecture
 * and finance run unable to deliver - it did the research, then failed its
 * `artifact.*.exists` gate with the finished document stranded in a message.
 *
 * So `artifact.write` alone keeps Edit and Write offered and allows them only
 * under the out directory. In headless mode a write that matches no allow rule
 * is refused rather than prompted, so the rest of the tree stays read-only.
 * `Edit(...)` is the rule form the CLI applies to every file-editing tool;
 * a `Write(...)` rule is ignored with a warning.
 */
export const ARTIFACT_ONLY_TOOLS: readonly string[] = ['Edit', 'Write'];
export const ARTIFACT_WRITE_RULE = `Edit(${ARTIFACT_OUT_DIR}/**)`;

function artifactOnly(grants: readonly Capability[]): boolean {
  return anyCapabilityMatches(grants, CORE_CAPABILITIES.artifactWrite)
    && !anyCapabilityMatches(grants, CORE_CAPABILITIES.filesystemWrite);
}

export function disallowedTools(grants: readonly Capability[]): string[] {
  const disallowed = CAPABILITY_TOOL_GUARDS
    .filter((guard) => !anyCapabilityMatches(grants, guard.capability))
    .flatMap((guard) => guard.tools);
  return artifactOnly(grants) ? disallowed.filter((tool) => !ARTIFACT_ONLY_TOOLS.includes(tool)) : disallowed;
}

/** The shell tools, allowed outright for a run granted shell that is not already bypassing prompts. */
export const SHELL_TOOLS: readonly string[] = CAPABILITY_TOOL_GUARDS[0]!.tools;

/**
 * Scoped allow rules implied by the grants, on top of any the profile configures.
 *
 * A run granted shell but not `filesystem.write` (review, QA) runs in `default`
 * mode so its edits stay scoped. Headless, `default` refuses every shell
 * command that is not plainly read-only ("This command requires approval"):
 * a real reviewer could read the diff but never run `npm test`, said so in its
 * handoff, and still passed. The grant has already said yes to shell, so the
 * shell tools are allowed by rule. A profile that pins `permissionMode` chose
 * its prompts on purpose and gets no rule.
 */
export function allowedToolRules(
  grants: readonly Capability[],
  settings: Readonly<Record<string, unknown>> = {},
): string[] {
  const rules = artifactOnly(grants) ? [ARTIFACT_WRITE_RULE] : [];
  const pinned = typeof settings['permissionMode'] === 'string' && (PERMISSION_MODES as readonly string[]).includes(settings['permissionMode']);
  if (!pinned && anyCapabilityMatches(grants, CORE_CAPABILITIES.shell) && permissionMode(grants, settings) !== 'bypassPermissions') {
    rules.push(...SHELL_TOOLS);
  }
  return rules;
}

/**
 * Chooses the headless permission mode.
 *
 * Headless Claude Code cannot answer an interactive permission prompt: a run
 * that triggers one blocks until its wall-time budget kills it. So the mode is
 * derived from what the assignment already granted:
 *
 *  - write **and** shell granted → `bypassPermissions`. The grant has already
 *    said yes to the two things that prompt, and Tandemise's own policy layer
 *    plus the execution target's workspace isolation are the real gate.
 *  - write granted, shell not → `acceptEdits`. Edits proceed; a shell attempt
 *    still prompts, which is the correct outcome for an ungranted capability.
 *  - shell granted, write not → `default`, with the shell tools allowed by
 *    rule (`allowedToolRules`), so commands run and edits stay scoped.
 *  - neither → `default`. With the write and shell tools already disallowed,
 *    the remaining toolset is read-only and does not prompt.
 *
 * `profile.settings.permissionMode` overrides all of this, because an operator
 * running against a sensitive workspace must be able to be stricter than the
 * grants imply.
 */
export function permissionMode(
  grants: readonly Capability[],
  settings: Readonly<Record<string, unknown>>,
): PermissionMode {
  const configured = settings['permissionMode'];
  if (typeof configured === 'string' && (PERMISSION_MODES as readonly string[]).includes(configured)) {
    return configured as PermissionMode;
  }
  const canWrite = anyCapabilityMatches(grants, CORE_CAPABILITIES.filesystemWrite);
  const canShell = anyCapabilityMatches(grants, CORE_CAPABILITIES.shell);
  if (canWrite && canShell) return 'bypassPermissions';
  if (canWrite) return 'acceptEdits';
  return 'default';
}

/**
 * Prompts above this go on stdin instead of argv. A compiled context pack can
 * be large, and `execve` fails outright past the platform's argument limit -
 * a failure mode that would look like "the runtime is broken" rather than
 * "the prompt is long".
 */
export const MAX_PROMPT_ARG_CHARS = 64 * 1024;

/** Every tool of the run-scoped Tandemise MCP server. */
export const TANDEMISE_MCP_RULE = 'mcp__tandemise';

/** An inline MCP config with no servers: strict mode with nothing in it. */
export const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';

export interface ClaudeInvocation {
  readonly args: readonly string[];
  /** Non-null when the prompt goes on stdin rather than argv. */
  readonly stdin: string | null;
}

/**
 * The flags both modes share: model, permissions, tool rules, extra roots and
 * the strict MCP config. Headless and interactive each add their own framing
 * around this one list, so the two cannot drift apart.
 */
function sharedFlags(request: RunRequest): string[] {
  const settings = request.profile.settings;
  const args: string[] = [];

  // The engine resolves the model per run (P12); an older caller leaves it to the profile.
  const model = request.model !== undefined ? request.model : settings['model'];
  if (typeof model === 'string' && model.length > 0) args.push('--model', model);

  args.push('--permission-mode', permissionMode(request.grants, settings));

  // The user's own settings stay out unless the profile says otherwise. Loaded
  // by default, a worker ran the user's PreToolUse hooks (rewriting its shell
  // commands), their SessionStart injections, every personal plugin and skill,
  // and a memory plugin that recorded the worker's session - none of it part of
  // the role's instructions. Project and local settings - the repository's own
  // .claude - still apply. Verified against Claude Code 2.1.269.
  if (settings['userSettings'] !== 'inherit') args.push('--setting-sources', 'project,local');

  const allowed = [...new Set([
    ...allowedToolRules(request.grants, settings),
    // The run-scoped gateway only publishes tools this assignment was granted,
    // and every call through it is decided by Tandemise's policy engine - with
    // an approval card when the grant says ask. Without an allow rule headless
    // Claude Code refused each one outright ("requested permissions ... but you
    // haven't granted it yet"), so no worker could use a connected app at all.
    ...(request.mcpConfigPath !== null ? [TANDEMISE_MCP_RULE] : []),
    ...stringList(settings['allowedTools']),
  ])];
  if (allowed.length > 0) args.push('--allowed-tools', allowed.join(','));

  const disallowed = [...new Set([...disallowedTools(request.grants), ...stringList(settings['disallowedTools'])])];
  if (disallowed.length > 0) args.push('--disallowed-tools', disallowed.join(','));

  // The working directory is implicit (it is the child's cwd); only additional
  // roots need declaring, and only roots outside it are additional. The cwd
  // resolves symlinks, so Claude Code trusts only the real path while the
  // prompt names the path as given (macOS /tmp is itself a link): a real run
  // had every read of its own repository refused. Declare the spelling it
  // would otherwise not recognise, for the working directory and each root.
  const dirs = new Set<string>();
  const cwd = request.workingDirectory;
  if (realPath(cwd) !== cwd) dirs.add(cwd);
  for (const root of request.allowedRoots) {
    if (isPathInside(cwd, root)) continue;
    dirs.add(root);
    const real = realPath(root);
    if (real !== root) dirs.add(real);
  }
  for (const dir of dirs) args.push('--add-dir', dir);

  // Always strict. Without --strict-mcp-config the CLI merges the user's own
  // MCP servers - their Gmail, Drive, Notion - into the run. Passing it only
  // when Tandemise had tools to offer left every run *without* granted tools
  // holding all of the user's personal servers, ungranted and unaudited: a
  // design worker searched its tools and found the user's Notion connector.
  if (request.mcpConfigPath !== null) {
    args.push('--mcp-config', request.mcpConfigPath, '--strict-mcp-config');
  } else {
    args.push('--mcp-config', EMPTY_MCP_CONFIG, '--strict-mcp-config');
  }

  return args;
}

/**
 * Builds the full argv for one run. Pure, so the flag mapping can be asserted
 * without spawning anything.
 */
export function buildInvocation(request: RunRequest, resumeSessionRef: string | null): ClaudeInvocation {
  const viaStdin = request.prompt.length > MAX_PROMPT_ARG_CHARS;

  // The prompt sits immediately after `-p`. It cannot be appended at the end:
  // `--allowed-tools`/`--disallowed-tools`/`--add-dir` are variadic, so a
  // trailing positional is silently absorbed as one more of their values and
  // the CLI then exits complaining that no prompt was given.
  const args: string[] = viaStdin ? ['-p'] : ['-p', request.prompt];
  args.push('--output-format', 'stream-json', '--verbose');
  args.push(...sharedFlags(request));

  if (resumeSessionRef !== null) args.push('--resume', resumeSessionRef);
  args.push(...stringList(request.profile.args));

  return { args, stdin: viaStdin ? request.prompt : null };
}

/**
 * The script a SessionStart hook runs: read the hook's JSON from stdin and
 * write its `session_id` to the session file, so the engine can learn the
 * session id after a person has been driving it. It runs on the daemon's own
 * runtime, never a `node` looked up on PATH: a packaged app has none, and its
 * Electron binary acts as Node under ELECTRON_RUN_AS_NODE (plain Node ignores
 * the variable). The path is a JSON string literal inside the script, and the
 * script uses double quotes only, so wrapping it in single quotes for the shell
 * needs just the one escape for a single quote in the path.
 */
function sessionHookCommand(sessionFile: string): string {
  const script = `let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{require("fs").writeFileSync(${JSON.stringify(sessionFile)},String(JSON.parse(d).session_id))}catch{}})`;
  return `ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
}

/**
 * The script a UserPromptSubmit hook runs: append the person's message, with
 * the time, as one JSON line to the prompts file. Same runtime and quoting
 * rules as {@link sessionHookCommand}; it prints nothing, so it adds nothing to
 * the conversation.
 */
function promptHookCommand(promptsFile: string): string {
  const script = `let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const p=JSON.parse(d).prompt;if(typeof p==="string"&&p.trim()){require("fs").appendFileSync(${JSON.stringify(promptsFile)},JSON.stringify({at:new Date().toISOString(),prompt:p})+"\\n")}}catch{}})`;
  return `ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
}

/** One word for a POSIX shell: single-quoted, with each single quote closed, escaped and reopened. */
function shellQuote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * The argv, env and cwd to start Claude Code's own interactive CLI for a hold:
 * the same flags as a headless run, minus the stream framing, plus a hook that
 * records the session id. The caller supplies the env base because only the
 * adapter knows which variables the CLI may inherit.
 */
export function buildInteractiveInvocation(
  request: RunRequest,
  sessionRef: string | null,
  opts: { readonly sessionFile: string; readonly initialPrompt: string | null; readonly promptsFile?: string },
): Pick<InteractiveInvocation, 'args' | 'sessionFile'> {
  const args = sharedFlags(request);
  args.push('--settings', JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: sessionHookCommand(opts.sessionFile) }] }],
      // What the person types is kept for the step's later attempts (#117).
      ...(opts.promptsFile === undefined ? {} : {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: promptHookCommand(opts.promptsFile) }] }],
      }),
    },
  }));
  if (sessionRef !== null) args.push('--resume', sessionRef);
  args.push(...stringList(request.profile.args));
  // After `--`, so the variadic flags above cannot absorb the prompt.
  if (sessionRef === null && opts.initialPrompt !== null) args.push('--', opts.initialPrompt);
  return { args, sessionFile: opts.sessionFile };
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}
