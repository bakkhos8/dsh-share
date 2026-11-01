# DSH Share

<img src="apps/DSHShare/Resources/AppIcon.png" alt="DSH Share icon" width="96" />

DSH Share is a macOS sharing tool that sends files, images, text and links from other apps on the **same Mac** to the **DeepSeek Harness desktop app** through the system Share menu. Shares appear as attachments in the **current thread’s input area**. Review them and send manually when ready.

English | [简体中文](README.zh-CN.md)

## Features

- **Finder:** select one or more regular files, then choose **Share → DeepSeek Harness**.
- **WeChat for Mac:** use **Other apps → Choose an app on this computer → DeepSeek Harness** when the content offers that option.
- Files, images, plain text and URLs exposed through a compatible macOS Share menu are accepted. Each share is limited to **128 files and 256 MiB in total**; folders are not supported.
- If DeepSeek Harness is not running, DSH Share attempts to open it. If opening fails, an error is reported to the user. Shared content remains queued locally until the app and plugin start.
- After confirmed forwarding, DSH Share immediately removes its local copies and forwarding records.

DSH Share provides a Universal 2 DMG containing Apple Silicon and Intel binaries. Its setup assistant connects to Harness desktop automatically. Installation and everyday use require neither Python nor a standalone Node.js runtime. Source installation is also available; see [compatibility](docs/validation.md) for supported environments and verification limits.

## Before installing

You need:

- macOS **13 or newer**. Testing so far used an **Apple Silicon Mac running macOS 27.0.1**; Intel Macs and other OS versions are not yet verified.
- A working DeepSeek Harness desktop installation. The plugin interfaces were tested with **0.2.1-rc.5**.
- DMG installation needs no development tools. Source installation requires Xcode or Apple's Command Line Tools; the build defaults to your Mac's architecture and local ad-hoc signing.

The inbox lock, cleanup command and plugin profile installer use a native executable bundled inside **DSHShare.app**. Installation and everyday use do not require Python or a separately installed Node.js runtime. The compiler is needed for source installation; the installed app uses macOS-provided runtime libraries.

Both the macOS share target and the DeepSeek Harness plugin must be installed.

### System permissions

Only two system settings need your action, and neither is a privacy permission prompt:

1. The first launch of the unnotarized DMG build may be blocked; choose **Open Anyway** for it under **System Settings → Privacy & Security**. This happens once.
2. Enable **DeepSeek Harness** under **System Settings → General → Login Items & Extensions → Sharing** (the setup assistant also checks this and tells you what to click).

**Never requested:** Full Disk Access, Files & Folders (Desktop/Documents/Downloads), Accessibility, Screen Recording, Automation, Notifications, Camera or Microphone. The extension only reads the items the source app hands to the system Share menu; it does not scan your disk. Its inbox lives under the app's own `~/Library/Application Support/DSHShare/`, which is not a protected folder.

The extension is sandboxed and declares three entitlements at signing time — granted at install, no dialog: `app-sandbox`, `files.user-selected.read-only`, and a `home-relative-path.read-write` exception scoped to `/Library/Application Support/DSHShare/` (the inbox). The host app and its bundled native helper are not sandboxed, run as the current user, use no privileged helper and need no `sudo` or admin password. Installing into `~/Applications` needs no admin rights; installing into `/Applications` only prompts for a password when your account cannot write there.

## Install

### Install from a DMG

1. Install and open **DeepSeek Harness** once. Configure its model and agent, confirm a session works, then **Command-Q** to quit it completely.
2. Open the DMG, drag **DSHShare.app** into **Applications**, then eject the disk image.
3. Open **DSHShare** from Applications. The app is not notarized. If macOS blocks it, attempt to open it once, then choose **Open Anyway** for this app in **System Settings → Privacy & Security**.
4. Follow the Chinese-language assistant: **Prepare → Install → Enable sharing → Test a share**. It selects Harness desktop automatically. The sharing step checks the running receiver and system Share entry, and offers actions only for unmet checks. It rechecks when you return from settings; no profile selection or Terminal commands are needed.
5. On the final page, click **显示测试文件** (Show test file). In Finder, right-click the selected file and choose **Share → DeepSeek Harness**. First select a thread in Harness, then check that the test file appears in its input area without starting a reply. Close the assistant when finished.

You can also copy the app to your own `~/Applications` folder. A fixed local location keeps the share extension and helper available after ejecting the image. The disk image includes [installation and usage instructions in Chinese](docs/installation.zh-CN.txt). You can close the assistant after setup; it does not need to stay open for everyday sharing.

### From source

Download and unpack this repository. Open Terminal in the extracted project directory and run:

```bash
./scripts/build-app.sh --install
./scripts/install-plugin.sh
```

The first command installs **DSHShare.app** into `~/Applications` and registers the Share menu entry. The second installs the receiving plugin into the **desktop** profile. Existing native app installations are backed up under the project's ignored `backups/` directory.

Then:

1. Open DeepSeek Harness and check that **dsh-share** is enabled in its plugin list. Restart DeepSeek Harness if the plugin has not appeared.
2. In **System Settings → General → Login Items & Extensions → Sharing**, enable **DeepSeek Harness** if needed.
3. Completely quit and reopen source apps that were already running, especially **WeChat**. Use **Command-Q**; closing a window is not sufficient.

For a different existing DeepSeek Harness profile, replace only the second command with:

```bash
DSH_PROFILE_DIR="$HOME/.dsh/profiles/your-profile" ./scripts/install-plugin.sh
```

Enable this plugin in only one running profile for the shared inbox. An exclusive system lock blocks additional consumers. If another profile owns it, disable that profile's plugin, then reload the intended receiver. Completely quit all running receivers before installing or updating.

## Use it

### From Finder

1. Select your files and open the **Share** menu.
2. Click the **DeepSeek Harness icon**.
3. The files appear as attachments in the current Harness thread’s input area. Text and links become a `分享内容.txt` attachment.
4. Add your instructions, then click **Send** when ready. Sharing alone does not start the agent.

Select the receiving thread before sharing. Existing draft text and attachments are preserved. If no thread is open, select one to receive the pending share. A transfer already in progress stays bound to its original thread; return to that thread to finish it.

### From WeChat

Open the content's sharing options and choose **Other apps → Choose an app on this computer → DeepSeek Harness**. Available options depend on the content WeChat exposes to macOS; private formats such as mini-program cards or entire chat histories are not guaranteed.

**After installing or updating the extension, restart WeChat before trying again if it shows an old icon or forwarding does nothing.**

### If DeepSeek Harness does not open

If the app cannot be opened, an error is reported. Open DeepSeek Harness manually and confirm that **dsh-share** is enabled. The saved share remains in the local inbox until it can be handled. Select a thread with an input area. Avoid repeatedly sharing the same item while checking a pending delivery, as each new share adds another attachment.

## Privacy and local data

Sharing puts attachments in the current Harness draft. The agent starts only after you send the draft. Model access, network transmission and tool permissions follow **your DeepSeek Harness configuration**; only share content you intend that agent to process.

The native extension hands content over through a local directory and does not need model API keys. This project adds no independent telemetry or analytics service.

| Location | Purpose |
| --- | --- |
| `/Applications/DSHShare.app` or `~/Applications/DSHShare.app` | Share menu target and setup assistant |
| `~/Library/Application Support/DSHShare/plugin/dsh-share` | Plugin files installed by the default installer |
| `~/Library/Application Support/DSHShare/inbox` | Pending local copies of shares |
| `inbox/failed/` | Failed packages and their error details |

DSH Share does not keep a session history or an archive of completed shares. Once the Harness input area owns the attachments and confirms receipt, DSH Share immediately deletes the inbox copy, delivery state and temporary completion receipt. The session and attachments received by DeepSeek Harness are the forwarding result and are managed by Harness itself.

Interrupted cleanup resumes automatically when the receiver runs again. Confirmed completion records left by earlier versions are also removed, without an age limit. Failed packages remain available for diagnosis; do not publish inbox contents or logs containing shared data.

**Pending, unconfirmed and failed content never expires automatically.** Files are transferred through a bounded local stream into Harness-owned browser attachments. Text and links are attached as a UTF-8 text file. Draft attachments follow Harness’s own lifecycle; closing or reloading Harness may discard an unsent draft. DeepSeek Harness may impose additional attachment limits.

## Common problems

| Problem | What to do |
| --- | --- |
| Clicking DSHShare opens no window | Quit any running DSHShare in Activity Monitor, then open the current copy from Applications. Keep one installed copy and eject the installation disk image; an older copy still running can receive the open request. |
| Missing menu entry or old icon | Enable the extension in System Settings, then completely quit and reopen the source app. For WeChat, use Command-Q. |
| Nothing arrives in DeepSeek Harness | Open DeepSeek Harness, enable **dsh-share**, and restart it after installing or updating the plugin. Check the intended profile. |
| A directory or a large file fails | Share at most 128 regular files and 256 MiB in total. Failed content is retained. |
| Very long inline text fails | Save it as a file and share the file. Inline text and manifest metadata together are limited to 1 MiB. |
| The plugin reports that the inbox is in use | Disable the other receiver, then reload the intended plugin. Do not remove `.consumer.lock`; the system releases ownership when its holder exits. |
| The plugin cannot start its native helper | Update the native app with `./scripts/build-app.sh --install`, then install the plugin and restart DSH. Update the native app and receiving plugin together. |
| A WeChat item cannot be forwarded | Retry after fully restarting WeChat. If its private card format is not exposed as text, a URL or a file, share the underlying link or saved file instead. |
| Installation or system security checks fail | See [signing and installation diagnostics](docs/signing.md). Signing checks and a visible menu entry alone do not prove a working share. |

Additional boundaries are listed in [known issues](KNOWN-ISSUES.md). Other source apps, including Safari, Preview and Mail, still need their own compatibility checks.

## Update

For a DMG update, completely quit DeepSeek Harness and DSHShare, replace DSHShare.app in Applications, then open it and run setup again. For source updates, run both installation commands from the new source version. Reopen Harness and previously running source apps afterwards. Update the native app and receiving plugin together; the installer preserves a private backup before changing existing configuration.

## Uninstall

1. Save your work and **Command-Q** to quit DeepSeek Harness completely.
2. Open the installed **DSHShare** from Applications and click **卸载** (Uninstall) immediately to the left of **开始安装** (Start installation). The same flow is also available from **DSH Share → 卸载 DSH Share…** in the macOS menu bar.
3. Review the removal summary, then confirm **卸载并移到废纸篓** (Uninstall and move to Trash). Close the window when complete, then restart source apps such as WeChat to refresh cached Share menus.

Uninstall removes the system share entry and receiver from connected Harness configurations, then moves the app to Trash. Source directories and other plugins are preserved.

Standard profiles and custom profiles recorded by the installer are discovered automatically. See [known issues](KNOWN-ISSUES.md#uninstall--卸载) for manually installed, unrecorded configurations.

Source installations can also open the same confirmation flow with:

```bash
./scripts/build-app.sh --uninstall
```

To pause receiving without uninstalling, disable **dsh-share** in Harness.

## License

Source code and documentation are available under [MIT](LICENSE). The avatar icon is **not included in that MIT grant**; see the [asset notice](apps/DSHShare/Resources/README.md) before reusing it.

DSH Share is an independently maintained integration and is not an official DeepSeek Harness distribution.
