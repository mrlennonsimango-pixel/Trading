const marketSelect = document.getElementById("market");
const timeframeSelect = document.getElementById("timeframe");
const loadButton = document.getElementById("loadButton");
const loadOlderButton = document.getElementById("loadOlderButton");
const statusText = document.getElementById("statusText");
const statusDot = document.getElementById("statusDot");
const selectedMarket = document.getElementById("selectedMarket");
const selectedTimeframe = document.getElementById("selectedTimeframe");
const candleCount = document.getElementById("candleCount");
const chartTitle = document.getElementById("chartTitle");
const dataStatus = document.getElementById("dataStatus");
const chartArea = document.getElementById("chartArea");
const backtestButton = document.getElementById("backtestButton");
const backtestStatus = document.getElementById("backtestStatus");
const fastLengthInput = document.getElementById("fastLength");
const slowLengthInput = document.getElementById("slowLength");
const rsiLengthInput = document.getElementById("rsiLength");
const rrInput = document.getElementById("rr");
const btTrades = document.getElementById("btTrades");
const btWinRate = document.getElementById("btWinRate");
const btPnl = document.getElementById("btPnl");
const btEquity = document.getElementById("btEquity");

let markets = [];
let timeframes = [];
let chart = null;
let candleSeries = null;
let resizeObserver = null;
let candles = [];
let loadingOlder = false;
let liveSocket = null;
let liveCandle = null;
let liveTimeframeSeconds = 60;
let livePollTimer = null;
let lastPersistedCandleTime = null;
let persistTimer = null;

const INITIAL_CANDLES = 500;
const OLDER_CANDLES = 500;

function setStatus(text, online = true) {
  statusText.textContent = text;
  statusDot.classList.toggle("offline", !online);
}

function populateMarkets() {
  marketSelect.innerHTML = "";
  for (const market of markets) {
    const option = document.createElement("option");
    option.value = market.symbol;
    option.textContent = market.name;
    marketSelect.appendChild(option);
  }
}

function populateTimeframes() {
  timeframeSelect.innerHTML = "";
  for (const timeframe of timeframes) {
    const option = document.createElement("option");
    option.value = timeframe.value;
    option.textContent = timeframe.label;
    timeframeSelect.appendChild(option);
  }
}

function selectedMarketObject() {
  return markets.find(market => market.symbol === marketSelect.value);
}

function selectedTimeframeObject() {
  return timeframes.find(
    timeframe => Number(timeframe.value) === Number(timeframeSelect.value)
  );
}

function createChart() {
  if (chart) chart.remove();

  chart = LightweightCharts.createChart(chartArea, {
    width: chartArea.clientWidth,
    height: Math.max(chartArea.clientHeight, 470),
    layout: {
      background: { type: "solid", color: "#10161d" },
      textColor: "#9ba7b4"
    },
    grid: {
      vertLines: { color: "#1b232c" },
      horzLines: { color: "#1b232c" }
    },
    rightPriceScale: { borderColor: "#303944" },
    timeScale: {
      borderColor: "#303944",
      timeVisible: true,
      secondsVisible: false
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal
    }
  });

  candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: "#22b573",
    downColor: "#e05252",
    borderVisible: false,
    wickUpColor: "#22b573",
    wickDownColor: "#e05252"
  });

  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => {
    if (!chart) return;
    chart.applyOptions({
      width: chartArea.clientWidth,
      height: Math.max(chartArea.clientHeight, 470)
    });
  });
  resizeObserver.observe(chartArea);

  chart.timeScale().subscribeVisibleLogicalRangeChange(range => {
    if (!range || range.from > 25 || loadingOlder || candles.length === 0) return;
    loadOlderHistory();
  });
}

function stopLiveStream() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (liveSocket) {
    try { liveSocket.close(); } catch {}
    liveSocket = null;
  }
  if (livePollTimer) {
    clearInterval(livePollTimer);
    livePollTimer = null;
  }
  liveCandle = null;
  lastPersistedCandleTime = null;
}

function persistLiveCandle() {
  if (!liveCandle) return;
  const market = selectedMarketObject();
  const timeframe = selectedTimeframeObject();
  if (!market || !timeframe) return;
  const candle = { ...liveCandle };
  fetch(`/api/live-candle?symbol=${encodeURIComponent(market.symbol)}&timeframe=${timeframe.value}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(candle), keepalive: true
  }).catch(() => {});
  lastPersistedCandleTime = candle.time;
}

function scheduleLivePersistence() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistLiveCandle();
    if (liveCandle) scheduleLivePersistence();
  }, 10000);
}

function subscribeLiveTicks(symbol, timeframeSeconds) {
  stopLiveStream();
  liveTimeframeSeconds = Number(timeframeSeconds);
  const poll = async () => {
    try {
      const response = await fetch(`/api/live-tick?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) return;
      updateLiveCandle(Number(data.epoch), Number(data.quote));
      dataStatus.textContent = "Live market data connected through bridge.";
      setStatus("Live", true);
    } catch {}
  };
  poll();
  livePollTimer = setInterval(poll, 2000);
}

function updateLiveCandle(epoch, price) {
  if (!Number.isFinite(epoch) || !Number.isFinite(price) || !candleSeries) return;
  const bucket = Math.floor(epoch / liveTimeframeSeconds) * liveTimeframeSeconds;
  if (!liveCandle || liveCandle.time !== bucket) {
    if (liveCandle) persistLiveCandle();
    liveCandle = { time: bucket, open: price, high: price, low: price, close: price };
    candles.push(liveCandle);
  } else {
    liveCandle.high = Math.max(liveCandle.high, price);
    liveCandle.low = Math.min(liveCandle.low, price);
    liveCandle.close = price;
  }
  candleSeries.update({ time: liveCandle.time, open: liveCandle.open, high: liveCandle.high, low: liveCandle.low, close: liveCandle.close });
  scheduleLivePersistence();
  candleCount.textContent = candles.length;
}
function normaliseCandles(rawCandles) {
  return rawCandles
    .map(candle => ({
      time: Number(candle.timestamp ?? candle.epoch),
      timestamp: Number(candle.timestamp ?? candle.epoch),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close)
    }))
    .filter(candle =>
      Number.isFinite(candle.time) &&
      Number.isFinite(candle.open) &&
      Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) &&
      Number.isFinite(candle.close)
    )
    .sort((a, b) => a.time - b.time);
}

function renderCandles(preservePosition = false, oldRange = null) {
  if (!candleSeries) createChart();

  candleSeries.setData(candles.map(candle => ({
    time: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close
  })));

  if (preservePosition && oldRange) {
    chart.timeScale().setVisibleLogicalRange({
      from: oldRange.from + (candles.length - oldRange.previousLength),
      to: oldRange.to + (candles.length - oldRange.previousLength)
    });
  } else {
    chart.timeScale().fitContent();
  }
}

async function requestHistory(end, count) {
  const market = selectedMarketObject();
  const timeframe = selectedTimeframeObject();

  if (!market || !timeframe) throw new Error("Market or timeframe not selected");

  const params = new URLSearchParams({
    symbol: market.symbol,
    timeframe: String(timeframe.value),
    count: String(count),
    end: end === "latest" ? "latest" : String(end)
  });

  const response = await fetch(`/api/history?${params.toString()}`);
  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error("Trading API returned an invalid response");
  }

  if (!response.ok || !data.ok) {
    throw new Error(data.error || "Could not load historical market data");
  }

  const result = normaliseCandles(data.candles || []);

  if (result.length === 0) {
    throw new Error("No historical candles were returned");
  }

  return result;
}

async function runBacktest() {
  const market = selectedMarketObject();
  const timeframe = selectedTimeframeObject();
  if (!market || !timeframe) return;

  backtestButton.disabled = true;
  backtestStatus.textContent = "Running backtest across D1 history...";

  try {
    const params = new URLSearchParams({
      symbol: market.symbol,
      timeframe: timeframe.value,
      limit: "5000",
      fast: fastLengthInput.value,
      slow: slowLengthInput.value,
      rsiLength: rsiLengthInput.value,
      rr: rrInput.value
    });

    const response = await fetch(`/api/backtest?${params}`);
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Backtest failed");

    const result = data.result;
    btTrades.textContent = result.trades;
    btWinRate.textContent = `${result.winRate.toFixed(2)}%`;
    btPnl.textContent = result.netPnl.toFixed(2);
    btEquity.textContent = result.finalEquity.toFixed(2);
    backtestStatus.textContent = `Tested ${data.candlesTested} candles using ${market.name} · ${timeframe.label}.`;
  } catch (error) {
    backtestStatus.textContent = error.message;
  } finally {
    backtestButton.disabled = false;
  }
}

async function loadMarketData() {
  const market = selectedMarketObject();
  const timeframe = selectedTimeframeObject();
  if (!market || !timeframe) return;

  selectedMarket.textContent = market.name;
  selectedTimeframe.textContent = timeframe.label;
  chartTitle.textContent = `${market.name} · ${timeframe.label}`;
  dataStatus.textContent = "Loading historical data...";
  loadButton.disabled = true;
  loadOlderButton.disabled = true;

  try {
    candles = await requestHistory("latest", INITIAL_CANDLES);
    renderCandles();
    candleCount.textContent = candles.length;
    dataStatus.textContent = `Loaded ${candles.length} candles. Live stream starting...`;
    setStatus("Connected", true);
    subscribeLiveTicks(market.symbol, timeframe.value);
    persistLiveCandle();
  } catch (error) {
    candles = [];
    candleCount.textContent = "—";
    dataStatus.textContent = error.message;
    setStatus("Data error", false);
  } finally {
    loadButton.disabled = false;
    loadOlderButton.disabled = false;
  }
}

async function loadOlderHistory() {
  if (loadingOlder || candles.length === 0) return;

  const market = selectedMarketObject();
  const timeframe = selectedTimeframeObject();
  if (!market || !timeframe) return;

  loadingOlder = true;
  loadOlderButton.disabled = true;
  dataStatus.textContent = "Loading older history...";

  const oldest = candles[0].timestamp;
  const previousLength = candles.length;
  const range = chart.timeScale().getVisibleLogicalRange();

  try {
    const older = await requestHistory(oldest - 1, OLDER_CANDLES);

    if (older.length === 0) {
      dataStatus.textContent = "No older candles are available.";
      return;
    }

    const merged = new Map(candles.map(candle => [candle.timestamp, candle]));
    for (const candle of older) merged.set(candle.timestamp, candle);

    candles = Array.from(merged.values()).sort((a, b) => a.timestamp - b.timestamp);
    renderCandles(true, {
      from: range?.from ?? 0,
      to: range?.to ?? previousLength,
      previousLength
    });

    candleCount.textContent = candles.length;
    dataStatus.textContent = `Loaded ${older.length} older candles · ${candles.length} total.`;
  } catch (error) {
    dataStatus.textContent = error.message;
  } finally {
    loadingOlder = false;
    loadOlderButton.disabled = false;
  }
}

async function initialise() {
  try {
    const response = await fetch("/api/markets");
    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Could not load markets");
    }

    markets = data.markets;
    timeframes = data.timeframes;

    populateMarkets();
    populateTimeframes();
    createChart();

    setStatus("Connected", true);
    await loadMarketData();
  } catch (error) {
    setStatus("Offline", false);
    dataStatus.textContent = error.message;
  }
}

marketSelect.addEventListener("change", loadMarketData);
timeframeSelect.addEventListener("change", () => {
  stopLiveStream();
  loadMarketData();
});
loadButton.addEventListener("click", loadMarketData);
backtestButton.addEventListener("click", runBacktest);
loadOlderButton.addEventListener("click", loadOlderHistory);

initialise();
