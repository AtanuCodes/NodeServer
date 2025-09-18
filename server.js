// Updated server.js
const WebSocket = require("ws");
const axios = require("axios");
const http = require("http");
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
require("dotenv").config();

const IDLC_BASE_URL = "https://192.168.110.140/iTradeServices";
const PORT = 3000;

// Create Express app and HTTP server
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors({
  origin: "*", // Allow all origins
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], // Allow common methods
  allowedHeaders: ["Content-Type", "Authorization"], // Allow common headers
  credentials: true,
}));
app.use(express.json());

// Store connected clients
const clients = new Set();

// Store latest stock data as a map for quick lookups (key: trading_code)
let latestStockMap = new Map();
let authToken = null;

// Corrected Axios default config (moved httpsAgent and proxy out of headers)
const { Agent } = require("https");
const httpsAgent = new Agent({ rejectUnauthorized: false }); // Ignore SSL cert errors if needed

const axiosConfig = {
  timeout: 60000, // Increased to 60 seconds for slower connections
  headers: {
    "Content-Type": "application/json",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  },
  httpsAgent, // Top-level config for HTTPS
  proxy: false, // Explicitly disable proxy if not needed
};

// Function to get authentication token with retry logic
async function getIDLCAuthToken(retryCount = 5) { 
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
          await new Promise((resolve) => setTimeout(resolve, 5000 * attempt)); // Increased backoff
        }
        continue;
      }
    } catch (error) {
      console.error(
        `Auth attempt ${attempt} error:`,
        error.response?.data || error.message || error.code
      );
      if (error.code === "ETIMEDOUT" || error.code === "ECONNRESET" || error.code === "ECONNABORTED") {
        console.log("Connection timeout, retrying...");
        if (attempt < retryCount) {
          await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
          continue;
        }
      }
      return null;
    }
  }
  return null;
}

// Function to get stock data with retry
async function getAllStockCompanies(token, retryCount = 5) { // Increased retries
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
        error.code === "ECONNABORTED" ||
        (error.response && error.response.status === 401)
      ) {
        // If 401, refresh token
        if (error.response && error.response.status === 401) {
          console.log("Token expired, refreshing...");
          await getIDLCAuthToken();
          token = authToken;
        }
        if (attempt < retryCount) {
          await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
          continue;
        }
      }
      return null;
    }
  }
  return null;
}

// Function to fetch stock data, detect changes, and broadcast updates
async function fetchAndBroadcastStockData(isInitial = false) {
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
    const newStockMap = new Map();
    const updates = [];

    stockData.forEach((item) => {
      const mappedItem = {
        trading_code: item.dseCompanyCode,
        last_trading_price: item.ycp,
        change: item.mktValueChange,
        change_percent: item.mktValChangePercentage,
        indicator: item.mktValueChange >= 0 ? "Up" : "Down",
      };

      const key = mappedItem.trading_code;
      newStockMap.set(key, mappedItem);

      // Compare with previous
      const prevItem = latestStockMap.get(key);
      if (isInitial || !prevItem || 
          prevItem.last_trading_price !== mappedItem.last_trading_price ||
          prevItem.change !== mappedItem.change ||
          prevItem.change_percent !== mappedItem.change_percent) {
        updates.push(mappedItem);
      }
    });

    // Update latest map
    latestStockMap = newStockMap;

    if (updates.length > 0 || isInitial) {
      // Broadcast: full data on initial, updates otherwise
      const message = JSON.stringify({
        type: isInitial ? "stock_data" : "stock_update",
        data: isInitial ? Array.from(newStockMap.values()) : updates,
        timestamp: new Date().toISOString(),
      });

      clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });

      console.log(`Broadcasted ${isInitial ? 'full data' : 'updates'} to ${clients.size} clients: ${updates.length} changes`);
    } else {
      console.log('No changes detected, skipping broadcast');
    }
  }
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
        last_trading_price: item.mktValue,
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
  if (latestStockMap.size > 0) {
    res.json({
      status: "success",
      data: Array.from(latestStockMap.values()),
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

  // Send initial full data on connection
  if (latestStockMap.size > 0) {
    ws.send(
      JSON.stringify({
        type: "stock_data",
        data: Array.from(latestStockMap.values()),
        timestamp: new Date().toISOString(),
      })
    );
  } else {
    // Fetch initial if no data
    fetchAndBroadcastStockData(true);
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

// Fetch stock data at regular intervals (every 3 seconds)
cron.schedule("*/3 * * * * *", () => {
  console.log("Cron job: Fetching latest stock data...");
  fetchAndBroadcastStockData();
});

// Initial data fetch on server start with delay to ensure env load
setTimeout(async () => {
  console.log("Initial auth and fetch...");
  const token = await getIDLCAuthToken();
  if (token) {
    await fetchAndBroadcastStockData(true);
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