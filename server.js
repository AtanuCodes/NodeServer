// Updated server.js
const WebSocket = require("ws");
const axios = require("axios");
const http = require("http");
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
require("dotenv").config();

const IDLC_BASE_URL = "https://amldfs.idlc.com/iTradeServices";
const PORT = process.env.PORT || 3000;

// Create Express app and HTTP server
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(express.json());

// Store connected clients
const clients = new Set();

// Store latest stock data
let latestStockData = null;
let authToken = null;

// Axios default config to mimic browser and add timeout/retry
const axiosConfig = {
  timeout: 30000, // 30 seconds timeout
  headers: {
    "Content-Type": "application/json",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    httpsAgent: new (require("https").Agent)({ rejectUnauthorized: false }),
    proxy: false,
  },
};

// Function to get authentication token with retry logic
async function getIDLCAuthToken(retryCount = 3) {
  const payload = {
    data: {
      EmailID: process.env.EMAIL_ID,
      Password: process.env.PASSWORD,
    },
  };

  for (let attempt = 1; attempt <= retryCount; attempt++) {
    try {
      console.log(`Auth attempt ${attempt}/${retryCount}`);
      const response = await axios.post(
        `${IDLC_BASE_URL}/api/Auth/Authorization`,
        payload,
        axiosConfig
      );

      if (response.data.result.resultCode === "200") {
        authToken = response.data.result.data.authToken;
        console.log("Auth token obtained successfully");
        return authToken;
      } else {
        console.error(
          "Authentication failed:",
          response.data.result.resultMessage
        );
        if (attempt < retryCount) {
          await new Promise((resolve) => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
        }
        continue;
      }
    } catch (error) {
      console.error(
        `Auth attempt ${attempt} error:`,
        error.response?.data || error.message || error.code
      );
      if (error.code === "ETIMEDOUT" || error.code === "ECONNRESET") {
        console.log("Connection timeout, retrying...");
        if (attempt < retryCount) {
          await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
          continue;
        }
      }
      return null;
    }
  }
  return null;
}

// Function to get stock data with retry
async function getAllStockCompanies(token, retryCount = 3) {
  if (!token) {
    console.error("Authentication token is required.");
    return null;
  }

  for (let attempt = 1; attempt <= retryCount; attempt++) {
    try {
      console.log(`Stock fetch attempt ${attempt}/${retryCount}`);
      const response = await axios.get(
        `${IDLC_BASE_URL}/api/CRM/GetAllStockCompany`,
        {
          ...axiosConfig,
          headers: {
            ...axiosConfig.headers,
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (response.data) {
        console.log("Stock data fetched successfully");
        return Array.isArray(response.data) ? response.data : [response.data];
      } else {
        console.error("No stock data received.");
        if (attempt < retryCount) continue;
        return null;
      }
    } catch (error) {
      console.error(
        `Stock fetch attempt ${attempt} error:`,
        error.response?.data || error.message || error.code
      );
      if (
        error.code === "ETIMEDOUT" ||
        error.code === "ECONNRESET" ||
        (error.response && error.response.status === 401)
      ) {
        // If 401, refresh token
        if (error.response && error.response.status === 401) {
          console.log("Token expired, refreshing...");
          await getIDLCAuthToken();
          token = authToken;
        }
        if (attempt < retryCount) {
          await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
          continue;
        }
      }
      return null;
    }
  }
  return null;
}

// Function to fetch and broadcast stock data
async function fetchAndBroadcastStockData() {
  console.log("Starting fetch and broadcast...");
  if (!authToken) {
    const token = await getIDLCAuthToken();
    if (!token) {
      console.error("Failed to get authentication token");
      return;
    }
  }

  const stockData = await getAllStockCompanies(authToken);
  if (stockData) {
    const mappedData = stockData.map((item) => ({
      trading_code: item.dseCompanyCode,
      last_trading_price: item.ycp,
      change: item.mktValueChange,
      change_percent: item.mktValChangePercentage,
      indicator: item.mktValueChange >= 0 ? "Up" : "Down",
    }));

    latestStockData = mappedData;

    // Broadcast to all connected clients
    const message = JSON.stringify({
      type: "stock_data",
      data: mappedData,
      timestamp: new Date().toISOString(),
    });

    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });

    console.log(`Broadcasted data to ${clients.size} clients`);
    return mappedData;
  }
  return null;
}

// Separate API Routes for Postman testing
// Auth route: POST /api/auth (body not needed, uses env)
app.post("/api/auth", async (req, res) => {
  try {
    console.log("Authenticating...");
    const token = await getIDLCAuthToken();
    if (token) {
      res.json({
        status: "success",
        message: "Authentication successful",
        token: token,
      });
    } else {
      res.status(401).json({
        status: "error",
        message: "Authentication failed",
      });
    }
  } catch (error) {
    console.error("Auth route error:", error);
    res.status(500).json({
      status: "error",
      message: "Internal server error",
      error: error.message,
    });
  }
});

// Stock route: GET /api/stock (no auth needed, handles internally)
app.get("/api/stock", async (req, res) => {
  try {
    if (!authToken) {
      await getIDLCAuthToken();
    }

    const stockData = await getAllStockCompanies(authToken);
    if (stockData) {
      const mappedData = stockData.map((item) => ({
        trading_code: item.dseCompanyCode,
        last_trading_price: item.ycp,
        change: item.mktValueChange,
        change_percent: item.mktValChangePercentage,
        indicator: item.mktValueChange >= 0 ? "Up" : "Down",
      }));
      res.json({
        status: "success",
        data: mappedData,
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(500).json({
        status: "error",
        message: "Failed to fetch stock data",
      });
    }
  } catch (error) {
    console.error("Stock route error:", error);
    res.status(500).json({
      status: "error",
      message: "Internal server error",
      error: error.message,
    });
  }
});

// Latest stock data route: GET /api/latest-stock (cached)
app.get("/api/latest-stock", (req, res) => {
  if (latestStockData) {
    res.json({
      status: "success",
      data: latestStockData,
      timestamp: new Date().toISOString(),
    });
  } else {
    res.status(404).json({
      status: "error",
      message: "No stock data available yet",
    });
  }
});

// WebSocket connection handling
wss.on("connection", (ws) => {
  console.log("New client connected");
  clients.add(ws);

  // Send initial data on connection
  if (latestStockData) {
    ws.send(
      JSON.stringify({
        type: "stock_data",
        data: latestStockData,
        timestamp: new Date().toISOString(),
      })
    );
  } else {
    // Fetch initial if no data
    fetchAndBroadcastStockData();
  }

  ws.on("close", () => {
    console.log("Client disconnected");
    clients.delete(ws);
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
    clients.delete(ws);
  });
});

// Fetch stock data at regular intervals (every 30 seconds)
cron.schedule("*/30 * * * * *", () => {
  console.log("Cron job: Fetching latest stock data...");
  fetchAndBroadcastStockData();
});

// Initial data fetch on server start with delay to ensure env load
setTimeout(async () => {
  console.log("Initial auth and fetch...");
  const token = await getIDLCAuthToken();
  if (token) {
    await fetchAndBroadcastStockData();
  }
}, 2000);

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`HTTP API available at http://localhost:${PORT}`);
  console.log(`- POST /api/auth (for token)`);
  console.log(`- GET /api/stock (for stock data)`);
  console.log(`- GET /api/latest-stock (for cached data)`);
  console.log(`WebSocket available at ws://localhost:${PORT}`);
});
