import express from "express";
import { WebSocket } from "ws";

const app = express();
const PORT = Number(process.env.PORT || 10000);
const DERIV_WS_URLS = [
  "wss://api.derivws.com/trading/v1/options/ws/public",
  "wss://ws.binaryws.com/websockets/v3"
];
let derivEndpointIndex = 0;

const ALLOWED_SYMBOLS = new Set([
  "frxEURUSD",
  "frxXAUUSD",
  "1HZ50V",
  "1HZ75V",
  "BOOM1000"
]);
const ALLOWED_GRANULARITIES = new Set([60, 300, 900, 3600, 14400, 86400]);

let derivSocket = null;
let derivState = "disconnected";
let lastMessageAt = null;
let lastError = null;
let lastClose = null;
let reconnectTimer = null;
let connectTimeout = null;

const pending = new Map();

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectDeriv();
  }, 3000);
}

function connectDeriv() {
  if (derivSocket && (derivSocket.readyState === WebSocket.OPEN ||
      derivSocket.readyState === WebSocket.CONNECTING)) return;

  derivState = "connecting";
  lastError = null;
  lastClose = null;

  const endpoint = DERIV_WS_URLS[derivEndpointIndex];\n  console.log("Connecting to Deriv endpoint:", endpoint);\n  const socket = new WebSocket(endpoint);
  derivSocket = socket;

  connectTimeout = setTimeout(() => {
    if (socket.readyState === WebSocket.CONNECTING) {
      lastError = {
        name: "ConnectionTimeout",
        message: "Deriv WebSocket did not complete its handshake within 10 seconds"
      };
      derivState = "timeout";\n      lastError = {\n        name: "ConnectionTimeout",\n        message: `Deriv WebSocket timeout: ${endpoint}`\n      };
      console.error("Deriv WebSocket connection timeout:", endpoint);
      socket.terminate();
    }
  }, 10000);

  socket.on("open", () => {
    clearTimeout(connectTimeout);
    connectTimeout = null;
    derivState = "connected";
    lastMessageAt = new Date().toISOString();
    lastError = null;
    lastClose = null;
    console.log("Connected to Deriv WebSocket");
  });

  socket.on("message", routeDerivMessage);

  socket.on("error", (error) => {
    clearTimeout(connectTimeout);
    connectTimeout = null;
    derivState = "error";
    lastError = {
      name: error?.name || "Error",
      message: error?.message || String(error)
    };
    console.error("Deriv WebSocket error:", lastError);
  });

  socket.on("close", (code, reason) => {
    clearTimeout(connectTimeout);
    connectTimeout = null;
    derivState = "disconnected";
    lastClose = {
      code,
      reason: reason?.toString() || ""
    };
    if (derivSocket === socket) derivSocket = null;
    console.error("Deriv WebSocket closed:", lastClose);
    scheduleReconnect();
  });
}

function routeDerivMessage(raw) {
  lastMessageAt = new Date().toISOString();

  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch (error) {
    lastError = {
      name: error?.name || "ParseError",
      message: "Invalid JSON from Deriv"
    };
    return;
  }

  const reqId = message.req_id;
  if (!reqId || !pending.has(reqId)) return;

  const item = pending.get(reqId);
  pending.delete(reqId);
  clearTimeout(item.timeout);

  if (message.error) {
    return item.res.status(502).json({
      ok: false,
      error: message.error.message || "Deriv API error",
      code: message.error.code || null
    });
  }

  item.res.json({
    ok: true,
    symbol: message.echo_req?.ticks_history,
    granularity: message.echo_req?.granularity,
    candles: Array.isArray(message.candles) ? message.candles : []
  });
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "trading-market-bridge",
    deriv: derivState
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "trading-market-bridge",
    deriv: derivState,
    lastMessageAt,
    lastError,
    lastClose
  });
});

app.get("/history", (req, res) => {
  const symbol = String(req.query.symbol || "");
  const granularity = Number(req.query.granularity || 60);
  const count = Math.min(Math.max(Number(req.query.count || 500), 1), 5000);
  const end = req.query.end === "latest" || !req.query.end
    ? "latest"
    : Number(req.query.end);

  if (!ALLOWED_SYMBOLS.has(symbol)) {
    return res.status(400).json({
      ok: false,
      error: "Unsupported symbol"
    });
  }

  if (!ALLOWED_GRANULARITIES.has(granularity)) {
    return res.status(400).json({
      ok: false,
      error: "Unsupported granularity"
    });
  }

  if (!derivSocket || derivSocket.readyState !== WebSocket.OPEN) {
    connectDeriv();
    return res.status(503).json({
      ok: false,
      error: "Deriv connection is not ready",
      deriv: derivState,
      lastError,
      lastClose
    });
  }

  const requestId = Date.now() + Math.floor(Math.random() * 1000);

  const request = {
    ticks_history: symbol,
    style: "candles",
    granularity,
    count,
    end,
    req_id: requestId
  };

  const timeout = setTimeout(() => {
    pending.delete(requestId);

    if (!res.headersSent) {
      res.status(504).json({
        ok: false,
        error: "Deriv history request timed out",
        deriv: derivState,
        lastError,
        lastClose
      });
    }
  }, 15000);

  pending.set(requestId, { res, timeout });

  try {
    derivSocket.send(JSON.stringify(request));
  } catch (error) {
    clearTimeout(timeout);
    pending.delete(requestId);

    lastError = {
      name: error?.name || "SendError",
      message: error?.message || String(error)
    };

    return res.status(502).json({
      ok: false,
      error: "Could not send request to Deriv",
      lastError,
      lastClose
    });
  }
});

connectDeriv();

app.listen(PORT, "0.0.0.0", () => {
  console.log("Trading market bridge listening on port " + PORT);
});
