# AK Tracker — Setup Guide

Follow this once to get the tracker running on your laptop. It takes about 2 minutes.

## 1. Download and install

Downloads: **https://github.com/HitarthTrivedi/ak-tracker/releases/tag/v1.1.0**

Pick the file matching your OS:

| OS | File |
|---|---|
| Windows | [`AK.Tracker.Setup.1.1.0.exe`](https://github.com/HitarthTrivedi/ak-tracker/releases/download/v1.1.0/AK.Tracker.Setup.1.1.0.exe) |
| macOS (Apple Silicon) | [`AK.Tracker-1.1.0-arm64.dmg`](https://github.com/HitarthTrivedi/ak-tracker/releases/download/v1.1.0/AK.Tracker-1.1.0-arm64.dmg) |
| Linux (AppImage) | [`AK.Tracker-1.1.0.AppImage`](https://github.com/HitarthTrivedi/ak-tracker/releases/download/v1.1.0/AK.Tracker-1.1.0.AppImage) |
| Linux (Debian/Ubuntu) | [`ak-tracker_1.1.0_amd64.deb`](https://github.com/HitarthTrivedi/ak-tracker/releases/download/v1.1.0/ak-tracker_1.1.0_amd64.deb) |

**Windows**
1. Double-click the `.exe`.
2. Windows will warn *"Windows protected your PC"* — click **More info → Run anyway**. (This just means the app isn't signed with a paid certificate; it's expected.)
3. It installs and opens itself.

**macOS**
1. Open the `.dmg`, drag **AK Tracker** into **Applications**, then eject the dmg.
2. Open **Applications**, **right-click AK Tracker → Open → Open** (first launch only — this bypasses Gatekeeper's "unidentified developer" block).
3. If it still refuses to open, open Terminal and run:
   ```bash
   xattr -cr "/Applications/AK Tracker.app"
   ```

**Linux (AppImage)**
```bash
chmod +x "AK Tracker-1.1.0.AppImage"
./AK\ Tracker-1.1.0.AppImage
```

**Linux (.deb — Debian/Ubuntu)**
```bash
sudo dpkg -i ak-tracker_1.1.0_amd64.deb
```

## 2. First launch — connect to the team database

On first open you'll see a **"Connect to your team"** screen asking for a **database connection string**. This is not public — ask Hitarth for it directly (chat/call), never post it anywhere public. Paste it in and click **Connect**. The app will relaunch straight into the login page; you only do this once.

## 3. Log in

Use your account:

| User | Username | Password |
|---|---|---|
| Hitarth | `hitarth` | `Hitarth@AK26` |
| Parth | `parth` | `Parth@AK26` |
| Harsh | `harsh` | `Harsh@AK26` |
| Het | `het` | `Het@AK26` |

**Change your password right after logging in** (top-right menu → *Change password*) — these defaults are shared, so don't leave yours as-is.

## 4. You're set

- The app starts automatically when you log into your laptop. Turn this off anytime: tray icon → **Start when I log in**.
- Closing the window doesn't quit the app — it just hides to the tray (so it can still notify you). To fully quit: tray icon → **Quit**.
- Everyone's app talks to the same shared database, so when a teammate updates something, you'll see it within ~1–3 seconds.
- No internet = no connection to the team database; you'll see an error until you're back online.

## Using it

- **Home** — say what you're doing right now, hit **LIVE** (or press Enter) so the team sees it.
- **For you** — heads-ups teammates sent you (e.g. "don't touch this file"). Click **Got it** to clear one.
- **Team right now** — who's live, what they're on, and a **Send heads-up** button to warn them about something.
- **All tasks** — the full task board, filterable by project/owner/priority/status.
- **History** — a log of every change, with who/when/what.

## If something breaks

- **"Could not connect to the team database"** — check your internet connection, then click **Retry** in the error dialog.
- **Forgot your password** — ask Hitarth to reset it for you (no self-service reset yet).
- **App won't open at all** — re-check the install step for your OS above (the unsigned-app warning is the most common snag).
