// -----------------------------------------------------------
// CONFIG — UPDATE THESE VALUES ONLY IF NEEDED
// -----------------------------------------------------------

// API Gateway invoke URL (with stage)
const API_BASE = "https://gqc6b15bmb.execute-api.us-east-1.amazonaws.com/dev";

// Cognito Hosted UI domain
const COGNITO_DOMAIN = "https://us-east-1hieemjvgm.auth.us-east-1.amazoncognito.com";

// Cognito App Client ID
const CLIENT_ID = "1oud3daqhov7gkfman25fimcip";

// Your GitHub Pages redirect URL
const REDIRECT_URI = "https://mathew-martin.github.io/virtual-stock-trading-simulator/";


// -----------------------------------------------------------
// Redirect user to Cognito Hosted UI Login
// -----------------------------------------------------------

function redirectToCognitoLogin() {
  const loginUrl =
    `${COGNITO_DOMAIN}/login?client_id=${CLIENT_ID}` +
    `&response_type=token&scope=email+openid+phone` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

  window.location.href = loginUrl;
}


// -----------------------------------------------------------
// Extract ID token from redirect URL OR localStorage
// -----------------------------------------------------------

function extractTokenFromUrl() {
  if (window.location.hash.includes("id_token")) {
    const params = new URLSearchParams(window.location.hash.substring(1));
    const token = params.get("id_token");

    if (token) {
      localStorage.setItem("idToken", token);
      window.location.hash = ""; // clean URL
      return token;
    }
  }

  return localStorage.getItem("idToken");
}


// -----------------------------------------------------------
// Make AUTHENTICATED GET request to API Gateway
// -----------------------------------------------------------

async function apiGet(path) {
  const token = localStorage.getItem("idToken");

  if (!token) {
    alert("Not logged in.");
    redirectToCognitoLogin();
    return;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: token
    }
  });

  if (res.status === 401) {
    alert("Session expired — login again.");
    localStorage.removeItem("idToken");
    redirectToCognitoLogin();
  }

  return res.json();
}


// -----------------------------------------------------------
// UI Logic
// -----------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  const loginBtn = document.getElementById("cognitoLoginBtn");
  loginBtn.addEventListener("click", redirectToCognitoLogin);

  const token = extractTokenFromUrl();

  if (!token) {
    showView("auth");
    return;
  }

  showView("app");

  // Test button listener
  document.getElementById("testFetchBtn").addEventListener("click", async () => {
    const out = document.getElementById("outputBox");
    out.textContent = "Fetching...";

    const result = await apiGet("/stock/AAPL");
    out.textContent = JSON.stringify(result, null, 2);
  });
});


// Switch between login & app screens
function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  document.querySelector(`.view[data-view="${name}"]`).classList.remove("hidden");
}


// Logout
document.addEventListener("click", (e) => {
  if (e.target.matches("[data-logout]")) {
    localStorage.removeItem("idToken");
    redirectToCognitoLogin();
  }
});
