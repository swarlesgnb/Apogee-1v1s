import type { RiftService } from './rift.ts';

interface RiftHost {
  service: () => RiftService;
  statsDir: () => string | null;
  ready: () => Promise<unknown>;
  launch: (scenario: string) => Promise<{ ok: boolean; error?: string }>;
  broadcast: (channel: string, view: unknown) => void;
}
/** Shared by the desktop and isolated Electron flow test; launch is the only simulated side effect. */
export function registerRiftHandlers(ipc: { handle: (channel: string, handler: (event: unknown, action?: unknown) => Promise<unknown>) => void }, host: RiftHost) {
  const errorText = (err: unknown) => err instanceof Error ? err.message : String(err);
  ipc.handle('apogee:rift', async () => {
    await host.ready();
    try { return host.service().view(host.statsDir(), true); }
    catch (err) { return { error: errorText(err) }; }
  });
  ipc.handle('apogee:riftAction', async (_event, action) => {
    await host.ready();
    let view: ReturnType<RiftService['view']> | undefined;
    try {
      const type = action && typeof action === 'object' ? (action as { type?: unknown }).type : null;
      if (type === 'arm' || type === 'launch') {
        view = type === 'arm' ? host.service().action(action, host.statsDir()) : host.service().view(host.statsDir(), true);
        if (view.error) return { view, error: view.error };
        const scenario = host.service().launchScenario(host.statsDir());
        const launched = await host.launch(scenario);
        // A file watcher may settle the round while Steam is opening. Never repaint the older armed state over it.
        view = host.service().view(host.statsDir());
        host.broadcast('apogee:rift', view);
        return { view, ...(launched.ok ? {} : { error: launched.error ?? "KovaaK's could not open. Your prepared round is saved; retry launch or open the named scenario manually." }) };
      }
      view = host.service().action(action, host.statsDir());
      host.broadcast('apogee:rift', view);
      return { view };
    } catch (err) { return { ...(view ? { view } : {}), error: errorText(err) }; }
  });
}
