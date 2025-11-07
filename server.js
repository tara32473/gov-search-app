const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files (HTML frontend)
app.use(express.static(__dirname));

// Root route - serve the main HTML page
app.get('/', (req, res) => {
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});