const DERIV_WS = "wss://ws.derivws.com/websockets/v3?app_id=1089";

const ALLOWED_SYMBOLS = new Set([
  "1HZ10V","1HZ15V","1HZ25V","1HZ30V","1HZ50V",
  "1HZ75V","1HZ90V","1HZ100V"
]);

function json(data, status = 200) {
  return Response.json(data, { status });
}

function wsRequest(symbol, granularity, count = 500) {
  return JSON.stringify({
    ticks_history: symbol,
    style: "candles",
    granularity,
    count,
    end: "latest"
  });
}

async function getHistoricalCandles(symbol, granularity, count) {
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
      socket.send(wsRequest(symbol, granularity, count));
    });

    socket.addEventListener("message", event => {
      try {
        const message = JSON.parse(event.data);
        if (message.error) return finish(reject, new Error(message.error.message));
        if (message.candles) return finish(resolve, message.candles);
      } catch (error) {
        finish(reject, error);
      }
    });

    socket.addEventListener("error", () => {
      finish(reject, new Error("Deriv WebSocket connection failed"));
    });
  });
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

async function handleHistory(request, env) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol") || "1HZ50V";
  const timeframe = Number(url.searchParams.get("timeframe") || 60);
  const count = Math.min(Number(url.searchParams.get("count") || 500), 5000);

  if (!ALLOWED_SYMBOLS.has(symbol)) {
    return json({ ok: false, error: "Unsupported volatility symbol" }, 400);
  }

  const allowedTimeframes = new Set([60, 300, 900, 3600, 14400, 86400]);
  if (!allowedTimeframes.has(timeframe)) {
    return json({ ok: false, error: "Unsupported timeframe" }, 400);
  }

  const candles = await getHistoricalCandles(symbol, timeframe, count);
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
  const symbol = url.searchParams.get("symbol") || "1HZ50V";
  const timeframe = Number(url.searchParams.get("timeframe") || 60);
  const limit = Math.min(Number(url.searchParams.get("limit") || 500), 5000);

  if (!ALLOWED_SYMBOLS.has(symbol)) {
    return json({ ok: false, error: "Unsupported volatility symbol" }, 400);
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

      if (url.pathname === "/history" && request.method === "GET") {
        return await handleHistory(request, env);
      }

      if (url.pathname === "/candles" && request.method === "GET") {
        return await handleCandles(request, env);
      }

      return json({
        ok: true,
        service: "trading-worker",
        endpoints: ["/health", "/history", "/candles"]
      });
    } catch (error) {
      return json({
        ok: false,
        error: error.message || "Internal error"
      }, 500);
    }
  }
};
