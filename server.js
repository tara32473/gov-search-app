const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Serve static files (HTML frontend)
app.use(express.static(__dirname));

// Root route - serve the main HTML page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Fallback route for index.html
app.get('/index.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    message: 'Government Watchdog API is running',
    status: 'ok',
    version: '1.0.1',
    timestamp: new Date().toISOString(),
    endpoints: [
      '/api/health',
      '/api/congress/members',
      '/api/spending',
      '/api/lobbying',
      '/api/legislation/bills'
    ]
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});