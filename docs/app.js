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

const analytics = {
  labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  roiHistory: [0, 1.8, 3.5, 2.9, 4.3, 5.6, 6.1],
  benchmarkHistory: [0, 0.5, 1.3, 1.9, 2.2, 2.7, 3.1],
  signals: 2,
};

const insights = [
  "ROI beat the benchmark by 3.0% over the last week.",
  "Volatility stayed within the configured guardrails.",
  "Two proactive alerts fired from the strategy monitor.",
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
  logout: document.querySelector("[data-logout]"),
  navButtons: Array.from(document.querySelectorAll("[data-route]")),
  pages: Array.from(document.querySelectorAll("[data-page]")),
};

// -----------------------------------------------------------
// Cognito Hosted UI (implicit flow) helpers
// -----------------------------------------------------------

function deriveRedirectUri() {
  const url = new URL(window.location.href);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/index\.html?$/i, "");
  if (!url.pathname.endsWith("/")) {
    url.pathname += "/";
  }
  return url.toString();
}

const DEFAULT_CONFIG = {
  apiBase: "https://gqc6b15bmb.execute-api.us-east-1.amazonaws.com/dev",
  region: "us-east-1",
  userPoolId: "us-east-1_HIEEMJvGm",
  userPoolWebClientId: "1oud3daqhov7gkfman25fimcip",
  domain: "us-east-1hieemjvgm.auth.us-east-1.amazoncognito.com",
  redirectUri: deriveRedirectUri(),
};

const CONFIG = { ...DEFAULT_CONFIG, ...(window.COGNITO_CONFIG ?? {}) };

function toBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generateCodeVerifier() {
  const random = new Uint8Array(32);
  crypto.getRandomValues(random);
  return toBase64Url(random);
}

async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toBase64Url(new Uint8Array(digest));
}

function buildLoginUrl(verifier, challenge) {
  const domain = CONFIG.domain.replace(/^https?:\/\//, "");
  const params = new URLSearchParams({
    client_id: CONFIG.userPoolWebClientId,
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: CONFIG.redirectUri,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  return `https://${domain}/oauth2/authorize?${params.toString()}`;
}

function buildLogoutUrl() {
  const domain = CONFIG.domain.replace(/^https?:\/\//, "");
  const params = new URLSearchParams({
    client_id: CONFIG.userPoolWebClientId,
    logout_uri: CONFIG.redirectUri,
  });
  return `https://${domain}/logout?${params.toString()}`;
}

function extractCodeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (code) {
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("code");
    cleanUrl.searchParams.delete("state");
    window.history.replaceState({}, document.title, cleanUrl.toString());
  }
  return code;
}

function extractTokenFromStorage() {
  return localStorage.getItem("idToken");
}

function decodeIdToken(token) {
  try {
    const payload = token.split(".")[1];
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch (err) {
    console.warn("Failed to decode id token", err);
    return null;
  }
}

async function exchangeCodeForTokens(code) {
  const verifier = sessionStorage.getItem("pkceVerifier");
  if (!verifier) {
    throw new Error("Missing PKCE verifier");
  }

  const domain = CONFIG.domain.replace(/^https?:\/\//, "");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CONFIG.userPoolWebClientId,
    code,
    redirect_uri: CONFIG.redirectUri,
    code_verifier: verifier,
  });

  const res = await fetch(`https://${domain}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json();
}

async function bootstrapAuth() {
  // If we already have a token stored, use it.
  const stored = extractTokenFromStorage();
  if (stored) {
    const payload = decodeIdToken(stored);
    const email =
      payload?.email ||
      payload?.["cognito:username"] ||
      payload?.username ||
      "Signed in";
    selectors.authStatus.textContent = "Signed in with Cognito.";
    enterApp(email);
    return;
  }

  // If we were just redirected back with a code, exchange it.
  const code = extractCodeFromUrl();
  if (code) {
    selectors.authStatus.textContent = "Finishing sign-in…";
    try {
      const tokens = await exchangeCodeForTokens(code);
      if (tokens.id_token) {
        localStorage.setItem("idToken", tokens.id_token);
        const payload = decodeIdToken(tokens.id_token);
        const email =
          payload?.email ||
          payload?.["cognito:username"] ||
          payload?.username ||
          "Signed in";
        selectors.authStatus.textContent = "Signed in with Cognito.";
        enterApp(email);
        return;
      }
      throw new Error("No id_token returned");
    } catch (err) {
      console.error(err);
      selectors.authStatus.textContent = "Login failed. Please try again.";
    }
  }

  leaveApp();
  selectors.authStatus.textContent = "Enter your credentials to continue.";
}

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

async function fetchQuote(symbol) {
  const now = Date.now();
  const cached = stockCache.get(symbol);
  if (cached && now - cached.timestamp < CACHE_TTL) {
    return cached.value;
  }

  const base = BASE_QUOTES[symbol] ?? 100;
  const previous = cached?.value.price ?? base;
  const drift = 1 + (Math.random() - 0.5) * 0.02;

  const response = await mockApi(() => {
    const price = +(base * drift).toFixed(2);
    return {
      symbol,
      price,
      change: +(price - previous).toFixed(2),
      changePct: +(((price - previous) / previous) * 100).toFixed(2),
    };
  });

  stockCache.set(symbol, { value: response, timestamp: now });
  latestQuotes[symbol] = response.price;
  return response;
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
      const price = latestQuotes[position.symbol] ?? BASE_QUOTES[position.symbol];
      const marketValue = position.shares * price;
      return `<tr>
        <td>${position.symbol}</td>
        <td>${position.shares}</td>
        <td>${formatCurrency(position.avgPrice)}</td>
        <td>${formatCurrency(position.stopLoss)}</td>
        <td>${formatCurrency(marketValue)}</td>
      </tr>`;
    })
    .join("\n");
}

function renderMetrics() {
  if (!selectors.balance || !selectors.portfolio || !selectors.pl) return;
  const holdingsValue = state.holdings.reduce((sum, position) => {
    const price = latestQuotes[position.symbol] ?? BASE_QUOTES[position.symbol];
    return sum + position.shares * price;
  }, 0);

  const portfolioValue = holdingsValue + state.cash;
  const dayChange = ((portfolioValue - 12000) / 12000) * 100;

  selectors.balance.textContent = formatCurrency(state.cash);
  selectors.portfolio.textContent = formatCurrency(portfolioValue);
  selectors.pl.textContent = `${dayChange >= 0 ? "+" : ""}${dayChange.toFixed(
    2
  )}%`;
  selectors.pl.classList.toggle("trend-up", dayChange >= 0);
  selectors.pl.classList.toggle("trend-down", dayChange < 0);
  selectors.signals.textContent = `${analytics.signals} alerts`;
}

function renderInsights() {
  if (!selectors.insightList) return;
  selectors.insightList.innerHTML = insights.map((item) => `<li>${item}</li>`).join("\n");
}

function drawPerformanceChart() {
  if (!selectors.chart) return;
  const ctx = selectors.chart.getContext("2d");
  const { width, height } = selectors.chart;
  ctx.clearRect(0, 0, width, height);

  ctx.fillStyle = "rgba(255,255,255,0.04)";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  const gridLines = 4;
  for (let i = 1; i <= gridLines; i += 1) {
    const y = (height / (gridLines + 1)) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  const padding = 40;

  const drawSeries = (data, color) => {
    const min = Math.min(...data);
    const max = Math.max(...data);
    const span = max - min || 1;

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    data.forEach((point, index) => {
      const x = padding + (index / (data.length - 1)) * (width - padding * 2);
      const y =
        height -
        padding -
        ((point - min) / span) * (height - padding * 2);
      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
  };

  drawSeries(analytics.benchmarkHistory, "rgba(255,186,107,0.9)");
  drawSeries(analytics.roiHistory, "rgba(102,195,255,1)");
}

function renderNews() {
  if (!selectors.newsGrid) return;
  selectors.newsGrid.innerHTML = newsCache.items
    .map(
      (article) => `<article class="news-card">
        <p class="eyebrow">${article.source}</p>
        <h3>${article.title}</h3>
        <p>${article.summary}</p>
        <span class="sentiment ${article.sentiment}">
          ${article.sentiment} · ${article.category}
        </span>
      </article>`
    )
    .join("\n");
}

async function refreshNews(force = false) {
  if (!selectors.newsButton) return;
  const now = Date.now();
  if (!force && now - newsCache.timestamp < 120_000 && newsCache.items.length) {
    renderNews();
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
        source: "Desk bulletin",
      },
    ],
    900
  );

  newsCache.items = articles;
  newsCache.timestamp = now;
  selectors.newsButton.disabled = false;
  selectors.newsButton.textContent = "Refresh feed";
  renderNews();
}

function setActiveRoute(route) {
  selectors.navButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.route === route);
  });
  selectors.pages.forEach((page) => {
    page.classList.toggle("active", page.dataset.page === route);
  });
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

function leaveApp() {
  state.user = { loggedIn: false, email: "" };
  selectors.userEmail.textContent = "";
  selectors.appView.classList.add("hidden");
  selectors.authView.classList.remove("hidden");
  selectors.navButtons.forEach((button) => button.classList.remove("active"));
  selectors.pages.forEach((page) => page.classList.remove("active"));
  clearInterval(state.intervalId);
  localStorage.removeItem("idToken");
}

function handleAuth(event) {
  event.preventDefault();
  selectors.authStatus.textContent = "Redirecting to Cognito…";
  const verifier = generateCodeVerifier();
  sessionStorage.setItem("pkceVerifier", verifier);
  generateCodeChallenge(verifier).then((challenge) => {
    window.location.href = buildLoginUrl(verifier, challenge);
  });
}

function handleLogout() {
  leaveApp();
  selectors.authStatus.textContent = "Enter your credentials to continue.";
  window.location.href = buildLogoutUrl();
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
  selectors.feedbackStatus.textContent = "Sending message…";

  mockApi(
    () => ({
      messageId: crypto.randomUUID(),
      topic: formData.get("topic"),
    }),
    650
  ).then(({ messageId, topic }) => {
    selectors.feedbackStatus.textContent = `Stored ${
      topic ?? "feedback"
    } message (${messageId}).`;
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

  bootstrapAuth();
}

init();
