import { Icon } from '../components/Icon.js';
import { Logo } from '../components/Logo.js';
import { useConnection } from '../lib/connection.js';
import { Banner, Button, Truncate } from '@tandemise/design/react';

/**
 * Shown whenever the daemon is not answering. It is a first-class screen, not
 * an error toast: without the daemon there is nothing else to render, and the
 * user's next action ("is it running? where does it look?") is a real one.
 */
export function DaemonDown(): JSX.Element {
  const { status, reconnect, reconnecting } = useConnection();
  const busy = reconnecting || status.phase === 'spawning' || status.phase === 'connecting';

  return (
    <main style={{ minHeight: '100%', display: 'grid', placeItems: 'center', padding: 'var(--s8) var(--s4)', background: 'var(--canvas)', overflowWrap: 'anywhere' }}>
      <div style={{ maxWidth: 460, width: '100%', minWidth: 0, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--s4)' }}>
        {/* The mark only takes its colour while there is something to connect to. */}
        <Logo size={34} muted={!busy} />

        <div>
          <h1 style={{ fontSize: 'var(--fs-lg)', fontWeight: 620, letterSpacing: '-0.015em' }}>
            {busy ? 'Connecting to the daemon…' : 'The Tandemise daemon is not running'}
          </h1>
          <p style={{ marginTop: 'var(--s2)', color: 'var(--text-secondary)', lineHeight: 1.65, fontSize: 'var(--fs-base)' }}>
            {status.detail}
          </p>
        </div>

        <Banner style={{ textAlign: 'left', width: '100%' }} icon={<Icon name="folder" size={15} className="dim" />}>
          <div className="dim" style={{ fontSize: 'var(--fs-xs)' }}>
            Looking for the handshake file at
          </div>
          <Truncate as="div" className="mono">
            {status.handshakePath}
          </Truncate>
        </Banner>

        <div className="row" style={{ gap: 'var(--s2)' }}>
          <Button variant="primary" size="lg" onClick={reconnect} disabled={busy}>
            <Icon name="refresh" size={14} />
            {busy ? 'Trying…' : 'Retry'}
          </Button>
        </div>

        <p className="dim" style={{ fontSize: 'var(--fs-xs)', lineHeight: 1.6 }}>
          Tandemise will try to start the daemon for you. If that keeps failing, start it by hand with{' '}
          <code style={{ fontFamily: 'var(--tds-font-mono)' }}>npm run daemon</code> and press Retry.
        </p>
      </div>
    </main>
  );
}
