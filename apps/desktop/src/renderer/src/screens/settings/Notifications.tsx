import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationPreferencesView, UpdateNotificationPreferencesRequest } from '@tandemise/api-contract';
import { ErrorState, SectionHead, Switch } from '../../components/primitives.js';
import { useDaemon } from '../../lib/connection.js';
import { Banner, Button, Card, StatusPill, type Tone } from '@tandemise/design/react';
import { Icon } from '../../components/Icon.js';
import type { NotificationReach } from '../../../../shared/bridge.js';

type Kind = keyof NotificationPreferencesView['kinds'];

/** One switch per kind of Inbox item (P16 spec §1), in the order the Inbox reads. */
const KINDS: ReadonlyArray<{ kind: Kind; title: string; detail: string }> = [
  { kind: 'decisions', title: 'Decisions and approvals', detail: 'A plan, a card or a step waits on your answer.' },
  { kind: 'refinements', title: 'Refinements', detail: 'A draft has proposals or questions to decide before it can be planned.' },
  { kind: 'stalled', title: 'Stalled missions', detail: 'Nothing moves a mission and nothing asks you about it.' },
  { kind: 'quiet', title: 'Quiet agents', detail: 'An agent has printed nothing for longer than it should.' },
  { kind: 'limits', title: 'Limits', detail: 'A mission or the project stopped at a spend or time limit.' },
];

const DEFAULT_QUIET = { from: '22:00', to: '07:00' } as const;
const KEY = ['settings', 'notifications'] as const;
const HEALTH_KEY = ['settings', 'notifications', 'health'] as const;

/** How the system treats Tandemise's notifications, in words and a tone (colour is never the only signal). */
const REACH: Readonly<Record<NotificationReach, { label: string; tone: Tone }>> = {
  ready: { label: 'Showing', tone: 'succeeded' },
  hidden: { label: 'No banners', tone: 'blocked' },
  unavailable: { label: 'Not delivered', tone: 'failed' },
  unknown: { label: 'Not reported', tone: 'pending' },
};

/**
 * Settings → Notifications (P16). The daemon keeps the preferences, so they
 * hold for a window re-opened from the tray and for the main process, which is
 * what actually shows the notifications.
 */
export function NotificationSettings(): JSX.Element {
  const daemon = useDaemon();
  const queryClient = useQueryClient();
  const preferences = useQuery({ queryKey: KEY, queryFn: () => daemon.notificationPreferences(), refetchInterval: 60_000 });
  const update = useMutation({
    mutationFn: (body: UpdateNotificationPreferencesRequest) => daemon.updateNotificationPreferences(body),
    onSuccess: (view) => queryClient.setQueryData(KEY, view),
  });
  const health = useQuery({ queryKey: HEALTH_KEY, queryFn: () => window.tandemise.notificationHealth(),
    // The person may have just changed a system setting (Do Not Disturb): read it again on every visit.
    refetchInterval: 30_000, refetchOnMount: 'always', refetchOnWindowFocus: 'always', staleTime: 0,
  });
  const test = useMutation({
    mutationFn: () => window.tandemise.testNotification(),
    onSuccess: (result) => queryClient.setQueryData(HEALTH_KEY, result.health),
  });
  const desktopEntry = useMutation({
    mutationFn: (action: 'install' | 'remove') => window.tandemise.notificationDesktopEntry(action),
    onSuccess: (view) => queryClient.setQueryData(HEALTH_KEY, view),
  });
  const entry = health.data?.desktopEntry ?? { offer: null, path: null };

  const view = preferences.data;
  const quiet = view?.quietHours ?? null;
  const [from, setFrom] = useState<string>(quiet?.from ?? DEFAULT_QUIET.from);
  const [to, setTo] = useState<string>(quiet?.to ?? DEFAULT_QUIET.to);
  // Follow what was saved, so the inputs never show hours that are not in force.
  useEffect(() => {
    if (quiet !== null) {
      setFrom(quiet.from);
      setTo(quiet.to);
    }
  }, [quiet?.from, quiet?.to]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = quiet !== null && (from !== quiet.from || to !== quiet.to);
  const sameEnds = from === to;

  return (
    <section className="section" aria-label="Notifications">
      <SectionHead title="Notifications" meta={view?.quietNow ? 'Quiet hours now' : undefined} />
      {preferences.isError ? <ErrorState error={preferences.error} onRetry={() => void preferences.refetch()} /> : null}
      {health.data && (health.data.reach === 'hidden' || health.data.reach === 'unavailable' || health.data.advice !== null) ? (
        <Banner
          tone={health.data.reach === 'unavailable' ? 'danger' : health.data.reach === 'hidden' ? 'warn' : 'neutral'}
          icon={<Icon name={health.data.reach === 'ready' || health.data.reach === 'unknown' ? 'info' : 'alert'} size={14} />}
          data-notify-banner={health.data.reach}
        >
          <strong>{health.data.summary}</strong>
          {health.data.advice !== null ? <> {health.data.advice}</> : null}
        </Banner>
      ) : null}
      <Card flush>
        {KINDS.map(({ kind, title, detail }) => (
          <div className="list__row" key={kind}>
            <div className="list__main">
              <div className="list__title">{title}</div>
              <div className="list__subtitle">{detail}</div>
            </div>
            <div className="list__aside">
              <Switch
                checked={view?.kinds[kind] ?? true}
                label={title}
                onChange={(on) => update.mutate({ kinds: { [kind]: on } })}
              />
            </div>
          </div>
        ))}

        <div className="list__row">
          <div className="list__main">
            <div className="list__title">Quiet hours</div>
            <div className="list__subtitle">
              {quiet === null
                ? 'Off. Turn on to hold notifications overnight; what arrives is summarised once in the morning.'
                : `${quiet.from} to ${quiet.to}. Held during these hours and summarised once they end.`}
            </div>
          </div>
          <div className="list__aside">
            <Switch
              checked={quiet !== null}
              label="Quiet hours"
              onChange={(on) => update.mutate({ quietHours: on ? { from, to: sameEnds ? DEFAULT_QUIET.to : to } : null })}
            />
          </div>
        </div>
        {quiet !== null ? (
          <div className="list__row">
            <div className="list__main">
              <div className="row">
                <input className="input" type="time" style={{ width: 120 }} aria-label="From" value={from} onChange={(event) => setFrom(event.target.value)} />
                <span className="list__subtitle">to</span>
                <input className="input" type="time" style={{ width: 120 }} aria-label="To" value={to} onChange={(event) => setTo(event.target.value)} />
              </div>
              {sameEnds ? <div className="field__error">Pick a different start and end.</div> : null}
            </div>
            <div className="list__aside">
              <Button
                disabled={!dirty || sameEnds || update.isPending}
                onClick={() => update.mutate({ quietHours: { from, to } })}
              >
                Save quiet hours
              </Button>
            </div>
          </div>
        ) : null}

        <div className="list__row" data-notify-reach={health.data?.reach ?? 'checking'}>
          <div className="list__main">
            <div className="list__title row">
              <span>Check they reach you</span>
              {health.data ? <StatusPill tone={REACH[health.data.reach].tone} label={REACH[health.data.reach].label} /> : null}
            </div>
            <div className="list__subtitle" data-notify-summary>
              {health.data ? health.data.summary : health.isError ? 'Could not ask the system about notifications.' : 'Asking the system…'}
            </div>
            {health.data?.lastFailure ? (
              <div className="list__subtitle" data-notify-failure>
                Last refused {new Date(health.data.lastFailure.at).toLocaleTimeString()}: {health.data.lastFailure.reason} It is announced again once the system takes it.
              </div>
            ) : null}
            <div className="list__subtitle" role="status" data-notify-test-result>
              {test.data ? test.data.message : ''}
            </div>
          </div>
          <div className="list__aside">
            <Button disabled={test.isPending} onClick={() => test.mutate()}>
              Send a test notification
            </Button>
          </div>
        </div>

        {entry.offer !== null ? (
          <div className="list__row" data-notify-desktop-entry={entry.offer}>
            <div className="list__main">
              <div className="list__title">{entry.offer === 'install' ? 'Add Tandemise to your apps' : 'Tandemise is in your apps'}</div>
              <div className="list__subtitle">
                {entry.offer === 'install'
                  ? 'This AppImage is not in your apps, so the desktop shows its notifications without the Tandemise name and icon, and lists no Tandemise in its notification settings. Adding it writes a launcher for this AppImage to your apps folder; nothing else changes.'
                  : `Tandemise added ${entry.path ?? 'its launcher'} from here. Removing it takes the launcher and its icon away again.`}
              </div>
            </div>
            <div className="list__aside">
              <Button
                variant={entry.offer === 'install' ? 'primary' : 'secondary'}
                disabled={desktopEntry.isPending}
                onClick={() => desktopEntry.mutate(entry.offer === 'install' ? 'install' : 'remove')}
              >
                {entry.offer === 'install' ? 'Add to apps' : 'Remove from apps'}
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
      {desktopEntry.isError ? <ErrorState error={desktopEntry.error} /> : null}
      {update.isError ? <ErrorState error={update.error} /> : null}
    </section>
  );
}
