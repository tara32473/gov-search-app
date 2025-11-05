# Government Watchdog App - Production Deployment Guide

## 🚀 Production Deployment Checklist

### Prerequisites
- [ ] Linux server (Ubuntu 20.04+ recommended)
- [ ] Docker and Docker Compose installed
- [ ] Domain name configured
- [ ] SSL certificate (Let's Encrypt recommended)
- [ ] API keys for government data sources

### 1. Environment Setup

#### Required API Keys
```bash
# Get these API keys from:
CONGRESS_API_KEY=          # https://api.congress.gov/sign-up/
OPENSECRETS_API_KEY=       # https://www.opensecrets.org/api/admin/index.php
PROPUBLICA_API_KEY=        # https://www.propublica.org/datastore/api/propublica-congress-api
USASPENDING_API_KEY=       # https://api.usaspending.gov/ (free)
```

#### Database Setup
```bash
# Create production environment file
cp backend/.env.production backend/.env

# Update with your production values:
# - Database credentials
# - API keys
# - Domain name
# - Email configuration
```

### 2. Server Setup

#### Install Docker
```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
sudo curl -L "https://github.com/docker/compose/releases/download/v2.21.0/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
```

#### Clone and Configure
```bash
git clone https://github.com/yourusername/gov-search-app.git
cd gov-search-app

# Set up environment variables
nano backend/.env.production

# Create necessary directories
mkdir -p logs database/init nginx/ssl
```

### 3. SSL Certificate Setup

#### Using Let's Encrypt (Recommended)
```bash
# Install certbot
sudo apt update
sudo apt install certbot

# Get SSL certificate
sudo certbot certonly --standalone -d yourdomain.com

# Copy certificates
sudo cp /etc/letsencrypt/live/yourdomain.com/fullchain.pem nginx/ssl/
sudo cp /etc/letsencrypt/live/yourdomain.com/privkey.pem nginx/ssl/
sudo chown -R $USER:$USER nginx/ssl/
```

### 4. Nginx Configuration

Create `nginx/nginx.conf`:
```nginx
events {
    worker_connections 1024;
}

http {
    upstream app {
        server app:4000;
    }

    # Rate limiting
    limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;

    server {
        listen 80;
        server_name yourdomain.com;
        return 301 https://$host$request_uri;
    }

    server {
        listen 443 ssl http2;
        server_name yourdomain.com;

        ssl_certificate /etc/nginx/ssl/fullchain.pem;
        ssl_certificate_key /etc/nginx/ssl/privkey.pem;

        # Security headers
        add_header X-Frame-Options DENY;
        add_header X-Content-Type-Options nosniff;
        add_header X-XSS-Protection "1; mode=block";
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains";

        # API routes
        location /api/ {
            limit_req zone=api burst=20 nodelay;
            proxy_pass http://app;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }

        # Static files
        location / {
            proxy_pass http://app;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        }
    }
}
```

### 5. Deploy Application

```bash
# Set environment variables
export POSTGRES_PASSWORD=your-secure-password
export REDIS_PASSWORD=your-redis-password

# Start the application
docker-compose up -d

# Check status
docker-compose ps
docker-compose logs app
```

### 6. Database Initialization

```bash
# Run database migrations
docker-compose exec app node -e "
const DatabaseService = require('./services/database');
const db = new DatabaseService();
db.createTables().then(() => process.exit(0));
"

# Import initial data
docker-compose exec app node -e "
const GovernmentAPIService = require('./services/governmentAPI');
const api = new GovernmentAPIService();
// Run initial data import
"
```

### 7. Monitoring Setup

#### Log Monitoring
```bash
# View logs
docker-compose logs -f app
tail -f logs/combined.log

# Set up log rotation
sudo nano /etc/logrotate.d/gov-watchdog
```

#### Health Checks
```bash
# Check application health
curl https://yourdomain.com/api/health

# Monitor with cron
echo "*/5 * * * * curl -f https://yourdomain.com/api/health || echo 'Health check failed' | mail admin@yourdomain.com" | crontab -
```

### 8. Backup Strategy

```bash
# Database backup script
#!/bin/bash
docker-compose exec -T db pg_dump -U postgres gov_watchdog > backup_$(date +%Y%m%d_%H%M%S).sql

# Add to crontab for daily backups
0 2 * * * /path/to/backup-script.sh
```

### 9. Security Hardening

#### Firewall Setup
```bash
sudo ufw enable
sudo ufw allow 22   # SSH
sudo ufw allow 80   # HTTP
sudo ufw allow 443  # HTTPS
```

#### Fail2Ban
```bash
sudo apt install fail2ban

# Configure fail2ban for nginx
sudo nano /etc/fail2ban/jail.local
```

### 10. Performance Optimization

#### Redis Configuration
```bash
# Optimize Redis for caching
echo "maxmemory 256mb" >> redis.conf
echo "maxmemory-policy allkeys-lru" >> redis.conf
```

#### Database Optimization
```sql
-- Run these optimizations
VACUUM ANALYZE;
REINDEX DATABASE gov_watchdog;
```

### 11. Maintenance

#### Update Process
```bash
# Update application
git pull origin main
docker-compose build app
docker-compose up -d app

# Update dependencies
docker-compose exec app npm audit fix
```

#### Scaling
```bash
# Scale application instances
docker-compose up -d --scale app=3
```

## 🔧 Troubleshooting

### Common Issues

1. **SSL Certificate Issues**
   ```bash
   # Check certificate validity
   openssl x509 -in nginx/ssl/fullchain.pem -text -noout
   ```

2. **Database Connection Issues**
   ```bash
   # Check database connectivity
   docker-compose exec app node -e "console.log(process.env.DATABASE_URL)"
   ```

3. **API Rate Limits**
   ```bash
   # Monitor API usage
   grep "rate limit" logs/combined.log
   ```

## 📊 Monitoring Dashboard

Access your monitoring at:
- Application: https://yourdomain.com
- Health: https://yourdomain.com/api/health
- Logs: `/var/log/gov-watchdog/`

## 🔄 Continuous Deployment

Set up GitHub Actions for automatic deployment:
```yaml
# .github/workflows/deploy.yml
name: Deploy to Production
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Deploy
        run: |
          ssh user@server "cd /path/to/app && git pull && docker-compose up -d --build"
```

## 📧 Support

For production support:
- Monitor logs: `docker-compose logs -f`
- Check health: `curl https://yourdomain.com/api/health`
- Database status: `docker-compose exec db pg_isready`