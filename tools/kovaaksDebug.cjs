/**
 * Evaluate JavaScript inside KovaaK's UI over its Coherent GT debugger.
 *
 * KovaaK's renders its interface with Coherent GT (Cohtml), which ships a Chrome
 * DevTools Protocol endpoint. While the game is running it listens on 9444, and /json
 * advertises a single inspectable page. That gives read access to the UI's JS context,
 * which is where the C++ bindings live.
 *
 * Node's built-in WebSocket offers permessage-deflate and this server rejects the
 * upgrade, so the framing is done by hand over a plain socket.
 *
 *   node tools/kovaaksDebug.cjs "<expression>" [--verbose]
 */
const net = require("node:net");
const crypto = require("node:crypto");

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");

/**
 * Canned expressions, because a long one-liner does not survive being pasted into a
 * terminal and a truncated probe looks like a failed probe.
 *
 *   node tools/kovaaksDebug.cjs --probe surface
 */
const PROBES = {
  // Is the bridge there, and what does it carry?
  surface:
    "JSON.stringify({url:location.href,engine:typeof engine," +
    "keys:Object.keys(engine)," +
    "proto:Object.getOwnPropertyNames(Object.getPrototypeOf(engine))})",

  // Coherent keeps its registered handlers and events in maps on the bridge; names
  // vary by version, so several are tried and whichever exists answers.
  bindings:
    "JSON.stringify({" +
    "events:engine.events?Object.keys(engine.events):null," +
    "boundEvents:engine._boundEvents?Object.keys(engine._boundEvents):null," +
    "handlers:engine._handlers?Object.keys(engine._handlers):null," +
    "onReady:typeof engine.whenReady," +
    "call:typeof engine.call,on:typeof engine.on,trigger:typeof engine.trigger})",

  // Anything on window that sounds like it owns playlists or game state.
  globals:
    "JSON.stringify(Object.keys(window).filter(function(k){" +
    "return /playlist|scenario|kovaak|store|game|app|menu|ui|state/i.test(k)}))",

  // Names of every registered event, which is where a refresh hook would surface.
  events:
    "JSON.stringify((function(){var o=engine.events||engine._boundEvents||{};" +
    "return Object.keys(o).filter(function(k){" +
    "return /playlist|refresh|reload|scenario/i.test(k)})})())",

  // What scripts the interface loaded, and where from.
  scripts:
    "JSON.stringify(Array.prototype.map.call(document.scripts,function(s){" +
    "return s.src||('inline:'+(s.textContent||'').length)}))",

  /**
   * Every handler name the interface calls across the C++ bridge.
   *
   * The UI ships inside a 6.8 GB pak, so its source cannot be read off disk, but the
   * scripts are already loaded here and coui:// is fetchable from inside the page.
   * Pulling each one back and matching engine.call sites recovers the vocabulary the
   * menu uses - including, if it exists, whatever reloads the local playlist folder.
   */
  calls:
    "(async function(){var out=[];var seen={};" +
    // Every fetch races a timer. coui:// is not http, and a request against it can
    // simply never settle - which with awaitPromise means the whole probe hangs and
    // reports nothing, rather than reporting the little it did learn.
    "function grab(u){return Promise.race([" +
    "fetch(u).then(function(r){return r.text()})," +
    "new Promise(function(_,rej){setTimeout(function(){rej(new Error('timeout'))},2500)})])}" +
    "function scan(t){var m=t.match(/engine\\.call\\(\\s*['\\\"][^'\\\"]+/g)||[];" +
    "for(var i=0;i<m.length;i++)seen[m[i].replace(/[\\s\\S]*['\\\"]/,'')]=1;return m.length}" +
    "for(var i=0;i<document.scripts.length;i++){var s=document.scripts[i];" +
    "if(!s.src){out.push({src:'inline',bytes:(s.textContent||'').length," +
    "found:scan(s.textContent||'')});continue}" +
    "try{var t=await grab(s.src);" +
    "out.push({src:s.src.split('/').pop(),bytes:t.length,found:scan(t)})}" +
    "catch(e){out.push({src:s.src.split('/').pop(),err:String(e.message||e).slice(0,40)})}}" +
    "return JSON.stringify({scripts:document.scripts.length,files:out," +
    "handlers:Object.keys(seen).sort()})})()",
};

const probeArg = args.indexOf("--probe");
const EXPR =
  probeArg !== -1
    ? PROBES[args[probeArg + 1]] ??
      (() => {
        console.error(`unknown probe. available: ${Object.keys(PROBES).join(", ")}`);
        process.exit(1);
      })()
    : args.find((a) => !a.startsWith("--")) ?? "1+1";

const HOST = "127.0.0.1";
const PORT = 9444;
const PATH = "/devtools/page/0";

const log = (...a) => VERBOSE && console.error("[dbg]", ...a);

const sock = net.connect(PORT, HOST);
let upgraded = false;
let buf = Buffer.alloc(0);
let nextId = 0;

sock.setTimeout(20000);

sock.on("connect", () => {
  log("tcp connected");
  sock.write(
    `GET ${PATH} HTTP/1.1\r\n` +
      `Host: ${HOST}:${PORT}\r\n` +
      "Connection: Upgrade\r\n" +
      "Upgrade: websocket\r\n" +
      "Sec-WebSocket-Version: 13\r\n" +
      `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\n\r\n`,
  );
});

function send(method, params = {}) {
  const id = ++nextId;
  const text = JSON.stringify({ id, method, params });
  const payload = Buffer.from(text, "utf8");
  const mask = crypto.randomBytes(4);

  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  header[0] = 0x81;

  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];

  sock.write(Buffer.concat([header, mask, masked]));
  log("sent", method, "id", id);
  return id;
}

function frames() {
  const out = [];
  for (;;) {
    if (buf.length < 2) break;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      len = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }

    let mask = null;
    if (masked) {
      if (buf.length < offset + 4) break;
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + len) break;

    let payload = Buffer.from(buf.subarray(offset, offset + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];

    buf = buf.subarray(offset + len);
    log(`frame opcode=${opcode} fin=${fin} len=${len}`);

    if (opcode === 0x8) {
      log("server sent close");
      sock.end();
      break;
    }
    if (opcode === 0x1 || opcode === 0x0) out.push(payload.toString("utf8"));
  }
  return out;
}

let evalId = null;
let contextId = null;
let attempts = 0;
const MAX_ATTEMPTS = 6;

/**
 * Ask for the expression against the context we were most recently told about.
 *
 * awaitPromise so a probe can be async: reading the interface's own scripts back out
 * of coui:// needs fetch, and without it the reply is a pending promise.
 */
function evaluate() {
  attempts++;
  evalId = send("Runtime.evaluate", {
    expression: EXPR,
    returnByValue: true,
    awaitPromise: true,
    ...(contextId != null ? { contextId } : {}),
  });
}

sock.on("data", (chunk) => {
  if (!upgraded) {
    const text = chunk.toString("latin1");
    const end = text.indexOf("\r\n\r\n");
    if (end === -1) return;

    const status = text.slice(0, text.indexOf("\r\n"));
    log("upgrade response:", status);
    if (!/\b101\b/.test(status)) {
      console.error("upgrade failed:", status);
      process.exit(1);
    }

    upgraded = true;
    buf = chunk.subarray(end + 4);

    // Enable the domain and then wait to be told a context exists.
    //
    // Evaluating straight after the handshake is a race that is lost often enough to
    // matter: the interface is a single-page app and its JS context is torn down and
    // rebuilt whenever the game changes what it is showing, so an expression sent at
    // the wrong moment comes back "Execution context was destroyed". Waiting for
    // executionContextCreated, and retrying on a destroyed context, turns a coin flip
    // into something that just works.
    send("Runtime.enable");

    // Runtime.enable normally announces the contexts that already exist, but if this
    // build does not, waiting for an announcement that is never coming would look
    // exactly like a hang. Go without one after a moment.
    setTimeout(() => {
      if (evalId === null) {
        log("no context announced, evaluating without one");
        evaluate();
      }
    }, 2000);
  } else {
    buf = Buffer.concat([buf, chunk]);
  }

  for (const frame of frames()) {
    log("<<", frame.slice(0, 300));

    let msg;
    try {
      msg = JSON.parse(frame);
    } catch {
      continue;
    }

    // A context appeared. Evaluate against it by id, so the expression cannot land in
    // one that has already gone away.
    if (msg.method === "Runtime.executionContextCreated") {
      contextId = msg.params?.context?.id ?? null;
      log("context", contextId, "created");
      if (evalId === null) evaluate();
      continue;
    }

    if (msg.method === "Runtime.executionContextDestroyed") {
      log("context destroyed");
      continue;
    }

    if (msg.id !== evalId) continue;

    // Lost the race anyway: the context went away between being announced and being
    // used. Wait for the next one rather than reporting a failure that is really a
    // timing accident.
    if (msg.error && /context was destroyed/i.test(msg.error.message ?? "")) {
      if (attempts < MAX_ATTEMPTS) {
        log("destroyed mid-evaluate, waiting for the next context");
        evalId = null;
        continue;
      }
      console.error(
        `the interface kept replacing its JS context (${MAX_ATTEMPTS} attempts). ` +
          "It does that while the game is changing screens - try again once it is " +
          "sitting still on a menu.",
      );
      process.exit(1);
    }

    if (msg.error) {
      console.error("protocol error:", JSON.stringify(msg.error));
      process.exit(1);
    }
    if (msg.result?.exceptionDetails) {
      console.log("EXCEPTION: " + JSON.stringify(msg.result.exceptionDetails).slice(0, 600));
    } else {
      const v = msg.result?.result?.value;
      console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
    }
    sock.end();
    process.exit(0);
  }
});

sock.on("timeout", () => {
  console.error("timed out with no usable reply (try --verbose)");
  process.exit(1);
});

sock.on("error", (e) => {
  console.error("socket error:", e.message);
  process.exit(1);
});
