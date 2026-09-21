const DERIV_WS = "wss://ws.derivws.com/websockets/v3?app_id=1089";

const MARKETS = [
  { symbol: "frxEURUSD", name: "EUR/USD", category: "Forex" },
  { symbol: "frxXAUUSD", name: "Gold/USD", category: "Commodities" },
  { symbol: "1HZ50V", name: "Volatility 50", category: "Synthetic" },
  { symbol: "1HZ75V", name: "Volatility 75", category: "Synthetic" },
  { symbol: "BOOM1000", name: "Boom 1000 Index", category: "Synthetic" }
];

const TIMEFRAMES = [
  { value: 60, label: "1M" },
  { value: 300, label: "5M" },
  { value: 900, label: "15M" },
  { value: 3600, label: "1H" },
  { value: 14400, label: "4H" },
  { value: 86400, label: "1D" }
];

const ALLOWED_SYMBOLS = new Set(MARKETS.map(market => market.symbol));
const ALLOWED_TIMEFRAMES = new Set(TIMEFRAMES.map(timeframe => timeframe.value));

function json(data, status = 200) {
  return Response.json(data, { status });
}

function wsRequest(symbol, granularity, count) {
  return JSON.stringify({
    ticks_history: symbol,
    style: "candles",
    granularity,
    count,
    end: "latest"
  });
}

async function getActiveSymbols() {
  const socket = new WebSocket(DERIV_WS);

  return await new Promise((resolve, reject) => {
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch {}
      fn(value);
    };

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        active_symbols: "brief",
        product_type: "basic"
      }));
    });

    socket.addEventListener("message", event => {
      try {
        const message = JSON.parse(event.data);

        if (message.error) {
          return finish(reject, new Error(message.error.message));
        }

        if (message.active_symbols) {
          return finish(resolve, message.active_symbols);
        }
      } catch (error) {
        finish(reject, error);
      }
    });

    socket.addEventListener("error", () => {
      finish(reject, new Error("Deriv WebSocket connection failed"));
    });
  });
}

async function saveSingleCandle(env, symbol, timeframe, candle) {
  if (!env.DB) return;

  await env.DB.prepare(
    `INSERT OR REPLACE INTO candles
     (symbol, timeframe, timestamp, open, high, low, close)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    symbol,
    timeframe,
    Number(candle.time),
    Number(candle.open),
    Number(candle.high),
    Number(candle.low),
    Number(candle.close)
  ).run();
}

async function handleLiveCandle(request, env) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol");
  const timeframe = Number(url.searchParams.get("timeframe"));

  const validationError = validateMarketAndTimeframe(symbol, timeframe);
  if (validationError) {
    return json({ ok: false, error: validationError }, 400);
  }

  if (!env.DB) {
    return json({ ok: false, error: "D1 binding DB is not configured" }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const candle = {
    time: Number(body.time),
    open: Number(body.open),
    high: Number(body.high),
    low: Number(body.low),
    close: Number(body.close)
  };

  if (
    !Number.isFinite(candle.time) ||
    !Number.isFinite(candle.open) ||
    !Number.isFinite(candle.high) ||
    !Number.isFinite(candle.low) ||
    !Number.isFinite(candle.close)
  ) {
    return json({ ok: false, error: "Invalid candle data" }, 400);
  }

  await saveSingleCandle(env, symbol, timeframe, candle);

  return json({
    ok: true,
    symbol,
    timeframe,
    timestamp: candle.time
  });
}

async function handleStream(request, env) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol");
  const timeframe = Number(url.searchParams.get("timeframe"));

  const validationError = validateMarketAndTimeframe(symbol, timeframe);
  if (validationError) {
    return json({ ok: false, error: validationError }, 400);
  }

  // This endpoint is intentionally HTTP-based. Cloudflare Workers cannot
  // keep a normal fetch handler alive forever, so the browser owns the
  // persistent Deriv WebSocket subscription for live ticks.
  return json({
    ok: true,
    symbol,
    timeframe,
    websocket: DERIV_WS,
    message: "Use the public Deriv WebSocket for the live tick stream."
  });
}

async function getHistoricalCandles(symbol, granularity, count, end = "latest") {
  const socket = new WebSocket(DERIV_WS);

  return await new Promise((resolve, reject) => {
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch {}
      fn(value);
    };

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        ticks_history: symbol,
        style: "candles",
        granularity,
        count,
        end
      }));
    });

    socket.addEventListener("message", event => {
      try {
        const message = JSON.parse(event.data);

        if (message.error) {
          return finish(reject, new Error(message.error.message));
        }

        if (message.candles) {
          return finish(resolve, message.candles);
        }
      } catch (error) {
        finish(reject, error);
      }
    });

    socket.addEventListener("error", () => {
      finish(reject, new Error("Deriv WebSocket connection failed"));
    });
  });
}

function validateMarketAndTimeframe(symbol, timeframe) {
  if (!ALLOWED_SYMBOLS.has(symbol)) {
    return "Unsupported market";
  }

  if (!ALLOWED_TIMEFRAMES.has(timeframe)) {
    return "Unsupported timeframe";
  }

  return null;
}

async function saveCandles(env, symbol, timeframe, candles) {
  const statements = candles.map(candle =>
    env.DB.prepare(
      `INSERT OR REPLACE INTO candles
       (symbol, timeframe, timestamp, open, high, low, close)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      symbol,
      timeframe,
      Number(candle.epoch),
      Number(candle.open),
      Number(candle.high),
      Number(candle.low),
      Number(candle.close)
    )
  );

  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }
}

async function handleMarkets() {
  return json({
    ok: true,
    markets: MARKETS,
    timeframes: TIMEFRAMES
  });
}

async function handleHistory(request, env) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol");
  const timeframe = Number(url.searchParams.get("timeframe"));
  const count = Math.min(
    Math.max(Number(url.searchParams.get("count") || 500), 1),
    5000
  );
  const endParam = url.searchParams.get("end") || "latest";
  const end = endParam === "latest" ? "latest" : Number(endParam);

  if (end !== "latest" && (!Number.isFinite(end) || end <= 0)) {
    return json({ ok: false, error: "Invalid end timestamp" }, 400);
  }

  const validationError = validateMarketAndTimeframe(symbol, timeframe);
  if (validationError) {
    return json({ ok: false, error: validationError }, 400);
  }

  if (!env.DB) {
    return json({ ok: false, error: "D1 binding DB is not configured" }, 503);
  }

  const candles = await getHistoricalCandles(symbol, timeframe, count, end);
  await saveCandles(env, symbol, timeframe, candles);

  return json({
    ok: true,
    symbol,
    timeframe,
    count: candles.length,
    candles
  });
}

async function handleCandles(request, env) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol");
  const timeframe = Number(url.searchParams.get("timeframe"));
  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit") || 500), 1),
    5000
  );

  const validationError = validateMarketAndTimeframe(symbol, timeframe);
  if (validationError) {
    return json({ ok: false, error: validationError }, 400);
  }

  if (!env.DB) {
    return json({ ok: false, error: "D1 binding DB is not configured" }, 503);
  }

  const result = await env.DB.prepare(
    `SELECT symbol, timeframe, timestamp, open, high, low, close
     FROM candles
     WHERE symbol = ? AND timeframe = ?
     ORDER BY timestamp DESC
     LIMIT ?`
  ).bind(symbol, timeframe, limit).all();

  return json({
    ok: true,
    symbol,
    timeframe,
    candles: (result.results || []).reverse()
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/health") {
        return json({
          ok: true,
          service: "trading-worker",
          timestamp: new Date().toISOString(),
          database: !!env.DB
        });
      }

      if (url.pathname === "/markets" && request.method === "GET") {
        return await handleMarkets();
      }

      if (url.pathname === "/history" && request.method === "GET") {
        return await handleHistory(request, env);
      }

      if (url.pathname === "/candles" && request.method === "GET") {
        return await handleCandles(request, env);
      }

      if (url.pathname === "/live-candle" && request.method === "POST") {
        return await handleLiveCandle(request, env);
      }

      return json({
        ok: true,
        service: "trading-worker",
        endpoints: ["/health", "/markets", "/history", "/candles", "/live-candle"]
      });
    } catch (error) {
      return json({
        ok: false,
        error: error.message || "Internal error"
      }, 500);
    }
  }
};
