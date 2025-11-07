const express = require('express');
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.json({
    message: "Government Watchdog API",
    status: "running",
    timestamp: new Date().toISOString()
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: "ok",
    service: "government-watchdog-api",
    version: "1.0.0"
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});