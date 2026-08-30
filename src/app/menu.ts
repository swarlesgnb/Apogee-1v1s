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

export interface MenuActions {
  rescan(): void;
  chooseFolder(): void;
  openStatsFolder(): void;
  /** Pasteable support text: build, folder, run count. Never anything private. */
  diagnostics(): string;
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
