# Signing and installation diagnostics

The native share target is installed in its own `DSHShare.app`; the official DeepSeek Harness app bundle is not modified. A receiving DSH plugin is also required. Start with the [installation instructions](../README.md).

## DMG installation

The DMG contains a Universal 2 app, share extension, native helper and receiving plugin. Copy the app to `/Applications` or `~/Applications`, eject the disk image, then open the installed copy. The Chinese-language setup assistant detects the desktop configuration automatically, checks prerequisites, installs the receiver and guides sharing activation and a test using a bundled text file. The assistant connects to Harness desktop automatically. Source installation can target a custom configuration through DSH_PROFILE_DIR. It refuses installation from a mounted image or temporary location.

This build uses ad-hoc signatures and has no Apple notarization ticket. A downloaded copy can be blocked by Gatekeeper. After attempting to open it, use the per-app **Open Anyway** action in **System Settings → Privacy & Security** to open it. There is no need to disable global security checks. A locally copied image does not reproduce every Gatekeeper check applied to an Internet download.

Installation uses the bundled native helper directly. It copies only the package's declared files, records the installed helper path in a private `.installation.json`, links the selected Harness configuration and backs up existing code/configuration. The app and plugin should be updated together. No Python, compiler or standalone Node.js is needed by a DMG user. See [compatibility](validation.md) for verified environments and remaining limits.

## Local source installation

The installation script uses Swift from Xcode or Command Line Tools and defaults to explicit ad-hoc signing (`SIGN_ID=-`). It signs the containing app, extension and native `dsh-share-helper` consistently, installs to `~/Applications/DSHShare.app`, and enables the extension. The helper provides inbox locking, explicit completion-data cleanup and profile JSON updates without Python or a standalone Node.js runtime.

Local ad-hoc sharing has been verified in the environment listed in [validation](validation.md). This does not establish that every OS or security configuration will accept the same build.

An existing native installation is saved as a ZIP archive under the ignored `backups/` directory before replacement. An archive avoids registering an unpacked backup as another app with the same identifier.

## Check the installed target

These commands inspect the installed app and extension. Set `DSH_APP_PATH` to `$HOME/Applications/DSHShare.app` if you installed it for your user account:

```bash
DSH_APP_PATH="/Applications/DSHShare.app"
codesign --verify --deep --strict "$DSH_APP_PATH"
"$DSH_APP_PATH/Contents/MacOS/dsh-share-helper" --version
pluginkit -m -v -i com.movy.dshshare.host.share
```

A `+` registration and a valid signature are prerequisites, not end-to-end acceptance. Try a small ordinary file through the actual source application's Share menu and check the resulting DSH session.

If the source app was running during an update, completely quit and reopen it. This is particularly relevant to WeChat. If DSH does not receive the share, confirm that `dsh-macos-share` is enabled in the intended profile and restart DSH.

Update the native app and receiving plugin together. A custom app location can set `DSH_SHARE_HELPER` to that executable when starting DSH. The receiver does not run a compiler or fall back to an interpreter if the helper is missing.

The default inbox is `~/Library/Application Support/DSHShare/inbox`. Keep it private: failed and pending packages may contain the original shared content. Share only redacted diagnostics when reporting a problem.

Confirmed transfers are cleared immediately, including local payloads, delivery state and completion receipts. If cleanup is interrupted, the receiver retries it automatically. For an offline repair, stop all receivers, then run the bundled helper with `cleanup --inbox "/path/to/inbox"` to preview leftovers; add `--apply` to remove proven completions. The default has no age limit. Pending, unconfirmed, failed and ambiguous data are preserved.

## Uninstall

Open the installed DSHShare, click **卸载** beside the main install button (or choose **DSH Share → 卸载 DSH Share…** from the macOS menu bar), and confirm after quitting Harness. Proven completed-transfer leftovers are cleared and receiver configuration is removed first; the share extension is disabled/unregistered and the app moves to Trash. If macOS denies the final move, the assistant explains the partial result and offers to reveal the app for manual removal. Unfinished shares and configuration backups are retained. Restart source apps to refresh cached menus.

## Open-source distribution

Source code is distributed through GitHub; source installation builds and signs on each user's Mac. A precompiled, unnotarized DMG is also available for installation without development tools. Neither workflow uses a paid Apple Developer account, a Developer ID certificate or Apple's notarization service by default.

The supplied DMG is not notarized. The native script still accepts an explicitly selected `SIGN_ID` for users with an existing signing setup; credentials and signing material belong outside the public repository.
