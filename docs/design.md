# Architecture and protocol

## Product behavior

DSH Share adds **DeepSeek Harness** to the macOS Share menu. A share appends attachments to the **current thread’s input area**, preserving existing text and attachments. Text and links become a UTF-8 `分享内容.txt` attachment. The user reviews the draft and sends it manually.

The receiver never creates a session, navigates to another thread, submits a prompt or starts an agent. Without an open composer, shares wait. A target is pinned before asynchronous file transfer; switching threads cannot redirect a share. Returning to the original thread resumes it.

## Components

- `apps/DSHShare/Extension`: sandboxed native AppKit Share Extension, embedded in the signed `DSHShare.app` and registered through LaunchServices/PlugInKit.
- `apps/DSHShare/App`: native four-step setup assistant and uninstaller.
- `apps/DSHShare/Helper`: bundled Swift helper for locking, profile configuration, installation, uninstall and safe completion cleanup. No interpreter or runtime compiler.
- `plugins/dsh-macos-share/index.js`: Host plugin inside Harness’s embedded Node process; validates queued packages and serves authenticated local transfer routes.
- `plugins/dsh-macos-share/client.js`: browser plugin bound to Harness’s current composer; registers browser files as draft attachments and confirms receipt.

Harness’s official app bundle is not modified. A Harness plugin cannot itself register a native macOS Share Extension.

## Data flow

```text
macOS Share Extension
  → collect all NSItemProvider results within their callbacks
  → copy original files into a request-specific scratch directory
  → copy into inbox/.tmp-<uuid>/
  → write manifest.json last, then atomically rename the package to <uuid>/
  → open dsh://open to bring Harness forward and await the launch callback
  → on failure, try the registered/conventional app path and await its result
  → completeRequest on confirmed launch; cancelRequest with an error if launch fails

Host plugin
  → acquire exclusive native inbox lock
  → scan on startup and every second
  → validate metadata, filenames, regular files, count and total size
  → queue packages by shareId; do not contact an agent

Client composer overlay
  → require a mounted composer whose sessionId is the selected thread
  → poll pending; prepare {shareId, sessionId} to pin its target
  → receive stable requestId and ordered file descriptors
  → stream each file through the local route into a browser File
  → recheck the same binding and editable input state
  → conversation.createDrafts(sessionId, files)
  → inputActions.addAttachments(ids)
  → verify every id in the input snapshot
  → ACK {shareId, sessionId, requestId}

Host ACK cleanup
  → write temporary .receipts/<shareId>.json
  → remove payload bytes first, .delivery.json last
  → remove empty package and completion marker immediately
```

`dsh://open` only brings the Harness window forward in the examined desktop build. It does not create or select a session. If activation fails, the extension tries the registered application and conventional system/user Applications locations. It completes the request only after a successful launch callback. If launch fails, it returns a localized error explaining that the share remains queued and can be received after opening Harness manually.

## Inbox directory and sandbox

The shared directory is `~/Library/Application Support/DSHShare/inbox`. The extension resolves the account home with `getpwuid_r`, avoiding its sandbox home, and uses a home-relative read/write entitlement for this location. It has no network entitlement and does not discover a Harness port or token.

A directory survives Harness being closed and decouples the two independently signed products. A new App Group would not automatically authorize Harness to read another application’s protected group container. The extension’s own sandbox container is also unsuitable for independent consumers. The ordinary Application Support handoff avoids depending on that cross-application container access.

Original user files are **copied**, never moved. Provider callback URLs are copied before the callback returns. All providers must finish before publishing or completing the request; the 15-second deadline cancels the entire share instead of publishing partial success.

## Manifest and limits

```json
{
  "version": 1,
  "createdAt": 1761792000,
  "text": "selected text",
  "urls": ["https://example.com/a"],
  "items": [
    {"kind": "file", "name": "report.pdf", "file": "0.bin"},
    {"kind": "image", "name": "shot.png", "file": "1.bin"}
  ]
}
```

Only complete, non-dot directories are candidates; `failed/` and staging directories are excluded. Metadata is bounded at 1 MiB. A share permits at most 128 source files and 256 MiB of attachment bytes in total, including the optional generated text attachment. A manifest must contain at least one nonempty text, URL or attachment.

Stored attachment paths must be leaf names, with no traversal or backslash separators. Original display names are reduced to a safe basename. Regular files are opened with `O_NOFOLLOW` and nonblocking flags; symlinks and non-regular files are refused. Transfers pull bounded chunks with backpressure and detect size changes. A failed or incomplete transfer cannot authorize cleanup.

Client memory holds browser attachment objects, as when a user manually chooses a file. There is no Base64 fallback. Harness owns image handling, background uploads, upload errors and its own attachment limits after draft admission.

## Wire protocol: version 2

Routes use Harness’s `connection.fetch.register` and same-origin `/api/...` transport, including its existing authentication and peer checks. Request bodies are bounded JSON, not filesystem paths.

| Route | Request / result |
| --- | --- |
| `GET /api/dsh-share.draft.pending` | `{protocol:2, shareId, targetSessionId?}` or 204. The `x-dsh-share-session` header selects unclaimed shares or shares pinned to that thread. |
| `POST /api/dsh-share.draft.prepare` | `{protocol:2, shareId, sessionId}` → stable identity plus ordered `files:[{index,name,type,size}]`. A different target cannot reclaim a pinned share. |
| `POST /api/dsh-share.draft.file` | `{protocol:2, shareId, sessionId, requestId, index}` → bounded raw-byte stream. |
| `POST /api/dsh-share.draft.ack` | Exact protocol/share/thread/request identity → cleanup after client-side draft admission. Repeated completed ACKs are harmless. |

The Host injects only `connection`. It has no prompt, session-creation or agent dependency. The client injects `sessions`, `uiSession`, `conversation` and `slots`, and registers a null-rendering receiver in `conversation.input.overlay`. It reads the main binding from `uiSession.adapter.current.value.key`, observes catalog updates, and uses session-scoped input actions and the actual input snapshot. The session catalog itself is not treated as the selected view.

The adapter uses `conversation.createDrafts`, `conversation.input.for`, `inputActions.addAttachments` and the resulting `attachmentIds` published by the Harness 0.2.1-rc.5 client. These were checked against the installed package. An incompatible interface fails closed with source bytes retained. There is no fallback to automatic submission or DOM manipulation.

The new route namespace and explicit protocol prevent cached old clients from interpreting an offer as an instruction to open a newly created session. Upload completion alone is not confirmation; only full composer ownership permits ACK.

## Identity, restart and deduplication

Pending entries are keyed by **shareId**, so several shares to the same thread do not overwrite one another. Preparation persists:

```json
{
  "version": 1,
  "deliveryMode": "draft",
  "sessionId": "target-thread-id",
  "requestId": "stable-uuid",
  "accepted": true,
  "createdAt": 1761792000000
}
```

Here `accepted` means the Host has prepared a transfer, **not** that a message was submitted or that cleanup is authorized. A matching receipt containing `shareId` and a positive `acknowledgedAt` is also required for cleanup. The disk record keeps version 1 for native-helper compatibility; wire protocol and disk format are separate.

The browser stores only unacknowledged draft identities on the live conversation service. After adding attachments, ACK failures retry confirmation without downloading or appending again. This transient proof survives a plugin hot reload while that service remains alive; successful ACK removes it immediately. Host restarts retain the same pinned thread and request identity.

A full browser reload may discard Harness’s runtime attachment draft. Any still-unconfirmed package can be re-imported into the pinned thread. Once a share is confirmed and removed, DSH Share does not restore it after Harness discards an unsent draft. Received drafts follow Harness’s own lifecycle, including explicit user removal or sending.

Legacy `.delivery.json` files lacking `deliveryMode:"draft"` are ambiguous even when `accepted:false`: an old prompt may have been admitted immediately before a crash. Unless a valid completion receipt already proves delivery, those packages move to `failed/` for manual review. No existing Harness session is deleted or replayed automatically.

## Locking and cleanup recovery

The bundled helper holds a kernel `flock` on `.consumer.lock` until its stdin closes. The recorded helper path in `.installation.json` supports `/Applications` and `~/Applications`; explicit `DSH_SHARE_HELPER` is available for isolated verification. Invalid metadata fails closed. No PID timeout steals ownership and the lock file must not be unlinked while a consumer runs.

A second receiver cannot scan, prepare or ACK without ownership. Unexpected helper loss aborts consumption and makes routes unavailable. Disposal cancels work, waits for queued operations and releases ownership. Profiles are not merged.

ACK and sweeps share a serial queue. A valid temporary completion record permits interrupted deletion to resume. Payload removal precedes delivery-state removal, preserving the proof until all bytes are gone. An empty leftover directory is also recoverable. Malformed or mismatched receipts, symbolic links and ambiguous packages are preserved. Native manual cleanup uses descriptor-relative operations and the same lock.

**Pending, unconfirmed, failed, staging and ambiguous content has no automatic expiry.** Only proven completions are removed, with no age delay. The receiver retains no completed-transfer archive, history or normal success logs containing share/thread IDs. `scripts/cleanup-inbox.sh` previews proven leftovers; `--apply` explicitly repairs them while receivers are stopped.

## Setup, distribution and uninstall

The native AppKit assistant uses four steps: prepare, install, enable sharing and test. It selects Harness desktop automatically. Step 3 checks the live helper/Host relationship, selected profile, PlugInKit election/path and actual sharing service, with bounded queries. Ready items need no repeated action; unknown results allow a direct share test. Checks never consume inbox content. The final test expects an attachment in the selected thread’s input area, waiting for manual send.

The installer stages declared package files, preserves unrelated settings and private backups, writes configuration atomically and rolls back code/links on configuration failure. It does not delete inbox content. Source installation needs Xcode or Command Line Tools; the Universal 2 DMG and daily use need neither Python nor standalone Node.js. The DMG contains ad-hoc signed arm64/x86_64 app, extension and helper binaries and is not notarized.

The Uninstall button beside the install action and the app menu require Harness to be closed. The helper removes only this plugin’s profile references and module links under installation/inbox locks, cleans proven completion leftovers and retains unfinished shares and backups. The app unregisters its own extension and moves its own bundle to Trash. Errors report the remaining stage. Harness sessions, drafts and received attachments are not deleted.
