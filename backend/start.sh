#!/bin/sh

# Production startup script for Render deployment
set -e

echo "🚀 Starting Government Search App Backend..."
echo "📊 Environment: ${NODE_ENV:-development}"
echo "🔗 Port: ${PORT:-4000}"

# Ensure database directory exists
mkdir -p /app/data

# Set database path if not specified
if [ -z "$DATABASE_URL" ]; then
    export DATABASE_URL="/app/data/watchdog.sqlite"
fi

echo "📁 Database: $DATABASE_URL"

# Initialize database if it doesn't exist
if [ ! -f "$DATABASE_URL" ]; then
    echo "🗄️ Initializing database..."
    node -e "
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database('$DATABASE_URL');
    db.close();
    console.log('✅ Database file created');
    "
fi

# Start the application
echo "✨ Starting server..."
exec node server.js