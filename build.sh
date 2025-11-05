#!/bin/bash
# Render Build Script

echo "🏛️ Building Government Watchdog App for Render..."

# Navigate to backend directory
cd backend

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Create logs directory
mkdir -p logs

# Run any migrations or setup
echo "🗄️ Setting up database..."
# Database tables will be created automatically when the app starts

echo "✅ Build complete! Ready to deploy."