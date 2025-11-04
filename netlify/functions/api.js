const express = require('express');
const serverless = require('serverless-http');

// Import the main Express app
const app = require('../../backend/server');

// Export the serverless handler
exports.handler = serverless(app);
