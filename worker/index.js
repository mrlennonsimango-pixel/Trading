const DERIV_WS = "wss://ws.binaryws.com/websockets/v3";

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

async function connectDerivWebSocket() {
  const response = await fetch(DERIV_WS.replace("wss://", "https://"), {
    headers: { Upgrade: "websocket" }
  });

  if (!response.webSocket) {
    throw new Error("Deriv WebSocket handshake was not accepted");
  }

  response.webSocket.accept();
  return response.webSocket;
}

async function getActiveSymbols() {
  const socket = await connectDerivWebSocket();

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
      finish(reject, new Error("Deriv WebSocket connection failed while requesting market data"));
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

function sma(values, length, index) {
  if (index + 1 < length) return null;
  let sum = 0;
  for (let i = index - length + 1; i <= index; i++) sum += values[i];
  return sum / length;
}

function rsi(closes, length, index) {
  if (index < length) return null;
  let gains = 0;
  let losses = 0;
  for (let i = index - length + 1; i <= index; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return 100;
  const rs = (gains / length) / (losses / length);
  return 100 - (100 / (1 + rs));
}

function runBacktest(candles, settings) {
  const fastLength = settings.fastLength;
  const slowLength = settings.slowLength;
  const rsiLength = settings.rsiLength;
  const rsiLong = settings.rsiLong;
  const rsiShort = settings.rsiShort;
  const atrLength = settings.atrLength;
  const atrMultiplier = settings.atrMultiplier;
  const rr = settings.rr;
  const initialCapital = settings.initialCapital;

  const closes = candles.map(c => c.close);
  const trades = [];
  let equity = initialCapital;
  let position = null;

  const trueRanges = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    return Math.max(
      c.high - c.low,
      Math.abs(c.high - candles[i - 1].close),
      Math.abs(c.low - candles[i - 1].close)
    );
  });

  for (let i = 1; i < candles.length; i++) {
    const fast = sma(closes, fastLength, i);
    const slow = sma(closes, slowLength, i);
    const prevFast = sma(closes, fastLength, i - 1);
    const prevSlow = sma(closes, slowLength, i - 1);
    const currentRsi = rsi(closes, rsiLength, i);

    if (fast == null || slow == null || prevFast == null || prevSlow == null || currentRsi == null) continue;

    let atr = null;
    if (i + 1 >= atrLength) {
      let sum = 0;
      for (let j = i - atrLength + 1; j <= i; j++) sum += trueRanges[j];
      atr = sum / atrLength;
    }
    if (atr == null) continue;

    if (position) {
      const hitStop = position.side === "long"
        ? candles[i].low <= position.sl
        : candles[i].high >= position.sl;
      const hitTarget = position.side === "long"
        ? candles[i].high >= position.tp
        : candles[i].low <= position.tp;

      // Conservative same-candle handling: if both levels are touched,
      // count the stop first because candle order is unknown.
      if (hitStop || hitTarget) {
        const exitPrice = hitStop ? position.sl : position.tp;
        const pnl = position.side === "long"
          ? exitPrice - position.entry
          : position.entry - exitPrice;

        equity += pnl;
        trades.push({
          entryTime: position.entryTime,
          exitTime: candles[i].timestamp,
          side: position.side,
          entry: position.entry,
          sl: position.sl,
          tp: position.tp,
          exit: exitPrice,
          pnl,
          result: pnl >= 0 ? "win" : "loss"
        });
        position = null;
      }
    }

    if (!position) {
      const bullishCross = prevFast <= prevSlow && fast > slow;
      const bearishCross = prevFast >= prevSlow && fast < slow;

      if (bullishCross && currentRsi >= rsiLong) {
        const entry = candles[i].close;
        const risk = atr * atrMultiplier;
        position = {
          side: "long",
          entry,
          sl: entry - risk,
          tp: entry + risk * rr,
          entryTime: candles[i].timestamp
        };
      } else if (bearishCross && currentRsi <= rsiShort) {
        const entry = candles[i].close;
        const risk = atr * atrMultiplier;
        position = {
          side: "short",
          entry,
          sl: entry + risk,
          tp: entry - risk * rr,
          entryTime: candles[i].timestamp
        };
      }
    }
  }

  const wins = trades.filter(t => t.result === "win").length;
  const losses = trades.filter(t => t.result === "loss").length;
  const netPnl = equity - initialCapital;
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;

  return {
    initialCapital,
    finalEquity: equity,
    netPnl,
    trades: trades.length,
    wins,
    losses,
    winRate,
    openPosition: position
  };
}

async function handleBacktest(request, env) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol");
  const timeframe = Number(url.searchParams.get("timeframe"));
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 5000), 100), 5000);

  const validationError = validateMarketAndTimeframe(symbol, timeframe);
  if (validationError) return json({ ok: false, error: validationError }, 400);

  if (!env.DB) return json({ ok: false, error: "D1 binding DB is not configured" }, 503);

  const fastLength = Math.min(Math.max(Number(url.searchParams.get("fast") || 20), 2), 200);
  const slowLength = Math.min(Math.max(Number(url.searchParams.get("slow") || 50), fastLength + 1), 500);
  const rsiLength = Math.min(Math.max(Number(url.searchParams.get("rsiLength") || 14), 2), 100);
  const rsiLong = Math.min(Math.max(Number(url.searchParams.get("rsiLong") || 50), 1), 99);
  const rsiShort = Math.min(Math.max(Number(url.searchParams.get("rsiShort") || 50), 1), 99);
  const atrLength = Math.min(Math.max(Number(url.searchParams.get("atrLength") || 14), 2), 100);
  const atrMultiplier = Math.min(Math.max(Number(url.searchParams.get("atrMultiplier") || 1), 0.1), 10);
  const rr = Math.min(Math.max(Number(url.searchParams.get("rr") || 3), 0.1), 20);
  const initialCapital = Math.max(Number(url.searchParams.get("initialCapital") || 1000), 1);

  const result = await env.DB.prepare(
    `SELECT timestamp, open, high, low, close
     FROM candles
     WHERE symbol = ? AND timeframe = ?
     ORDER BY timestamp ASC
     LIMIT ?`
  ).bind(symbol, timeframe, limit).all();

  const candles = (result.results || []).map(c => ({
    timestamp: Number(c.timestamp),
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close)
  }));

  if (candles.length < slowLength + 2) {
    return json({
      ok: false,
      error: `Not enough candles. Need at least ${slowLength + 2}, have ${candles.length}.`
    }, 400);
  }

  const backtest = runBacktest(candles, {
    fastLength,
    slowLength,
    rsiLength,
    rsiLong,
    rsiShort,
    atrLength,
    atrMultiplier,
    rr,
    initialCapital
  });

  return json({
    ok: true,
    symbol,
    timeframe,
    candlesTested: candles.length,
    settings: {
      fastLength,
      slowLength,
      rsiLength,
      rsiLong,
      rsiShort,
      atrLength,
      atrMultiplier,
      rr,
      initialCapital
    },
    result: backtest
  });
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
  const socket = await connectDerivWebSocket();

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

      if (url.pathname === "/backtest" && request.method === "GET") {
        return await handleBacktest(request, env);
      }

      return json({
        ok: true,
        service: "trading-worker",
        endpoints: ["/health", "/markets", "/history", "/candles", "/live-candle", "/backtest"]
      });
    } catch (error) {
      return json({
        ok: false,
        error: error.message || "Internal error"
      }, 500);
    }
  }
};
