import { useState } from 'react';
import { Icon } from '../components/Icon.js';
import { Logo } from '../components/Logo.js';
import { ErrorState, Field } from '../components/primitives.js';
import { useDaemonMutation } from '../lib/queries.js';
import { shortenPath } from '../lib/format.js';
import { Button, Tooltip } from '@tandemise/design/react';

/**
 * The first thing a new install shows.
 *
 * Tandemise used to seed a workspace called "My workspace" on first start, so
 * the app opened onto a project nobody had decided to make. That reads as an
 * app with settings rather than one organised around projects - and it hid the
 * fact that repositories, roles, runtimes and integrations all belong to a
 * project, because there was only ever the one.
 *
 * So creating a project is the first act. It also collects repositories here,
 * since a project of several repositories is the normal case rather than the
 * exotic one, and finding out later that more can be added is exactly the
 * discovery this screen exists to prevent.
 */
export function FirstProject(): JSX.Element {
  return (
    <main className="onboard">
      <div className="onboard__inner">
        <div className="onboard__mark">
          <Logo size={34} />
        </div>
        <h1 className="onboard__title">Create your first project</h1>
        <p className="onboard__body">
          A project is a codebase and everything that works on it — its repositories, its roles, the runtimes that carry them, and the
          services it may reach. You can have several and switch between them.
        </p>
        <ProjectForm />
      </div>
    </main>
  );
}

/**
 * Shared by the first-run screen and the "New project" dialog, because the
 * decisions are the same either way and two forms would drift.
 */
export function ProjectForm({ onCreated }: { onCreated?: (id: string) => void }): JSX.Element {
  const [name, setName] = useState('');
  const [paths, setPaths] = useState<readonly string[]>([]);

  const create = useDaemonMutation(
    async (daemon) => {
      // The first repository comes with creation; the rest are added to the
      // project that comes back, so one failing path does not lose the project.
      const [first, ...rest] = paths;
      const view = await daemon.createWorkspace({
        name: name.trim(),
        ...(first === undefined ? {} : { repositoryPath: first }),
      });
      for (const path of rest) await daemon.addRepository(view.workspace.id, { path });
      return view;
    },
    ['workspaces'],
  );

  const browse = async (): Promise<void> => {
    const path = await window.tandemise.selectDirectory('Choose a repository');
    if (path && !paths.includes(path)) setPaths((current) => [...current, path]);
  };

  return (
    <div className="stack" style={{ gap: 'var(--s5)', textAlign: 'left' }}>
      <Field label="Project name">
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Beveloce"
          autoFocus
        />
      </Field>

      <Field
        label="Repositories"
        hint="A project can hold several — a web app, a mobile client, shared tooling. One mission can change more than one of them."
      >
        <div className="stack" style={{ gap: 'var(--s2)' }}>
          {paths.map((path) => (
            <div key={path} className="list__row list__row--bordered">
              <Icon name="folder" size={14} className="dim" />
              <div className="list__main">
                <Tooltip content={path}>
                  <div className="list__title mono truncate">
                    {shortenPath(path, 3)}
                  </div>
                </Tooltip>
              </div>
              <Tooltip content={`Remove ${path}`}>
                <Button
                  iconOnly variant="ghost"
                  aria-label={`Remove ${path}`}
                  onClick={() => setPaths((current) => current.filter((p) => p !== path))}
                >
                  <Icon name="x" size={13} />
                </Button>
              </Tooltip>
            </div>
          ))}
          <Button onClick={() => void browse()}>
            <Icon name="plus" size={13} />
            {paths.length === 0 ? 'Add a repository' : 'Add another'}
          </Button>
        </div>
      </Field>

      {create.isError ? <ErrorState error={create.error} /> : null}

      <Button
        variant="primary" size="lg"
        disabled={name.trim() === '' || create.isPending}
        onClick={() =>
          create.mutate(undefined, { onSuccess: (view) => onCreated?.(view.workspace.id) })
        }
      >
        {create.isPending ? 'Creating…' : 'Create project'}
      </Button>
    </div>
  );
}
