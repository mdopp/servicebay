# Beets — music tagger

[beets](https://beets.io) reads the audio files in your music folder, looks
each album up in MusicBrainz, and writes proper tags back into the files —
artist, album, track number, year, cover art. A media server such as Jellyfin
then has something to build a library from instead of guessing from filenames.

The service runs beets' **web UI**, a browser for what is already in the beets
library, published on your LAN. Tagging itself is something **you trigger**;
this template does not run it for you. The rest of this file explains why, and
how to trigger it.

## Why nothing is imported automatically

`beet import` is not a read-only operation. It edits the tags inside your audio
files, and — depending on configuration — it also **moves and renames** them
into a folder scheme of its own. When it can't tell which release an album is,
beets normally asks. Running unattended it can only do one of two things:
stop and wait forever, or pick the first plausible answer and write it.

Neither is something that should happen to somebody's music collection at
03:00 without them knowing. So the choice here was between three options:

| Option | Verdict |
|---|---|
| **Import on a schedule** | No. A silent nightly job that rewrites files is the failure mode we are trying to avoid, not a feature. If it guesses wrong you find out months later. |
| **Watch a drop folder** | No, for now. It is the safer shape of automation — only *new* arrivals get touched, never the existing library — but it needs a staging folder that is separate from the library, and there isn't one yet. Worth revisiting when there is. |
| **Operable, you trigger it** | **Yes.** The UI is reachable, the defaults are safe, and the import command is one line. The decision about your own music collection stays with you. |

There is a concrete reason to be careful rather than a theoretical one. Before
this template existed, this service was installed from a hand-written local
copy that carried a "nightly import" helper script. That script would have run
a quiet, unattended import over the whole library every night, against a config
that had **`import: move: yes`** and a `paths:` rename scheme — in other words,
it would have restructured and renamed the entire collection overnight. It
never actually ran (its shell variables came out empty, and the location it was
dropped into is no longer executed by the base image), so nobody noticed. A
quiet import that fails silently is bad. A quiet import that *succeeds*
unnoticed is worse.

## What you get instead

- **A reachable web UI** at `http://<your-box>:8337` — the library browser, so
  you can see what beets actually knows about. LAN-only, on purpose (below).
- **Safe defaults.** On a fresh install `post-deploy.py` seeds
  `/config/config.yaml` with `import.copy: no`, `import.move: no`,
  `import.write: yes`: beets writes tags into your files where they already
  are and never relocates or renames anything. `web.readonly: yes` keeps the
  browser a browser.
- **A health check that tells the truth.** Alongside the normal "is it up"
  probe, the install registers a second check that compares what is in the
  beets library against the audio files actually sitting under `/music`, and
  goes **red when the library covers less than `BEETS_COVERAGE_MIN_PERCENT`
  of them** (default 90 %). See below for why it is a ratio and not "the
  library has something in it".
- **An import you can run in one line**, below.

## Running an import

Interactive — beets asks you about anything it isn't sure of. This is the one
to use the first time:

```bash
podman exec -it beets-beets beet import /music
```

Unattended-safe bulk pass — applies only matches beets is confident about and
**skips** everything ambiguous instead of guessing. `-i` (incremental) means
re-running it only looks at directories it hasn't seen:

```bash
podman exec beets-beets beet import -q -i /music
```

Look before you leap:

```bash
podman exec beets-beets beet stats      # how much is in the library
podman exec beets-beets beet ls -a      # which albums
```

Skipped albums are listed in beets' import log so you can come back and handle
them interactively.

> **Check the config before the first import**, especially if this service was
> installed before and you have a `/config/config.yaml` from then. `post-deploy.py`
> never overwrites an existing config — it only warns. If yours has `move: yes`
> or `copy: yes` under `import:`, an import **will relocate and rename** every
> file it touches, whichever command above you use. Set them to `no` first
> unless that is genuinely what you want.

## The coverage check, and why it is a ratio

The first version of this check asserted that beets' `/stats` endpoint reported
at least one item. It went green after the first album and never went back —
so a box with 27,000 audio files and 485 items in the library reported healthy
while nearly all of the music was still untagged. A media server then scans
that untagged remainder over and over, which is how "beets looks fine" turns
into a machine under load.

The number that was missing is the **denominator**: how many audio files are on
disk. It is not in beets' answer, and ServiceBay's HTTP check is status code +
body regex, so no pattern over `{"albums": M, "items": N}` can express it.
Baking a file count into the check instead would only move the lie — it would
be wrong again the next time you add an album.

So a second container in the pod answers the question where both numbers exist:

```bash
curl -s http://127.0.0.1:8338/coverage
{"music_dir": "/music", "files": 27268, "items": 485, "percent": 1.8,
 "min_percent": 90.0, "status": "behind", "detail": "…"}
```

It walks `/music` once an hour (dot-directories such as Syncthing's
`.stversions` are skipped so copies don't inflate the count), asks beets for
its item count over the pod's own loopback, and answers `200` at or above the
floor and `503` below it. That endpoint is bound to `127.0.0.1` on the host —
its only consumer is ServiceBay's health poller.

Two consequences worth knowing:

- **100 % is not the target.** `beet import -q` skips albums it can't match
  confidently, and a folder can hold audio beets has no business tagging. 90 %
  is the default floor; `BEETS_COVERAGE_MIN_PERCENT` moves it.
- **A red check here means "there is tagging work to do"**, not "the service is
  broken". The liveness check is separate and stays green.

## Why it is LAN-only, with no subdomain and no SSO

beets' web plugin has **no authentication at all** — no login, no token,
nothing. Exposing it on a public hostname would mean the only thing between the
internet and this UI is Authelia forward-auth on the proxy host, and this is a
UI that fronts a service capable of rewriting a music library. That is a worse
trade than for a read-only dashboard, and there is no use case for reaching a
music tagger from outside the house.

So: a plain `hostPort` on the LAN, no `type: subdomain` variable, no `nginx` or
`auth` dependency. Per ADR 0007 the pod runs in its own network namespace — it
is not on the closed `hostNetwork` carve-out list and has no reason to be.

## Permissions, and why the pod runs as container UID 0

Under rootless podman, container UID 0 maps to the host user that runs podman
(`core`), which owns the file-share data tree. A container running as UID 1000
maps to a *sub*-UID that has no write access to those files at all — so beets
would fail to write a single tag, silently, on every import. `securityContext:
runAsUser: 0` plus `PUID`/`PGID` of `0` is the same arrangement file-share's
own containers use for the same reason.

## Upgrading from a local copy of this template

If `beets` was installed from a local (file-dropped) template, that copy still
**wins over this one** — local templates override built-ins by name. To hand
the service over:

1. Remove the local directory: `DATA_DIR/local-templates/templates/beets`
   (inside the ServiceBay container: `/app/data/local-templates/templates/beets`).
   This does **not** touch the running service — the deployed unit and its data
   are independent of the template it was rendered from.
2. Re-deploy `beets` from the wizard. The volume paths are unchanged, so the
   library database, the config, and the music all stay exactly where they are.

`migrations/v1-to-v2.py` handles the one thing that does have to change: the
`/config` directory was written by a container running as UID 1000, so it is
owned by a sub-UID that the new UID-0 container cannot write. The migration
re-owns it. See `CHANGELOG.md`.
