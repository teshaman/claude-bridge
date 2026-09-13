/**
 * Claude Bridge — Foundry side.
 *
 * When enabled, the GM's browser opens a WebSocket to a Claude Bridge MCP server
 * running on the same machine (ws://localhost:<port>). The server forwards
 * requests from Claude Code; this module runs them in the GM client and replies.
 *
 * Only a GM user ever connects. Disable the setting (or the module) to cut access.
 */

const MOD = "claude-bridge";
const LOG = "Claude Bridge |";

let socket = null;
let reconnectTimer = null;
let backoff = 2000;
let everConnected = false;
let stopping = false;

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MOD, "enabled", {
    name: "Enable Claude Code bridge",
    hint: "Connect this GM browser to the Claude Bridge MCP server on localhost. Only the GM's client ever connects.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => restart()
  });
  game.settings.register(MOD, "port", {
    name: "Bridge port",
    hint: "Must match the port the MCP server listens on (default 30311).",
    scope: "world",
    config: true,
    type: Number,
    default: 30311,
    onChange: () => restart()
  });
  game.settings.register(MOD, "token", {
    name: "Shared token (optional)",
    hint: "If the MCP server was started with CLAUDE_BRIDGE_TOKEN set, enter the same value here.",
    scope: "world",
    config: true,
    type: String,
    default: "",
    onChange: () => restart()
  });
  game.settings.register(MOD, "notify", {
    name: "Show connection notifications",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });
});

Hooks.once("ready", () => {
  const mod = game.modules.get(MOD);
  mod.api = { connect, disconnect, restart, status, isConnected };
  globalThis.claudeBridge = mod.api;
  if (game.user.isGM) connect();
});

/* -------------------------------------------- */
/*  Connection                                  */
/* -------------------------------------------- */

function notify(message, level = "info") {
  console.log(LOG, message);
  if (game.settings.get(MOD, "notify")) ui.notifications[level](`Claude Bridge: ${message}`);
}

function isConnected() {
  return socket?.readyState === WebSocket.OPEN;
}

function status() {
  return {
    enabled: game.settings.get(MOD, "enabled"),
    port: game.settings.get(MOD, "port"),
    connected: isConnected(),
    readyState: socket?.readyState ?? null
  };
}

function connect() {
  if (!game.user.isGM) return;
  if (!game.settings.get(MOD, "enabled")) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  stopping = false;

  const url = `ws://localhost:${game.settings.get(MOD, "port")}`;
  try {
    socket = new WebSocket(url);
  } catch (err) {
    console.warn(LOG, "could not open socket", err);
    scheduleReconnect();
    return;
  }

  socket.addEventListener("open", () => {
    backoff = 2000;
    everConnected = true;
    send({
      type: "hello",
      token: game.settings.get(MOD, "token") || null,
      module: game.modules.get(MOD)?.version ?? "?",
      world: game.world.id,
      worldTitle: game.world.title,
      system: game.system.id,
      systemVersion: game.system.version,
      core: game.version,
      user: game.user.name
    });
    notify(`connected to ${url}`);
  });

  socket.addEventListener("message", (event) => handleMessage(event.data));

  socket.addEventListener("close", () => {
    const wasOpen = everConnected;
    socket = null;
    if (stopping) return;
    if (wasOpen) notify("disconnected — will retry", "warn");
    everConnected = false;
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    /* the close event follows and handles reconnection */
  });
}

function disconnect() {
  stopping = true;
  clearTimeout(reconnectTimer);
  if (socket) {
    try { socket.close(); } catch (_) { /* ignore */ }
  }
  socket = null;
  everConnected = false;
}

function restart() {
  if (!game.user?.isGM) return;
  disconnect();
  if (game.settings.get(MOD, "enabled")) setTimeout(connect, 250);
}

function scheduleReconnect() {
  if (stopping || !game.settings.get(MOD, "enabled")) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 30000);
}

function send(payload) {
  if (!isConnected()) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

/* -------------------------------------------- */
/*  Request handling                            */
/* -------------------------------------------- */

const ops = {
  async ping() {
    return {
      pong: true,
      world: game.world.id,
      user: game.user.name,
      scene: canvas?.scene?.name ?? null,
      paused: game.paused,
      time: Date.now()
    };
  },

  /** Run arbitrary JavaScript in the GM client. `args` is passed through as a plain object. */
  async eval({ code, args } = {}) {
    if (typeof code !== "string" || !code.trim()) throw new Error("eval: 'code' must be a non-empty string");
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction("game", "canvas", "ui", "foundry", "CONFIG", "CONST", "args", code);
    return fn(game, canvas, ui, foundry, CONFIG, CONST, args ?? {});
  }
};

async function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (_) {
    console.warn(LOG, "ignoring non-JSON message");
    return;
  }

  if (msg.type === "welcome") {
    console.log(LOG, "server accepted connection", msg);
    return;
  }
  if (msg.type === "error") {
    notify(msg.message ?? "server error", "error");
    return;
  }
  if (msg.id === undefined || !msg.op) return;

  const started = Date.now();
  try {
    const op = ops[msg.op];
    if (!op) throw new Error(`Unknown op '${msg.op}'`);
    const result = await op(msg.params ?? {});
    const plain = toPlain(result);
    send({ id: msg.id, ok: true, result: plain, ms: Date.now() - started });
  } catch (err) {
    console.error(LOG, `op ${msg.op} failed`, err);
    send({
      id: msg.id,
      ok: false,
      error: `${err?.name ?? "Error"}: ${err?.message ?? String(err)}`,
      stack: String(err?.stack ?? "").slice(0, 4000),
      ms: Date.now() - started
    });
  }
}

/* -------------------------------------------- */
/*  Serialisation                               */
/* -------------------------------------------- */

/**
 * Convert an arbitrary value into JSON-safe data.
 * Documents become their source data (flags included); collections become arrays.
 */
function toPlain(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value ?? null;
  const t = typeof value;
  if (t === "string" || t === "boolean") return value;
  if (t === "number") return Number.isFinite(value) ? value : String(value);
  if (t === "bigint") return value.toString();
  if (t === "function" || t === "symbol") return undefined;
  if (depth > 16) return "[max depth]";
  if (seen.has(value)) return "[circular]";

  if (value instanceof Date) return value.toISOString();
  if (typeof value.toObject === "function" && (value.documentName || value.schema)) {
    try { return toPlain(value.toObject(), depth + 1, seen); } catch (_) { /* fall through */ }
  }
  if (typeof value.toJSON === "function" && !Array.isArray(value)) {
    try { return toPlain(value.toJSON(), depth + 1, seen); } catch (_) { /* fall through */ }
  }
  if (value instanceof Map) {
    seen.add(value);
    return Array.from(value.values()).map((v) => toPlain(v, depth + 1, seen));
  }
  if (value instanceof Set) {
    seen.add(value);
    return Array.from(value).map((v) => toPlain(v, depth + 1, seen));
  }
  if (Array.isArray(value)) {
    seen.add(value);
    return value.map((v) => toPlain(v, depth + 1, seen));
  }
  if (t === "object") {
    seen.add(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const p = toPlain(v, depth + 1, seen);
      if (p !== undefined) out[k] = p;
    }
    return out;
  }
  return String(value);
}
