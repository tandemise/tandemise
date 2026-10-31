import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  diagnosticsText,
  mismatchAdvice,
  TANDEMISE_DOCS_URL,
  TANDEMISE_NEW_ISSUE_URL,
  TANDEMISE_REPOSITORY_URL,
  uptimeText,
  versionMismatch,
  versionWithBuild,
} from '@tandemise/api-contract/about';
import { Icon } from '../components/Icon.js';
import { SectionHead } from '../components/primitives.js';
import { useConnection } from '../lib/connection.js';
import { useSystem } from '../lib/queries.js';
import { platformWords } from '../lib/platform.js';
import { Banner, Button, Card, Truncate } from '@tandemise/design/react';

/**
 * Settings → About: which code is running, where its data lives, and one
 * button that copies all of it for a bug report.
 *
 * Built for the one person running Tandemise from their own checkout, whose
 * most common "bug" is a daemon still running last week's build: the version
 * and commit of both halves sit side by side, and a mismatch says what to do.
 */
export function SettingsAbout(): JSX.Element {
  const system = useSystem();
  const { status } = useConnection();
  const appInfo = useQuery({ queryKey: ['app-info'], queryFn: () => window.tandemise.getAppInfo(), staleTime: Infinity });
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');

  // Uptime moves; a restarted daemon has a new start time and maybe a new build.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const url = status.connection?.url;
  const { refetch } = system;
  useEffect(() => {
    if (url) void refetch();
  }, [url, refetch]);

  const connected = status.phase === 'connected';
  const app = appInfo.data ?? null;
  const daemon = connected ? (system.data ?? null) : null;
  const daemonState = connected ? 'Running' : 'Not connected';
  const mismatch = app && daemon ? versionMismatch(app, daemon) : null;

  const copy = (): void => {
    const text = diagnosticsText({ app, daemon, daemonState, now: Date.now() });
    navigator.clipboard.writeText(text).then(
      () => setCopied('copied'),
      () => setCopied('failed'),
    );
    window.setTimeout(() => setCopied('idle'), 2_000);
  };

  return (
    <section className="section" data-section="about">
      <SectionHead
        title="About"
        meta={app ? versionWithBuild(app.version, app.build) : undefined}
        action={
          <Button onClick={copy}>
            <Icon name={copied === 'copied' ? 'check' : 'file'} size={14} />
            {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Could not copy' : 'Copy diagnostics'}
          </Button>
        }
      />

      {mismatch ? (
        <Banner tone="warn" live="assertive" style={{ marginBottom: 'var(--s3)' }} icon={<Icon name="alert" size={14} />}>
          <strong>{mismatch.kind === 'version' ? 'The app and the daemon run different versions.' : 'The daemon was built from different code than the app.'}</strong>{' '}
          {mismatchAdvice(mismatch, daemon?.pid ?? null)}
        </Banner>
      ) : null}

      <Card flush>
        <table className="table">
          <tbody>
            <Row label="App" value={app ? versionWithBuild(app.version, app.build) : '—'} />
            <Row label="Daemon" value={daemon ? versionWithBuild(daemon.daemonVersion, daemon.daemonBuild) : '—'} />
            <Row
              label="Daemon status"
              value={daemon ? `${daemonState} · up ${uptimeText(daemon.startedAt, now)} · process ${daemon.pid}` : daemonState}
            />
            <Row label="Database schema" value={daemon ? `Version ${daemon.schemaVersion}` : '—'} />
            <tr>
              <td style={{ width: 160, color: 'var(--text-tertiary)', verticalAlign: 'middle' }}>Data folder</td>
              <td>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <Truncate className="mono">{daemon?.home ?? '—'}</Truncate>
                  {daemon ? (
                    <Button variant="ghost" onClick={() => void window.tandemise.revealInFinder(daemon.home)}>
                      <Icon name="folder" size={14} />
                      Show in {platformWords().fileManager}
                    </Button>
                  ) : null}
                </div>
              </td>
            </tr>
            <Row label="Electron" value={app ? `${app.electron} (Chromium ${app.chrome}, Node ${app.node})` : '—'} />
            <Row label="Operating system" value={app?.os ?? '—'} />
          </tbody>
        </table>
      </Card>

      <div className="row row--wrap" style={{ marginTop: 'var(--s3)' }}>
        <LinkButton label="Repository" url={TANDEMISE_REPOSITORY_URL} />
        <LinkButton label="Documentation" url={TANDEMISE_DOCS_URL} />
        <LinkButton label="Report an issue" url={TANDEMISE_NEW_ISSUE_URL} />
      </div>
      <p className="list__subtitle" style={{ marginTop: 'var(--s2)' }}>
        Reporting a problem? Press Copy diagnostics and paste the text into the issue. It holds versions, the data folder and the daemon&apos;s state, never tokens or settings.
      </p>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <tr>
      <td style={{ width: 160, color: 'var(--text-tertiary)' }}>{label}</td>
      <td>{value}</td>
    </tr>
  );
}

function LinkButton({ label, url }: { label: string; url: string }): JSX.Element {
  return (
    <Button variant="ghost" onClick={() => void window.tandemise.openExternal(url)}>
      <Icon name="externalLink" size={14} />
      {label}
    </Button>
  );
}
