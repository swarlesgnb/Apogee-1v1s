import { net } from "electron";

/**
 * Call after app.whenReady(), before creating the Supabase client. Node's fetch uses
 * its own certificate roots and proxy handling; on a Windows installation with a
 * trusted local issuer it rejected HTTPS that worked in the user's browser. The
 * Chromium transport uses the desktop's trust and proxy settings, with normal TLS
 * verification, for sign-in and the other backend requests alike.
 */
export function installDesktopFetch(): void {
  globalThis.fetch = (input, init) => net.fetch(input instanceof URL ? input.href : input, init);
}
