import { useState } from 'react';
import type { MissionClaimView } from '@tandemise/api-contract';
import { DaemonError } from '../lib/daemon.js';
import { useDaemonMutation } from '../lib/queries.js';
import { Icon } from './Icon.js';
import { Modal } from './Modal.js';
import { ErrorState } from './primitives.js';
import { Banner, Button } from '@tandemise/design/react';

/**
 * A mission's claim with the team, when it needs saying (relay spec):
 * Unclaimed (someone else holds the item now; the mission keeps running and
 * you decide) or Pending (the relay hears about it when you're back online).
 */
export function ClaimBanner({ missionId, claim }: { missionId: string; claim: MissionClaimView }): JSX.Element | null {
  const act = useDaemonMutation(
    (daemon, action: 'stop' | 'take-back' | 'keep-going') =>
      action === 'stop' ? daemon.stopWorking(missionId)
        : action === 'take-back' ? daemon.takeBackClaim(missionId)
          : daemon.keepGoingWithoutClaim(missionId),
    ['coordination', 'missions'],
    missionId,
  );
  if (claim.state === 'held') return null;
  if (claim.state === 'pending') {
    return (
      <Banner data-claim="pending" icon={<Icon name="clock" size={15} className="dim" />}>
        {claim.sentence}
      </Banner>
    );
  }
  return (
    <div className="stack" style={{ gap: 'var(--s2)' }}>
      <Banner
        tone="warn"
        data-claim="unclaimed"
        icon={<Icon name="alert" size={15} />}
        action={
          <>
            <Button disabled={act.isPending} onClick={() => act.mutate('stop')}>Stop</Button>
            {claim.mayTakeBack ? (
              <Button disabled={act.isPending} onClick={() => act.mutate('take-back')}>Take it back</Button>
            ) : null}
            <Button variant="primary" disabled={act.isPending} onClick={() => act.mutate('keep-going')}>Keep going without a claim</Button>
          </>
        }
      >
        <strong>Unclaimed.</strong> {claim.sentence} This mission keeps running until you decide.
      </Banner>
      {act.isError ? <ErrorState error={act.error} /> : null}
    </div>
  );
}

/** The daemon's refusal to start a held item, when `error` is one; null otherwise. */
export function claimHeld(error: unknown): { message: string; claimId: string; takeOver: boolean; missionId: string | null } | null {
  if (!(error instanceof DaemonError) || error.details['reason'] !== 'claim_held') return null;
  return {
    message: error.message,
    claimId: String(error.details['claimId'] ?? ''),
    takeOver: error.details['takeOver'] === true,
    missionId: typeof error.details['missionId'] === 'string' ? error.details['missionId'] : null,
  };
}

/**
 * "Ana is working on ACME-123 since 10:42." with **Take over** where the rules
 * allow it, and **Not now**. There is no "start anyway": silent parallel work
 * is what this exists to prevent.
 */
export function ClaimRefusal({ error, onClose, onTakenOver }: { error: unknown; onClose: () => void; onTakenOver: () => void }): JSX.Element | null {
  const held = claimHeld(error);
  const take = useDaemonMutation(
    (daemon, args: { claimId: string; missionId: string | null }) => daemon.takeOverClaim(args.claimId, args.missionId),
    ['coordination', 'missions'],
  );
  if (held === null) return null;
  return (
    <Modal
      title="Someone is working on this"
      onClose={onClose}
      footer={
        <>
          <Button data-autofocus onClick={onClose}>Not now</Button>
          {held.takeOver ? (
            <Button
              variant="primary"
              disabled={take.isPending}
              onClick={() => take.mutate({ claimId: held.claimId, missionId: held.missionId }, { onSuccess: () => { onClose(); onTakenOver(); } })}
            >
              Take over
            </Button>
          ) : null}
        </>
      }
    >
      <p className="claim-refusal__message" style={{ margin: 0 }}>{held.message}</p>
      {take.isError ? <ErrorState error={take.error} /> : null}
    </Modal>
  );
}

/**
 * An error from an action that may start a mission (a plan approval): the
 * claim refusal as a dialog when the item is held, the plain error otherwise.
 */
export function ClaimAwareError({ error, onRetry }: { error: unknown; onRetry: () => void }): JSX.Element | null {
  const [closed, setClosed] = useState<unknown>(null);
  if (claimHeld(error) === null) return <ErrorState error={error} />;
  if (closed === error) return null;
  return <ClaimRefusal error={error} onClose={() => setClosed(error)} onTakenOver={onRetry} />;
}
