/**
 * The application menu.
 *
 * Electron's default menu is a generic File/Edit/View/Window/Help that says nothing
 * about this app: no way to rescan, no way to reach the stats folder, and no answer to
 * "which build am I running", which is the first question whenever something looks
 * wrong. This replaces it with the four things worth reaching by keyboard, and keeps
 * the standard View roles so reload, zoom and dev tools still behave as expected.
 *
 * Every item here duplicates something already reachable by clicking. That is the
 * point: the buttons stay the discoverable path, and the accelerators are for the
 * person who is running the same three actions forty times an evening.
 */

import { app, BrowserWindow, clipboard, dialog, Menu, shell } from "electron";
import { logPath } from "./crashLog.ts";
import { createProgressBackup, restoreProgressBackup } from "./progressBackup.ts";

async function restoreProgress(): Promise<void> {
  try {
    const picked = await dialog.showOpenDialog({ title: "Select an Apogee backup folder",
      buttonLabel: "Restore this backup", properties: ["openDirectory"] });
    if (picked.canceled || !picked.filePaths[0]) return;
    const answer = await dialog.showMessageBox({ type: "question", title: "Restore local progress",
      message: "Replace local progress with this backup and restart Apogee?",
      detail: "A copy of your current saves will be kept in the app data folder. Folder locations will be detected again on this computer.",
      buttons: ["Cancel", "Restore and restart"], defaultId: 0, cancelId: 0 });
    if (answer.response !== 1) return;
    restoreProgressBackup(picked.filePaths[0], app.getPath("userData"));
    // Restart without yielding: a queued run must not save the old in-memory quest
    // state over the newly restored file while a success dialog is still open.
    app.relaunch();
    app.exit(0);
  } catch (error) {
    await dialog.showMessageBox({ type: "error", title: "Restore failed", message: "Could not restore this backup.", detail: String(error) });
  }
}

async function backupProgress(): Promise<void> {
  const picked = await dialog.showOpenDialog({
    title: "Choose where to save your Apogee backup",
    buttonLabel: "Save backup here",
    properties: ["openDirectory", "createDirectory"],
  });
  if (picked.canceled || !picked.filePaths[0]) return;
  try {
    const result = createProgressBackup(app.getPath("userData"), picked.filePaths[0]);
    await dialog.showMessageBox({
      type: "info", title: "Backup saved", message: "Your local progress backup is ready.",
      detail: `${result.files.length} files saved to:\n${result.folder}\n\nRestore instructions are included. Back up your KovaaK's stats folder separately to keep your training history.`,
    });
    await shell.openPath(result.folder);
  } catch (error) {
    await dialog.showMessageBox({ type: "error", title: "Backup failed",
      message: "The backup could not be completed.", detail: String(error) });
  }
}

export interface MenuActions {
  rescan(): void;
  chooseFolder(): void;
  openStatsFolder(): void;
  /** Pasteable support text: build, folder, run count. Never anything private. */
  diagnostics(): string;
  checkForUpdates(): void;
}

export function installMenu(actions: MenuActions): void {
  const menu = Menu.buildFromTemplate([
    {
      label: "Apogee",
      submenu: [
        {
          label: "Rescan stats folder",
          // F5 rather than Ctrl+R, which belongs to reload and would shadow it.
          accelerator: "F5",
          click: () => actions.rescan(),
        },
        {
          label: "Choose stats folder…",
          accelerator: "CmdOrCtrl+O",
          click: () => actions.chooseFolder(),
        },
        {
          label: "Open stats folder",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => actions.openStatsFolder(),
        },
        { type: "separator" },
        {
          label: "Back up local progress…",
          accelerator: "CmdOrCtrl+Shift+B",
          click: () => void backupProgress(),
        },
        { label: "Restore local progress…", click: () => void restoreProgress() },
        { type: "separator" },
        {
          label: "Copy diagnostics",
          click: () => clipboard.writeText(actions.diagnostics()),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Help",
      submenu: [
        { label: "Check for updates", click: () => actions.checkForUpdates() },
        { label: "Keyboard shortcuts", click: () => {
          void dialog.showMessageBox({ type: "info", title: "Keyboard shortcuts", message: "Apogee keyboard shortcuts",
            detail: "Ctrl+K: jump to a screen\nCtrl+F or /: search scenarios\n1–9: open a screen\nM: mute sounds\nF5: rescan stats\nCtrl+O: choose stats folder\nCtrl+Shift+O: open stats folder\nCtrl+Shift+B: back up local progress\nCtrl++ / Ctrl+-: zoom\nCtrl+0: reset zoom\nAlt: show the app menu\nEscape: clear search or close a popup" });
        } },
        {
          // Where settings.json and quests.json live. Cheaper to open than to describe:
          // the path is a different one on every platform and nobody remembers it.
          label: "Open app data folder",
          click: () => void shell.openPath(app.getPath("userData")),
        },
        {
          // The one thing worth attaching to a bug report. A player who can be told
          // "Help > Open log" can send something useful; one who has to be talked
          // through %APPDATA% usually cannot.
          label: "Open log",
          click: () => void shell.showItemInFolder(logPath()),
        },
        {
          label: "About Apogee",
          click: () => {
            const parent = BrowserWindow.getFocusedWindow();
            const body = actions.diagnostics();
            const options = {
              type: "info" as const,
              title: "About Apogee",
              message: `Apogee ${app.getVersion()}`,
              detail: body,
              buttons: ["Copy", "Close"],
              defaultId: 1,
              cancelId: 1,
            };
            const answer = parent
              ? dialog.showMessageBoxSync(parent, options)
              : dialog.showMessageBoxSync(options);
            if (answer === 0) clipboard.writeText(body);
          },
        },
      ],
    },
  ]);

  Menu.setApplicationMenu(menu);
}
