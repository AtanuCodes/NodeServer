require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const cron = require('node-cron');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// CORS configuration
app.use(cors({
  origin: ["http://localhost:3000", "http://localhost:3001", "http://localhost:5173", "http://localhost:5174"],
  credentials: true
}));

const io = new Server(server, {
  cors: {
    origin: ["http://localhost:3000", "http://localhost:3001", "http://localhost:5173", "http://localhost:5174"],
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.use(express.json());

// Constants
const IDLC_BASE_URL = 'https://amldfs.idlc.com/iTradeServices';
const EMAIL = process.env.EMAIL_ID;
const PASSWORD = process.env.PASSWORD;
const PORT = process.env.PORT || 3000;

let authToken = null;
let previousStockData = {};
let lastFetchTime = null;
let tokenExpiryTime = null;

// Create axios instance with proper configuration
const axiosInstance = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
  }
});

// Routes for testing
app.get('/', (req, res) => {
  res.json({ 
    message: 'Stock WebSocket Server is running!',
    timestamp: new Date().toISOString(),
    connectedClients: io.sockets.sockets.size
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    authToken: authToken ? 'present' : 'missing',
    lastFetch: lastFetchTime || 'never',
    activeConnections: io.sockets.sockets.size
  });
});

// Separate authentication endpoint
app.post('/auth', async (req, res) => {
  try {
    const token = await getAuthToken(true);
    if (token) {
      res.json({ status: 'success', token: token.substring(0, 20) + '...' });
    } else {
      res.status(500).json({ status: 'error', message: 'Authentication failed' });
    }
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Separate stock data endpoint
app.get('/stocks', async (req, res) => {
  try {
    const stocks = await fetchStockData();
    if (stocks) {
      res.json({ status: 'success', count: stocks.length, data: stocks });
    } else {
      res.status(500).json({ status: 'error', message: 'Failed to fetch stocks' });
    }
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Authentication function
async function getAuthToken(forceRefresh = false) {
  if (authToken && !forceRefresh && tokenExpiryTime && Date.now() < tokenExpiryTime) {
    return authToken;
  }

  try {
    console.log('🔄 Fetching new auth token...');
    
    // Try different payload formats that the API might expect
    const payloadFormats = [
      { EmailID: EMAIL, Password: PASSWORD },
      { data: { EmailID: EMAIL, Password: PASSWORD } },
      { email: EMAIL, password: PASSWORD },
      { username: EMAIL, password: PASSWORD }
    ];

    let response;
    let lastError;

    for (const payload of payloadFormats) {
      try {
        response = await axiosInstance.post(`${IDLC_BASE_URL}/api/Auth/Authorization`, payload, {
          timeout: 10000
        });
        console.log('👍 Auth token fetched successfully', response);
        
        if (response.status === 200) {
          // Try different response structures
          const token = 
            response.data?.result?.data?.authToken ||
            response.data?.data?.authToken ||
            response.data?.authToken ||
            response.data?.token;
            
          if (token) {
            authToken = token;
            tokenExpiryTime = Date.now() + (55 * 60 * 1000); // 55 minutes
            console.log('✅ Auth token obtained successfully');
            
            io.emit('auth-status', { 
              status: 'authenticated', 
              timestamp: new Date().toISOString()
            });
            
            return authToken;
          }
        }
      } catch (error) {
        lastError = error;
        console.log(`⚠️ Attempt with payload format failed: ${JSON.stringify(payload)}`);
      }
    }

    throw lastError || new Error('All authentication attempts failed');
    
  } catch (error) {
    console.error('💥 Auth Error:', error.message);
    
    io.emit('auth-status', { 
      status: 'error', 
      error: error.message,
      timestamp: new Date().toISOString() 
    });
    
    return null;
  }
}

// Stock data fetching function
async function fetchStockData() {
  try {
    const token = await getAuthToken();
    if (!token) {
      throw new Error('No auth token available');
    }

    const response = await axiosInstance.get(`${IDLC_BASE_URL}/api/CRM/GetAllStockCompany`, {
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    if (response.status === 401) {
      console.log('🔄 Token expired, refreshing...');
      authToken = null;
      return await fetchStockData(); // Retry with new token
    }

    if (response.status !== 200) {
      throw new Error(`API returned status ${response.status}`);
    }

    const stockData = Array.isArray(response.data) ? response.data : 
                     Array.isArray(response.data.result) ? response.data.result : 
                     [response.data];
    
    console.log(`📈 Received ${stockData.length} stock records`);

    // Process updates
    const updates = [];
    stockData.forEach(stock => {
      const stockCode = stock.dseCompanyCode || stock.trading_code;
      if (!stockCode) return;
      
      const prev = previousStockData[stockCode];
      const hasUpdate = !prev || 
                       prev.last_trading_price !== stock.last_trading_price ||
                       prev.change !== stock.change;
      
      if (hasUpdate) {
        previousStockData[stockCode] = stock;
        updates.push(stock);
      }
    });

    lastFetchTime = new Date().toISOString();

    if (updates.length > 0) {
      console.log(`📢 Broadcasting ${updates.length} stock updates`);
      io.emit('stock-updates', updates);
    }

    return stockData;
    
  } catch (error) {
    console.error('💥 Stock fetch error:', error.message);
    
    io.emit('fetch-status', { 
      status: 'error', 
      error: error.message,
      timestamp: new Date().toISOString() 
    });
    
    return null;
  }
}

// Socket.IO handlers
io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);
  
  // Send initial data if available
  const stockValues = Object.values(previousStockData);
  if (stockValues.length > 0) {
    socket.emit('stock-updates', stockValues);
  }
  
  // Send server status
  socket.emit('server-status', {
    status: 'connected',
    authToken: authToken ? 'present' : 'missing',
    lastFetch: lastFetchTime,
    totalStocks: Object.keys(previousStockData).length
  });
  
  socket.on('request-refresh', async () => {
    console.log('🔄 Manual refresh requested by:', socket.id);
    await fetchStockData();
  });
  
  socket.on('ping', () => {
    socket.emit('pong', { timestamp: new Date().toISOString() });
  });
  
  socket.on('disconnect', (reason) => {
    console.log('🔌 Client disconnected:', socket.id, 'Reason:', reason);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  
  // Initial data fetch with retry mechanism
  const initialFetch = async (retries = 3) => {
    try {
      await fetchStockData();
    } catch (error) {
      if (retries > 0) {
        console.log(`🔄 Retrying initial fetch... (${retries} attempts left)`);
        setTimeout(() => initialFetch(retries - 1), 5000);
      }
    }
  };
  
  setTimeout(initialFetch, 2000);
});