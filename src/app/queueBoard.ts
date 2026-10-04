/**
 * The queue board in the main process: Shadows and Flags for the renderer.
 *
 * Two jobs, both reads of the server's queue-board function:
 *
 *   ASKED   the renderer asks what queueing a category would do, before the player
 *           commits, and acknowledges Flag news once it has shown it
 *   POLLED  on launch, on sign-in, after every settled match and whenever the window
 *           takes focus, so a planter learns their Flag was answered without having to
 *           look. Pushed to the renderer as `apogee:queueBoard`.
 *
 * Kept out of main.ts so the integration there is one install call and three refreshes.
 * Decides nothing: every Shadow, verdict and Flag state is the server's, and the renderer
 * draws what this hands over.
 */

import { app, ipcMain } from "electron";

import { fetchQueueBoard, friendlyError, type QueueBoard } from "./api.ts";

/**
 * How often a focus can re-read the board.
 *
 * Alt-tabbing between KovaaK's and Apogee is the whole play loop, and every switch is a
 * focus. Twenty seconds keeps that loop well under queue-board's 60 per 5 minutes while a
 * planter who comes back to the window still sees an answer within the time it takes to
 * look at the screen.
 */
const FOCUS_INTERVAL_MS = 20_000;

export interface QueueBoardDeps {
  signedIn: () => boolean;
  broadcast: (channel: string, payload: unknown) => void;
  /** Every board read, polled or asked for, before the renderer hears of it (the share records). */
  onBoard?: (board: QueueBoard) => void;
}

export function installQueueBoard(deps: QueueBoardDeps): { refresh: (reason: string, force?: boolean) => Promise<void> } {
  let lastRead = 0;

  async function refresh(reason: string, force = false): Promise<void> {
    if (!deps.signedIn()) return;
    if (!force && Date.now() - lastRead < FOCUS_INTERVAL_MS) return;
    lastRead = Date.now();
    try {
      const board = await fetchQueueBoard({});
      deps.onBoard?.(board);
      deps.broadcast("apogee:queueBoard", board);
    } catch (err) {
      // Quiet, like the duel board: a missed read is a convenience lost, and the next
      // focus tries again. Not deployed yet reads the same way.
      console.warn(`could not read the queue board (${reason}):`, err instanceof Error ? err.message : err);
    }
  }

  ipcMain.handle("apogee:queueBoard", async (_e, args: unknown) => {
    if (!deps.signedIn()) return { error: "Sign in with Steam to play ranked." };
    const a = (args ?? {}) as { category?: unknown; pool?: { window?: unknown }; ack?: unknown };
    const request: { category?: string; window?: number; ack?: string[] } = {};
    if (typeof a.category === "string" && a.category.length > 0 && a.category.length <= 64) request.category = a.category;
    if (typeof a.pool?.window === "number" && Number.isInteger(a.pool.window) && a.pool.window >= 0) request.window = a.pool.window;
    if (Array.isArray(a.ack)) request.ack = a.ack.filter((id): id is string => typeof id === "string").slice(0, 50);
    try {
      const board = await fetchQueueBoard(request);
      lastRead = Date.now();
      deps.onBoard?.(board);
      return { board };
    } catch (err) {
      return { error: friendlyError(err) };
    }
  });

  app.on("browser-window-focus", () => void refresh("focus"));

  return { refresh };
}
