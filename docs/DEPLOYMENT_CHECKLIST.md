# Deployment Checklist

Use this checklist to ensure your deployment is configured correctly and securely.

## Pre-Deployment

### Security
- [ ] Generated a strong, random `JWT_SECRET` (minimum 32 characters)
  - Use: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- [ ] Reviewed all environment variables
- [ ] Ensured no secrets are committed to version control
- [ ] Checked that `.env` is in `.gitignore`

### Code Quality
- [ ] All tests pass locally
- [ ] Backend starts without errors
- [ ] API endpoints tested manually
- [ ] Docker build succeeds (if using Docker)
- [ ] Dependencies are up to date

### Configuration
- [ ] Selected deployment platform (Vercel, Heroku, Railway, Netlify, Docker)
- [ ] Reviewed platform-specific documentation in [DEPLOYMENT.md](DEPLOYMENT.md)
- [ ] Configured environment variables on deployment platform
- [ ] Verified deployment configuration file exists for chosen platform

## During Deployment

### Platform Setup
- [ ] Created account on deployment platform
- [ ] Connected GitHub repository
- [ ] Set all required environment variables
- [ ] Configured custom domain (optional)

### Deployment Process
- [ ] Triggered first deployment
- [ ] Monitored deployment logs for errors
- [ ] Verified deployment completed successfully
- [ ] Checked application health endpoint

## Post-Deployment

### Verification
- [ ] Tested `/api/register` endpoint
- [ ] Tested `/api/login` endpoint
- [ ] Tested `/api/search` endpoint with authentication
- [ ] Verified JWT tokens are being generated
- [ ] Checked database connection (SQLite or hosted DB)

### Monitoring
- [ ] Set up error logging/monitoring (e.g., Sentry, LogRocket)
- [ ] Configured uptime monitoring (e.g., UptimeRobot, Pingdom)
- [ ] Reviewed platform logs for any warnings
- [ ] Set up alerts for downtime/errors

### Documentation
- [ ] Updated README with deployment URL
- [ ] Documented any platform-specific configuration
- [ ] Shared API documentation with team
- [ ] Updated API.md with production URL

### Performance
- [ ] Tested API response times
- [ ] Verified CORS is working for frontend
- [ ] Checked rate limiting (if implemented)
- [ ] Tested under expected load

## Platform-Specific Considerations

### Vercel
- [ ] Note: SQLite may not persist; consider using a hosted database
- [ ] Verified serverless function limits (10-second timeout on free tier)
- [ ] Configured environment variables in Vercel dashboard

### Heroku
- [ ] Note: Free tier dynos sleep after 30 minutes of inactivity
- [ ] Note: Filesystem is ephemeral; data may be lost on restart
- [ ] Consider using Heroku Postgres for persistent data
- [ ] Configured Procfile for process management

### Railway
- [ ] Railway provides persistent disk storage
- [ ] SQLite will work well on Railway
- [ ] Configured railway.json for build and deploy commands

### Netlify
- [ ] Note: Best for serverless, not for long-running processes
- [ ] Consider using Netlify Functions
- [ ] May need hosted database for production use

### Docker
- [ ] Volume configured for persistent data (if needed)
- [ ] Health check configured
- [ ] Resource limits set appropriately
- [ ] Container registry configured (if pushing to registry)

## Troubleshooting Checklist

If deployment fails:
- [ ] Check deployment logs for specific errors
- [ ] Verify all environment variables are set correctly
- [ ] Ensure Node.js version matches (20.x recommended)
- [ ] Check that package.json is valid JSON
- [ ] Verify all dependencies are listed in package.json
- [ ] Test build process locally
- [ ] Check platform-specific limitations

## Security Checklist

- [ ] HTTPS is enabled (should be automatic on most platforms)
- [ ] JWT_SECRET is unique and strong
- [ ] Environment variables are not exposed in client-side code
- [ ] CORS is configured appropriately
- [ ] Rate limiting is implemented (recommended for production)
- [ ] Input validation is in place
- [ ] SQL injection protection (using parameterized queries)
- [ ] Password hashing is using bcrypt with appropriate rounds

## Rollback Plan

- [ ] Documented how to rollback to previous version
- [ ] Tested rollback procedure
- [ ] Database backup strategy in place (if using hosted DB)
- [ ] Know how to access previous deployment logs

## Success Criteria

Your deployment is successful when:
- ✅ Application is accessible via public URL
- ✅ All API endpoints respond correctly
- ✅ Authentication works (register, login)
- ✅ Database queries work
- ✅ No errors in deployment logs
- ✅ HTTPS is working
- ✅ Environment variables are loaded correctly

---

**Next Steps After Successful Deployment:**

1. Share the API URL with your team
2. Update documentation with production URL
3. Set up continuous deployment (CI/CD)
4. Monitor application performance
5. Plan for scaling as needed

For detailed deployment instructions, see [DEPLOYMENT.md](DEPLOYMENT.md).
