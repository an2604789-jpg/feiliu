# feiliu · 飞流下载器

飞流(FeiLiu) — a complete download manager (orig. downloadx): concurrent segmented transfers, a persistent queue,
a scheduler, FTP / HTTP(S) / HLS / DASH support, browser integration, a media
sniffer and a site grabber — with a web GUI.

Original implementation. Zero runtime dependencies: Node.js >= 20 is the only
requirement.

---

## Quick start

`BT`bash
# start the daemon and open the GUI
node bin/downloadx.mjs daemon
# (in another shell)
node bin/downloadx.mjs open
`BT`

Or from Windows: double-click `downloadx.cmd`.

`BT`bash
# one-off download in the foreground
node bin/downloadx.mjs get https://example.com/big.iso -c 16

# queue it in the background
node bin/downloadx.mjs add https://example.com/big.iso

# see what is happening
node bin/downloadx.mjs list
node bin/downloadx.mjs status
`BT`

---

## Desktop app (Windows)

A standalone Electron build runs the same engine, daemon, queue and persistence
inside a dedicated **DownloadX window** — it never opens the GUI in Edge/Chrome,
and no external browser is required. The download core is reused unchanged.

```bash
npm install
npm run desktop          # run the desktop window from source
npm run desktop:dir      # build an unpacked app -> release/win-unpacked/
npm run desktop:build    # build a portable single-file -> release/DownloadX-Portable-<version>-x64.exe
```

End users can just double-click `release\DownloadX-Portable-<version>-x64.exe`
(or `release\win-unpacked\DownloadX.exe`); no Node.js install is needed.

Desktop tests:

```bash
npm run desktop:test     # daemon lifecycle: spawn / reuse / stale-runtime replacement
npm run desktop:e2e      # real Electron window: add/pause/resume/fail-retry + restart persistence
```

Behavior and security:

- On launch the window reuses a healthy local daemon or spawns its own; closing
  the window stops only the daemon it started. The daemon listens on
  `127.0.0.1` with a random token kept in `runtime.json`; the token is never
  logged.
- The capture proxy, browser extension and third-party traffic capture are
  **off by default** and must be enabled manually.
- Data stays under `%APPDATA%\downloadx` (override with `DOWNLOADX_HOME`);
  upgrading or reinstalling keeps the queue and settings.

See `Windows安装与首次使用.md` (install/usage) and `验收流程说明.md`
(acceptance steps and results) for details.

---

## Commands

| Command | Purpose |
|---|---|
| `get <url...>` | Download now, in the foreground, with a progress bar |
| `add <url...>` | Queue it (starts the daemon automatically) |
| `list` | Queued, running and finished downloads |
| `status` | Daemon and queue summary |
| `pause [id|all]` / `resume [id|all]` | Queue control |
| `remove <id> [--delete]` | Remove a task, optionally deleting its file |
| @BT@grab <page>@BT@ | Queue every resource the page links to |
| `sniff <page>` | Find media streams on a page and describe them |
| `open` | Open the web GUI |
| `proxy [sub]` | Capture proxy: status / start / stop / list / ca |
| `stop` | Stop the daemon cleanly |
| `config [key[=value]]` | Read or write settings |
| `schedule [...]` | Time-based queue actions |
| `doctor` | Check Node, daemon, API, folders, native host and ffmpeg |
| `history [q]` | Show, search or clear the URL history (`add <url>` / `clear`) |
| `test` | Run the built-in self-test |

### Options for `get` / `add`

| Option | Meaning |
|---|---|
| `-o, --output <p>` | File or directory (auto-detected) |
| `-c, --connections <n>` | Connections, 1–32 |
| `-s, --segment-size <n>` | Segment size, e.g. `8M` |
| `-l, --limit <rate>` | Speed limit, e.g. `2M` |
| `--proxy <url>` | HTTP proxy |
| `-H, --header "N: v"` | Extra request header (repeatable) |
| `--referer <url>` / `--cookie <s>` | Site-specific headers |
| `-u` / `-p` | Credentials (FTP, HTTP auth) |
| `-k, --insecure` | Skip TLS verification |
| `--filename <n>` / `--kind <k>` | Override name / force protocol |
| `--dry-run` | Probe and print the plan only |

---

## What it does

### Concurrent segmented download
Probes `Accept-Ranges` and `Content-Length`, splits the resource into
byte ranges, and fetches them in parallel — each worker writing straight to its
own offset in one preallocated file. Files below 1 MiB are deliberately **not**
split, because connection setup costs more than it saves.

### Resume that survives a crash
Progress is kept **per segment** in its own small file under
`<file>.downloadx/segments/`, not in one large state document. A crash can
only lose the segment being written; startup rebuilds the rest. Every state
write is write-temp-then-rename, so a torn file is impossible.

### Integrity checks and automatic downgrade
Concurrent ranged downloads can silently produce a corrupt file when different
connections receive inconsistent content (CDN nodes out of sync, a middlebox
rewriting responses). downloadx:

1. compares the stored `ETag` / `Last-Modified` before resuming, and
   **discards stale partial data** rather than stitching two revisions together;
2. verifies the finished file when the origin supplies a validator;
3. **falls back to a single connection** when the origin ignores `Range` and
   answers 200, instead of letting every worker rewrite byte 0.

### Boundary verification (IDM's core fault tolerance)
Concurrent ranged connections can be served by different CDN backends, so a
finished file can hash consistently yet still be a blend of two revisions.
After the segments land, downloadx re-reads short windows across every
segment seam and compares them with fresh requests. A mismatch means the
origin is inconsistent, and the transfer is discarded and redone as a single
stream — which cannot disagree with itself.

An origin-published digest is verified too: `Digest`, `Content-Digest`,
`Repr-Digest` and `Content-MD5` are all parsed, and a mismatch deletes the
file instead of delivering it.

### Adaptive concurrency
A fixed connection count is a guess. downloadx treats the requested number
as a ceiling and adapts downward when a server pushes back:

- a 429/503 (or a Retry-After header) halves the working cap;
- further throttles **within the same cooldown do not halve again**, so a
  burst of rejections cannot collapse the transfer to one connection;
- healthy windows add one connection back, never all at once.

Retry-After is honoured as the cooldown, in either delta-seconds or HTTP
date form.

### Worker health
Two failure modes are watched while the fleet runs:

- **stall** — no bytes for 30s, which catches a socket that is open but dead;
- **relative slowness** — far below the mean of the other workers, which
  catches a degraded connection the stall timer would take minutes to notice.

A grace period protects freshly started workers, and workers parked on the
rate limiter are skipped. Without that last exclusion, turning on a speed
limit would make the monitor cancel every worker for appearing slow.

### Pre-flight sanity checks
A request for an archive that returns 300 bytes of text/html is an error
page, not a file. downloadx flags that during the probe. Probes to one host
are also serialised, because parallel probes are what trigger rate limits.

### Native muxing (no ffmpeg required)
Fragmented MP4 (what DASH and HLS-fMP4 deliver) is joined at the box level:
one ftyp, a moov holding both traks and both trex records, then the
fragments interleaved by decode time. No sample data is rewritten, so the
merge is lossless and needs no external binary.

ffmpeg remains available as a fallback for containers the box-level muxer
does not handle (MPEG-TS, legacy MP4). Prefer the native path unless you
know the tracks are not fragmented MP4.

### Dynamic segmentation
A worker that finds the queue empty looks for a long segment still in
flight and takes half its remaining tail. This is the upward counterpart
to the adaptive gate, and it only runs when the origin has proven it
serves byte ranges — after a downgrade the splitter stays out of the way,
because a range-less origin cannot fetch a tail at all.

### Layered TLS fallback
Handshake failures retry under progressively older parameters
(system default → TLS >= 1.2 → TLS >= 1.0) before the transfer is declared dead.

### Rate limiting
A token bucket shared by all workers of one task, so `-l 2M` is the **total**
rate, not a per-connection rate. This covers HLS/DASH fragment downloads too:
concurrent fragments, both DASH tracks and a separate HLS audio rendition all
draw from the same bucket (one task = one bucket), and the wait is applied while
the response is read, so a throttled fragment is pulled off the socket slowly
instead of being buffered at line speed and delayed afterwards. `-l` overrides
the `speedLimit` setting for that one download.

This covers every strategy, including a chunked response whose length the origin
never declares: the streaming path checks the window while it reads, so a
schedule applies to it exactly as it does to a ranged transfer.

**Precedence.** A scheduled bandwidth window sets a *downloader-wide* cap that
every running task shares, so two concurrent downloads move the window's rate in
total rather than that rate each. A task's own `speedLimit` (the CLI `--limit`)
applies on top of it, and the effective rate is the **tighter of the two**.
Changing either one reaches transfers that are already running, not just the next
one; leaving the window restores unlimited. Unlimited (`0`) at task level means
"whatever the window says".

### Where a file lands
`-o <full file path>` is taken literally: the artefact is written to exactly
that path and no category subfolder is applied. `-o <directory>` hands the
directory to the strategy that owns the transfer: a plain HTTP or chunked
(unknown length) download writes straight into it, while HLS/DASH go through
the `categorizeByType` rules and land in e.g. `<dir>/video/`.

An exact path still obeys `overwriteExisting`, because naming a file says where
it goes, not that an existing file there may be destroyed:

| `overwriteExisting` | existing file at the requested path |
|---|---|
| `rename` (default) | artefact goes beside it as `movie (2).ts`; the summary reports the real path |
| `skip` | the task fails with `ALREADY_EXISTS`; the existing bytes are untouched |
| `overwrite` | the existing file is replaced |

A destination that cannot be created fails with the path you asked for and
the OS reason (`cannot create the output folder for Z:/missing/a.bin: ENOENT`),
on the plain HTTP, the streaming and the HLS/DASH strategies alike, instead of
an internal long-path spelling the user never typed.

The foreground `get` path and a queued download answer that table with a single
implementation (`chooseOutputName` in `src/downloader.mjs`), so
`get -o <existing file>` cannot behave differently from `add`, and the HLS/DASH
paths inherit the same answer. A transfer that was interrupted keeps the name
it already started under: the journal and staging file beside the target record
the URL that left them, so re-running the same command resumes instead of
renaming to `movie (2).ts`.

### Credentials and redirects
Following a redirect keeps the request headers while the target shares the
origin. As soon as the chain leaves the origin — a different scheme, host or
effective port — `Authorization`, `Cookie`, `Proxy-Authorization` and other
explicitly-marked credential headers (`X-Api-Key`, `X-Auth-Token`,
`X-Access-Token`, `X-Amz-Security-Token`, `X-Goog-Api-Key`) are dropped, and the
dropped names are reported by `requestFollow`. Non-credential headers such as
`Referer` or a custom trace header still travel.

### Queue and scheduler
A configurable number of simultaneous downloads; the rest wait. Scheduled
actions (start/pause/clear) fire at `HH:MM`, and the queue survives
restarts — anything that was mid-flight comes back **paused**, never silently
resumed.

### Proxy support: HTTP and SOCKS5

A proxy can be set once in Settings, or supplied per download:

```
downloadx get https://example.com/big.iso --proxy socks5://127.0.0.1:1080
downloadx get https://example.com/big.iso --proxy socks5://user:pass@127.0.0.1:1080
downloadx get https://example.com/big.iso --proxy http://127.0.0.1:8080
```

`https://` URLs work over both, because SOCKS5 is a transparent TCP relay and
the TLS handshake happens through it. Destination host names are handed to the
proxy to resolve (the `socks5h` behaviour), so names the local resolver cannot
reach still work. The proxy credential is used only for the proxy handshake and
is never forwarded to the destination.

The proxy set in Settings applies to every transfer; a per-task value overrides
it. SOCKS5 authentication is implemented in `src/net.mjs` (RFC 1928 + RFC 1929)
rather than pulled in as a dependency, in keeping with the zero-dependency rule.

### URL history

Every URL that enters the queue is recorded, so a link used before can be found
again instead of hunted for:

```
downloadx history              # the most recent 30
downloadx history ubuntu       # filter by URL or file name
downloadx history clear        # remove everything
```

The GUI has a **History** tab with the same list and a "Download again" button.

History is an append-only journal at `%APPDATA%\downloadx\history.jsonl`,
bounded to 500 entries by default. **Query parameters that look like credentials
are removed before anything is written**: `?token=`, `?sig=`, `?session=` and
similar are replaced by a `__redacted=1` marker, and a `user:password@` in the URL
is dropped entirely. The redaction is visible on purpose: re-queueing a redacted
URL may need the token added back, and the marker explains why rather than
leaving a silently failing download.

History is never deleted automatically. The `clear` command and the GUI's Clear
button are the only paths, and the GUI asks first.

### Protocols
HTTP/HTTPS, FTP (PASV/EPSV, `REST` resume, `SIZE` / `MDTM`),
HLS (`m3u8`, master and media playlists, `EXT-X-MAP` init segments,
AES-128 key detection) and DASH (`mpd`, `SegmentTemplate` expansion,
best-representation selection).

### Browser integration
A Manifest V3 extension plus a native messaging host:

- right-click "Download with downloadx", `Ctrl+Shift+D`, toolbar button;
- the content script hooks `fetch`, `XMLHttpRequest` and
  `MediaSource.addSourceBuffer` at `document_start`, so stream URLs
  surface before the page uses them;
- a small in-page badge offers the media it found.

Register the host once, passing the extension ID the browser assigned:

`BT`bash
node extension/install.mjs install --extension-id <id>
node extension/install.mjs status
`BT`

### Track merging (adaptive audio + video)
Adaptive streaming delivers video and audio as separate representations.
Downloading only the video produces a silent file, so downloadx fetches **both**
tracks and muxes them with ffmpeg (stream copy, no re-encode). If ffmpeg is not
available the two track files are kept and the task says so rather than
pretending the merge happened. Set `ffmpegPath` in settings to point at a
specific binary; otherwise PATH is searched.

Both DASH (`AdaptationSet` per track) and HLS (`EXT-X-MEDIA` audio
renditions) are handled.

### Capture proxy (the kernel-driver alternative)

IDM uses a WHQL-signed WFP kernel driver to see traffic from applications that
have no browser extension. downloadx reaches the same goal in user mode: point
a client (or the system proxy setting) at the local capture proxy and it
reports every response that looks like a download.

`BT`bash
downloadx proxy start              # tunnel mode (default): no trust changes
downloadx proxy start mitm         # decrypt HTTPS; needs the CA below
downloadx proxy list               # what has been seen
downloadx proxy ca create          # mint a local CA certificate
`BT`

| Mode | Sees | Requires |
|---|---|---|
| `tunnel` | destinations and plain HTTP bodies | nothing |
| `mitm` | decrypted HTTPS | importing the generated CA into the trust store |

The classification is deliberately conservative — a false positive interrupts
browsing, a false negative only misses a convenience — and each capture carries
a confidence level. `autoQueue` can queue high-confidence captures automatically.

**Why not a driver?** A WFP driver needs an EV certificate and Microsoft WHQL
attestation to load on 64-bit Windows. The comparable open-source projects (XDM,
AB Download Manager, Motrix) all use a browser extension plus a loopback
connection instead; none ships a driver.

### Media sniffer and site grabber
`sniff` reads a page (without executing its script) and lists stream
candidates with variant counts, durations and live/encrypted flags. `grab`
collects every downloadable resource a page references — attributes and inline
script both — and queues them.

### Web GUI
Task list with live progress over server-sent events, add-by-URL bar,
per-task pause/resume/delete, a **Discover** panel (find streams on a page and
queue them, or list every resource a page links to), settings editor with
ffmpeg/clipboard status, schedule editor and a log view. Loopback-only and
token-protected.

### HTTP API

Every `/api/...` route (SSE included) requires the per-start token from
`runtime.json`, via the `x-downloadx-token` header or `?token=`. Two
behaviour notes API clients must know about:

**Duplicate adds answer 409, not a second task.** `POST /api/tasks` refuses a
URL that already has a *live* task — `queued`, `connecting`, `downloading` or
`paused` — with `409 {"error":"task already in queue","existingTaskId":"..."}`.
`error` and `complete` do not count: re-adding a failed or finished URL is
legitimate and still creates a new task.

**Ask before adding (extension/clipboard sources).** With `askBeforeAdd` on
(the default), an add marked as coming from the browser extension
(`queueId:"extension"`) or the clipboard watcher does not enter the queue. It
waits in a pending list until approved, rejected or timed out:

```
GET  /api/pending                     list waiting adds
POST /api/pending/:id/approve         queue it; body may override dir/filename/category
POST /api/pending/:id/reject          forget it, nothing is queued
```

Each held add is announced on the SSE stream as a `pending_added` event (and
resolved as `pending_resolved`), so the GUI can pop its confirmation dialog.
After `askBeforeAddTimeoutMs` (default 5 minutes) an unattended entry is
queued to the default directory **on purpose**: better to download something
the user did not confirm than to silently drop a link they actually acted on.
Manual adds (CLI, GUI, plain API calls) are never held.

---

## Architecture

`BT`
bin/downloadx.mjs        entry point
src/cli.mjs              command line, progress rendering
src/daemon.mjs           process that owns the queue, API and scheduler
src/api.mjs              HTTP API + SSE + static GUI host
src/queue.mjs            task state machine, concurrency, persistence
src/task.mjs             task model and transitions
src/downloader.mjs       strategy selection and orchestration
src/engine.mjs           concurrent segmented HTTP engine
src/net.mjs              HTTP(S) transport, redirects, proxy, TLS fallback
src/probe.mjs            capability probe and resume validation
src/plan.mjs             segment planning
src/store.mjs            crash-safe per-segment state
src/ftp.mjs              FTP control and data channels
src/hls.mjs / src/dash.mjs   playlist and manifest parsing
src/mp4.mjs              fragmented-MP4 box muxer (no ffmpeg needed)
src/merge.mjs            track merging (native first, ffmpeg fallback)
src/paths.mjs / util.mjs state and config locations, shared helpers
src/grabber.mjs          site resource collection
src/sniffer.mjs          media stream discovery
src/scheduler.mjs        timed queue actions
src/config.mjs           settings with validation
src/categories.mjs       type classification and naming
src/rules.mjs            per-host rules and exceptions
src/clipboard.mjs        clipboard URL watcher
src/gate.mjs             adaptive concurrency gate
src/health.mjs           worker stall / slow-connection monitor
src/proxy.mjs            local capture proxy (tunnel + MITM)
src/ca.mjs               certificate authority for HTTPS inspection
src/logger.mjs           rotating log
gui/index.html           web GUI (self-contained)
extension/               MV3 extension + native messaging host
test/                    self-test suite and controlled origin server
`BT`

State lives in `%APPDATA%\downloadx` (override with `DOWNLOADX_HOME`):
`config.json`, `queue.json`, `schedules.json`, `tasks/`,
`logs/`, `runtime.json`.

---

## Testing

`BT`bash
node test/run.mjs      # or: node bin/downloadx.mjs test
`BT`

88 checks run against a **controlled local origin** — no public network needed.
The suite covers planning, classification, rules, config, scheduling, the engine
(including resume, stale-data discard, downgrade, flaky sockets and short
bodies), rate limiting, HLS/DASH parsing, FTP framing, the queue state machine,
every API route, the browser host protocol, and the CLI parser.

Four real bugs were found and fixed by these tests; each has a regression test:

| Bug | Symptom | Fix |
|---|---|---|
| Non-atomic segment claim | 543 MB file downloaded as 3.25 GB (progress 612%) | claim with `Array#shift` |
| Greeting read as the first FTP reply | `USER` returned `220` | wait for the banner before sending |
| Glob `*` excluded dots | `*.example.com` missed `a.example.com` | rewrite the matcher |
| `0 || default` in config | `maxConcurrentDownloads: 0` became 3 | explicit clamping |

The first one is the instructive one: the file was **correct** (identical bytes
at identical offsets are idempotent), so only a bandwidth assertion caught it.

---

## Measured results

Against the 543.3 MB Ghidra 12.1.4 release archive:

`BT`
done: 543.3 MB in 00:39 (14.1 MB/s)
sha256: ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db
retries: 0
`BT`

That digest matches the same file downloaded by other means, and the archive
opens with all 6,695 entries intact.

---

---

## Test status

| Command | Result |
|---|---|
| `node test/run.mjs` | 166 passed, 0 failed (~72 s) |
| `node test/acceptance.mjs` | 9 scenarios, 0 failed (~45 s) |
| `node test/acceptance-real.mjs` | live checks; SKIP when unreachable |

All three must stay green. The first two run offline against deterministic
fixtures; the third is opt-in and reaches public endpoints.

---
## Acceptance suite

The unit suite checks units; the acceptance suite drives **complete downloads**
over real TCP against an origin that misbehaves on purpose, then verifies the
result byte-for-byte (SHA-256, plus a cross-check against a single-stream fetch).

```
node test/acceptance.mjs            # nine scenarios, ~44s
node test/acceptance.mjs --list     # list them
node test/acceptance.mjs --only large-file --verbose
```

Scenarios: large file, range multipart, no-range downgrade, redirect chain,
custom headers, interrupt/resume, rate limiting, error retry, SHA-256 verify.
All are configured in `test/acceptance.config.json` and use deterministic local
payloads — no external network is involved.

Results are written to `test/acceptance-runs/<timestamp>/` as `result.json` and
`RESULT.md`, with stable `latest.json` / `latest.md` pointers.

See [验收流程说明.md](验收流程说明.md) for the full description and the list of
risks that remain uncovered.

### Real-network acceptance (opt-in)

The local suite above never touches the internet. A separate entry point
exercises live endpoints; it records **SKIP** when a host is unreachable and
never reports a skip as a pass.

```
node test/acceptance-real.mjs                    # all live checks
node test/acceptance-real.mjs --list
node test/acceptance-real.mjs --only https-range --verbose
node test/acceptance-real.mjs --proxy http://127.0.0.1:7897
```

A local HTTP proxy is often required; pass `--proxy` or set
`DOWNLOADX_ACCEPT_PROXY`. Results land in `test/acceptance-runs-real/`.

Nine scenarios:

| Scenario | What it checks |
|---|---|
| `https-range` | Ranged HTTPS download, exact byte count |
| `hls-live` | Real HLS playlist assembles to playable media (ffprobe) |
| `dash-live` | Real DASH manifest merges video + audio tracks (ffprobe) |
| `tls-expired-rejected` | An expired certificate is refused by default |
| `tls-insecure-allowed` | `--insecure` explicitly permits the same transfer |
| `headers-vary` | Volatile response headers do not affect the result |
| `interrupt-real` | A dropped connection is never reported as success |
| `redirect-live` | A live redirect chain resolves to content |
| `non2xx-live` | A live 404 fails and leaves no file |

`interrupt-real` uses a server the script owns, because a public host cannot be
made to drop a connection on demand. Its record is marked `controlled: true`
and is not public-network evidence.

Media scenarios allow 360 s; the per-scenario timeout is recorded in the result
and a timeout is reported as an explicit `FAIL` with `timedOut: true`.

### `get` and media URLs

`get` routes by resource type. `--kind hls` and `--kind dash` force the media
path, and without `--kind` the URL is inspected so `.m3u8` / `.mpd` are
detected automatically. Media downloads go through the same code as the
daemon (`src/downloader.mjs`), so the output is the assembled media, not the
playlist text. Each fragment is retried on transient failure.

### Responses without Content-Length

A chunked response has no declared size, so it cannot be split into byte
ranges. Instead of failing, `get` streams it in one pass to a temporary file
and renames on success. Progress shows bytes received and states that the
total is unknown — no percentage or ETA is invented. Such a transfer is not
resumable, and a cancelled one leaves no file at all.
---

## Documents

| File | Contents |
|---|---|
| `情况说明.md` | **Handover brief** — current state, key decisions, risks, suggested next steps. Start here if you are picking this up. |
| `IDM对照.md` | Feature-by-feature comparison with Internet Download Manager |
| `替代品调研.md` | Survey of eight open-source download managers |
| `借鉴笔记.md` | Four designs borrowed from Surge, with source references |
| `真实验收记录.md` | **Real-network run record** — commands, per-scenario results, evidence |
| `验收流程说明.md` | **Acceptance suite** — scenarios, results, defects it caught, uncovered risks |
| `验收报告.md` | The defects found and how each was fixed |
| `Windows安装与首次使用.md` | **Install, first download, runtime layout, diagnosis, upgrade, uninstall** |
| `浏览器扩展冒烟记录.md` | **Extension smoke record** — install steps, fixed defects, what still needs a browser |
| `GUI冒烟记录.md` | **GUI smoke record** — real-browser evidence for the six required lifecycle steps |
| `大文件恢复验收说明.md` | **Large-file and recovery suite** — scenarios, metrics, defects found |

---

## Notes

A download manager is a neutral tool. Use it for content you are entitled to
obtain, and respect the terms of service and `robots.txt` of the sites you
touch. It does not bypass paywalls, DRM or access controls.

MIT licensed.
