import { useState } from 'react';
import type { AutonomySettings, Repository } from '@tandemise/domain';
import { PageHeader } from '../components/PageHeader.js';
import { Icon } from '../components/Icon.js';
import { ConfirmDialog } from '../components/Modal.js';
import { Empty, ErrorState, Field, SectionHead, Segmented, SkeletonList } from '../components/primitives.js';
import { useDaemonMutation } from '../lib/queries.js';
import { useWorkspace } from '../lib/workspace.js';
import { shortenPath } from '../lib/format.js';
import { Limits } from './project/Limits.js';
import { PathInput } from './FirstProject.js';
import { Factory } from './project/Factory.js';
import { Merge } from './project/Merge.js';
import { Issues } from './project/Issues.js';
import { SetupAsCode } from './project/SetupAsCode.js';
import { BrainLink } from './project/BrainLink.js';
import { Badge, Button, Card, Chip, Tooltip } from '@tandemise/design/react';

const AUTONOMY_ROWS: readonly { key: keyof AutonomySettings; label: string; hint: string; options: readonly string[] }[] = [
  { key: 'planApproval', label: 'Plan approval', hint: 'Show the proposed task graph before anything runs.', options: ['ask', 'auto'] },
  { key: 'localCodeChanges', label: 'Local code changes', hint: 'Edits inside an isolated worktree, never your checkout.', options: ['auto', 'ask'] },
  { key: 'externalWrites', label: 'Writes that leave this machine', hint: 'Pull requests, issue comments, API calls.', options: ['auto', 'policy', 'ask', 'deny'] },
  { key: 'productionRelease', label: 'Production release', hint: 'Merging, deploying, publishing.', options: ['ask', 'deny'] },
  { key: 'financialActions', label: 'Financial actions', hint: 'Locked to deny. Tandemise never spends money on your behalf.', options: ['deny'] },
];

/**
 * What this project is and how it behaves.
 *
 * Separate from Settings because these are not preferences about the app - they
 * are the project itself. Its repositories, how much it may do without asking,
 * and how many workers it may run are properties of this codebase, and none of
 * them follow you to another project.
 */
export function Project(): JSX.Element {
  const [removingRepository, setRemovingRepository] = useState<Repository | null>(null);
  const workspaceView = useWorkspace().current;
  const workspace = workspaceView?.workspace;

  const updateWorkspace = useDaemonMutation(
    (daemon, body: Parameters<typeof daemon.updateWorkspace>[1]) => daemon.updateWorkspace(workspace?.id ?? '', body),
    ['workspaces'],
  );
  const addRepository = useDaemonMutation(
    (daemon, path: string) => daemon.addRepository(workspace?.id ?? '', { path }),
    ['workspaces'],
  );
  const removeRepository = useDaemonMutation((daemon, id: string) => daemon.removeRepository(id), ['workspaces']);

  const pickRepository = async (): Promise<void> => {
    const path = await window.tandemise.selectDirectory('Choose a repository');
    if (path) addRepository.mutate(path);
  };

  return (
    <>
      <PageHeader
        narrow
        title={workspace?.name ?? 'Project'}
        subtitle="The repositories this project works on, and how it is allowed to behave."
      />

      <div className="page">
        <div className="page__inner page__inner--narrow">
          {workspace === undefined || workspaceView === null ? (
            <SkeletonList rows={5} />
          ) : (
            <>
              <section className="section">
                <SectionHead title="Name" />
                <Card>
                  <Field label="Project name" hint="Shown in the switcher at the top of the sidebar.">
                    <input
                      className="input"
                      key={workspace.id}
                      defaultValue={workspace.name}
                      onBlur={(event) => {
                        const next = event.target.value.trim();
                        if (next !== '' && next !== workspace.name) updateWorkspace.mutate({ name: next });
                      }}
                    />
                  </Field>
                </Card>
              </section>

              <section className="section">
                              <SectionHead
                                title="Repositories"
                                action={
                                  <div className="path-input">
                                    <PathInput disabled={addRepository.isPending} onAdd={(path) => addRepository.mutate(path)} />
                                    <Button onClick={() => void pickRepository()} disabled={addRepository.isPending}>
                                      <Icon name="folder" size={13} />
                                      {addRepository.isPending ? 'Adding…' : 'Add repository'}
                                    </Button>
                                  </div>
                                }
                              />
                              {(workspaceView.repositories.length ?? 0) === 0 ? (
                                <Card>
                                  <Empty
                                    icon="folder"
                                    title="No repositories yet"
                                    body="Tandemise never edits your checkout directly — it cuts a git worktree per task. Point it at a repository to get started."
                                    action={
                                      <Button variant="primary" onClick={() => void pickRepository()}>
                                        Choose a folder
                                      </Button>
                                    }
                                  />
                                </Card>
                              ) : (
                                <div className="list">
                                  {(workspaceView.repositories ?? []).map((repository) => (
                                    <div key={repository.id} className="list__row">
                                      <Icon name="folder" size={15} className="dim" />
                                      <div className="list__main">
                                        <div className="list__title">{repository.name}</div>
                                        <Tooltip content={repository.path}>
                                          <div className="list__subtitle mono truncate">
                                            {shortenPath(repository.path, 4)}
                                          </div>
                                        </Tooltip>
                                      </div>
                                      <div className="list__aside">
                                        <Chip muted>{repository.defaultBranch}</Chip>
                                        <Tooltip content={`Reveal ${repository.name} in Finder`}>
                                          <Button
                                            iconOnly variant="ghost"
                                            aria-label={`Reveal ${repository.name} in Finder`}
                                            onClick={() => void window.tandemise.revealInFinder(repository.path)}
                                          >
                                            <Icon name="externalLink" size={13} />
                                          </Button>
                                        </Tooltip>
                                        <Tooltip content={`Remove ${repository.name}`}>
                                          <Button
                                            iconOnly variant="ghost"
                                            aria-label={`Remove ${repository.name}`}
                                            onClick={() => setRemovingRepository(repository)}
                                          >
                                            <Icon name="trash" size={13} />
                                          </Button>
                                        </Tooltip>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {addRepository.isError ? <ErrorState error={addRepository.error} /> : null}
                            </section>

              <Issues />

              <section className="section">
                              <SectionHead title="Autonomy" meta="Per action class, not one global dial" />
                              <Card flush>
                                {AUTONOMY_ROWS.map((row) => {
                                  const current = workspace.autonomy[row.key] ?? row.options[0] ?? 'ask';
                                  const locked = row.options.length === 1;
                                  return (
                                    <div key={row.key} className="list__row" style={{ alignItems: 'flex-start' }}>
                                      <div className="list__main">
                                        <div className="list__title">{row.label}</div>
                                        <div className="list__subtitle">{row.hint}</div>
                                      </div>
                                      <div className="list__aside">
                                        {locked ? (
                                          <Badge tone="failed">
                                            <Icon name="shield" size={11} />
                                            Denied
                                          </Badge>
                                        ) : (
                                          <Segmented
                                            label={row.label}
                                            value={current}
                                            options={row.options.map((option) => ({ value: option, label: capitalise(option) }))}
                                            onChange={(next) =>
                                                                                            updateWorkspace.mutate({
                                                autonomy: { ...workspace.autonomy, [row.key]: next } as AutonomySettings,
                                              })
                                            }
                                          />
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </Card>
                              {updateWorkspace.isError ? <ErrorState error={updateWorkspace.error} /> : null}
                            </section>

              <section className="section">
                              <SectionHead title="Concurrency" meta="How many workers may run at once" />
                              <Card>
                                <Field label="Maximum total workers" hint="Each worker is a child process with its own worktree. Three is a sane default on a laptop.">
                                  <input
                                    className="input"
                                    type="number"
                                    min={1}
                                    max={16}
                                    style={{ width: 96 }}
                                    defaultValue={workspace.concurrency.maxTotalWorkers ?? 3}
                                    onBlur={(event) => {
                                      const next = Number(event.target.value);
                                      if (workspace && Number.isFinite(next) && next !== workspace.concurrency.maxTotalWorkers) {
                                        updateWorkspace.mutate({ concurrency: { ...workspace.concurrency, maxTotalWorkers: next } });
                                      }
                                    }}
                                  />
                                </Field>
                              </Card>
                            </section>

              <Limits workspaceId={workspace.id} monthly={workspace.monthlyLimits ?? []} perMission={workspace.defaultMissionLimits ?? []} />

              <Factory key={workspace.id} workspaceId={workspace.id} />
              <Merge key={`merge-${workspace.id}`} workspaceId={workspace.id} />

              <BrainLink key={`brain-${workspace.id}`} workspaceId={workspace.id} ownerHint={workspace.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')} />

              <SetupAsCode
                key={workspace.id}
                workspaceId={workspace.id}
                repositories={workspaceView.repositories ?? []}
                defaultRepositoryId={workspace.defaultRepositoryId}
              />
            </>
          )}
        </div>
      </div>

      {removingRepository ? (
        <ConfirmDialog
          title={`Remove ${removingRepository.name}?`}
          confirmLabel="Remove repository"
          destructive
          busy={removeRepository.isPending}
          onCancel={() => setRemovingRepository(null)}
          onConfirm={() => removeRepository.mutate(removingRepository.id, { onSuccess: () => setRemovingRepository(null) })}
          body={
            <p>
              Tandemise forgets this repository and its detected check commands. Nothing on disk is touched — your checkout, its branches and
              any existing worktrees stay exactly as they are.
            </p>
          }
        />
      ) : null}
    </>
  );
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
