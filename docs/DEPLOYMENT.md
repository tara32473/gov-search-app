# Deployment Guide

This guide provides step-by-step instructions for deploying the Gov Search App backend API to various cloud platforms.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Environment Variables](#environment-variables)
- [Deployment Platforms](#deployment-platforms)
  - [Vercel](#vercel)
  - [Heroku](#heroku)
  - [Railway](#railway)
  - [Netlify](#netlify)
  - [Docker](#docker)
- [Post-Deployment](#post-deployment)
- [Troubleshooting](#troubleshooting)

## Prerequisites

Before deploying, ensure you have:

- A GitHub account (for most deployment platforms)
- Node.js 20.x or later installed locally (for testing)
- Git installed and configured
- Account on your chosen deployment platform

## Environment Variables

The application requires the following environment variables:

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `JWT_SECRET` | Secret key for JWT token generation and verification | Yes | `changeme` (not secure) |
| `PORT` | Port number for the server | No | `4000` |

**Important**: Always use a strong, randomly generated `JWT_SECRET` in production. You can generate one using:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Deployment Platforms

### Vercel

Vercel is a serverless platform that's great for Node.js applications.

#### Deploy via Vercel Dashboard

1. Fork or clone this repository to your GitHub account
2. Go to [Vercel](https://vercel.com) and sign in
3. Click "Add New Project"
4. Import your GitHub repository
5. Configure the project:
   - **Framework Preset**: Other
   - **Root Directory**: Leave as `./`
   - **Build Command**: Leave empty
   - **Output Directory**: Leave empty
6. Add environment variables:
   - `JWT_SECRET`: Your secure secret key
7. Click "Deploy"

#### Deploy via Vercel CLI

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
cd /path/to/gov-search-app
vercel

# Follow the prompts and set environment variables when asked
```

#### Configuration File

The deployment is configured via `vercel.json` in the repository root.

**Note**: Vercel's serverless environment has limitations with SQLite. Consider using a hosted database service like PlanetScale (MySQL) or Neon (PostgreSQL) for production deployments on Vercel.

---

### Heroku

Heroku is a container-based cloud platform that's easy to use.

#### One-Click Deploy

Click the button below to deploy to Heroku:

[![Deploy to Heroku](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/tara32473/gov-search-app)

#### Manual Deploy via Heroku CLI

```bash
# Install Heroku CLI from https://devcenter.heroku.com/articles/heroku-cli

# Login to Heroku
heroku login

# Create a new Heroku app
cd /path/to/gov-search-app
heroku create your-app-name

# Set environment variables
heroku config:set JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# Deploy
git push heroku main

# Open your app
heroku open
```

#### Configuration Files

- `Procfile`: Defines the process to run
- `app.json`: Defines the app configuration for one-click deploys

**Note**: The SQLite database will be ephemeral on Heroku's free tier. For persistent data, upgrade to a paid dyno or use a hosted database.

---

### Railway

Railway is a modern deployment platform with excellent developer experience.

#### Deploy via Railway Dashboard

1. Go to [Railway](https://railway.app) and sign in
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Choose your repository
5. Railway will auto-detect the Node.js app
6. Add environment variables in the project settings:
   - `JWT_SECRET`: Your secure secret key
7. Deploy!

#### Deploy via Railway CLI

```bash
# Install Railway CLI
npm i -g @railway/cli

# Login
railway login

# Initialize and link project
cd /path/to/gov-search-app
railway init

# Set environment variables
railway variables set JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# Deploy
railway up
```

#### Configuration File

The deployment is configured via `railway.json` in the repository root.

**Note**: Railway provides persistent storage, so SQLite will work well here.

---

### Netlify

Netlify is primarily for static sites but supports serverless functions.

#### Deploy via Netlify Dashboard

1. Go to [Netlify](https://netlify.com) and sign in
2. Click "Add new site" → "Import an existing project"
3. Connect to your Git provider and select the repository
4. Configure the build settings:
   - **Base directory**: `backend`
   - **Build command**: `npm install`
   - **Publish directory**: `backend`
5. Add environment variables in Site settings → Environment variables:
   - `JWT_SECRET`: Your secure secret key
6. Deploy!

#### Deploy via Netlify CLI

```bash
# Install Netlify CLI
npm i -g netlify-cli

# Login
netlify login

# Initialize site
cd /path/to/gov-search-app
netlify init

# Set environment variables
netlify env:set JWT_SECRET "your-secret-here"

# Deploy
netlify deploy --prod
```

#### Configuration File

The deployment is configured via `netlify.toml` in the repository root.

**Note**: Netlify uses serverless functions which have limitations with SQLite. Consider using a hosted database for production.

---

### Docker

You can also deploy using Docker to any platform that supports containers.

#### Build and Run Locally

```bash
cd /path/to/gov-search-app/backend

# Build the image
docker build -t gov-search-backend .

# Run the container
docker run -d -p 4000:4000 \
  -e JWT_SECRET="your-secret-here" \
  --name gov-search-api \
  gov-search-backend

# Test
curl http://localhost:4000/api/search
```

#### Deploy to Docker Hub and Cloud Services

```bash
# Tag and push to Docker Hub
docker tag gov-search-backend yourusername/gov-search-backend
docker push yourusername/gov-search-backend

# Then deploy to:
# - AWS ECS/Fargate
# - Google Cloud Run
# - Azure Container Instances
# - DigitalOcean App Platform
# - etc.
```

---

## Post-Deployment

After deploying, verify your application:

1. **Test the API endpoints**:
   ```bash
   # Register a user
   curl -X POST https://your-app-url/api/register \
     -H "Content-Type: application/json" \
     -d '{"username":"testuser","password":"testpass123"}'
   
   # Login
   curl -X POST https://your-app-url/api/login \
     -H "Content-Type: application/json" \
     -d '{"username":"testuser","password":"testpass123"}'
   
   # Search (use token from login response)
   curl https://your-app-url/api/search?name=Smith \
     -H "Authorization: Bearer YOUR_TOKEN_HERE"
   ```

2. **Monitor logs**: Check your platform's logging dashboard for any errors

3. **Set up monitoring**: Consider adding application monitoring (e.g., Sentry, LogRocket)

4. **Configure custom domain** (optional): Most platforms allow you to add a custom domain

## Troubleshooting

### Common Issues

#### Database Issues

**Problem**: Data not persisting across deployments
- **Solution**: Use a hosted database service instead of SQLite, or ensure your platform provides persistent storage

**Problem**: SQLite errors in serverless environments
- **Solution**: Switch to a hosted database (PostgreSQL, MySQL) or use a platform with persistent file storage

#### Environment Variables

**Problem**: JWT authentication failing
- **Solution**: Ensure `JWT_SECRET` is set correctly in your platform's environment variables

#### Port Issues

**Problem**: App not starting or connection refused
- **Solution**: Ensure `PORT` environment variable is not hardcoded and respects `process.env.PORT`

#### Build Failures

**Problem**: npm install fails
- **Solution**: Check that `package.json` is properly formatted and all dependencies are available

### Getting Help

- Check the [Issues](https://github.com/tara32473/gov-search-app/issues) page
- Review platform-specific documentation:
  - [Vercel Docs](https://vercel.com/docs)
  - [Heroku Docs](https://devcenter.heroku.com/)
  - [Railway Docs](https://docs.railway.app/)
  - [Netlify Docs](https://docs.netlify.com/)
- Open a new issue if you encounter problems

---

## Security Considerations

1. **Always use a strong JWT_SECRET** - Never use the default value in production
2. **Use HTTPS** - All deployment platforms provide HTTPS by default
3. **Rate limiting** - Consider adding rate limiting middleware for production
4. **Database security** - Use a hosted database service with proper authentication
5. **Environment variables** - Never commit secrets to version control

---

For more information about the API endpoints, see [API.md](API.md).
