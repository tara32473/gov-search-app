# Government Repository Search App - Setup & Usage Guide

This application provides three ways to search government repositories on GitHub:

## 🛠️ Setup

Run this command first to install all dependencies:
```bash
npm run setup
```

## 🚀 Usage Options

### 1. CLI Tool (Command Line)
Search directly from your terminal:
```bash
# Basic search
npm run cli data

# Search with custom limit
npm run cli cybersecurity 15

# Or run directly
node index.js justice 5
./index.js healthcare 10
```

### 2. Web API (Backend Server)
Start the backend server to use the REST API:
```bash
npm run backend
```
The server runs on http://localhost:4000

**API Endpoints:**
- `GET /api/health` - Health check
- `GET /api/search/repos?keyword=<term>&limit=<n>` - Public search
- `POST /api/register` - Register new user
- `POST /api/login` - User login  
- `GET /api/search/repos/tracked` - Authenticated search with history
- `GET /api/search/history` - User search history

### 3. Web Interface (Full App)
Start both backend and open the web UI:
```bash
npm run dev
```
Then visit: http://localhost:4000

## 🌟 Features

### CLI Features:
- ✅ Fast command-line search
- ✅ Colored output with repo stats
- ✅ Sort by stars (most popular first)
- ✅ Customizable result limit

### Web API Features:
- ✅ RESTful API endpoints
- ✅ User authentication & registration
- ✅ Search history tracking
- ✅ Rate limiting (max 50 results)
- ✅ CORS enabled

### Web Interface Features:
- ✅ Beautiful responsive UI
- ✅ Real-time search results
- ✅ User accounts with search history
- ✅ Repository stats (stars, language, last update)
- ✅ Direct links to GitHub repositories
- ✅ Mobile-friendly design

## 🔍 Example Searches

Try these keywords:
- `data` - Data-related government projects
- `cybersecurity` - Security and privacy tools  
- `healthcare` - Health and medical systems
- `education` - Educational platforms
- `covid` - COVID-19 related projects
- `census` - Census and demographic tools
- `justice` - Justice and legal systems

## 📁 Project Structure

```
gov-search-app/
├── index.js              # CLI application
├── package.json           # Main dependencies & scripts
├── backend/
│   ├── server.js         # Express API server
│   ├── package.json      # Backend dependencies
│   └── appdata.sqlite    # User data (auto-created)
├── frontend/
│   └── dist/
│       └── index.html    # Web interface
└── docs/
    └── API.md           # API documentation
```

## 🔧 Development

- Backend runs on port 4000
- Frontend is served by backend as static files
- SQLite database for user accounts and search history
- GitHub API integration (no API key required for public repos)

## 📖 Help

```bash
npm run help  # Show available commands
```