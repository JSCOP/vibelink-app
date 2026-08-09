const PROTOCOL_VERSION = 1;
const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_BASE_MS = 24_000;
const MAX_RECONNECT_MS = 30_000;
const KEEPALIVE_MS = 20_000;
const DEBUGGER_PROTOCOL_VERSION = "1.3";
const GROUP_COLORS = new Set([
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
]);

const attachedTabIds = new Set();
const connections = new Map();
let started = false;

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!Number.isInteger(tabId) || !attachedTabIds.has(tabId)) return;

  broadcast({
    v: PROTOCOL_VERSION,
    type: "event",
    tabId,
    method,
    params: params ?? {},
  });
});

chrome.debugger.onDetach.addListener((source) => {
  if (Number.isInteger(source.tabId)) attachedTabIds.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabIds.delete(tabId);
});

chrome.runtime.onInstalled.addListener(() => void start());
chrome.runtime.onStartup.addListener(() => void start());
void start();

async function start() {
  if (started) return;
  started = true;

  try {
    const response = await fetch(chrome.runtime.getURL("pairing.json"), {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("pairing.json is missing");

    const pairing = validatePairing(await response.json());
    for (const port of pairing.ports) connectPort(port, pairing.token);
  } catch (error) {
    console.error(`VibeLink Browser Control is idle: ${errorMessage(error)}`);
  }
}

function validatePairing(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("pairing.json must contain an object");
  }
  if (typeof value.token !== "string" || !/^[0-9a-fA-F]{64}$/.test(value.token)) {
    throw new Error("pairing.json has an invalid token");
  }
  if (!Array.isArray(value.ports) || value.ports.length === 0) {
    throw new Error("pairing.json has no ports");
  }

  const ports = [...new Set(value.ports)];
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error("pairing.json has an invalid port");
  }

  return { token: value.token, ports };
}

function connectPort(port, token) {
  const connection = {
    port,
    token,
    attempt: 0,
    socket: null,
    reconnectTimer: null,
    keepaliveTimer: null,
  };
  connections.set(port, connection);
  openSocket(connection);
}

function openSocket(connection) {
  let socket;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${connection.port}`);
  } catch {
    scheduleReconnect(connection);
    return;
  }

  connection.socket = socket;

  socket.addEventListener("open", () => {
    if (connection.socket !== socket) return;

    connection.attempt = 0;
    sendFrame(socket, {
      v: PROTOCOL_VERSION,
      type: "hello",
      token: connection.token,
      browser: "chrome",
      extensionVersion: chrome.runtime.getManifest().version,
      userAgent: navigator.userAgent,
    });

    connection.keepaliveTimer = setInterval(() => {
      if (connection.socket === socket) {
        sendFrame(socket, { v: PROTOCOL_VERSION, type: "keepalive" });
      }
    }, KEEPALIVE_MS);
  });

  socket.addEventListener("message", (event) => {
    if (connection.socket === socket) void handleMessage(socket, event.data);
  });

  socket.addEventListener("error", () => {
    if (socket.readyState === WebSocket.OPEN) socket.close();
  });

  socket.addEventListener("close", () => {
    if (connection.socket !== socket) return;

    if (connection.keepaliveTimer !== null) {
      clearInterval(connection.keepaliveTimer);
      connection.keepaliveTimer = null;
    }
    connection.socket = null;
    scheduleReconnect(connection);
  });
}

function scheduleReconnect(connection) {
  const base = Math.min(
    MAX_RECONNECT_BASE_MS,
    INITIAL_RECONNECT_MS * 2 ** Math.min(connection.attempt, 5),
  );
  const delay = Math.min(
    MAX_RECONNECT_MS,
    Math.round(base * (1 + Math.random() * 0.25)),
  );
  connection.attempt += 1;
  connection.reconnectTimer = setTimeout(() => {
    connection.reconnectTimer = null;
    openSocket(connection);
  }, delay);
}

async function handleMessage(socket, data) {
  let request;

  try {
    if (typeof data !== "string") throw new Error("Expected a WebSocket text frame");
    request = JSON.parse(data);
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new Error("Request must be a JSON object");
    }
    if (request.v !== PROTOCOL_VERSION) throw new Error("Unsupported protocol version");
    if (!Number.isSafeInteger(request.id) || request.id < 0) {
      throw new Error("Request id must be a non-negative safe integer");
    }

    const result = await dispatch(request);
    sendFrame(socket, {
      v: PROTOCOL_VERSION,
      type: "result",
      id: request.id,
      ok: true,
      result,
    });
  } catch (error) {
    sendFrame(socket, {
      v: PROTOCOL_VERSION,
      type: "result",
      id: request?.id ?? null,
      ok: false,
      error: errorMessage(error),
    });
  }
}

async function dispatch(request) {
  switch (request.op) {
    case "listTabs": {
      const tabs = await chrome.tabs.query({});
      return { tabs: tabs.filter((tab) => Number.isInteger(tab.id)).map(tabResult) };
    }

    case "newTab": {
      if (typeof request.url !== "string") throw new Error("url must be a string");
      return tabResult(await chrome.tabs.create({ url: request.url }));
    }

    case "closeTab": {
      const tabId = requestTabId(request);
      await chrome.tabs.remove(tabId);
      attachedTabIds.delete(tabId);
      return {};
    }

    case "attach": {
      await ensureAttached(requestTabId(request));
      return {};
    }

    case "detach": {
      const tabId = requestTabId(request);
      try {
        await chrome.debugger.detach({ tabId });
      } catch (error) {
        if (!errorMessage(error).toLowerCase().includes("not attached")) throw error;
      } finally {
        attachedTabIds.delete(tabId);
      }
      return {};
    }

    case "send": {
      const tabId = requestTabId(request);
      if (typeof request.method !== "string" || request.method.length === 0) {
        throw new Error("method must be a non-empty string");
      }
      await ensureAttached(tabId);
      // Chrome does not deliver synthesized input to a tab that is not the
      // active one in its window: the compositor is not driving it, so the
      // event is accepted and dropped. Raise the tab first, exactly as a
      // person would, and the user also gets to see what is being clicked.
      if (request.method.startsWith("Input.")) {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (!tab.active) await chrome.tabs.update(tabId, { active: true });
        } catch (error) {
          // A tab that vanished fails on the command below with a clearer message.
        }
      }
      return (
        (await chrome.debugger.sendCommand(
          { tabId },
          request.method,
          request.params ?? {},
        )) ?? {}
      );
    }

    case "nameSession": {
      const tabId = requestTabId(request);
      if (typeof request.title !== "string") throw new Error("title must be a string");

      const tab = await chrome.tabs.get(tabId);
      const groupId =
        Number.isInteger(tab.groupId) && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE
          ? tab.groupId
          : await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(groupId, {
        title: request.title,
        color: GROUP_COLORS.has(request.color) ? request.color : "blue",
      });
      return {};
    }

    default:
      throw new Error(`Unknown op: ${String(request.op)}`);
  }
}

async function ensureAttached(tabId) {
  if (attachedTabIds.has(tabId)) return;

  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
  } catch (error) {
    if (!errorMessage(error).toLowerCase().includes("already attached")) throw error;
  }

  attachedTabIds.add(tabId);
}

function requestTabId(request) {
  if (!Number.isInteger(request.tabId)) throw new Error("tabId must be an integer");
  return request.tabId;
}

function tabResult(tab) {
  if (!Number.isInteger(tab.id)) throw new Error("Chrome returned a tab without an id");

  return {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.pendingUrl ?? tab.url ?? "",
    title: tab.title ?? "",
    active: Boolean(tab.active),
    attached: attachedTabIds.has(tab.id),
  };
}

function broadcast(frame) {
  for (const connection of connections.values()) {
    if (connection.socket) sendFrame(connection.socket, frame);
  }
}

function sendFrame(socket, frame) {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(frame));
  } catch {
    socket.close();
  }
}

function errorMessage(error) {
  return String((error && error.message) || error);
}
