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

/**
 * Shell commands that do what a Tandemise tool does, withheld from a run that
 * was granted the tool (#141).
 *
 * The tool goes through the broker: policy, the step's approval, a card when
 * one is needed, the audit trail. The same action typed into the shell goes
 * through none of it, so a worker whose tool call was refused or cut off could
 * open the pull request from Bash on its next try, and one attempt asked while
 * the next did not. With the tool granted there is a gated way to do it, and
 * it is the only way offered. Like the guards above this is defence in depth,
 * not the boundary - a determined agent has other ways to reach an API.
 */
export const GATED_SHELL_COPIES: ReadonlyArray<{ capability: Capability; rules: readonly string[] }> = [
  { capability: 'github.pr.create', rules: ['Bash(gh pr create:*)'] },
  { capability: 'github.pr.comment', rules: ['Bash(gh pr comment:*)'] },
  { capability: 'github.issue.create', rules: ['Bash(gh issue create:*)'] },
];

export function gatedShellCopies(grants: readonly Capability[]): string[] {
  if (!anyCapabilityMatches(grants, CORE_CAPABILITIES.shell)) return [];
  return GATED_SHELL_COPIES.filter((copy) => anyCapabilityMatches(grants, copy.capability)).flatMap((copy) => copy.rules);
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
  mode: PermissionMode = permissionMode(grants, settings),
): string[] {
  const rules = artifactOnly(grants) ? [ARTIFACT_WRITE_RULE] : [];
  if (!pinnedMode(settings) && anyCapabilityMatches(grants, CORE_CAPABILITIES.shell) && mode !== 'bypassPermissions') {
    rules.push(...SHELL_TOOLS);
  }
  return rules;
}

function pinnedMode(settings: Readonly<Record<string, unknown>>): boolean {
  return typeof settings['permissionMode'] === 'string' && (PERMISSION_MODES as readonly string[]).includes(settings['permissionMode']);
}

/**
 * The mode of a held (interactive) session. Interactive Claude Code opens
 * `bypassPermissions` on a "Bypass Permissions mode" warning whose default
 * answer is "No, exit" (#102): a person pressing Enter to get past it ends the
 * session they meant to steer. A person is at the keyboard during a hold, so
 * the grants' bypass becomes `acceptEdits` with the granted shell tools
 * allowed by rule: the same reach, and anything else asks the person present.
 * A profile that pins its mode keeps it (`interactiveSettings` then
 * acknowledges the warning for that session only).
 */
export function interactivePermissionMode(
  grants: readonly Capability[],
  settings: Readonly<Record<string, unknown>>,
): PermissionMode {
  const mode = permissionMode(grants, settings);
  return mode === 'bypassPermissions' && !pinnedMode(settings) ? 'acceptEdits' : mode;
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
function sharedFlags(request: RunRequest, interactive = false): string[] {
  const settings = request.profile.settings;
  const args: string[] = [];
  const mode = interactive ? interactivePermissionMode(request.grants, settings) : permissionMode(request.grants, settings);

  // The engine resolves the model per run (P12); an older caller leaves it to the profile.
  const model = request.model !== undefined ? request.model : settings['model'];
  if (typeof model === 'string' && model.length > 0) args.push('--model', model);

  args.push('--permission-mode', mode);

  // The user's own settings stay out unless the profile says otherwise. Loaded
  // by default, a worker ran the user's PreToolUse hooks (rewriting its shell
  // commands), their SessionStart injections, every personal plugin and skill,
  // and a memory plugin that recorded the worker's session - none of it part of
  // the role's instructions. Project and local settings - the repository's own
  // .claude - still apply. Verified against Claude Code 2.1.269.
  if (settings['userSettings'] !== 'inherit') args.push('--setting-sources', 'project,local');
  // The one plugin a step's skill comes from (#131), whether or not the
  // person's own settings are let in: naming it in a factory rule is the team
  // asking for it, and nothing else of theirs comes with it. Loaded twice (also
  // enabled in their settings) it is still one plugin. Verified on 2.1.316.
  for (const dir of request.skill?.pluginDirs ?? []) args.push('--plugin-dir', dir);

  const allowed = [...new Set([
    ...allowedToolRules(request.grants, settings, mode),
    // The run-scoped gateway only publishes tools this assignment was granted,
    // and every call through it is decided by Tandemise's policy engine - with
    // an approval card when the grant says ask. Without an allow rule headless
    // Claude Code refused each one outright ("requested permissions ... but you
    // haven't granted it yet"), so no worker could use a connected app at all.
    ...(request.mcpConfigPath !== null ? [TANDEMISE_MCP_RULE] : []),
    ...stringList(settings['allowedTools']),
  ])];
  if (allowed.length > 0) args.push('--allowed-tools', allowed.join(','));

  const disallowed = [...new Set([
    ...disallowedTools(request.grants),
    // Only with the tool surface: it is where the gated copy of the action lives.
    ...(request.mcpConfigPath !== null ? gatedShellCopies(request.grants) : []),
    ...stringList(settings['disallowedTools']),
  ])];
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
  const prompt = resumeSessionRef === null ? skillPrompt(request) : request.prompt;
  const viaStdin = prompt.length > MAX_PROMPT_ARG_CHARS;

  // The prompt sits immediately after `-p`. It cannot be appended at the end:
  // `--allowed-tools`/`--disallowed-tools`/`--add-dir` are variadic, so a
  // trailing positional is silently absorbed as one more of their values and
  // the CLI then exits complaining that no prompt was given.
  const args: string[] = viaStdin ? ['-p'] : ['-p', prompt];
  args.push('--output-format', 'stream-json', '--verbose');
  args.push(...sharedFlags(request));

  if (resumeSessionRef !== null) args.push('--resume', resumeSessionRef);
  args.push(...stringList(request.profile.args));

  return { args, stdin: viaStdin ? prompt : null };
}

/**
 * A fresh run of a step that runs a skill (#131) starts with the slash
 * command: Claude Code expands the skill and hands it everything after its
 * name - the arguments, then the step's context - as its input. A resumed
 * session already has the skill, so it is not sent again.
 */
export function skillPrompt(request: Pick<RunRequest, 'prompt' | 'skill'>): string {
  if (request.skill === undefined) return request.prompt;
  const command = `/${request.skill.name}${request.skill.args === '' ? '' : ` ${request.skill.args}`}`;
  return `${command}\n\n${request.prompt}`;
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
  const args = sharedFlags(request, true);
  args.push('--settings', JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: sessionHookCommand(opts.sessionFile) }] }],
      // What the person types is kept for the step's later attempts (#117).
      ...(opts.promptsFile === undefined ? {} : {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: promptHookCommand(opts.promptsFile) }] }],
      }),
    },
    // A profile that pinned bypassPermissions chose it for Tandemise's own
    // worktree: the warning is acknowledged in this session's flag settings,
    // never in the person's Claude Code config. Verified on Claude Code 2.1.316.
    ...(interactivePermissionMode(request.grants, request.profile.settings) === 'bypassPermissions'
      ? { skipDangerousModePermissionPrompt: true }
      : {}),
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
