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

let markets = [];
let timeframes = [];

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
  return timeframes.find(timeframe => Number(timeframe.value) === Number(timeframeSelect.value));
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

    candleCount.textContent = data.count;
    dataStatus.textContent = `Loaded ${data.count} candles from Deriv and saved to D1.`;
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
