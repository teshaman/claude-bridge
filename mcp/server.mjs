#!/usr/bin/env node
/**
 * Claude Bridge — MCP server (zero dependencies).
 *
 * Speaks MCP (JSON-RPC over stdio, newline-delimited) to Claude Code and hosts a
 * WebSocket server on 127.0.0.1 that the Claude Bridge Foundry module connects
 * to from the GM's browser. Every tool becomes an "eval" request executed in
 * that browser.
 *
 * Environment:
 *   CLAUDE_BRIDGE_PORT   WebSocket port (default 30311)
 *   CLAUDE_BRIDGE_TOKEN  optional shared secret; the module setting must match
 *
 * Register with Claude Code:
 *   claude mcp add -s user claude-bridge -- node "<path to this file>"
 */

import http from "node:http";
import crypto from "node:crypto";
import readline from "node:readline";

const VERSION = "1.0.2";
const PORT = Number(process.env.CLAUDE_BRIDGE_PORT || 30311);
const TOKEN = process.env.CLAUDE_BRIDGE_TOKEN || "";
const DEFAULT_TIMEOUT = 30000;
const MAX_TIMEOUT = 300000;
const DEFAULT_MAX_CHARS = 60000;
const MAX_MAX_CHARS = 400000;

const log = (...args) => console.error("[claude-bridge]", ...args);

/* ============================================================================ */
/*  Minimal RFC 6455 WebSocket server                                           */
/* ============================================================================ */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class WsConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.open = true;
    this.onmessage = null;
    this.onclose = null;
    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("close", () => this._close());
    socket.on("error", (err) => { log("socket error", err.message); this._close(); });
  }

  _close() {
    if (!this.open) return;
    this.open = false;
    try { this.socket.destroy(); } catch (_) { /* ignore */ }
    this.onclose?.();
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.open) {
      const frame = this._readFrame();
      if (!frame) break;
      this._handleFrame(frame);
    }
  }

  _readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      len = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    let mask = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;
    const payload = Buffer.from(buf.subarray(offset, offset + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buffer = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case 0x0: // continuation
        this.fragments.push(payload);
        if (fin) this._deliver(this.fragmentOpcode, Buffer.concat(this.fragments));
        break;
      case 0x1: // text
      case 0x2: // binary
        if (fin) this._deliver(opcode, payload);
        else { this.fragments = [payload]; this.fragmentOpcode = opcode; }
        break;
      case 0x8: // close
        this._sendFrame(0x8, payload.subarray(0, 2));
        this._close();
        break;
      case 0x9: // ping
        this._sendFrame(0xA, payload);
        break;
      case 0xA: // pong
        break;
      default:
        log("unknown opcode", opcode);
        this._close();
    }
  }

  _deliver(opcode, payload) {
    this.fragments = [];
    this.onmessage?.(payload.toString("utf8"));
  }

  _sendFrame(opcode, payload) {
    if (!this.open) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(text) {
    this._sendFrame(0x1, Buffer.from(text, "utf8"));
  }

  close() {
    this._sendFrame(0x8, Buffer.from([0x03, 0xe8]));
    this._close();
  }
}

function startWsServer(port, onConnection) {
  const server = http.createServer((req, res) => {
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("Claude Bridge: WebSocket endpoint. Connect with the Foundry module.");
  });
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (req.headers.upgrade?.toLowerCase() !== "websocket" || !key) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);
    onConnection(new WsConnection(socket), req);
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      // Another bridge server (a previous session still shutting down, or Codex) holds the port. Keep trying:
      // once it lets go, this server binds and the Foundry module reconnects on its own.
      if (!portBusy) log(`port ${port} is already in use: another Claude Bridge server (Claude Code or Codex) owns the Foundry connection. Only one assistant can hold the bridge at a time; close the other one or change CLAUDE_BRIDGE_PORT and the module's port setting. Retrying every ${LISTEN_RETRY_MS / 1000}s.`);
      portBusy = true;
      setTimeout(() => server.listen(port, "127.0.0.1"), LISTEN_RETRY_MS);
      return;
    }
    log("ws server error", err.message);
  });
  server.on("listening", () => {
    if (portBusy) log(`port ${port} is free again`);
    portBusy = false;
    log(`listening on ws://127.0.0.1:${port}`);
  });
  server.listen(port, "127.0.0.1");
  return server;
}

/* ============================================================================ */
/*  Foundry connection + request routing                                        */
/* ============================================================================ */

let portBusy = false;        // another bridge server owns the port right now (we keep retrying)
const LISTEN_RETRY_MS = 3000;
let foundry = null;          // active WsConnection
let hello = null;            // info sent by the module
let connectedAt = null;
let nextId = 1;
const pending = new Map();   // id -> {resolve, reject, timer}

function rejectAllPending(reason) {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    pending.delete(id);
  }
}

startWsServer(PORT, (conn, req) => {
  log("browser connected from", req.headers.origin ?? "unknown origin");
  let authed = false;

  conn.onmessage = (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch (_) { return; }

    if (!authed) {
      if (msg.type !== "hello") return;
      if (TOKEN && msg.token !== TOKEN) {
        conn.send(JSON.stringify({ type: "error", message: "token mismatch — check the module's Shared token setting" }));
        conn.close();
        return;
      }
      authed = true;
      if (foundry && foundry !== conn) {
        log("replacing previous Foundry connection");
        rejectAllPending("Foundry reconnected; request abandoned");
        foundry.close();
      }
      foundry = conn;
      hello = msg;
      connectedAt = new Date();
      conn.send(JSON.stringify({ type: "welcome", server: VERSION }));
      log(`Foundry connected: ${msg.worldTitle} (${msg.system} ${msg.systemVersion}, core ${msg.core}) as ${msg.user}`);
      return;
    }

    if (msg.id === undefined) return;
    const p = pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(Object.assign(new Error(msg.error ?? "unknown error"), { stack: msg.stack }));
  };

  conn.onclose = () => {
    if (foundry === conn) {
      log("Foundry disconnected");
      foundry = null;
      hello = null;
      connectedAt = null;
      rejectAllPending("Foundry disconnected");
    }
  };
});

function request(op, params, timeoutMs = DEFAULT_TIMEOUT) {
  if (!foundry?.open) {
    return Promise.reject(new Error(notConnectedHint()));
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Foundry did not answer within ${timeoutMs} ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    foundry.send(JSON.stringify({ id, op, params }));
  });
}

function notConnectedHint() {
  if (portBusy) {
    return `Port ${PORT} is already in use by another Claude Bridge server (for example Codex while Claude Code is open, or the reverse). ` +
      "Only one assistant can hold the Foundry connection at a time: close the other assistant or its bridge server. This server retries the port every few seconds and connects on its own once it is free.";
  }
  return `Foundry is not connected to the Claude Bridge server (ws://localhost:${PORT}). ` +
    "In Foundry, log in as GM, open Configure Settings → Claude Bridge, enable the bridge and check the port. " +
    "The module reconnects on its own. The GM browser must run on this machine.";
}

/* ============================================================================ */
/*  Tools                                                                        */
/* ============================================================================ */

function clampTimeout(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT;
  return Math.min(n, MAX_TIMEOUT);
}

function clampChars(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_CHARS;
  return Math.min(n, MAX_MAX_CHARS);
}

function render(value, maxChars) {
  let text = value === undefined ? "undefined" : JSON.stringify(value, null, 2);
  if (text === undefined) text = String(value);
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + `\n…[truncated at ${maxChars} chars; pass maxChars up to ${MAX_MAX_CHARS} or narrow the query]`;
  }
  return text;
}

const evalScript = (code, args, timeoutMs) => request("eval", { code, args }, timeoutMs);

const TOOLS = [
  {
    name: "bridge_status",
    description: "Check whether the GM's Foundry browser is connected to this bridge and summarise the world (system, core version, user, scene).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      if (!foundry?.open) return { connected: false, hint: notConnectedHint() };
      const ping = await request("ping", {}, 10000);
      return { connected: true, since: connectedAt?.toISOString(), ...hello, token: undefined, live: ping };
    }
  },
  {
    name: "run_script",
    description: "Run JavaScript in the GM's Foundry browser with full API access (game, canvas, ui, foundry, CONFIG, CONST, args). The code body runs inside an async function: use `return` to send a value back; `await` is allowed. Documents in the result are converted with toObject() (flags included). Use this to inspect module APIs, edit flags, build skill trees, or do anything Familiar refuses.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript function body to run in the GM client" },
        args: { type: "object", description: "Optional plain object exposed to the code as `args`" },
        timeoutMs: { type: "number", description: `Timeout in ms (default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT})` },
        maxChars: { type: "number", description: `Truncate the rendered result to this many characters (default ${DEFAULT_MAX_CHARS}, max ${MAX_MAX_CHARS})` }
      },
      required: ["code"],
      additionalProperties: false
    },
    async run({ code, args, timeoutMs }) {
      return evalScript(code, args ?? {}, clampTimeout(timeoutMs));
    }
  },
  {
    name: "get_document",
    description: "Fetch any document by UUID (Actor, Item, JournalEntry, JournalEntryPage, Macro, Scene, Folder, embedded documents…) and return its full source data including flags.",
    inputSchema: {
      type: "object",
      properties: {
        uuid: { type: "string", description: "Document UUID, e.g. JournalEntry.kLl2PFHs1ScpF6fx or Actor.abc.Item.def" },
        maxChars: { type: "number" }
      },
      required: ["uuid"],
      additionalProperties: false
    },
    async run({ uuid }) {
      return evalScript(
        "const d = await fromUuid(args.uuid); if (!d) throw new Error(`No document for ${args.uuid}`); return d.toObject();",
        { uuid }
      );
    }
  },
  {
    name: "update_document",
    description: "Apply a Foundry update (dot-notation keys allowed, flags included) to a document by UUID. Returns the document's name and the keys that were sent.",
    inputSchema: {
      type: "object",
      properties: {
        uuid: { type: "string" },
        updates: { type: "object", description: "Update data, e.g. {\"flags.skill-tree.grid\": {\"w\": 9, \"h\": 9}}" }
      },
      required: ["uuid", "updates"],
      additionalProperties: false
    },
    async run({ uuid, updates }) {
      return evalScript(
        "const d = await fromUuid(args.uuid); if (!d) throw new Error(`No document for ${args.uuid}`); " +
        "await d.update(args.updates); return { uuid: d.uuid, name: d.name, updatedKeys: Object.keys(args.updates) };",
        { uuid, updates }
      );
    }
  },
  {
    name: "create_document",
    description: "Create a world document (Actor, Item, JournalEntry, Macro, RollTable, Scene, Folder, Playlist…) or, with parentUuid, an embedded document (Item on an Actor, JournalEntryPage on a JournalEntry, ActiveEffect on an Item…). Data may include flags.",
    inputSchema: {
      type: "object",
      properties: {
        documentName: { type: "string", description: "e.g. JournalEntry, Item, Actor, Macro, Folder, JournalEntryPage, ActiveEffect" },
        data: { type: "object", description: "Document source data" },
        parentUuid: { type: "string", description: "UUID of the parent when creating an embedded document" }
      },
      required: ["documentName", "data"],
      additionalProperties: false
    },
    async run({ documentName, data, parentUuid }) {
      return evalScript(
        "let created; if (args.parentUuid) { const parent = await fromUuid(args.parentUuid); if (!parent) throw new Error(`No parent ${args.parentUuid}`); " +
        "[created] = await parent.createEmbeddedDocuments(args.documentName, [args.data]); } " +
        "else { const cls = getDocumentClass(args.documentName); if (!cls) throw new Error(`Unknown document type ${args.documentName}`); created = await cls.create(args.data); } " +
        "return { uuid: created.uuid, id: created.id, name: created.name ?? null };",
        { documentName, data, parentUuid }
      );
    }
  },
  {
    name: "delete_document",
    description: "Delete a document by UUID. Irreversible — confirm with the GM first for anything they did not just ask you to remove.",
    inputSchema: {
      type: "object",
      properties: { uuid: { type: "string" } },
      required: ["uuid"],
      additionalProperties: false
    },
    async run({ uuid }) {
      return evalScript(
        "const d = await fromUuid(args.uuid); if (!d) throw new Error(`No document for ${args.uuid}`); const name = d.name; await d.delete(); return { deleted: true, uuid: args.uuid, name };",
        { uuid }
      );
    }
  },
  {
    name: "create_macro",
    description: "Create a Foundry macro (script or chat) directly in the world. Script macros run as the GM when executed.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        command: { type: "string", description: "Macro source" },
        type: { type: "string", enum: ["script", "chat"], description: "Default script" },
        img: { type: "string" },
        folder: { type: "string", description: "Macro folder id or name" }
      },
      required: ["name", "command"],
      additionalProperties: false
    },
    async run({ name, command, type = "script", img, folder }) {
      return evalScript(
        "let folderId = null; if (args.folder) { const f = game.folders.get(args.folder) ?? game.folders.find(x => x.type === 'Macro' && x.name === args.folder); folderId = f?.id ?? null; } " +
        "const data = { name: args.name, type: args.type, command: args.command, scope: 'global', folder: folderId }; if (args.img) data.img = args.img; " +
        "const m = await Macro.create(data); return { uuid: m.uuid, id: m.id, name: m.name, type: m.type };",
        { name, command, type, img, folder }
      );
    }
  },
  {
    name: "update_macro",
    description: "Replace the source (and optionally name/type/img) of an existing macro by id or exact name.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "Macro id or exact name" },
        command: { type: "string" },
        name: { type: "string" },
        type: { type: "string", enum: ["script", "chat"] },
        img: { type: "string" }
      },
      required: ["identifier"],
      additionalProperties: false
    },
    async run({ identifier, ...changes }) {
      return evalScript(
        "const m = game.macros.get(args.identifier) ?? game.macros.getName(args.identifier); if (!m) throw new Error(`No macro ${args.identifier}`); " +
        "const upd = {}; for (const k of ['command','name','type','img']) if (args[k] !== undefined) upd[k] = args[k]; await m.update(upd); return { id: m.id, name: m.name, updatedKeys: Object.keys(upd) };",
        { identifier, ...changes }
      );
    }
  }
];

const toolByName = new Map(TOOLS.map((t) => [t.name, t]));

async function callTool(name, input = {}) {
  const tool = toolByName.get(name);
  if (!tool) return { content: [{ type: "text", text: `Unknown tool ${name}` }], isError: true };
  const maxChars = clampChars(input.maxChars);
  try {
    const result = await tool.run(input);
    return { content: [{ type: "text", text: render(result, maxChars) }] };
  } catch (err) {
    const text = `${err.message}${err.stack && !err.message.includes(err.stack) ? `\n${String(err.stack).slice(0, 2000)}` : ""}`;
    return { content: [{ type: "text", text }], isError: true };
  }
}

/* ============================================================================ */
/*  MCP over stdio (JSON-RPC 2.0, newline-delimited)                            */
/* ============================================================================ */

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleRpc(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "claude-bridge", version: VERSION },
        instructions:
          "Claude Bridge runs code in the GM's Foundry browser. Prefer Familiar for ordinary reads and edits; use this bridge for flags, module APIs, script macros and anything Familiar refuses. Check bridge_status if a call reports Foundry is not connected."
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const result = await callTool(params?.name, params?.arguments ?? {});
      return reply(id, result);
    }
    default:
      if (!isNotification) replyError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch (_) {
    log("ignoring malformed line");
    return;
  }
  handleRpc(msg).catch((err) => {
    log("rpc error", err);
    if (msg.id !== undefined && msg.id !== null) replyError(msg.id, -32603, err.message);
  });
});
rl.on("close", () => {
  log("stdin closed, exiting");
  process.exit(0);
});

log(`Claude Bridge MCP server ${VERSION} ready${TOKEN ? " (token required)" : ""}`);
