# Notifications: hear about it when something needs you

Your agents keep working when the Tandemise window is hidden or closed to the
tray. When something new lands in your Inbox and you are not already looking at
it, Tandemise shows one native notification. Click it and the window opens on
the thing to decide.

![Settings → Notifications with quiet hours on](../../apps/desktop/screenshots/notifications-settings.png)

## What you get notified about

Only items that are in your Inbox, and only the ones that are for you. Each
kind has its own switch in **Settings → Notifications**:

| Switch | You hear about it when… | The notification says | Clicking opens |
|---|---|---|---|
| Decisions and approvals | a plan, a card or a step waits on your answer | "Decision needed" or "Your step is waiting" | the mission |
| Refinements | a draft has proposals or questions to decide before it can be planned | "Decide before planning" | the mission |
| Stalled missions | nothing moves a mission and nothing asks you about it | "Mission stalled" | Inbox, stalled only |
| Quiet agents | an agent has printed nothing for longer than it should | "Agent gone quiet" | the Inbox |
| Limits | a mission or the project stopped at a spend or time limit | "Limit reached" | the mission (or the Inbox) |

Check cards (a look at finished work that holds nothing up) never notify.

## Never a flood, never twice

- **Each Inbox item is announced once.** Tandemise remembers what it has told
  you, even across restarts. An item that leaves the Inbox and comes back is not
  announced again.
- **Several at once become one.** If three things arrive together you get one
  notification, "3 things need you", which opens the Inbox.
- **Nothing while you are looking.** If the window is in front and showing the
  Inbox, new items are simply there; you are not notified about them later
  either.
- **A switch that is off stays quiet about the past.** Turning a kind back on
  does not replay what arrived while it was off.

## Quiet hours

Turn on **Quiet hours** and set **From** and **To** (they can wrap midnight,
like 22:00 to 07:00), then **Save quiet hours**. While they are on, nothing is
shown; what arrives is held. When they end you get one notification, "After
quiet hours: N things need you", covering whatever is still waiting. Items you
dealt with in the meantime are left out. The section header reads **Quiet hours
now** while they are in force.

## Check that notifications reach you

The last row of **Settings → Notifications** says what your system does with
Tandemise's notifications, as far as the system tells:

| It says | Meaning |
|---|---|
| **Showing** | The system takes them and shows banners (GNOME and other Linux desktops say so). |
| **No banners** | The system takes them but shows no banner: GNOME's **Do Not Disturb** is on, or banners (or notifications) are off for Tandemise in GNOME Settings. They wait in the notification list; the row says which switch to turn. |
| **Not delivered** | The system takes none: no notification library (install `libnotify4`), no notification server on the session, or Windows refused the toast. Nothing is recorded as notified, so every item is announced once the system can show it. |
| **Not reported** | macOS and Windows do not tell apps whether their notifications are allowed. Send a test notification to find out. |

Click **Send a test notification**. Below the button it reports whether the
system **took** it (on Linux: the notification server answered with an id) and,
where the system says, whether it is **on screen** or went to the list without
a banner. If it was not delivered it says why. On macOS or Windows, if nothing
appears, allow notifications for Tandemise in System Settings → Notifications
(macOS) or Settings → System → Notifications (Windows).

### The Linux AppImage

The .deb installs a `tandemise.desktop` entry, which is how the desktop finds
Tandemise's name and icon. The AppImage installs nothing, so its notifications
arrive with the icon inside the notification and GNOME lists no Tandemise under
Settings → Notifications. Settings offers **Add to apps**: on your click it
writes a launcher for this AppImage to `~/.local/share/applications` and its
icon beside it; **Remove from apps** takes both away again. Tandemise never
writes there on its own.

![A notification's click opens the mission on its plan card](../../apps/desktop/screenshots/notifications-opened.png)

## How it works

The daemon compares the Inbox with the list of items it has already announced,
and records the answer in its `settings.json` before replying, so the decision
never depends on the window being open. The desktop app asks every few seconds
and shows what comes back. If the system refuses a notification, the app hands
its items back (`POST /v1/notifications/release`), so they are not counted as
announced, and waits a minute before asking again; when the system cannot show
notifications at all, the app does not ask. Everything here is read from the Inbox's own rows;
no model decides what to tell you.
