import type { Closure, IntakeSourceConfig } from '@tandemise/domain';
import { MAX_TITLE, cut, record, text } from './http.js';

/**
 * What Slack and Discord share (spec §2 "From chat, only explicit work comes
 * in", §8; plan Task 12): the trigger, the title, and the one reply that
 * closes the loop.
 */

/** Spec §2: the configured emoji, `:tandemise:` by default; written with or without colons. */
export function triggerEmoji(source: IntakeSourceConfig): string {
  return (source.trigger?.emoji ?? 'tandemise').replace(/^:+|:+$/g, '');
}

/** Spec §2: a mention of the app files the message too, unless the source switched it off. */
export function mentionTriggers(source: IntakeSourceConfig): boolean {
  return source.trigger?.mention !== false;
}

/**
 * Whether the runner acknowledges with reactions (`:eyes:` when filed, swapped
 * for `:white_check_mark:` when done): on unless the source sets
 * `trigger.react: false` (Ruling 26), for a channel that wants no bot marks.
 */
export function reacts(source: IntakeSourceConfig): boolean {
  return source.trigger?.react !== false;
}

/**
 * The first line of a message as a signal's title: mentions taken out (the
 * app's own name is not the work), cut at the contract's 200. The fallback
 * when nothing is left keeps the title required by the contract.
 */
export function titleOf(message: string, fallback: string): string {
  const line = message.replace(/<@!?[A-Za-z0-9]+>/g, ' ').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find((l) => l !== '');
  return cut(line ?? fallback, MAX_TITLE);
}

/** How the loop's reply starts: what each runner looks for before posting (Review Focus 5). */
export function replyPrefix(kind: Closure['kind']): string {
  return kind === 'done' ? 'Done:' : 'Not planned:';
}

/**
 * Spec §8: "Done: <title> · ACME-12 · <PR>", the PR left out when there is
 * none. A won't-do item (only with `closeWontDo`) says "Not planned:" and
 * names no PR.
 */
export function replyText(closure: Closure): string {
  const parts = [closure.signal.title, closure.item.key];
  if (closure.kind === 'done' && closure.prUrl !== null) parts.push(closure.prUrl);
  return `${replyPrefix(closure.kind)} ${parts.join(' · ')}`;
}

/**
 * The thread a closure replies in: the signal's `reply.address`, which the
 * runner wrote as `<channel>:<id>` (RULINGS ruling 18), else its key, which
 * has the same shape.
 */
export function replyAddress(closure: Closure): { readonly channel: string; readonly id: string } | null {
  const address = text(record(closure.signal.reply)['address']) ?? closure.signal.key;
  const at = address.indexOf(':');
  if (at <= 0 || at === address.length - 1) return null;
  return { channel: address.slice(0, at), id: address.slice(at + 1) };
}

/**
 * `<before>#<after>` (Slack's `<workspace>#<channel>`, Discord's
 * `<guild>#<channel>`), or null when either side is empty.
 */
export function splitInstance(instance: string): { readonly scope: string; readonly channel: string } | null {
  const at = instance.lastIndexOf('#');
  if (at <= 0 || at === instance.length - 1) return null;
  return { scope: instance.slice(0, at), channel: instance.slice(at + 1) };
}
