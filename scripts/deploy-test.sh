#!/bin/bash

# Deployment Test Script
# This script helps test the deployment configurations locally

set -e

echo "🚀 Gov Search App - Deployment Test Script"
echo "==========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Function to print colored output
print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

# Check prerequisites
echo "Checking prerequisites..."

if ! command -v node &> /dev/null; then
    print_error "Node.js is not installed"
    exit 1
fi
print_success "Node.js is installed"

if ! command -v npm &> /dev/null; then
    print_error "npm is not installed"
    exit 1
fi
print_success "npm is installed"

if ! command -v docker &> /dev/null; then
    print_warning "Docker is not installed (optional)"
else
    print_success "Docker is installed"
fi

echo ""
echo "Select deployment type to test:"
echo "1) Local Development"
echo "2) Docker Build"
echo "3) Environment Check"
echo "4) API Health Check"
echo ""
read -p "Enter choice [1-4]: " choice

case $choice in
    1)
        echo ""
        echo "🔧 Testing Local Development Setup"
        echo "===================================="
        cd backend
        
        if [ ! -d "node_modules" ]; then
            echo "Installing dependencies..."
            npm install
            print_success "Dependencies installed"
        else
            print_success "Dependencies already installed"
        fi
        
        echo ""
        echo "Starting server (press Ctrl+C to stop)..."
        npm start
        ;;
    
    2)
        echo ""
        echo "🐳 Testing Docker Build"
        echo "======================="
        
        if ! command -v docker &> /dev/null; then
            print_error "Docker is required for this test"
            exit 1
        fi
        
        cd backend
        echo "Building Docker image..."
        docker build -t gov-search-backend-test .
        print_success "Docker image built successfully"
        
        echo ""
        echo "Starting container on port 4000..."
        docker run -d -p 4000:4000 \
            -e JWT_SECRET="test-secret-key" \
            --name gov-search-test \
            gov-search-backend-test
        
        print_success "Container started"
        echo ""
        echo "Container logs:"
        sleep 2
        docker logs gov-search-test
        
        echo ""
        echo "To stop and remove the container, run:"
        echo "  docker stop gov-search-test && docker rm gov-search-test"
        ;;
    
    3)
        echo ""
        echo "🔍 Environment Check"
        echo "===================="
        
        # Check backend directory
        if [ -d "backend" ]; then
            print_success "Backend directory exists"
        else
            print_error "Backend directory not found"
            exit 1
        fi
        
        # Check package.json
        if [ -f "backend/package.json" ]; then
            print_success "package.json found"
        else
            print_error "package.json not found"
            exit 1
        fi
        
        # Check server.js
        if [ -f "backend/server.js" ]; then
            print_success "server.js found"
        else
            print_error "server.js not found"
            exit 1
        fi
        
        # Check deployment configs
        echo ""
        echo "Deployment configuration files:"
        [ -f "vercel.json" ] && print_success "vercel.json exists" || print_warning "vercel.json not found"
        [ -f "Procfile" ] && print_success "Procfile exists" || print_warning "Procfile not found"
        [ -f "app.json" ] && print_success "app.json exists" || print_warning "app.json not found"
        [ -f "railway.json" ] && print_success "railway.json exists" || print_warning "railway.json not found"
        [ -f "netlify.toml" ] && print_success "netlify.toml exists" || print_warning "netlify.toml not found"
        [ -f "backend/Dockerfile" ] && print_success "Dockerfile exists" || print_warning "Dockerfile not found"
        
        echo ""
        echo "Documentation files:"
        [ -f "docs/DEPLOYMENT.md" ] && print_success "DEPLOYMENT.md exists" || print_warning "DEPLOYMENT.md not found"
        [ -f "docs/API.md" ] && print_success "API.md exists" || print_warning "API.md not found"
        [ -f "README.md" ] && print_success "README.md exists" || print_warning "README.md not found"
        ;;
    
    4)
        echo ""
        echo "🏥 API Health Check"
        echo "==================="
        
        if ! command -v curl &> /dev/null; then
            print_error "curl is required for health check"
            exit 1
        fi
        
        read -p "Enter API URL (default: http://localhost:4000): " api_url
        api_url=${api_url:-http://localhost:4000}
        
        echo ""
        echo "Testing API at: $api_url"
        echo ""
        
        # Test registration
        echo "1. Testing registration endpoint..."
        response=$(curl -s -w "\n%{http_code}" -X POST "$api_url/api/register" \
            -H "Content-Type: application/json" \
            -d '{"username":"testuser'$(date +%s)'","password":"testpass123"}')
        
        http_code=$(echo "$response" | tail -n1)
        body=$(echo "$response" | head -n-1)
        
        if [ "$http_code" = "200" ]; then
            print_success "Registration successful"
            token=$(echo "$body" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
            echo "Token: ${token:0:20}..."
        else
            print_error "Registration failed (HTTP $http_code)"
            echo "Response: $body"
        fi
        
        echo ""
        echo "API health check complete!"
        ;;
    
    *)
        print_error "Invalid choice"
        exit 1
        ;;
esac

echo ""
echo "✅ Done!"
