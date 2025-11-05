const express = require('express');
const serverless = require('serverless-http');

// Import the main Express app with error handling
let app;
try {
    app = require('../../backend/server');
} catch (error) {
    console.error('Failed to load backend server:', error);
    // Create a minimal error app
    app = express();
    app.all('*', (req, res) => {
        res.status(500).json({ error: 'Server initialization failed' });
    });
}

// Export the serverless handler
exports.handler = serverless(app);
