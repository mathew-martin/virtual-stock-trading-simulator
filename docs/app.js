const holdings = [
  { symbol: "AAPL", shares: 25, avgPrice: 182.15, stopLoss: 170 },
  { symbol: "MSFT", shares: 15, avgPrice: 329.2, stopLoss: 305 },
  { symbol: "AMZN", shares: 10, avgPrice: 134.83, stopLoss: 120 },
  { symbol: "NVDA", shares: 5, avgPrice: 439.73, stopLoss: 400 },
];

const BASE_QUOTES = {
  AAPL: 190.45,
  MSFT: 335.1,
  AMZN: 138.2,
  NVDA: 452.35,
  TSLA: 248.03,
  META: 299.65,
};

const API_BASE = "https://gqc6b15bmb.execute-api.us-east-1.amazonaws.com/dev";

const analytics = {
  labels: ["Mon", "Tue", "Wed", "Thu", "Fri"],
  portfolio: [1.2, 1.8, -0.5, 0.9, 2.1],
  benchmark: [0.8, 1.1, -0.2, 0.4, 0.9],
};

const insights = [
  "You tend to concentrate risk in a few large positions — consider diversifying position sizes.",
  "Your simulated stop-losses often sit far from recent volatility — experiment with tighter levels.",
  "You’ve been more active on high-volatility days; tracking win-rate on these days may be useful.",
  "Scaling into positions over multiple fills has reduced drawdowns in several trades.",
];

const state = {
  user: { loggedIn: false, email: "" },
  cash: 12850.0,
  holdings,
  watchlist: ["AAPL", "MSFT", "AMZN", "NVDA", "TSLA", "META"],
  intervalId: null,
  initialized: false,
};

const stockCache = new Map();
const newsCache = { items: [], timestamp: 0 };
const latestQuotes = {};
const CACHE_TTL = 45_000;

const selectors = {
  holdingsBody: document.querySelector("[data-holdings]"),
  watchList: document.querySelector("[data-watchlist]"),
  balance: document.querySelector("[data-balance]"),
  portfolio: document.querySelector("[data-portfolio]"),
  pl: document.querySelector("[data-pl]"),
  signals: document.querySelector("[data-signals]"),
  newsGrid: document.querySelector("[data-news]"),
  authStatus: document.querySelector("[data-auth-status]"),
  orderStatus: document.querySelector("[data-order-status]"),
  feedbackStatus: document.querySelector("[data-feedback-status]"),
  insightList: document.querySelector("[data-insights]"),
  newsButton: document.querySelector("[data-refresh-news]"),
  chart: document.getElementById("performanceChart"),
  authView: document.querySelector('[data-view="auth"]'),
  appView: document.querySelector('[data-view="app"]'),
  userEmail: document.querySelector("[data-user-email]"),
  navButtons: document.querySelectorAll(".nav-link"),
  pages: document.querySelectorAll(".page"),
  signalsCount: document.querySelector("[data-signals]"),
};

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function formatCurrency(value) {
  return currencyFormatter.format(value);
}

function mockApi(payloadFn, latency = 600) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(payloadFn()), latency + Math.random() * 400);
  });
}

// ---- LIVE QUOTE FETCH USING YOUR BACKEND ----
async function fetchQuote(symbol) {
  const now = Date.now();
  const cached = stockCache.get(symbol);

  // Use cache if fresh
  if (cached && now - cached.timestamp < CACHE_TTL) {
    return cached.value;
  }

  try {
    const response = await fetch(
      `${API_BASE}/stock/${encodeURIComponent(symbol)}`
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    // Lambda may return { symbol, quote: {...}, cached } or flat object
    const apiQuote = data.quote ?? data;

    if (!apiQuote || typeof apiQuote.price !== "number") {
      throw new Error("Unexpected API response format");
    }

    const previous = cached?.value?.price ?? apiQuote.price;

    const normalized = {
      symbol: apiQuote.symbol || symbol,
      price: apiQuote.price,
      change:
        typeof apiQuote.change === "number"
          ? apiQuote.change
          : +(apiQuote.price - previous).toFixed(2),
      changePct:
        typeof apiQuote.changePct === "number"
          ? apiQuote.changePct
          : +(((apiQuote.price - previous) / previous) * 100).toFixed(2),
    };

    stockCache.set(symbol, { value: normalized, timestamp: now });
    latestQuotes[symbol] = normalized.price;

    return normalized;
  } catch (error) {
    console.error(`Error fetching quote for ${symbol}:`, error);

    // Fallback to static baseline / last known price
    const base = BASE_QUOTES[symbol] ?? 100;
    const previous = cached?.value?.price ?? base;

    const fallback = {
      symbol,
      price: previous,
      change: 0,
      changePct: 0,
    };

    return fallback;
  }
}

async function refreshWatchlist() {
  const quotes = await Promise.all(
    state.watchlist.map(async (symbol) => fetchQuote(symbol))
  );
  renderWatchlist(quotes);
  renderHoldings();
  renderMetrics();
}

function renderWatchlist(quotes) {
  if (!selectors.watchList) return;
  selectors.watchList.innerHTML = quotes
    .map((quote) => {
      const trendClass = quote.change >= 0 ? "trend-up" : "trend-down";
      const changeSymbol = quote.change >= 0 ? "+" : "";
      return `<li class="watch-item">
        <strong>${quote.symbol}</strong>
        <span>${formatCurrency(quote.price)}</span>
        <small class="${trendClass}">
          ${changeSymbol}${quote.change.toFixed(2)} (${changeSymbol}${
        quote.changePct
      }%)
        </small>
      </li>`;
    })
    .join("\n");
}

function renderHoldings() {
  if (!selectors.holdingsBody) return;
  selectors.holdingsBody.innerHTML = state.holdings
    .map((position) => {
      const price =
        latestQuotes[position.symbol] ?? BASE_QUOTES[position.symbol];
      const marketValue = position.shares * price;
      return `<tr>
        <td>${position.symbol}</td>
        <td>${position.shares}</td>
        <td>${formatCurrency(position.avgPrice)}</td>
        <td>${position.stopLoss ? formatCurrency(position.stopLoss) : "—"}</td>
        <td>${formatCurrency(marketValue)}</td>
      </tr>`;
    })
    .join("\n");
}

function renderMetrics() {
  const totalHoldingsValue = state.holdings.reduce((sum, position) => {
    const price =
      latestQuotes[position.symbol] ?? BASE_QUOTES[position.symbol];
    return sum + position.shares * price;
  }, 0);

  if (selectors.balance)
    selectors.balance.textContent = formatCurrency(state.cash);
  if (selectors.portfolio)
    selectors.portfolio.textContent = formatCurrency(
      state.cash + totalHoldingsValue
    );
  if (selectors.pl) selectors.pl.textContent = "+1.24%";
  if (selectors.signals) selectors.signals.textContent = "3 alerts";
}

async function refreshNews(force = false) {
  const now = Date.now();
  const NEWS_TTL = 60_000;

  if (!force && newsCache.items.length && now - newsCache.timestamp < NEWS_TTL) {
    renderNews(newsCache.items);
    return;
  }

  if (!selectors.newsButton || !selectors.newsGrid) {
    return;
  }

  selectors.newsButton.disabled = true;
  selectors.newsButton.textContent = "Refreshing…";

  const articles = await mockApi(
    () => [
      {
        title: "AI accelerators lead semiconductor rally",
        summary:
          "Chipmakers see inflows as hyperscalers expand GPU fleets for experimentation.",
        sentiment: "positive",
        category: "Technology",
        source: "Market desk",
      },
      {
        title: "Consumer discretionary faces volatility",
        summary:
          "Macro data hints at slower retail growth, prompting tighter stop-loss monitoring.",
        sentiment: "negative",
        category: "Macro",
        source: "Strategy team",
      },
      {
        title: "Energy sector stable despite inventory build",
        summary:
          "Analytics reports limited downside risk and maintains hedge coverage.",
        sentiment: "positive",
        category: "Energy",
        source: "Commodities",
      },
    ],
    900
  );

  newsCache.items = articles;
  newsCache.timestamp = now;

  renderNews(articles);
  selectors.newsButton.disabled = false;
  selectors.newsButton.textContent = "Refresh headlines";
}

function renderNews(articles) {
  if (!selectors.newsGrid) return;
  selectors.newsGrid.innerHTML = articles
    .map(
      (article) => `<article class="card card--news">
      <div class="card__body">
        <p class="eyebrow">${article.category} • ${article.source}</p>
        <h3>${article.title}</h3>
        <p>${article.summary}</p>
      </div>
    </article>`
    )
    .join("\n");
}

function renderInsights() {
  if (!selectors.insightList) return;
  selectors.insightList.innerHTML = insights
    .map((point) => `<li>${point}</li>`)
    .join("\n");
}

function drawPerformanceChart() {
  if (!selectors.chart) return;
  const canvas = selectors.chart;
  const ctx = canvas.getContext("2d");
  const { labels, portfolio, benchmark } = analytics;

  const width = canvas.width || 480;
  const height = canvas.height || 240;
  canvas.width = width;
  canvas.height = height;

  ctx.clearRect(0, 0, width, height);

  const allValues = [...portfolio, ...benchmark];
  const min = Math.min(...allValues) - 1;
  const max = Math.max(...allValues) + 1;

  const padding = 32;
  const chartWidth = width - padding * 2;
  const chartHeight = height - padding * 2;
  const stepX = chartWidth / (labels.length - 1);

  function yScale(value) {
    return (
      padding +
      chartHeight -
      ((value - min) / (max - min || 1)) * chartHeight
    );
  }

  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding, padding);
  ctx.lineTo(padding, padding + chartHeight);
  ctx.lineTo(padding + chartWidth, padding + chartHeight);
  ctx.stroke();

  ctx.fillStyle = "#6b7280";
  ctx.font = "12px system-ui";
  labels.forEach((label, i) => {
    const x = padding + i * stepX;
    ctx.fillText(label, x - 8, padding + chartHeight + 16);
  });

  function drawLine(data, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    data.forEach((value, i) => {
      const x = padding + i * stepX;
      const y = yScale(value);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  drawLine(portfolio, "#6366f1");
  drawLine(benchmark, "#9ca3af");
}

function setActiveRoute(route) {
  selectors.navButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.route === route);
  });

  selectors.pages.forEach((page) => {
    page.classList.toggle("hidden", page.dataset.page !== route);
  });

  if (route === "dashboard" || route === "portfolio") {
    refreshWatchlist();
  }

  clearInterval(state.intervalId);
  state.intervalId = setInterval(refreshWatchlist, 30_000);
}

function leaveApp() {
  state.user = { loggedIn: false, email: "" };
  selectors.userEmail.textContent = "trader@example.com";
  selectors.authView.classList.remove("hidden");
  selectors.appView.classList.add("hidden");
  selectors.navButtons.forEach((button) =>
    button.classList.remove("active")
  );
  selectors.pages.forEach((page) => page.classList.add("hidden"));
  clearInterval(state.intervalId);
}

function enterApp(email) {
  state.user = { loggedIn: true, email };
  selectors.userEmail.textContent = email;
  selectors.authView.classList.add("hidden");
  selectors.appView.classList.remove("hidden");
  setActiveRoute("dashboard");

  if (!state.initialized) {
    renderInsights();
    drawPerformanceChart();
    refreshNews(true);
    refreshWatchlist();
    state.initialized = true;
  } else {
    refreshWatchlist();
  }

  clearInterval(state.intervalId);
  state.intervalId = setInterval(refreshWatchlist, 30_000);
}

function handleAuth(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const email = formData.get("email");
  selectors.authStatus.textContent = "Verifying credentials…";

  mockApi(
    () => ({
      email,
      token: "eyJraWQiOiJsb2NhbC5zaW0uLi4i",
    }),
    700
  ).then(({ email: userEmail }) => {
    selectors.authStatus.textContent = "Signed in successfully.";
    enterApp(userEmail);
  });
}

function handleLogout() {
  leaveApp();
  selectors.authStatus.textContent = "Enter your credentials to continue.";
}

function handleOrder(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const symbol = formData.get("symbol").toUpperCase();
  const quantity = Number(formData.get("quantity"));
  const orderType = formData.get("orderType");
  const trigger = formData.get("trigger");

  selectors.orderStatus.textContent = "Sending order…";

  mockApi(
    () => ({
      status: "accepted",
      symbol,
      quantity,
      orderType,
      trigger,
    }),
    800
  ).then((response) => {
    selectors.orderStatus.textContent = `Order confirmed: ${response.orderType} ${
      response.quantity
    } ${response.symbol}${
      response.trigger ? ` @ ${response.trigger}` : ""
    }.`;
    event.currentTarget.reset();
  });
}

function handleFeedback(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const message = formData.get("message");

  selectors.feedbackStatus.textContent = "Sending feedback…";

  mockApi(
    () => ({
      status: "received",
      message,
    }),
    800
  ).then(() => {
    selectors.feedbackStatus.textContent =
      "Thanks for sharing — your feedback has been stored.";
    event.currentTarget.reset();
  });
}

function initNavigation() {
  selectors.navButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const { route } = button.dataset;
      if (!route) return;
      setActiveRoute(route);
    });
  });
}

function init() {
  document.getElementById("authForm")?.addEventListener("submit", handleAuth);
  document.getElementById("orderForm")?.addEventListener("submit", handleOrder);
  document
    .getElementById("feedbackForm")
    ?.addEventListener("submit", handleFeedback);
  selectors.logout?.addEventListener("click", handleLogout);
  selectors.newsButton?.addEventListener("click", () => refreshNews(true));
  initNavigation();
}

init();
