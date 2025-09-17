require('dotenv').config();
const https = require('https');
const axios = require('axios');
const dns = require('dns');
const { promisify } = require('util');

const EMAIL = process.env.EMAIL_ID;
const PASSWORD = process.env.PASSWORD;
const IDLC_BASE_URL = 'https://amldfs.idlc.com/iTradeServices';

const dnsLookup = promisify(dns.lookup);

console.log('🧪 IDLC API Connectivity Test');
console.log('================================');

async function testDNS() {
  try {
    console.log('1. Testing DNS resolution...');
    const result = await dnsLookup('amldfs.idlc.com');
    console.log('✅ DNS OK:', result);
    return true;
  } catch (error) {
    console.error('❌ DNS Failed:', error.message);
    return false;
  }
}

async function testBasicHTTPS() {
  return new Promise((resolve) => {
    console.log('2. Testing basic HTTPS connection...');
    
    const options = {
      hostname: 'amldfs.idlc.com',
      port: 443,
      path: '/',
      method: 'GET',
      timeout: 10000,
      rejectUnauthorized: false
    };

    const req = https.request(options, (res) => {
      console.log('✅ HTTPS Connection OK, Status:', res.statusCode);
      res.on('data', () => {}); // Consume response
      res.on('end', () => resolve(true));
    });

    req.on('error', (error) => {
      console.error('❌ HTTPS Connection Failed:', error.message);
      resolve(false);
    });

    req.on('timeout', () => {
      console.error('❌ HTTPS Connection Timeout');
      req.destroy();
      resolve(false);
    });

    req.end();
  });
}

async function testAxiosDefault() {
  try {
    console.log('3. Testing with default axios...');
    const response = await axios.get('https://amldfs.idlc.com', { timeout: 10000 });
    console.log('✅ Default Axios OK, Status:', response.status);
    return true;
  } catch (error) {
    console.error('❌ Default Axios Failed:', error.code || error.message);
    return false;
  }
}

async function testAxiosWithAgent() {
  try {
    console.log('4. Testing with custom HTTPS agent...');
    
    const agent = new https.Agent({
      rejectUnauthorized: false,
      keepAlive: true,
      timeout: 30000
    });

    const response = await axios.get('https://amldfs.idlc.com', {
      httpsAgent: agent,
      timeout: 10000,
      headers: {
        'User-Agent': 'PostmanRuntime/7.41.5'
      }
    });
    
    console.log('✅ Custom Agent Axios OK, Status:', response.status);
    return true;
  } catch (error) {
    console.error('❌ Custom Agent Axios Failed:', error.code || error.message);
    return false;
  }
}

async function testAuthAPI() {
  try {
    console.log('5. Testing IDLC Auth API...');
    
    const agent = new https.Agent({
      rejectUnauthorized: false,
      keepAlive: true,
      timeout: 30000
    });

    const payload = {
      data: {
        EmailID: EMAIL,
        Password: PASSWORD
      }
    };

    console.log('   Using credentials:', {
      EmailID: EMAIL,
      Password: PASSWORD ? '[SET]' : '[NOT SET]'
    });

    const response = await axios.post(`${IDLC_BASE_URL}/api/Auth/Authorization`, payload, {
      httpsAgent: agent,
      timeout: 30000,
      headers: {
        'User-Agent': 'PostmanRuntime/7.41.5',
        'Content-Type': 'application/json',
        'Accept': '*/*'
      }
    });

    console.log('✅ Auth API OK, Status:', response.status);
    
    if (response.data?.result?.data?.authToken) {
      const token = response.data.result.data.authToken;
      console.log('✅ Token received, Length:', token.length);
      console.log('   Token Preview:', token.substring(0, 50) + '...');
      return token;
    } else {
      console.error('❌ No token in response');
      console.log('   Response:', JSON.stringify(response.data, null, 2));
      return null;
    }
  } catch (error) {
    console.error('❌ Auth API Failed:', error.code || error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', JSON.stringify(error.response.data, null, 2));
    }
    return null;
  }
}

async function testStockAPI(token) {
  if (!token) {
    console.log('6. Skipping Stock API test (no token)');
    return false;
  }

  try {
    console.log('6. Testing Stock API...');
    
    const agent = new https.Agent({
      rejectUnauthorized: false,
      keepAlive: true,
      timeout: 30000
    });

    const response = await axios.get(`${IDLC_BASE_URL}/api/CRM/GetAllStockCompany`, {
      httpsAgent: agent,
      timeout: 30000,
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'PostmanRuntime/7.41.5',
        'Content-Type': 'application/json',
        'Accept': '*/*'
      }
    });

    console.log('✅ Stock API OK, Status:', response.status);
    
    const stockData = Array.isArray(response.data) ? response.data : [response.data];
    console.log('✅ Stock count:', stockData.length);
    
    if (stockData.length > 0) {
      const sample = stockData[0];
      console.log('   Sample stock:', {
        dseCompanyCode: sample.dseCompanyCode,
        ycp: sample.ycp,
        mktValue: sample.mktValue
      });
    }
    
    return true;
  } catch (error) {
    console.error('❌ Stock API Failed:', error.code || error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', JSON.stringify(error.response.data, null, 2));
    }
    return false;
  }
}

async function runAllTests() {
  console.log('Starting comprehensive connectivity tests...\n');
  
  const dnsOk = await testDNS();
  console.log('');
  
  const httpsOk = await testBasicHTTPS();
  console.log('');
  
  const axiosDefaultOk = await testAxiosDefault();
  console.log('');
  
  const axiosAgentOk = await testAxiosWithAgent();
  console.log('');
  
  const authToken = await testAuthAPI();
  console.log('');
  
  const stockOk = await testStockAPI(authToken);
  console.log('');
  
  console.log('================================');
  console.log('TEST SUMMARY:');
  console.log('DNS Resolution:', dnsOk ? '✅' : '❌');
  console.log('Basic HTTPS:', httpsOk ? '✅' : '❌');
  console.log('Default Axios:', axiosDefaultOk ? '✅' : '❌');
  console.log('Custom Agent:', axiosAgentOk ? '✅' : '❌');
  console.log('Auth API:', authToken ? '✅' : '❌');
  console.log('Stock API:', stockOk ? '✅' : '❌');
  
  if (!dnsOk) {
    console.log('\n🔧 DNS ISSUES DETECTED:');
    console.log('- Try using Google DNS (8.8.8.8, 8.8.4.4)');
    console.log('- Check if your ISP blocks certain domains');
    console.log('- Try using a VPN');
  }
  
  if (!httpsOk && dnsOk) {
    console.log('\n🔧 NETWORK/FIREWALL ISSUES:');
    console.log('- Check firewall settings');
    console.log('- Try different network (mobile hotspot)');
    console.log('- Contact your network administrator');
  }
  
  if (httpsOk && !authToken) {
    console.log('\n🔧 API/CREDENTIALS ISSUES:');
    console.log('- Verify email and password');
    console.log('- Check if account is active');
    console.log('- Try different user agent');
  }
}

// Run the tests
runAllTests().catch(console.error);