# Software Blocker

Software Blocker is a Windows desktop app that lets a user choose a set of apps, define one recurring daily time window, and automatically close those apps whenever they are launched during that window.

This project is intentionally designed as a **tamper-resistant productivity tool**, not as an anti-removal or anti-admin agent. It requires an admin PIN to change settings or quit from the app UI, but it does **not** attempt to make itself impossible to uninstall. Preventing an administrator from removing software crosses a line this project intentionally avoids.

## What it does

- Lets the user add apps either by browsing for `.exe` files or by selecting from currently running apps.
- Enforces one daily blocking window, including overnight windows like `22:00` to `06:00`.
- Runs in the system tray and can launch automatically at Windows sign-in.
- Requires an admin PIN to:
  - change the blocked app list
  - change the schedule
  - disarm blocking
  - quit the blocker from the dashboard
- Stores settings in the app's Electron `userData` folder.

## How blocking works

The app checks running Windows processes every few seconds. During the active schedule, it matches the selected executables against running processes and force-closes matches using `taskkill`.

This is effective for many personal productivity scenarios, but it has limits:

- A Windows administrator can still kill or uninstall the app.
- Some elevated or protected processes may resist termination.
- If the user renames or relocates apps, the blocked list may need to be updated.
- This project currently supports one shared daily schedule for all selected apps.

## Project structure

- `main.js`: Electron main process, tray app, config management, process enforcement
- `preload.js`: safe bridge between renderer and Electron APIs
- `index.html`: dashboard UI
- `renderer.js`: dashboard logic
- `styles.css`: visual styling

## Requirements

- Windows 10 or Windows 11
- Node.js 20+ recommended
- npm

## Install dependencies

```powershell
npm install
```

## Run in development

```powershell
npm start
```

On first launch:

1. Create the admin PIN.
2. Set the daily start and end time.
3. Optionally add one or more apps to block.
4. Keep `Launch automatically at Windows sign-in` enabled if you want it to re-arm after reboot.
5. Click `Save changes`.

## Finding Codex

If Codex is already open, the easiest path is:

1. Open Software Blocker.
2. Unlock the dashboard with your PIN.
3. Click `Add running apps`.
4. Select `Codex.exe`.
5. Click `Save changes`.

On this machine, I found Codex here:

- `C:\Program Files\WindowsApps\OpenAI.Codex_26.506.3741.0_x64__2p2nqsd0c76g0\app\Codex.exe`
- `C:\Users\Indrajeet\AppData\Local\OpenAI\Codex\bin\codex.exe`

Microsoft Store style installs can be hard to browse to manually, which is why the running-app picker is included.

## Build a Windows installer

```powershell
npm run dist
```

The packaged installer will be written to `dist/`.

## Configuration behavior

- The app starts minimized to the tray when launched with the `--hidden` flag.
- The tray icon stays alive even if the window is closed.
- Closing the window hides it instead of quitting.
- Quitting through the dashboard requires the admin PIN.

## Data storage

Electron stores app data under a path similar to:

```text
%APPDATA%\Software Blocker\
```

The main settings file is:

```text
config.json
```

That file includes:

- selected blocked apps
- daily schedule
- startup preference
- whether blocking is armed
- salted PIN hash

## Uninstall

This application is intentionally uninstallable by a Windows administrator.

Typical uninstall flow:

1. Open the app dashboard.
2. Enter the admin PIN.
3. Quit the blocker.
4. Uninstall it from Windows Settings or remove the packaged app normally.

If the app was only run from source and not installed:

1. Stop the process.
2. Delete the project folder.
3. Remove the startup registration if it remains.

## Safe product note

If you need something stronger for a legitimate household, school, or managed-device setup, the safer path is to pair an app like this with:

- a separate Windows administrator account controlled by someone else
- Microsoft Family Safety
- enterprise device management policies
- kiosk or assigned-access configurations

Those approaches provide accountable system-level control without trying to make software secretly or impossibly removable.
