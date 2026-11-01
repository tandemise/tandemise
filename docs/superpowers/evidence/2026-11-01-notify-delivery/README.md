# Evidence: desktop notifications reach the person (GNOME 50.1, Wayland)

Headline: **32/32 real-app checks pass** (`scratch/notify-gnome-check.mjs`) against GNOME Shell 50.1's own notification server, and the offline `notify-delivery-check` passes 47/47.

## The report

On the Linux AppImage of v0.11.0 (GNOME 50.1, Wayland, libnotify4), no Tandemise notification was ever seen, yet `settings.json` listed 7 approvals, a stalled mission and a quiet run as notified.

## What was found on the owner's machine (read-only)

- `gsettings get org.gnome.desktop.notifications show-banners` → `false`: GNOME's **Do Not Disturb is on**. GNOME Shell 50.1 then takes every normal-urgency notification, answers `Notify` with an id, and files it in the notification list without a banner (`messageTray.js`: `if (!policy.showBanners && urgency !== CRITICAL) return;`). Tandemise could not tell and said nothing.
- `notify-send` from a plain shell behaves the same way (accepted, id returned, no banner), so this is the session, not Electron.
- The "other peer" GNOME forwards `Notify` to is normal: `org.freedesktop.Notifications` is owned by `gjs org.gnome.Shell.Notifications`, which proxies to the Shell.
- Electron 44 does send `desktop-entry: "tandemise"` (from package.json `desktopName`, which electron-builder's `syncDesktopName` keeps). The .deb installs `tandemise.desktop` with `StartupWMClass=tandemise`, so GNOME finds the app. The AppImage installs no entry, so GNOME cannot resolve the hint: the notification shows under a generic source with no icon (Electron sends an empty `app_icon`), Tandemise is missing from GNOME Settings → Notifications, and the portal logs `Could not register app ID: App info not found for 'tandemise'`.
- Notifications from an app with no entry and no hint are still shown (a generic source by pid and app name), not dropped.
- `Notifier.#show` recorded every notice before showing it and returned silently when `Notification.isSupported()` was false; the daemon also recorded at `take`, before the desktop showed anything.

## How it was run

Nothing on the owner's desktop was changed. The check runs in a private, headless GNOME Shell 50.1 (the same build), with its own session bus, GSettings in a keyfile and XDG dirs in a temp dir, so Do Not Disturb could be switched there:

```bash
npm run build
NOTIFY_NESTED_DIR=/tmp/tdm-gnome sh scratch/notify-gnome-nested.sh \
  node scratch/notify-gnome-check.mjs docs/superpowers/evidence/2026-11-01-notify-delivery
```

The app is this checkout under `electron-vite dev` (CDP 9851), a daemon on a fresh `TANDEMISE_HOME`, `APPIMAGE` pointing at a stand-in file so the app behaves as the AppImage does. `dbus-monitor --session` captures the traffic (read-only); screenshots come from `org.gnome.Shell.Screenshot` of the private Shell; the banner click is a real pointer click through Mutter's remote-desktop API.

## Scenarios

| # | What | Result | Files |
|---|---|---|---|
| 1 | Inbox card, AppImage with no entry | Banner "Decision needed / Allow a network call" with the icon carried as `image-data`; GNOME replied id 1; card recorded; clicking the banner → `ActionInvoked "default"` → window shown on `#/inbox` | `1-banner-appimage-no-entry.png`, `1-after-click-inbox.png` |
| 2 | Settings → Add to apps, then test | Offer shown, nothing written until the click; entry + icon written to `$XDG_DATA_HOME`; test reports "GNOME Shell 50.1 took it and shows it as a banner now"; banner now carries the Tandemise name and icon from the entry | `2-settings-offer-add-to-apps.png`, `2-banner-test-with-entry.png`, `tandemise.desktop` |
| 3 | Do Not Disturb on (private session) | Settings: "No banners — GNOME's Do Not Disturb is on …" with how to turn it off; test reports "took it but shows no banner"; GNOME still returned an id; no banner on screen | `3-settings-do-not-disturb.png`, `3-desktop-do-not-disturb-no-banner.png` |
| 4 | No notification server (app on a bus with none) | Electron `failed`; the card is released, **not** recorded as notified; Settings: "Not delivered — No notification server answers …", last refusal shown; test reports "Not delivered: …" | `4-settings-no-server.png` |
| 4b | Server back | The released card is announced and recorded; banner carries the app icon; "Remove from apps" deletes the entry Tandemise added | `4b-banner-after-server-back.png` |

`dbus-notify.txt` holds every `Notify` call Electron made with GNOME's reply (icon pixels elided), and the `ActionInvoked` / `NotificationClosed` signals. `summary.json` is the check's own record.

A screenshot of the owner's real desktop was not possible: the screenshot portal refuses non-interactive captures (response 2), and its banners are hidden by Do Not Disturb anyway.
