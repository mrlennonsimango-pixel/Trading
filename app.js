const marketSelect = document.getElementById("market");
const timeframeSelect = document.getElementById("timeframe");
const loadButton = document.getElementById("loadButton");
const statusText = document.getElementById("statusText");
const statusDot = document.getElementById("statusDot");
const selectedMarket = document.getElementById("selectedMarket");
const selectedTimeframe = document.getElementById("selectedTimeframe");
const candleCount = document.getElementById("candleCount");
const chartTitle = document.getElementById("chartTitle");
const dataStatus = document.getElementById("dataStatus");
const chartArea = document.getElementById("chartArea");

let markets = [];
let timeframes = [];
let chart = null;
let candleSeries = null;
let resizeObserver = null;

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
  if (chart) {
    chart.remove();
    chart = null;
    candleSeries = null;
  }

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
    rightPriceScale: {
      borderColor: "#303944"
    },
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

  resizeObserver = new ResizeObserver(() => {
    if (!chart) return;
    chart.applyOptions({
      width: chartArea.clientWidth,
      height: Math.max(chartArea.clientHeight, 470)
    });
  });

  resizeObserver.observe(chartArea);
}

function renderCandles(candles) {
  if (!candleSeries) createChart();

  const data = candles
    .map(candle => ({
      time: Number(candle.timestamp),
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

  candleSeries.setData(data);
  chart.timeScale().fitContent();
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

  try {
    const response = await fetch(
      `/api/history?symbol=${encodeURIComponent(market.symbol)}&timeframe=${timeframe.value}&count=500`
    );
    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Market data request failed");
    }

    renderCandles(data.candles || []);
    candleCount.textContent = data.count;
    dataStatus.textContent = `Loaded ${data.count} candles.`;
    setStatus("Connected", true);
  } catch (error) {
    candleCount.textContent = "—";
    dataStatus.textContent = error.message;
    setStatus("Data error", false);
  } finally {
    loadButton.disabled = false;
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
timeframeSelect.addEventListener("change", loadMarketData);
loadButton.addEventListener("click", loadMarketData);

initialise();
