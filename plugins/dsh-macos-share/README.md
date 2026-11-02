# dsh-macos-share

Receiving plugin for **DSH Share**, the macOS Share menu integration for DeepSeek Harness.

Select a thread in Harness, then share a file, image, text or link from another app on the same Mac. Files are appended to the **current thread’s input area** as attachments. Text and links become a `分享内容.txt` attachment. Existing draft text and attachments stay in place. Review the draft, add instructions and click **Send** yourself.

No session is created and no agent is started by sharing. If no composer is available, the share waits. A transfer binds to the selected thread before reading files; after switching threads, return to the original thread to finish it.

Use the native **DSHShare.app** setup assistant or the repository’s source installation scripts. This plugin alone cannot add a macOS Share menu entry. Enable **dsh-macos-share** in Harness and update both the native app and receiving plugin together. The draft adapter targets the interfaces shipped with Harness **0.2.1-rc.5**; an unavailable or busy composer retains the share instead of sending it.

The bundled native `dsh-share-helper` holds an exclusive OS inbox lock. There is no Python, interpreter or separately installed Node.js requirement. Stop other receivers before reloading the intended profile. Unexpected helper exit stops consumption safely.

The installer records the installed app’s helper path in a private `.installation.json`, supporting `/Applications` and `~/Applications`. Source installations without metadata try those conventional locations. Invalid metadata fails closed. Rerun setup after moving the app. `DSH_SHARE_HELPER` selects an executable explicitly for isolated verification.

Each share supports at most 128 ordinary files and 256 MiB in total, including the generated text attachment. Manifest metadata is limited to 1 MiB. File bytes stream through authenticated local routes to browser `File` objects; Harness’s conversation service owns their draft and background upload. Harness may impose further attachment limits.

The local inbox is `~/Library/Application Support/DSHShare/inbox`. Once the input area owns all attachments and confirms receipt, the receiver immediately removes the package, delivery state and temporary cleanup receipt. No completed-share or session history is retained. Harness manages the received draft and attachments. Closing or reloading Harness may discard an unsent draft, as with manually added attachments.

Pending, unconfirmed and failed content has no automatic expiry. Interrupted cleanup retries without delivering again. Legacy delivery states without draft mode are preserved in `failed/` for review to avoid replaying a possibly submitted share. Do not publish inbox data. `scripts/cleanup-inbox.sh` previews only proven completed leftovers; manual deletion requires `--apply` while receivers are stopped.

Uninstall using **卸载** beside the install button or **DSH Share → 卸载 DSH Share…** after quitting Harness. Unfinished shares, unrelated settings, backups and development source directories are preserved. Received Harness content is untouched.

Code and documentation: MIT. Avatar artwork: see [the asset notice](AvatarNotice.md).
