# gov-search-app

[![License: MIT](https://img.shields.io/github/license/tara32473/gov-search-app)](LICENSE)
[![Build Status](https://github.com/tara32473/gov-search-app/actions/workflows/ci.yml/badge.svg)](https://github.com/tara32473/gov-search-app/actions/workflows/ci.yml)
[![Issues](https://img.shields.io/github/issues/tara32473/gov-search-app)](https://github.com/tara32473/gov-search-app/issues)
[![Pull Requests](https://img.shields.io/github/issues-pr/tara32473/gov-search-app)](https://github.com/tara32473/gov-search-app/pulls)
[![Last Commit](https://img.shields.io/github/last-commit/tara32473/gov-search-app)](https://github.com/tara32473/gov-search-app/commits)
[![Deploy to Heroku](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/tara32473/gov-search-app)

A government search application with a backend API for searching and managing information about Congress members.

## Features

- User authentication with JWT tokens
- Secure password hashing with bcrypt
- RESTful API for Congress member search
- SQLite database for data persistence
- CORS support for cross-origin requests

## Quick Start

### Local Development

```bash
# Clone the repository
git clone https://github.com/tara32473/gov-search-app.git
cd gov-search-app/backend

# Install dependencies
npm install

# Set environment variables (optional)
export JWT_SECRET="your-secret-key"
export PORT=4000

# Start the server
npm start
```

The API will be available at `http://localhost:4000`.

### Environment Variables

Create a `.env` file in the `backend` directory (see `.env.example`):

```bash
JWT_SECRET=your-secret-key-here
PORT=4000
```

**Important**: Use a strong, randomly generated secret in production.

## Deployment

This application is ready to deploy to multiple platforms with pre-configured deployment files:

### One-Click Deployments

- **Heroku**: Click the "Deploy to Heroku" button above
- **Railway**: [Deploy to Railway](https://railway.app/new)
- **Vercel**: [Deploy to Vercel](https://vercel.com/new)
- **Netlify**: [Deploy to Netlify](https://app.netlify.com/start)

### Supported Platforms

- ✅ **Vercel** - Serverless deployment (configuration: `vercel.json`)
- ✅ **Heroku** - Container-based deployment (configuration: `Procfile`, `app.json`)
- ✅ **Railway** - Modern deployment platform (configuration: `railway.json`)
- ✅ **Netlify** - Serverless functions (configuration: `netlify.toml`)
- ✅ **Docker** - Containerized deployment (configuration: `backend/Dockerfile`)

For detailed deployment instructions, see **[DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

## API Documentation

See [API.md](docs/API.md) for detailed API endpoint documentation.

### Quick API Reference

- `POST /api/register` - Create a new user account
- `POST /api/login` - Login and receive JWT token
- `GET /api/search` - Search Congress members (requires authentication)
- `POST /api/admin/addcongress` - Add Congress member data

## Project Structure

```
gov-search-app/
├── backend/           # Backend API server
│   ├── server.js     # Main Express application
│   ├── package.json  # Node.js dependencies
│   └── Dockerfile    # Docker configuration
├── docs/             # Documentation
│   ├── API.md        # API documentation
│   └── DEPLOYMENT.md # Deployment guide
├── netlify/          # Netlify serverless functions
├── vercel.json       # Vercel configuration
├── railway.json      # Railway configuration
├── netlify.toml      # Netlify configuration
├── Procfile          # Heroku configuration
└── app.json          # Heroku app definition
```

## Technology Stack

- **Backend**: Node.js, Express.js
- **Database**: SQLite3
- **Authentication**: JWT (jsonwebtoken), bcryptjs
- **Security**: CORS enabled

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

- 📫 [Open an Issue](https://github.com/tara32473/gov-search-app/issues)
- 📖 [Read the Documentation](docs/)
- 🚀 [Deployment Guide](docs/DEPLOYMENT.md)