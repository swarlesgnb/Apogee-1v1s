# Apogee on Linux

Linux builds target x86-64. KovaaK's runs through Steam/Proton; Apogee runs natively.
Native Steam, Flatpak Steam and custom libraries listed in `libraryfolders.vdf` are
detected automatically. **Apogee > Choose stats folder** can select a game folder,
Steam library or the actual `FPSAimTrainer/stats` directory.
An absolute `APOGEE_STATS_DIR` environment variable can point to an alternate stats
folder for command-line launches and testing.

## Arch Linux

Use the native package when possible:

```sh
sudo pacman -U ./Apogee-0.4.8-linux-x64.pkg.tar.gz
apogee
```

Pacman installs the desktop launcher and runtime dependencies. A running keyring
(for example GNOME Keyring or KDE Wallet) lets Electron remember Steam sign-in securely.
Update this package with pacman; in-app updates are reserved for AppImage builds.

## Portable archive

The archive requires no FUSE. On Arch install the same runtime dependencies first:

```sh
sudo pacman -S --needed gtk3 nss alsa-lib libxss libxtst xdg-utils libxkbcommon mesa
tar -xzf Apogee-0.4.8-linux-x64.tar.gz
cd Apogee-0.4.8-linux-x64
./start-apogee.sh
```

## An AppImage does not open

Launch it from a terminal to see the actual error:

```sh
chmod +x Apogee-0.4.8-linux-x64.AppImage
./Apogee-0.4.8-linux-x64.AppImage
```

If an older build reports `libfuse.so.2`, Arch needs the `fuse2` package. New AppImage
builds pin electron-builder's static runtime (`toolsets.appimage: 1.0.3`) to remove
that shared-library requirement. The native package or
portable archive avoids this requirement. AppImage also supports extracting without
mounting it:

```sh
./Apogee-0.4.8-linux-x64.AppImage --appimage-extract
./squashfs-root/AppRun
```

If the error names Chromium's sandbox or user namespaces, use the native Arch package,
which installs the sandbox helper with its required root ownership and permissions.
Do not run Apogee as root. The native package and portable launcher do not add
`--no-sandbox`. electron-builder's AppImage launcher can add that flag when the
kernel does not offer unprivileged user namespaces; prefer the native package then.

For a Wayland-specific display error, try launching with `--ozone-platform=x11` when
XWayland is available. Include the terminal output and **Apogee > Copy diagnostics**
when reporting a problem. **Help > Open log** opens the application log after startup.

See the [AppImage FUSE guide](https://docs.appimage.org/user-guide/troubleshooting/fuse.html)
and [Electron sandbox guide](https://docs.appimage.org/user-guide/troubleshooting/electron-sandboxing.html)
for the runtime requirements.

## Building and verification

```sh
npm ci
npm run typecheck
npm run validate:desktop
npm run validate:backup
npm run dist:linux
node tools/validatePackage.mjs release --linux
npm run validate:linux-package
```

`npm run dist` also selects Linux packaging automatically when run on Linux; on
Windows it selects the Windows installer. `npm run dist:win` requests Windows explicitly.

Provide the three public client values in `.env` or the environment, as described in
`SETUP.md`. Never provide a service-role key to client packaging. AppImage creation
requires Linux. `npm run dist:linux:portable` can build the archive and native Arch
package on Windows as well; the archive writer sets Unix executable permissions.

Packaged editable reference data lives under the profile's `reference-data/<version>`
directory. The bundled data remains read-only; relaunching the same version preserves
local edits, while a new version receives its shipped season and keeps the prior copy.

The Linux packaging workflow builds all three formats, validates archive contents,
boots extracted packages under Xvfb, and installs the native package with pacman in
an Arch container. The Arch container disables Chromium's sandbox only for its smoke
test; it does not prove sandbox behavior on a real Arch desktop. AppImage extraction
tests do not exercise FUSE mounting, and headless smoke tests do not prove Wayland,
Steam authentication, or actual gameplay. CI builds use an offline test configuration
unless the repository's three public client variables are set; do not distribute those
offline test builds to players.
