/** Electron integration check, built and run by checkDesktopNetwork.mjs. */
import { app } from "electron";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createClient } from "@supabase/supabase-js";
import { installDesktopFetch } from "../src/app/network.ts";

app.setPath("userData", mkdtempSync(join(tmpdir(), "apogee-network-check-")));
const [cert, key] = process.argv.slice(2);
if (!cert || !key) throw Error("Supply a throwaway self-signed TLS certificate and key");
const http = createServer(async (req, res) => {
  if (req.url === "/slow") return;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  res.setHeader("content-type", "application/json");
  if (req.url === "/auth/v1/verify") {
    assert.equal(req.headers.apikey, "public-test-key");
    assert.equal(JSON.parse(Buffer.concat(chunks).toString()).token_hash, "test-token");
    res.statusCode = 403;
    res.end(JSON.stringify({ error_code: "otp_expired", msg: "Test token rejected" }));
    return;
  }
  res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString(), header: req.headers["x-apogee-check"] }));
});
const https = createHttpsServer({ cert: readFileSync(cert), key: readFileSync(key) }, (_req, res) => res.end("untrusted"));

app.whenReady().then(async () => {
  setTimeout(() => { console.error("Desktop network check timed out"); app.exit(1); }, 30000).unref();
  await Promise.all([http, https].map(server => new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))));
  installDesktopFetch();
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const get = await fetch(new URL(base));
  assert.equal(get.status, 200);
  assert.equal((await get.json()).method, "GET");
  console.log("PASS URL input reaches local server");
  const post = await fetch(new Request(base, {method: "POST", headers: {"x-apogee-check": "present"}, body: "hello"}));
  assert.deepEqual(await post.json(), {method: "POST", body: "hello", header: "present"});
  console.log("PASS Request input preserves POST body and headers");
  const client = createClient(base, "public-test-key", {auth: {persistSession: false, autoRefreshToken: false}});
  const result = await client.auth.verifyOtp({token_hash: "test-token", type: "magiclink"});
  assert.equal(result.error?.status, 403);
  assert.equal(result.error?.message, "Test token rejected");
  console.log("PASS Supabase sign-in request uses desktop transport and preserves auth errors");
  await assert.rejects(fetch(base + "/slow", {signal: AbortSignal.timeout(100)}), /abort|timeout/i);
  console.log("PASS stalled requests still abort");
  await assert.rejects(fetch(`https://127.0.0.1:${(https.address() as AddressInfo).port}`), /CERT|certificate/i);
  console.log("PASS untrusted HTTPS certificate is rejected");
  if (process.env.APOGEE_NETWORK_CHECK_URL && process.env.APOGEE_NETWORK_CHECK_ANON) {
    const response = await fetch(process.env.APOGEE_NETWORK_CHECK_URL + "/auth/v1/health", {
      headers: {apikey: process.env.APOGEE_NETWORK_CHECK_ANON}, signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).name, "GoTrue");
    console.log("PASS live Apogee authentication service responds with GoTrue health");
  }
  console.log("Desktop network integration checks completed");
  app.exit(0);
}).catch(error => {console.error(error); app.exit(1);});
