# AK Tracker — Alpha.Kore team board

A desktop app (Windows / macOS / Linux) that shows who is working on what **right now**, built for split shifts. It starts when you log in, runs the tracker on your own machine (`localhost`), and every copy talks to **one shared cloud database**, so all four of you see the same thing.

```
 Hitarth's laptop          Parth's laptop          Harsh's / Het's ...
 ┌──────────────┐          ┌──────────────┐
 │ AK Tracker   │          │ AK Tracker   │
 │ localhost UI │          │ localhost UI │
 └──────┬───────┘          └──────┬───────┘
        └──────────┬──────────────┘
          Supabase (shared Postgres in the cloud)
```

## What's in it

- **Home** (deliberately simple)
  - *What are you doing right now?* + task + **LIVE** button (Enter also goes live / saves)
  - **For you** — only heads-ups where someone tagged you ("don't touch / don't push"). **Got it** clears one. Hidden when empty.
  - **Team right now** — one row per person: LIVE/Off, what they're doing (or their last note), **Send heads-up**
  - **What's new** — what others did recently (added, started, stopped + note, finished, moved, posted). Each item stays until you click **Seen** (or *Mark all seen*). Seen is per person — it only clears your own Home.
- **Send heads-up** — presets ("Don't work on this — I'm changing it", "If you're on it, don't push yet", "Pull first — I just pushed") + optional detail → lands in their *For you* + a desktop notification
- **All tasks** — table with filters (project / owner / priority / status), sortable
- **History** — every change logged automatically with time, author, note, tags
- Priorities color-coded: Critical (red) · Medium (amber) · Low (green). Statuses: To do · In progress · Blocked · Done
- Desktop extras: starts at login, close = hides to tray (still notifies), tray menu → *Start when I log in* toggle, *Change database connection*, *Quit*

## Accounts

| User | Username | Password |
|---|---|---|
| Hitarth | `hitarth` | `Hitarth@AK26` |
| Parth | `parth` | `Parth@AK26` |
| Harsh | `harsh` | `Harsh@AK26` |
| Het | `het` | `Het@AK26` |

Created automatically the first time any copy connects to an empty database. **Change them on first login** (top-right → Change password). New people can register with the team code `alphakore` (set `REGISTER_CODE` to change).

## One-time setup (Hitarth, ~10 min)

### 1. Create the shared database (Supabase, free plan)
1. Create a project at [supabase.com](https://supabase.com) (pick any name/region, set a strong database password).
2. **Project Settings → Database → Connection string → URI** tab → copy the string. Use the **direct connection** (port `5432`), not the "Transaction pooler" — each laptop keeps one long-lived connection open, which is what the direct connection is for.
3. It looks like `postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres`.

Free plan: 500 MB database, more than enough for 4 people's tasks and history.

### 2. Build the installers (GitHub Actions — no Mac/Windows machine needed)
1. Push this folder to a GitHub repo (private is fine).
2. **Actions → Build desktop apps → Run workflow.** ~10 min.
3. Download from the run's *Artifacts*:
   - Windows: `AK Tracker Setup 1.1.0.exe`
   - macOS (Apple Silicon): `.dmg`
   - Linux: `.AppImage` or `.deb`

   Push a tag (`git tag v1.1.0 && git push --tags`) to get them on a GitHub Release page instead.

### 3. Each person installs and connects
Open the app → paste the **database connection string** once → *Connect*. Then log in.

The apps aren't code-signed, so the OS warns the first time:
- **Windows:** "Windows protected your PC" → *More info* → *Run anyway*
- **macOS:** right-click the app → *Open* → *Open* (or `xattr -cr "/Applications/AK Tracker.app"`)
- **Linux AppImage:** `chmod +x "AK Tracker-1.1.0.AppImage"` then run it

> Optional: put the connection string in `desktop/config.json` (`{"dbUrl":"postgresql://…"}`) before building and nobody has to paste anything. It's git-ignored — don't commit it.

## Good to know (honest trade-offs)

- **Live updates** — each app checks the shared DB every 3 s, so changes from teammates show within ~1–3 s.
- **Security** — the DB connection string (including its password) is stored on each laptop (`config.json` in the app's user-data folder). Anyone with that string can read/write the DB. If a laptop is lost: reset the database password in the Supabase dashboard (Project Settings → Database), which invalidates the old connection string, then re-enter the new one on the other laptops (tray → *Change database connection*).
- **Offline** — the app needs internet to reach the DB; without it you'll see an error until it reconnects.
- **Intel Macs** — the workflow builds Apple Silicon only. Intel: run `npm run dist:mac -- --x64` on an Intel Mac.
- **Updates** — no auto-update. Rebuild and reinstall; data is untouched (it lives in Supabase).

## Development

Node 20+. Needs a Postgres connection (Supabase, or any local Postgres for dev) — there's no local-file fallback.
```bash
npm install
DATABASE_URL=postgresql://… npm start   # web server only → http://localhost:3000
npm run desktop           # desktop app (uses DATABASE_URL / setup screen)
npm run dist:linux        # build installer for your own OS (dist:win / dist:mac)
```

| Env var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — (required) | Postgres connection string (Supabase direct connection) |
| `PORT` | `3000` (desktop: `47820`) | HTTP port |
| `REGISTER_CODE` | `alphakore` | Code to register new members |
| `POLL_MS` | `3000` | How often each app checks for teammates' changes |

## Files

- `server.js` — Express + Postgres (Supabase) API, sessions, heads-ups, live sync (SSE + polling the shared DB)
- `public/` — the UI (plain HTML/CSS/JS, no build step)
- `desktop/` — Electron: starts the server, window, tray, start-at-login, first-run setup
- `.github/workflows/build.yml` — builds Windows / macOS / Linux installers
