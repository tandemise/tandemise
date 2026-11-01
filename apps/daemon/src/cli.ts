#!/usr/bin/env node
/**
 * `tandemise`: a thin command over the daemon's API (spec
 * 2026-10-30-intake-design.md §2 "The CLI").
 *
 * It holds no state and no rules: it reads the daemon's connection file (or
 * an intake token from the environment), calls one route, and prints the
 * daemon's own words. Plan Task 3 ships `intake push`, Task 8 `start`,
 * Task 13 `intake closures`.
 *
 * Exit codes: 0 when the daemon accepted the request, 1 when it refused (or
 * cannot be reached), 2 for a usage error.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { defaultRoot } from '@tandemise/shared';
import {
  API_VERSION, API_VERSION_HEADER, INTAKE_SCHEMA_V1, type IngestResultView, type IntakeClosuresView, type IntakeClosureView, type MissionSummary,
} from '@tandemise/api-contract';
import { readConnectionFile } from './http/identity.js';

const USAGE = `Usage:
  tandemise intake push --source <id> --file <signal.json> [--project <id>]
  tandemise intake push --source <id> --title <text> --url <https link> --key <id> [--description <text>] [--project <id>]
  tandemise intake closures --source <id> [--ack <closureId> [--error <text>]] [--project <id>]
  tandemise start <key> [--project <id>]

Connects with $TANDEMISE_HOME/daemon.json, or with TANDEMISE_URL and
TANDEMISE_INTAKE_TOKEN when both are set.`;

class UsageError extends Error {}
class Refusal extends Error {}

interface Connection {
  readonly url: string;
  readonly token: string;
  /** True for an intake token: its project and source come from the token. */
  readonly intakeToken: boolean;
}

async function main(argv: readonly string[]): Promise<number> {
  const [group, command, ...rest] = argv;
  if (group === undefined || group === '--help' || group === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return group === undefined ? 2 : 0;
  }
  if (group === 'intake' && command === 'push') return intakePush(rest);
  if (group === 'intake' && command === 'closures') return intakeClosures(rest);
  if (group === 'start') return start(argv.slice(1));
  throw new UsageError(`Unknown command '${[group, command].filter(Boolean).join(' ')}'.`);
}

async function intakePush(args: readonly string[]): Promise<number> {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        project: { type: 'string' }, source: { type: 'string' }, file: { type: 'string' },
        title: { type: 'string' }, url: { type: 'string' }, key: { type: 'string' }, description: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }) as { values: Record<string, string | undefined> });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const source = values['source'];
  if (source === undefined || source === '') throw new UsageError('Name the source with --source.');
  const body = values['file'] !== undefined ? readSignalFile(values['file']) : signalFromFlags(source, values);

  const connection = connect();
  const query = new URLSearchParams({ source });
  if (connection.intakeToken) {
    if (values['project'] !== undefined) query.set('workspace', values['project']);
  } else {
    query.set('workspace', values['project'] ?? (await onlyProject(connection)));
  }
  const answer = await call(connection, 'POST', `/v1/intake/signals?${query.toString()}`, body);
  for (const r of (answer as { results: readonly IngestResultView[] }).results) {
    process.stdout.write(`${r.fingerprint ?? '(unreadable signal)'}: ${r.status}\n`);
    if (r.reason !== null) process.stdout.write(`  ${r.reason}\n`);
  }
  return 0;
}

/**
 * A custom source's closures (plan Task 13): one line per closure,
 * `<id> <fingerprint> <state>`. With `--ack`, acknowledges that one (closed,
 * or failed with `--error`'s words) and prints its line.
 */
async function intakeClosures(args: readonly string[]): Promise<number> {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: { project: { type: 'string' }, source: { type: 'string' }, ack: { type: 'string' }, error: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }) as { values: Record<string, string | undefined> });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const source = values['source'];
  if (source === undefined || source === '') throw new UsageError('Name the source with --source.');
  const ack = values['ack'];
  if (values['error'] !== undefined && (ack === undefined || ack === '')) throw new UsageError('--error goes with --ack <closureId>.');

  const connection = connect();
  const line = (c: IntakeClosureView): string => `${c.id} ${c.fingerprint} ${c.state}`;
  if (ack !== undefined && ack !== '') {
    const error = values['error'];
    const body = error === undefined ? { ok: true } : { ok: false, error };
    const answer = (await call(connection, 'POST', `/v1/intake/closures/${encodeURIComponent(ack)}/ack`, body)) as IntakeClosureView;
    process.stdout.write(`${line(answer)}\n`);
    return 0;
  }
  const query = new URLSearchParams({ sourceId: source });
  if (connection.intakeToken) {
    if (values['project'] !== undefined) query.set('workspace', values['project']);
  } else {
    query.set('workspace', values['project'] ?? (await onlyProject(connection)));
  }
  const answer = (await call(connection, 'GET', `/v1/intake/closures?${query.toString()}`)) as IntakeClosuresView;
  for (const c of answer.closures) process.stdout.write(`${line(c)}\n`);
  return 0;
}

/** Starts a tracker item as a mission (plan Task 8), with the daemon token only. */
async function start(args: readonly string[]): Promise<number> {
  let values: Record<string, string | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...args],
      options: { project: { type: 'string' } },
      strict: true,
      allowPositionals: true,
    }) as { values: Record<string, string | undefined>; positionals: string[] });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const key = positionals[0];
  if (key === undefined || key === '' || positionals.length > 1) throw new UsageError('Name one item to start, e.g. tandemise start ACME-12.');
  const connection = connect();
  if (connection.intakeToken) throw new Refusal('An intake token can only push signals. Start from the machine running Tandemise.');
  const project = values['project'] ?? (await onlyProject(connection));
  const answer = (await call(connection, 'POST', `/v1/workspaces/${encodeURIComponent(project)}/board/start`, { key })) as MissionSummary;
  process.stdout.write(`Started ${key}: ${answer.mission.title}\n`);
  return 0;
}

function readSignalFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new UsageError(`Cannot read ${path}.`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UsageError(`${path} is not JSON.`);
  }
}

/** Without a file, a signal of the custom kind whose instance is the source id. */
function signalFromFlags(source: string, values: Record<string, string | undefined>): unknown {
  const { title, url, key, description } = values;
  if (title === undefined || url === undefined || key === undefined) {
    throw new UsageError('Give --file, or --title, --url and --key.');
  }
  return {
    schema: INTAKE_SCHEMA_V1,
    source: { kind: 'custom', instance: source },
    key, url, title,
    ...(description === undefined ? {} : { description }),
  };
}

function connect(): Connection {
  const url = process.env['TANDEMISE_URL'];
  const token = process.env['TANDEMISE_INTAKE_TOKEN'];
  if (url !== undefined && url !== '' && token !== undefined && token !== '') return { url, token, intakeToken: true };
  const home = defaultRoot();
  const file = readConnectionFile(home);
  if (file === undefined) throw new Refusal(`Tandemise is not running: there is no daemon.json in ${home}.`);
  return { url: file.url, token: file.token, intakeToken: false };
}

/** The daemon token reaches every project; the CLI picks one only when there is exactly one. */
async function onlyProject(connection: Connection): Promise<string> {
  const list = (await call(connection, 'GET', '/v1/workspaces')) as readonly { workspace: { id: string } }[];
  if (list.length !== 1) throw new UsageError('Name the project with --project.');
  return list[0]!.workspace.id;
}

async function call(connection: Connection, method: string, path: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${connection.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${connection.token}`,
        [API_VERSION_HEADER]: API_VERSION,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Refusal(`Cannot reach Tandemise at ${connection.url}.`);
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text === '' ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!res.ok) {
    const message = (parsed as { error?: { message?: string } } | undefined)?.error?.message;
    throw new Refusal(message ?? `Tandemise answered ${res.status}.`);
  }
  return parsed;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e: unknown) => {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n\n${USAGE}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  },
);
