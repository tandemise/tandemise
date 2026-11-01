# Writing an intake runner

Intake brings "something that might be work" from any source into your
project's primary tracker (YouTrack or GitHub Issues), filed once: a new item,
or a link to the item that already tracks it. A person starts an item from the
**Board**, and only then does a mission exist. When the item is done, the loop
closes at every source it came from.

Tandemise ships runners for GitHub issues, Sentry, PostHog, Slack and Discord;
they run inside the daemon. Anything else is a **custom runner**: your own
script, cron job or service that pushes signals over a loopback HTTP route or
with the `tandemise` CLI, and pulls back the closures it should act on. This
page is for whoever writes one.

The design is in
[`docs/superpowers/specs/2026-10-30-intake-design.md`](../superpowers/specs/2026-10-30-intake-design.md).

## 1. Add the source

A runner pushes for one **source** of one project. Add it in **Settings →
Intake → Sources** with the kind **A custom runner** and an id such as
`web-form`. Then, under **Custom sources**, press **Make a token**. The token
(`tdi_…`) is shown once: keep it with the runner. Only its hash is stored, so
a lost token cannot be recovered: make another.

The project needs a tracker first. Without one, every push is refused with
"Set this project's tracker first."

## 2. The contract: `tandemise.intake/v1`

A signal is one JSON object. The JSON Schema is
[`signal.v1.schema.json`](signal.v1.schema.json); the zod schema
`intakeSignalV1` in `@tandemise/api-contract` is the authority, and the two
agree. `GET /v1/intake/schema` answers the versions a daemon accepts.

```json
{
  "schema": "tandemise.intake/v1",
  "source": { "kind": "custom", "instance": "web-form" },
  "key": "form-18",
  "url": "https://forms.example.com/replies/18",
  "title": "Export to CSV drops accents",
  "description": "Ñandú becomes Nand in the export.",
  "reporter": { "name": "Sam", "handle": "sam" },
  "impact": { "events": 4, "users": 2, "level": "error" },
  "reply": { "address": "C0SUPPORT:1730000001.000100" }
}
```

- **Required:** `schema`, `source`, `key`, `url` (https only), `title`
  (at most 200 characters).
- **`source`** must be this source's own kind and instance as configured. A
  custom source's instance is its id unless you set another, and the CLI
  always pushes `{ "kind": "custom", "instance": "<source id>" }`.
- **The fingerprint** is `<kind>:<instance>:<key>`. The same fingerprint always
  updates the same signal (its count goes up); it never files a second item.
- **Unknown fields are refused**, each named in the reason. A newer schema
  version than the daemon knows is refused with the versions it accepts.
- **Text is data.** The title, description and labels only ever become the
  tracker item's text (and, after Start, the mission's goal, quoted). No field
  can choose the project, the tracker, a state, a threshold or another source.
- **Attachments:** at most 10, inline ones at most 1 MB each and 5 MB in all;
  link anything bigger with a `url`.
- **`reply`** is opaque to Tandemise. Set it when your runner needs an address
  back to answer where the work came from; the closure hands it back.
- A push is one signal, or `{ "signals": [ … ] }` of at most 50. Each signal is
  checked on its own: one bad signal is recorded as rejected, the others go on.

## 3. Pushing

Over HTTP, to the daemon's loopback address (`url` in
`~/.tandemise/daemon.json`):

```bash
curl -s -X POST "$TANDEMISE_URL/v1/intake/signals" \
  -H "authorization: Bearer $TANDEMISE_INTAKE_TOKEN" \
  -H 'x-tandemise-api-version: v1' \
  -H 'content-type: application/json' \
  -d @signal.json
```

The answer is `202` with one result per signal:

```json
{ "results": [ { "fingerprint": "custom:web-form:form-18", "signalId": "…", "status": "received", "reason": null } ] }
```

`received` means it is recorded. Filtering, dedupe and filing happen after the
answer, so a slow tracker never holds your request open. Follow it in the
**Intake** tab of the Board: "Filed as ACME-12", "Linked to ACME-7",
"Held back: 3 events in 24 h; this source needs 20", "Needs your decision"
(an Inbox card asks "Is this the same as ACME-7?"), "Rejected: …".

Or with the CLI, which needs no `curl`:

```bash
export TANDEMISE_URL=http://127.0.0.1:47321          # the daemon's address
export TANDEMISE_INTAKE_TOKEN=tdi_…
tandemise intake push --source web-form --title "Export to CSV drops accents" \
  --url https://forms.example.com/replies/18 --key form-18 [--description "…"]
tandemise intake push --source web-form --file signal.json
```

It prints `<fingerprint>: <status>` per signal, and a reason line under one
that has a reason.

## 4. Auth and refusals

- **An intake token opens only its own source's routes:** pushing
  (`POST /v1/intake/signals`), reading its closures and acking them. Anything
  else, or another source, is `403`: "This token can only push to 'web-form'."
- **The daemon token** (`daemon.json`) can push for any project and source, but
  must name both: `POST /v1/intake/signals?workspace=<id>&source=<id>`.
- **Rate:** 60 signals a minute per token, counted per signal (a batch of 50 is
  50). Past it the push is `429`, "Too many signals from this source: at most
  60 a minute.", and safe to retry.
- **Revoking:** `DELETE /v1/intake/tokens/<id>` (daemon token) stops a token at
  once.
- The API listens on `127.0.0.1` only. A runner on another machine pushes
  through something you run there (an SSH tunnel, your own relay), never
  through an open port.

Every refusal is `{ "error": { "code", "message" } }`, and `message` is a
sentence meant for a person: print it as it is.

### Webhooks for the shipped runners

Sentry and PostHog can also push to Tandemise. The runner verifies each
delivery with the source's secret on your computer; nothing in between reads
the body.

- **With a team relay:** in Settings → Team relay → Webhooks, add a webhook
  address for the project and **name it exactly after the source id**
  (`sentry-web`). Paste its URL into Sentry. Only the computer that runs the
  source at the moment reads its deliveries. A delivery to an address named
  after no source is left on the relay and, after ten tries, shows there as
  "couldn't be processed".
- **Without one:** set `intakeWebhookPort` in the local settings and point
  your own tunnel (cloudflared, ngrok) at
  `http://127.0.0.1:<port>/hooks/<workspace id>/<source id>`. It is the only
  path served. A project or source this computer doesn't configure is `404`
  and nothing is stored; each source takes at most 60 deliveries a minute
  (`429` beyond).
- Sentry deliveries whose `Sentry-Hook-Timestamp` is more than 5 minutes from
  when they were received are refused.

## 5. Closing the loop: the closures feed

When the tracker item reaches a mapped **done** state (whoever moved it there),
Tandemise opens one closure per signal linked to it. The shipped runners close
theirs themselves. A custom runner **pulls** its closures, because the daemon
never calls arbitrary URLs:

```bash
curl -s "$TANDEMISE_URL/v1/intake/closures?after=<last id you saw>" \
  -H "authorization: Bearer $TANDEMISE_INTAKE_TOKEN" -H 'x-tandemise-api-version: v1'
```

```json
{
  "closures": [
    {
      "id": "…",
      "fingerprint": "custom:web-form:form-18",
      "key": "form-18",
      "url": "https://forms.example.com/replies/18",
      "kind": "done",
      "state": "pending",
      "item": { "key": "ACME-12", "url": "https://acme.youtrack.cloud/issue/ACME-12" },
      "prUrl": "https://github.com/acme/web/pull/88",
      "reply": { "address": "C0SUPPORT:1730000001.000100" },
      "lastError": null
    }
  ]
}
```

- Closures come in id order; pass the last id you handled as `after`.
- `kind` is `done`, or `not_planned` when the item was won't-do and the source
  has "Say so when the task won't be done" switched on.
- Do what closing means for your source (reply, resolve, close), then ack:

```bash
curl -s -X POST "$TANDEMISE_URL/v1/intake/closures/<id>/ack" \
  -H "authorization: Bearer $TANDEMISE_INTAKE_TOKEN" -H 'x-tandemise-api-version: v1' \
  -H 'content-type: application/json' -d '{"ok":true}'
# or, when it could not: -d '{"ok":false,"error":"The form service answered 503."}'
```

An ack of a closure already closed changes nothing, so acking twice after a
crash is safe; make your own side idempotent too (look for your earlier reply
before posting another). A failed ack shows in the Intake tab as
"Couldn't close: …" with **Retry**.

With the CLI:

```bash
tandemise intake closures --source web-form                  # <id> <fingerprint> <state>, one per line
tandemise intake closures --source web-form --ack <id>       # closes it
tandemise intake closures --source web-form --ack <id> --error "The form service answered 503."
```

## 6. The `tandemise` CLI

`tandemise` is a thin command over the daemon's API: it holds no state and
prints the daemon's own words. From a checkout, `npm install` links it as
`node_modules/.bin/tandemise` (run it with `npx tandemise`).

```
tandemise intake push --source <id> --file <signal.json> [--project <id>]
tandemise intake push --source <id> --title <text> --url <https link> --key <id> [--description <text>] [--project <id>]
tandemise intake closures --source <id> [--ack <closureId> [--error <text>]] [--project <id>]
tandemise start <key> [--project <id>]
```

It connects with `$TANDEMISE_HOME/daemon.json` (the daemon token; name the
project with `--project` when there is more than one), or with
`TANDEMISE_URL` and `TANDEMISE_INTAKE_TOKEN` when both are set. `start` needs
the daemon token: an intake token can only push signals. Exit codes: `0`
accepted, `1` refused (the daemon's sentence on stderr) or unreachable, `2` a
usage error.
