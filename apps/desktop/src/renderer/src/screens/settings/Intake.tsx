import { useEffect, useRef, useState } from 'react';
import type { IntakeConfigView, UpdateIntakeConfigRequest } from '@tandemise/api-contract';
import type { IntakeSourceConfig, TrackerConfig } from '@tandemise/domain';
import { Field, SectionHead, SkeletonList, Switch } from '../../components/primitives.js';
import { describeError } from '../../lib/daemon.js';
import { useDaemonMutation, useIntakeConfig } from '../../lib/queries.js';
import { useWorkspace, useWorkspaceId } from '../../lib/workspace.js';
import { showFlash } from '../../lib/notices.js';
import { INTAKE_SOURCE_SECRETS, intakeSourceLabel, isShippedIntakeKind } from '../../lib/domain.js';
import './Intake.css';
import { Banner, Button, Card } from '@tandemise/design/react';

/** The daemon's words for a refusal, as it said them (plan Global Constraints: "the UI shows the daemon's own words"). */
function Refusal({ error }: { error: unknown }): JSX.Element {
  return <p className="intake-settings__refusal" role="alert">{describeError(error).detail}</p>;
}

/**
 * Settings → Intake (intake spec §2, §4.1, §6.2; plan Task 14), for the
 * selected project: its primary tracker, the sources that file work into it,
 * and tokens for custom runners. Secrets go to the local secret store, never
 * the configuration. When the configuration lives in the project's brain, the
 * whole form is read-only.
 */
export function IntakeSettings({ focus = false }: { focus?: boolean }): JSX.Element {
  const config = useIntakeConfig();
  const project = useWorkspace().current?.workspace.name ?? 'this project';
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { if (focus && config.data) ref.current?.scrollIntoView({ block: 'start' }); }, [focus, config.data]);
  const view = config.data;
  const readOnly = view !== undefined && (view.origin === 'brain' || !view.editable);
  return (
    <section ref={ref} className="section intake-settings" aria-label="Intake" id="intake" data-origin={view?.origin ?? 'loading'}>
      <SectionHead title="Intake" meta={`For ${project}`} />
      {config.isError ? <Refusal error={config.error} /> : null}
      {view === undefined ? <SkeletonList rows={3} /> : (
        <>
          {/* Outside the read-only fieldset: a brain moves the address, this computer's person confirms it (Ruling 23). */}
          <MovedAddresses view={view} />
          {readOnly ? <Banner className="intake-settings__brain">Set in this project's brain.</Banner> : null}
          {/* The tracker's settings are read-only with a brain; its token, this computer's, never is. */}
          <TrackerCard view={view} readOnly={readOnly} />
          <fieldset className="intake-settings__fieldset" disabled={readOnly}>
            <SourcesCard view={view} />
          </fieldset>
          {/* Outside the read-only fieldset: a push token is this computer's, even when the brain sets the source. */}
          <CustomSources view={view} />
          {/* Outside the read-only fieldset: running a source here is this computer's choice, even when the brain sets it. */}
          <ThisComputerCard view={view} readOnly={readOnly} />
        </>
      )}
    </section>
  );
}

/**
 * A saved token whose tracker or source now points somewhere else (Ruling 23):
 * the daemon sends it nowhere until the person here says so. The daemon's own
 * sentence, the address it was saved for, and **Use the new address**.
 */
function MovedAddresses({ view }: { view: IntakeConfigView }): JSX.Element | null {
  const workspaceId = useWorkspaceId() ?? '';
  const confirm = useDaemonMutation(
    (d, sourceId: string | null) => (sourceId === null ? d.confirmTrackerOrigin(workspaceId) : d.confirmSourceOrigin(workspaceId, sourceId)),
    ['intake'],
  );
  const moved = [
    ...(view.originMismatch.tracker === null ? [] : [{ sourceId: null, label: 'Tracker', ...view.originMismatch.tracker }]),
    ...Object.entries(view.originMismatch.sources).map(([sourceId, m]) => ({ sourceId, label: sourceId, ...m })),
  ];
  if (moved.length === 0) return null;
  return (
    <div className="intake-settings__moved" aria-label="Moved addresses">
      {moved.map((m) => (
        <Banner
          key={m.sourceId ?? 'tracker'}
          tone="warn"
          live="assertive"
          className="intake-settings__moved-item"
          data-intake-moved={m.sourceId ?? 'tracker'}
          action={
            <div className="row intake-settings__actions">
              <Button variant="primary" disabled={confirm.isPending}
                onClick={() => confirm.mutate(m.sourceId, { onSuccess: () => showFlash('Using the new address.') })}>
                Use the new address
              </Button>
            </div>
          }
        >
          <p className="intake-settings__moved-text">
            {m.sourceId === null ? null : <span className="mono">{m.label}: </span>}
            {m.message}
          </p>
          <p className="muted intake-settings__moved-saved">Saved for <span className="mono">{m.saved}</span>.</p>
        </Banner>
      ))}
      {confirm.isError ? <Refusal error={confirm.error} /> : null}
    </div>
  );
}

/**
 * Which of the project's sources run on this computer (Ruling 22). A source
 * the brain sets is off here until switched on, so a teammate's daemon never
 * reads it with their credentials by surprise. With the brain setting the
 * rest, its secrets are saved here too.
 */
function ThisComputerCard({ view, readOnly }: { view: IntakeConfigView; readOnly: boolean }): JSX.Element | null {
  const workspaceId = useWorkspaceId() ?? '';
  const toggle = useDaemonMutation((d, next: { sourceId: string; enabled: boolean }) => d.setIntakeSourceEnabled(workspaceId, next.sourceId, next.enabled), ['intake']);
  const shipped = view.sources.filter((s) => isShippedIntakeKind(s.kind));
  if (shipped.length === 0) return null;
  return (
    <Card className="intake-settings__card" aria-label="On this computer">
      <h3 className="intake-settings__subhead">On this computer</h3>
      <p className="muted intake-settings__lead">Sources this computer reads, with your credentials. {view.origin === 'brain' ? "A source from the project's brain stays off here until you switch it on." : ''}</p>
      <ul className="intake-settings__sources">
        {shipped.map((source) => (
          <li key={source.id} className="intake-settings__source" data-intake-machine-source={source.id}>
            <div className="row intake-settings__switch">
              <Switch
                checked={view.enabled[source.id] === true}
                label={`Run ${source.id} on this computer`}
                onChange={(enabled) => toggle.mutate({ sourceId: source.id, enabled })}
              />
              <span>Run <span className="mono">{source.id}</span> ({intakeSourceLabel(source.kind)}) on this computer</span>
            </div>
            {readOnly ? (INTAKE_SOURCE_SECRETS[source.kind] ?? []).map((secret) => <SecretField key={secret.name} sourceId={source.id} name={secret.name} label={secret.label} />) : null}
          </li>
        ))}
      </ul>
      {toggle.isError ? <Refusal error={toggle.error} /> : null}
    </Card>
  );
}

// ------------------------------------------------------------------ the tracker

interface TrackerDraft {
  kind: TrackerConfig['kind'];
  url: string;
  project: string;
  repo: string;
  board: string;
  ready: string;
  inProgress: string;
  inReview: string;
  done: string;
  wontDo: string;
  draft: string;
  onComplete: TrackerConfig['onComplete'];
  buildTypes: string;
  repoTag: string;
}

const list = (text: string): string[] => text.split(',').map((s) => s.trim()).filter((s) => s !== '');

function trackerDraft(t: TrackerConfig | null): TrackerDraft {
  return {
    kind: t?.kind ?? 'youtrack',
    url: t?.url ?? '',
    project: t?.project ?? '',
    repo: t?.repo ?? '',
    board: t?.board ?? '',
    ready: (t?.states.ready ?? ['Open']).join(', '),
    inProgress: t?.states.in_progress ?? 'In Progress',
    inReview: t?.states.in_review ?? '',
    done: (t?.states.done ?? ['Done']).join(', '),
    wontDo: (t?.states.wont_do ?? []).join(', '),
    draft: (t?.states.draft ?? []).join(', '),
    onComplete: t?.onComplete ?? 'done',
    buildTypes: (t?.buildTypes ?? []).join(', '),
    repoTag: t?.repoTag ?? '',
  };
}

function trackerOf(d: TrackerDraft, before: TrackerConfig | null): TrackerConfig {
  return {
    kind: d.kind,
    ...(d.kind === 'youtrack' ? { url: d.url.trim(), project: d.project.trim() } : { repo: d.repo.trim() }),
    board: d.board.trim(),
    states: {
      ready: list(d.ready),
      in_progress: d.inProgress.trim(),
      ...(d.inReview.trim() === '' ? {} : { in_review: d.inReview.trim() }),
      done: list(d.done),
      wont_do: list(d.wontDo),
      ...(list(d.draft).length === 0 ? {} : { draft: list(d.draft) }),
    },
    onComplete: d.onComplete,
    // Item types to workflows are not edited here; what is set is kept.
    ...(before?.workflows === undefined ? {} : { workflows: before.workflows }),
    ...(list(d.buildTypes).length === 0 ? {} : { buildTypes: list(d.buildTypes) }),
    ...(d.repoTag.trim() === '' ? {} : { repoTag: d.repoTag.trim() }),
  };
}

function TrackerCard({ view, readOnly }: { view: IntakeConfigView; readOnly: boolean }): JSX.Element {
  const workspaceId = useWorkspaceId() ?? '';
  const [draft, setDraft] = useState<TrackerDraft>(() => trackerDraft(view.tracker));
  const savedKey = JSON.stringify(trackerDraft(view.tracker));
  useEffect(() => { setDraft(trackerDraft(view.tracker)); }, [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [token, setToken] = useState('');
  const save = useDaemonMutation((d, body: UpdateIntakeConfigRequest) => d.saveIntakeConfig(workspaceId, body), ['intake']);
  const saveToken = useDaemonMutation((d, value: string) => d.saveTrackerSecret(workspaceId, value), ['intake']);
  const set = (patch: Partial<TrackerDraft>): void => setDraft({ ...draft, ...patch });
  const dirty = JSON.stringify(draft) !== savedKey;
  const youtrack = draft.kind === 'youtrack';
  return (
    <Card className="intake-settings__card" aria-label="Tracker">
      <h3 className="intake-settings__subhead">Tracker</h3>
      <p className="muted intake-settings__lead">
        {view.tracker === null
          ? 'Set this project\'s tracker first: work from every source is filed there, once, and you start it from the Board.'
          : `Work is filed in ${youtrack ? `YouTrack ${view.tracker.project ?? ''}` : `GitHub Issues ${view.tracker.repo ?? ''}`}, and you start it from the Board.`}
      </p>
      <fieldset className="intake-settings__fieldset" disabled={readOnly}>
      <div className="grid grid--2">
        <Field label="Tracker">
          <select className="select" aria-label="Tracker kind" value={draft.kind} onChange={(e) => set({ kind: e.target.value as TrackerDraft['kind'] })}>
            <option value="youtrack">YouTrack</option>
            <option value="github-issues">GitHub Issues</option>
          </select>
        </Field>
        {youtrack ? (
          <>
            <Field label="YouTrack address" hint="https, or http on this computer only.">
              <input className="input mono" value={draft.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://acme.youtrack.cloud" />
            </Field>
            <Field label="Project" hint="Its short name, as in GAR-12.">
              <input className="input" value={draft.project} onChange={(e) => set({ project: e.target.value })} placeholder="GAR" />
            </Field>
          </>
        ) : (
          <Field label="Repository" hint="owner/name, as on github.com.">
            <input className="input mono" value={draft.repo} onChange={(e) => set({ repo: e.target.value })} placeholder="acme/web" />
          </Field>
        )}
        <Field label="Board query" hint="The tracker's own search for the work you choose from.">
          <input className="input mono" value={draft.board} onChange={(e) => set({ board: e.target.value })} placeholder={youtrack ? 'project: GAR #Unresolved' : 'is:open label:ready'} />
        </Field>
      </div>
      <h4 className="intake-settings__minor">Your tracker's states</h4>
      <div className="grid grid--2">
        <Field label="Ready" hint="Where new work is filed, and what Start offers. Separate several with commas.">
          <input className="input" value={draft.ready} onChange={(e) => set({ ready: e.target.value })} />
        </Field>
        <Field label="In progress" hint="Where Start moves an item.">
          <input className="input" value={draft.inProgress} onChange={(e) => set({ inProgress: e.target.value })} />
        </Field>
        <Field label="In review" hint="Optional. Where a pull request waiting for a person moves it.">
          <input className="input" value={draft.inReview} onChange={(e) => set({ inReview: e.target.value })} />
        </Field>
        <Field label="Done" hint="The first is what Tandemise writes. Reaching any closes the loop at the sources.">
          <input className="input" value={draft.done} onChange={(e) => set({ done: e.target.value })} />
        </Field>
        <Field label="Won't do" hint="Optional. Separate several with commas.">
          <input className="input" value={draft.wontDo} onChange={(e) => set({ wontDo: e.target.value })} />
        </Field>
        <Field label="Draft" hint="Optional. Work still to be refined: the Board offers Refine on it, never Start.">
          <input className="input" value={draft.draft} onChange={(e) => set({ draft: e.target.value })} />
        </Field>
        <Field label="When a mission completes">
          <select className="select" aria-label="When a mission completes" value={draft.onComplete} onChange={(e) => set({ onComplete: e.target.value as TrackerDraft['onComplete'] })}>
            <option value="in_review">Move it to in review</option>
            <option value="done">Move it to done</option>
          </select>
        </Field>
      </div>
      <h4 className="intake-settings__minor">What Start offers</h4>
      <div className="grid grid--2">
        <Field label="Types to build" hint="Optional. Your tracker's item types this project starts, like Bug, Task. Others show on the Board with Start off. Empty starts every type.">
          <input className="input" value={draft.buildTypes} onChange={(e) => set({ buildTypes: e.target.value })} placeholder="Bug, Task" />
        </Field>
        <Field label="Repository tag" hint="Optional. The tag that marks this repository's work, like repo:web. An item tagged for another repository (repo:api) shows with Start off.">
          <input className="input mono" value={draft.repoTag} onChange={(e) => set({ repoTag: e.target.value })} placeholder="repo:web" />
        </Field>
      </div>
      {save.isError ? <Refusal error={save.error} /> : null}
      <div className="row intake-settings__actions">
        <Button variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate({ tracker: trackerOf(draft, view.tracker) } as UpdateIntakeConfigRequest, { onSuccess: () => showFlash('Tracker saved.') })}>
          {save.isPending ? 'Checking with your tracker…' : 'Save tracker'}
        </Button>
      </div>
      </fieldset>
      <div className="intake-settings__secret">
        <Field label={youtrack ? 'YouTrack token' : 'GitHub'} hint={youtrack ? 'A permanent token. Kept only on this computer, in its secret store.' : 'GitHub Issues are read with the gh command line tool you are signed in to.'}>
          {youtrack ? <input className="input mono" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="perm:…" /> : <span />}
        </Field>
        {youtrack ? (
          <Button disabled={token.trim() === '' || saveToken.isPending} onClick={() => saveToken.mutate(token.trim(), { onSuccess: () => { setToken(''); showFlash('Token saved on this computer.'); } })}>
            Save token
          </Button>
        ) : null}
      </div>
      {saveToken.isError ? <Refusal error={saveToken.error} /> : null}
    </Card>
  );
}

// ------------------------------------------------------------------ sources

/** Saves the project's sources, keeping its daily cap and similarity as they are. */
function intakeBody(view: IntakeConfigView, sources: readonly IntakeSourceConfig[]): UpdateIntakeConfigRequest {
  return { intake: { sources: sources as IntakeSourceConfig[], dailyCap: view.dailyCap, similarity: { ...view.similarity } } } as UpdateIntakeConfigRequest;
}

function SourcesCard({ view }: { view: IntakeConfigView }): JSX.Element {
  const shipped = view.sources.filter((s) => isShippedIntakeKind(s.kind));
  return (
    <Card className="intake-settings__card" aria-label="Sources">
      <h3 className="intake-settings__subhead">Sources</h3>
      <p className="muted intake-settings__lead">What files work into your tracker. Each is read on its own schedule, and Check sources now on the Board reads them all.</p>
      {shipped.length === 0 ? <p className="muted">No sources yet.</p> : (
        <ul className="intake-settings__sources">
          {shipped.map((s) => <SourceRow key={s.id} view={view} source={s} />)}
        </ul>
      )}
      <AddSource view={view} />
    </Card>
  );
}

function SourceRow({ view, source }: { view: IntakeConfigView; source: IntakeSourceConfig }): JSX.Element {
  const workspaceId = useWorkspaceId() ?? '';
  const save = useDaemonMutation((d, next: IntakeSourceConfig) => d.saveIntakeConfig(workspaceId, intakeBody(view, view.sources.map((s) => (s.id === next.id ? next : s)))), ['intake']);
  const remove = useDaemonMutation((d, _: void) => d.saveIntakeConfig(workspaceId, intakeBody(view, view.sources.filter((s) => s.id !== source.id))), ['intake']);
  const [minEvents, setMinEvents] = useState(String(source.filter?.minEvents ?? ''));
  const [minUsers, setMinUsers] = useState(String(source.filter?.minUsers ?? ''));
  const [span, setSpan] = useState(source.filter?.window ?? '24h');
  const filterOf = (): IntakeSourceConfig['filter'] => {
    const n = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v));
    const events = n(minEvents);
    const users = n(minUsers);
    const rest = { ...(source.filter ?? {}) };
    delete (rest as { minEvents?: number }).minEvents;
    delete (rest as { minUsers?: number }).minUsers;
    delete (rest as { window?: string }).window;
    return { ...rest, ...(events === undefined ? {} : { minEvents: events }), ...(users === undefined ? {} : { minUsers: users }), ...(events === undefined && users === undefined ? {} : { window: span }) };
  };
  const counts = source.kind === 'sentry' || source.kind === 'posthog';
  return (
    <li className="intake-settings__source" data-intake-source={source.id}>
      <div className="intake-settings__source-head">
        <strong>{intakeSourceLabel(source.kind)}</strong>
        <span className="muted mono">{source.id}</span>
        <span className="muted">{source.instance}</span>
      </div>
      <div className="intake-settings__switches">
        <div className="row intake-settings__switch">
          <Switch checked={source.closeOnDone} label={`Close the loop at ${intakeSourceLabel(source.kind)} when the task is done`} onChange={(closeOnDone) => save.mutate({ ...source, closeOnDone })} />
          <span>Close the loop when the task is done</span>
        </div>
        <div className="row intake-settings__switch">
          <Switch checked={source.closeWontDo} label={`Tell ${intakeSourceLabel(source.kind)} when the task won't be done`} onChange={(closeWontDo) => save.mutate({ ...source, closeWontDo })} />
          <span>Say so when the task won't be done</span>
        </div>
      </div>
      {counts ? (
        <div className="row row--wrap intake-settings__filter">
          <Field label="File only from" hint="Events in the window. Below it, a signal is held back.">
            <input className="input" inputMode="numeric" aria-label={`${source.id} minimum events`} value={minEvents} onChange={(e) => setMinEvents(e.target.value)} placeholder="20" />
          </Field>
          <Field label="Or people affected">
            <input className="input" inputMode="numeric" aria-label={`${source.id} minimum people`} value={minUsers} onChange={(e) => setMinUsers(e.target.value)} placeholder="5" />
          </Field>
          <Field label="In">
            <select className="select" aria-label={`${source.id} window`} value={span} onChange={(e) => setSpan(e.target.value as typeof span)}>
              <option value="1h">1 hour</option>
              <option value="24h">24 hours</option>
              <option value="7d">7 days</option>
            </select>
          </Field>
          <Button disabled={save.isPending} onClick={() => save.mutate({ ...source, filter: filterOf() } as IntakeSourceConfig)}>Save filter</Button>
        </div>
      ) : null}
      {(INTAKE_SOURCE_SECRETS[source.kind] ?? []).map((secret) => <SecretField key={secret.name} sourceId={source.id} name={secret.name} label={secret.label} />)}
      {save.isError ? <Refusal error={save.error} /> : null}
      {remove.isError ? <Refusal error={remove.error} /> : null}
      <div>
        <Button variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate()}>Remove this source</Button>
      </div>
    </li>
  );
}

function SecretField({ sourceId, name, label }: { sourceId: string; name: string; label: string }): JSX.Element {
  const workspaceId = useWorkspaceId() ?? '';
  const [value, setValue] = useState('');
  const save = useDaemonMutation((d, v: string) => d.saveSourceSecret(workspaceId, sourceId, name, v), ['intake']);
  return (
    <div className="intake-settings__secret">
      <Field label={label} hint="Kept only on this computer, in its secret store. Saving replaces the one saved before.">
        <input className="input mono" type="password" autoComplete="off" aria-label={`${sourceId} ${label}`} value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      <Button disabled={value.trim() === '' || save.isPending} onClick={() => save.mutate(value.trim(), { onSuccess: () => { setValue(''); showFlash(`${label} saved on this computer.`); } })}>
        Save
      </Button>
      {save.isError ? <Refusal error={save.error} /> : null}
    </div>
  );
}

const SHIPPED_KINDS = ['sentry', 'posthog', 'slack', 'discord', 'github'] as const;

function AddSource({ view }: { view: IntakeConfigView }): JSX.Element {
  const workspaceId = useWorkspaceId() ?? '';
  const [id, setId] = useState('');
  const [kind, setKind] = useState<string>('sentry');
  const [instance, setInstance] = useState('');
  // A custom runner's signals name its source id as their instance (the CLI pushes them so).
  const where = instance.trim() === '' && kind === 'custom' ? id.trim() : instance.trim();
  const add = useDaemonMutation(
    (d, _: void) => d.saveIntakeConfig(workspaceId, intakeBody(view, [...view.sources, { id: id.trim(), kind, instance: where, closeOnDone: false, closeWontDo: false }])),
    ['intake'],
  );
  return (
    <form className="stack intake-settings__add" onSubmit={(e) => { e.preventDefault(); add.mutate(undefined, { onSuccess: () => { setId(''); setInstance(''); } }); }}>
      <div className="row row--wrap">
        <Field label="Source id" hint="Lowercase letters, digits and dashes.">
          <input className="input mono" value={id} onChange={(e) => setId(e.target.value)} placeholder="sentry-web" />
        </Field>
        <Field label="Kind" hint="A custom runner pushes with a token instead.">
          <select className="select" aria-label="Source kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {SHIPPED_KINDS.map((k) => <option key={k} value={k}>{intakeSourceLabel(k)}</option>)}
            <option value="custom">A custom runner</option>
          </select>
        </Field>
        <Field label="Where" hint="acme/web, or acme.slack.com#support. A custom runner may leave it empty.">
          <input className="input" value={instance} onChange={(e) => setInstance(e.target.value)} />
        </Field>
      </div>
      {add.isError ? <Refusal error={add.error} /> : null}
      <div><Button type="submit" disabled={id.trim() === '' || where === '' || add.isPending}>Add a source</Button></div>
    </form>
  );
}

// ------------------------------------------------------------------ custom runners

function CustomSources({ view }: { view: IntakeConfigView }): JSX.Element {
  const custom = view.sources.filter((s) => !isShippedIntakeKind(s.kind));
  return (
    <Card className="intake-settings__card" aria-label="Custom sources">
      <h3 className="intake-settings__subhead">Custom sources</h3>
      <p className="muted intake-settings__lead">
        A runner of your own pushes signals with a token for its source, over HTTP or with <span className="mono">tandemise intake push</span>, and reads its closures back with <span className="mono">tandemise intake closures</span>.
      </p>
      {custom.length === 0 ? <p className="muted">No custom sources. Add one above as A custom runner.</p> : (
        <ul className="intake-settings__sources">
          {custom.map((s) => <CustomSource key={s.id} source={s} />)}
        </ul>
      )}
    </Card>
  );
}

function CustomSource({ source }: { source: IntakeSourceConfig }): JSX.Element {
  const workspaceId = useWorkspaceId() ?? '';
  const mint = useDaemonMutation((d, _: void) => d.mintIntakeToken(workspaceId, source.id), []);
  const token = mint.data?.token ?? null;
  return (
    <li className="intake-settings__source" data-custom-source={source.id}>
      <div className="intake-settings__source-head">
        <strong className="mono">{source.id}</strong>
        <span className="muted">{source.instance}</span>
        <Button disabled={mint.isPending} onClick={() => mint.mutate()}>Make a token</Button>
      </div>
      {token !== null ? (
        <div className="intake-settings__token">
          <code className="mono intake-settings__token-value" data-intake-token>{token}</code>
          <Button onClick={() => { void navigator.clipboard.writeText(token); showFlash('Token copied.'); }}>Copy</Button>
          <p className="muted intake-settings__token-note">Shown once. It can only push to {source.id} and read its closures. If you lose it, make another.</p>
        </div>
      ) : null}
      {mint.isError ? <Refusal error={mint.error} /> : null}
    </li>
  );
}
