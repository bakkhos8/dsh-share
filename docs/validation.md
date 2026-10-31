# Compatibility and verification / 兼容性与验证

DSH Share targets macOS on a single computer. This page distinguishes automated verification from live application compatibility.

## Compatibility

| Component | Requirement or examined environment |
| --- | --- |
| Native app and receiving plugin | 0.1.13 |
| macOS requirement | 13 or newer |
| DMG architectures | arm64 and x86_64 (Universal 2) |
| Local environment | Apple Silicon, macOS 27.0.1 |
| Harness draft interface | 0.2.1-rc.5 |
| Source applications exercised locally | Finder and WeChat 4.1.15 |
| Setup assistant language | Simplified Chinese |

Intel operation, other macOS versions, Safari, Preview, Mail and additional WeChat content types have not been fully verified. Source applications determine what data they expose to sharing. Future Harness API changes may require an adapter update.

The DMG is ad-hoc signed and not notarized. Signature validation does not establish Apple notarization or predict Gatekeeper behavior on another Mac.

## Installation and package verification

- Host app, Share Extension and native helper compile for arm64 and x86_64 and pass strict deep signature verification.
- The image contains the app, Applications shortcut and usage instructions. Only declared public plugin files are bundled; local configuration, installation metadata and private inboxes are excluded.
- The plugin declares and bundles the avatar icon within Harness’s icon size limit.
- Installation preserves unrelated settings, backs up code/configuration and rolls back code/links after profile-write failures. Repeated installation and directory aliases remain idempotent.
- A copied app resolves its bundled helper after the DMG is ejected.
- Uninstall removes only the receiver’s profile references and links, clears proven completed leftovers and preserves unfinished shares, unrelated settings and source directories. Active ownership blocks removal.
- The setup page checks the live helper/Host/profile relationship and system Share service. Ready items need no repeated setup; failed or unknown checks retain focused actions. Checks do not send or consume content.

## Live draft verification

In the local Harness 0.2.1-rc.5 UI, a harmless test file appeared under **待发送附件** in the previously selected thread. No new message or agent run started. The inbox package disappeared after receipt, and the test attachment was then removed to restore the input area. This check covers one local file; broader source-app compatibility remains bounded as described above.

## Automated receiving checks

The suite uses synthetic Harness services and isolated inboxes. It never calls a model or sends an actual prompt.

| Area | Covered behavior |
| --- | --- |
| App activation | The extension waits for the launch callback, falls back to opening the app if needed, and reports a localized failure while retaining queued content. |
| Current thread | Attachments land in the selected composer; existing text and attachments remain. Several shares can append to one thread. |
| Manual sending | Host tests reject session creation, agent resolution and prompt calls; client never navigates, replaces draft text or calls submit. |
| Missing/busy composer | Content waits without being acknowledged. |
| Target pinning | Changing threads during transfer cannot redirect the share. Return to the original thread to finish. |
| Ownership confirmation | Preparing or downloading bytes does not delete the source; ACK follows verified composer admission. Rejected admission releases only newly created draft objects. |
| ACK recovery | Failure and client plugin reload retry confirmation without duplicate attachments. Successful ACK immediately deletes package/state/receipt. |
| Host restart | Stable share/thread/request identity survives restart. Same-thread shares have independent identities. |
| Legacy migration | Both accepted and unaccepted old delivery states are preserved for review; proven old completions can still be cleaned. |
| Streaming and input safety | Bounded reads, exact bytes, cancellation, size changes, source count/total limits, metadata limits, safe display names, symlinks and non-regular files. |
| Cleanup safety | Interrupted deletion preserves proof, never re-imports partial content and retries cleanup. Malformed, mismatched and symlinked records cannot delete pending data. |
| Locking | Independent processes cannot consume simultaneously; helper loss stops delivery and parent exit releases the kernel lock. |
| Dependencies | Installation, receiver and maintenance work with Python blocked and no standalone Node.js on PATH. |

These checks establish the plugin’s draft behavior with the observed SDK contract. They do not establish complete compatibility with every Harness build, source application, model provider or Mac. Received unsent attachment drafts follow Harness’s own lifecycle; closing or reloading Harness can discard them.

For usage see the [README](../README.md); for limits see [known issues](../KNOWN-ISSUES.md).
