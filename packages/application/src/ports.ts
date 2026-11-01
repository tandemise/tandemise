import type { ArtifactHandoff, ArtifactType, SkillFile, WorkflowDefinition, WorkflowIssue } from '@tandemise/domain';
import type { Result, Timestamp } from '@tandemise/shared';
import type {
  ClaimView, CoordDeviceView, CoordMemberView, CreateEndpointRequest, CreateInviteRequest, EndpointView, ImportReport, LeaseRequest, LeaseView, MailboxMessage, PresenceView,
} from '@tandemise/api-contract/relay';

/**
 * Ports the mission engine owns.
 *
 * Each of these exists for the same reason: the engine needs a capability that
 * a *lower* layer already implements, and `@tandemise/application` may not
 * import that layer. Rather than duplicate the implementation, the engine
 * states the narrowest contract it needs and the composition root binds it.
 */

/**
 * The authoring template for an artifact type, as handed to a worker inside the
 * output contract. Bound to `renderArtifactTemplate` from
 * `@tandemise/artifacts`.
 *
 * Every artifact type has a template, since every one carries a handoff.
 * `undefined` stays in the contract so a binding without a template for some
 * type still works: the task names the file it must write, it simply has no
 * skeleton to fill in.
 */
export interface ArtifactTemplatePort {
  render(type: ArtifactType): string | undefined;
}

export interface ArtifactParseIssue {
  /** Dotted path into the front matter, e.g. `findings.0.severity`. */
  readonly path: string;
  readonly message: string;
}

export interface ParsedArtifactDocument {
  readonly type: ArtifactType;
  readonly frontMatter: Readonly<Record<string, unknown>>;
  readonly body: string;
}

/**
 * Validates an agent-authored artifact against its front-matter contract.
 * Bound to `parseArtifact` from `@tandemise/artifacts`.
 *
 * Returns a `Result` because a malformed artifact is the ordinary way a first
 * attempt fails; the issues are fed straight back into the retry prompt.
 */
export interface ArtifactParserPort {
  parse(type: ArtifactType, source: string): Result<ParsedArtifactDocument, readonly ArtifactParseIssue[]>;
}

/** An artifact body measured against its type's word budget. */
export interface ArtifactBodyMeasure {
  /** Words before `## Appendix`, excluding fenced code and tables. */
  readonly mainWords: number;
  readonly appendixWords: number;
  readonly codeLines: number;
  readonly hasAppendix: boolean;
  /** The type's main-body budget, in words. */
  readonly budget: number;
  readonly overBudget: boolean;
}

/**
 * Length budgets, derived handoffs and the appendix split. Bound to
 * `measureArtifact`, `deriveHandoff` and `splitAppendix` from
 * `@tandemise/artifacts`.
 *
 * The engine needs both to decide whether a round gets a tighten pass and to
 * give a person's work the same headline an agent's carries, and the rules
 * themselves belong with the schemas that quote the same numbers.
 */
export interface ArtifactMeasurePort {
  measure(type: ArtifactType, body: string): ArtifactBodyMeasure;
  deriveHandoff(text: string): ArtifactHandoff;
  /** Cuts a body at its first `## Appendix` heading, with the same fence and table rules `measure` uses. */
  splitAppendix(body: string): { main: string; appendix: string | null };
}

/** User-visible daemon settings. The application only reads and merges them. */
export interface SettingsStorePort {
  read(): Record<string, unknown>;
  write(patch: Record<string, unknown>): Record<string, unknown>;
}

/**
 * Facts about the running daemon that only the composition root knows. Supplied
 * rather than read from `process` so the application layer stays a pure
 * consumer of its environment.
 */
export interface SystemEnvironmentPort {
  readonly daemonVersion: string;
  readonly daemonBuild: string;
  readonly schemaVersion: number;
  readonly home: string;
  readonly startedAt: Timestamp;
  readonly pid: number;
  readonly platform: string;
  readonly nodeVersion: string;
}

/**
 * "Is this process id still running?"
 *
 * Recovery has to answer that for a pid recorded by a *previous* daemon, which
 * no supervisor in this process knows anything about (MVP.md §21.2).
 */
export interface ProcessLivenessPort {
  isAlive(pid: number): boolean;
}

/**
 * A workflow file found in a project's repository.
 *
 * Either it parsed or it did not; a file with problems is still listed, with
 * its issues, because a workflow that silently disappears from the list is far
 * harder to debug than one that shows up saying what is wrong with it.
 */
export interface LoadedWorkflow {
  /** Filename without extension - what a mission names to run it. */
  readonly id: string;
  /** Absolute path, so the UI can open the file that needs fixing. */
  readonly path: string;
  readonly definition: WorkflowDefinition | null;
  readonly issues: readonly WorkflowIssue[];
  /** The file's text as it is on disk, so an export can copy it byte for byte (P15). */
  readonly text?: string;
  /** Where it was read from: the project's brain, or a code repository (#51). */
  readonly origin?: 'brain' | 'repository';
}

/**
 * Where workflow files come from.
 *
 * A port because reading files is not the application layer's business, and
 * because the same list has to be producible from a fixture in a test. The
 * convention - `.tandemise/workflows/*.yaml` inside each of the project's
 * repositories - lives in the adapter.
 */
export interface WorkflowSourcePort {
  list(repositoryPaths: readonly string[]): Promise<readonly LoadedWorkflow[]>;
}

/**
 * A `.tandemise` setup folder on disk (P15). The codec decides what the files
 * say; this port only reads and writes them, and asks git about them.
 */
export interface SetupFolderPort {
  /**
   * The files of `<folder>/.tandemise/` - or of `folder` itself when it is a
   * `.tandemise` folder - as path (relative to it) → text. Null when there is
   * no such folder. `root` names another setup folder: a brain passes `factory`.
   */
  read(folder: string, opts?: { readonly root?: string }): Promise<{ readonly root: string; readonly files: Readonly<Record<string, string>>; readonly ignored: readonly string[] } | null>;
  /**
   * Stages writes (absolute path → text) next to their destinations. Nothing
   * is visible until `commit` renames them into place and deletes `remove`;
   * `discard` drops the staged files. Staging throws on the first failure,
   * having discarded what it staged.
   */
  stage(changes: { readonly write: Readonly<Record<string, string>>; readonly remove: readonly string[] }): Promise<StagedSetupWrite>;
  /**
   * Repairs Tandemise's own old ignore lines in the repository (an exact old
   * `.tandemise/.gitignore`, an exact `.tandemise/` exclude line), then says
   * which of `paths` git still ignores, and why, in words.
   */
  gitWarnings(repositoryPath: string, paths: readonly string[]): Promise<readonly string[]>;
}

export interface StagedSetupWrite {
  commit(): Promise<void>;
  discard(): Promise<void>;
}

/** What the browser brought back to the loopback redirect. */
export interface OAuthCallback {
  readonly params: URLSearchParams;
  /** Answers the browser tab. Called exactly once per callback. */
  respond(outcome: { readonly ok: boolean; readonly title: string; readonly message: string }): void;
}

/**
 * A redirect URI that exists for one connect attempt (RFC 8252 §7.3).
 *
 * Bound in the daemon, which may listen on sockets. The listener is on
 * 127.0.0.1, on a port the OS picks, for as long as the attempt lasts - never on
 * the daemon's API port, whose every route requires the desktop's bearer token
 * and which a browser redirect could not present.
 */
export interface OAuthCallbackListener {
  readonly redirectUri: string;
  /** Resolves with the next request to the callback path. */
  next(signal: AbortSignal): Promise<OAuthCallback>;
  close(): void;
}

export interface OAuthCallbackPort {
  open(): Promise<OAuthCallbackListener>;
}

/**
 * A folder read as a skill (P13): every file's bytes, or the reason it was
 * refused. Reading stops at the first rule broken, so a huge folder is never
 * read in full. Name, description and hash are the application's to derive.
 */
export interface ScannedSkillFolder {
  /** The absolute folder that was read. */
  readonly folder: string;
  readonly files: readonly SkillFile[];
  readonly sizeBytes: number;
  /** Why it is not a skill that can be imported, in the person's words; null when it is. */
  readonly problem: string | null;
}

/** A skill folder discovery found, and where (#129). */
export interface DiscoveredSkillFolder {
  /** Absolute. */
  readonly path: string;
  readonly origin: 'personal' | 'plugin' | 'project';
  /** The folder it was found under: the personal root, a plugin's `skills`, a repository's `.claude/skills`. */
  readonly root: string;
  /** The grouping folder it sits in (`synced` for `synced/tdd`), or null at the top. */
  readonly group: string | null;
  readonly plugin?: { readonly name: string; readonly marketplace: string; readonly version: string };
  /** The repository's name, for a project skill. */
  readonly repository?: string;
}

/**
 * Where skills' files come from and where their content is kept (P13).
 *
 * A port because it reads the person's folders, clones repositories with `git`
 * and writes the content store - none of which the engine may do itself. The
 * daemon binds it (`skill-files.ts`); the default binding finds nothing.
 * Nothing behind this port ever executes a file it reads.
 */
export interface SkillFilesPort {
  /** Where "Your Claude skills" looks: ~/.claude/skills unless TANDEMISE_SKILLS_DISCOVER_DIR says otherwise. */
  discoverRoot(): string;
  /**
   * Every skill folder Claude Code keeps (#129): the personal root's, each
   * installed plugin's, and each given repository's `.claude/skills`, one
   * level of grouping folders walked. `exists` is about the personal root.
   */
  discover(repositories: readonly { readonly name: string; readonly path: string }[]): Promise<{
    readonly exists: boolean;
    readonly folders: readonly DiscoveredSkillFolder[];
  }>;
  /** Reads a folder under the skill rules: SKILL.md present, size and count limits, no link outside. */
  scan(folder: string): Promise<ScannedSkillFolder>;
  /** Clones a repository shallow into a temporary folder (hooks off, nothing run); `dispose` removes it. */
  fetchGit(source: { readonly url: string; readonly subpath?: string; readonly ref?: string }): Promise<{ readonly folder: string; dispose(): Promise<void> }>;
  /** Writes content under its hash, once (a hash already stored is left as it is). */
  store(hash: string, files: readonly SkillFile[]): Promise<void>;
  /** The stored files, or null when they are absent or no longer hash to `hash`. */
  read(hash: string): Promise<readonly SkillFile[] | null>;
  /** Removes stored content. */
  drop(hash: string): Promise<void>;
}

/**
 * The factory's files (#53): `planner.yaml`, `routing.yaml`, `merge.yaml`.
 * Read from each repository's `.tandemise/factory/`, then this computer's
 * `$TANDEMISE_HOME/factory/`, then the shipped defaults. The brain (#51)
 * becomes the first source once it lands.
 */
export const FACTORY_FILES = ['planner', 'routing', 'merge'] as const;
export type FactoryFileName = (typeof FACTORY_FILES)[number];

export interface LoadedFactoryFile {
  readonly name: FactoryFileName;
  readonly origin: 'brain' | 'project' | 'home' | 'shipped';
  /** Null for the shipped file. */
  readonly path: string | null;
  /** Parsed YAML, or the shipped object; null when `error` is set. */
  readonly raw: unknown;
  /** A YAML parse error. */
  readonly error: string | null;
  /** `shipped`, or `sha256:<first 12 hex>` of the file's text. */
  readonly ref: string;
}

export interface FactoryConfigSourcePort {
  /** With `workspaceId`, a project linked to a brain reads `factory/<name>.yaml` there first (#51, #53 Task 20). */
  read(name: FactoryFileName, repositoryPaths: readonly string[], workspaceId?: string): Promise<LoadedFactoryFile>;
  /** A person's edit or "Write the defaults": the brain's `factory/` when linked, else `<repo>/.tandemise/factory/<name>.yaml`. */
  write(name: FactoryFileName, repositoryPath: string, raw: unknown, workspaceId?: string): Promise<{ readonly path: string; readonly ref: string }>;
}

// ------------------------------------------------------------- coordination

/**
 * Who is working on which tracker item, with or without a team relay
 * (docs/superpowers/specs/2026-10-30-relay-design.md, §The coordination port).
 * The daemon binds it to the local store or to the relay client; the
 * application never learns which. Reads are synchronous from local tables and
 * never touch the network.
 */
export type CoordinationStatus =
  | { readonly kind: 'local' }
  | { readonly kind: 'connected'; readonly host: string; readonly teamName: string }
  | { readonly kind: 'offline'; readonly since: string; readonly pendingOps: number }
  | { readonly kind: 'refused'; readonly reason: string };

export type ClaimResult =
  | { readonly kind: 'claimed'; readonly claim: ClaimView }
  /** `mayTakeOver` is decided where the claim lives: the relay knows the time and who was seen when. */
  | { readonly kind: 'held_by'; readonly claim: ClaimView; readonly self: boolean; readonly sentence: string; readonly mayTakeOver: boolean }
  | { readonly kind: 'queued_offline'; readonly claim: ClaimView };

export interface ClaimSync {
  readonly sync: 'confirmed' | 'pending' | 'conflicted' | 'lost';
  readonly note: string | null;
  readonly decided: 'keep_going' | null;
}

export interface CoordinationMe {
  readonly memberId: string;
  readonly deviceId: string;
  readonly role: 'admin' | 'member';
  readonly displayName: string;
  readonly deviceLabel: string;
}

export type CoordinationTopic = 'claims' | 'members' | 'presence' | 'mailbox';

export interface CoordinationPort {
  readonly mode: 'local' | 'relay';
  status(): CoordinationStatus;
  me(): CoordinationMe;
  claim(input: { readonly projectKey: string; readonly itemRef: string; readonly itemTitle: string; readonly itemUrl: string | null; readonly localRef: string }): Promise<ClaimResult>;
  release(claimId: string, reason: 'done' | 'released'): Promise<void>;
  takeOver(claimId: string, localRef: string): Promise<ClaimResult>;
  /**
   * Takes or renews a short lease, `('source', id)` in a project (intake spec
   * §3, Ruling 22): with the relay, one daemon of the team holds it at a time;
   * solo it is always granted. Optional: a port without it grants everything.
   */
  lease?(input: LeaseRequest): Promise<LeaseView>;
  /** Active claims, from the local copy. */
  claims(projectKey?: string): readonly ClaimView[];
  /** The newest claim, active or ended, tied to a local mission. */
  claimByLocalRef(localRef: string): ClaimView | null;
  members(): readonly CoordMemberView[];
  presence(): readonly PresenceView[];
  /** When a member was last seen on any of their computers, as far as this install knows. */
  holderLastSeenAt(memberId: string): string | null;
  claimSync(claimId: string): ClaimSync;
  keepGoing(claimId: string): void;
  /**
   * A mission that could not claim its item in the background (it was already
   * held). Recorded under the claim id `lost:<localRef>`, so the mission shows
   * Unclaimed and the person decides.
   */
  markLost(localRef: string, note: string): void;
  onChange(listener: (topic: CoordinationTopic) => void): () => void;
  readonly mailbox: {
    pull(projectKey: string, max: number, leaseSeconds?: number): Promise<readonly MailboxMessage[]>;
    ack(ids: readonly string[]): Promise<{ readonly acked: readonly string[]; readonly ignored: readonly string[] }>;
  };
}

/** Connecting, importing, membership and webhooks: what Settings and the Team screen drive. */
export interface CoordinationControlPort {
  connect(input: { readonly url: string; readonly code: string; readonly displayName: string; readonly deviceLabel: string; readonly allowInsecure: boolean }): Promise<CoordinationStatus>;
  /** Whether "Bring my local data" applies: connected, an admin, and the relay empty. */
  offerImport(): boolean;
  importLocal(): Promise<ImportReport>;
  disconnect(): Promise<void>;
  createInvite(req: CreateInviteRequest): Promise<{ readonly code: string; readonly expiresAt: string }>;
  revokeDevice(id: string): Promise<void>;
  removeMember(id: string): Promise<void>;
  devices(): readonly CoordDeviceView[];
  createEndpoint(req: CreateEndpointRequest): Promise<EndpointView>;
  disableEndpoint(id: string): Promise<void>;
  retryParked(id: string): Promise<void>;
  dropParked(id: string): Promise<void>;
  endpoints(): readonly EndpointView[];
  /** Webhooks leased ten times without an ack, with the last computer that tried. */
  parked(): Promise<readonly { readonly id: string; readonly endpointId: string; readonly receivedAt: string; readonly lastDeviceId: string | null }[]>;
  /** Outbox writes that failed for good, in plain words. */
  failures(): readonly { readonly id: string; readonly op: string; readonly lastError: string }[];
  exportLines(): string[];
  /** The relay host, when connected or offline. */
  host(): string | null;
  teamName(): string | null;
}
