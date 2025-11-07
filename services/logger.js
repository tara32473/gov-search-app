const winston = require('winston');
const path = require('path');

// Custom log format
const logFormat = winston.format.combine(
    winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.json()
);

// Create logger instance
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: logFormat,
    defaultMeta: { 
        service: 'gov-watchdog-api',
        version: process.env.APP_VERSION || '1.0.0'
    },
    transports: [
        // File transports for production
        new winston.transports.File({
            filename: path.join(__dirname, '../logs/error.log'),
            level: 'error',
            maxsize: 5242880, // 5MB
            maxFiles: 10
        }),
        new winston.transports.File({
            filename: path.join(__dirname, '../logs/combined.log'),
            maxsize: 5242880, // 5MB
            maxFiles: 10
        }),
        new winston.transports.File({
            filename: path.join(__dirname, '../logs/api-access.log'),
            level: 'info',
            maxsize: 5242880, // 5MB
            maxFiles: 20
        })
    ]
});

// Add console transport for development
if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
        )
    }));
}

// Performance monitoring middleware
const performanceLogger = (req, res, next) => {
    const startTime = Date.now();
    
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        const logData = {
            method: req.method,
            url: req.url,
            status: res.statusCode,
            duration: duration,
            ip: req.ip,
            userAgent: req.get('User-Agent'),
            userId: req.user ? req.user.id : null
        };
        
        // Log slow requests as warnings
        if (duration > 2000) {
            logger.warn('Slow request detected', logData);
        } else {
            logger.info('API request', logData);
        }
    });
    
    next();
};

// Error logging middleware
const errorLogger = (error, req, res, next) => {
    logger.error('Application error', {
        error: error.message,
        stack: error.stack,
        url: req.url,
        method: req.method,
        ip: req.ip,
        userId: req.user ? req.user.id : null
    });
    
    next(error);
};

// Security event logger
const securityLogger = {
    logFailedAuth: (req, username) => {
        logger.warn('Authentication failed', {
            username,
            ip: req.ip,
            userAgent: req.get('User-Agent'),
            event: 'failed_auth'
        });
    },
    
    logRateLimit: (req) => {
        logger.warn('Rate limit exceeded', {
            ip: req.ip,
            url: req.url,
            userAgent: req.get('User-Agent'),
            event: 'rate_limit'
        });
    },
    
    logSuspiciousActivity: (req, activity) => {
        logger.error('Suspicious activity detected', {
            activity,
            ip: req.ip,
            url: req.url,
            userAgent: req.get('User-Agent'),
            event: 'suspicious_activity'
        });
    }
};

// System health monitoring
class HealthMonitor {
    constructor() {
        this.metrics = {
            requests: 0,
            errors: 0,
            startTime: Date.now()
        };
        
        // Log system metrics every 5 minutes
        setInterval(() => {
            this.logSystemMetrics();
        }, 5 * 60 * 1000);
    }
    
    logSystemMetrics() {
        const uptime = process.uptime();
        const memoryUsage = process.memoryUsage();
        
        logger.info('System metrics', {
            uptime: uptime,
            memory: {
                rss: memoryUsage.rss,
                heapUsed: memoryUsage.heapUsed,
                heapTotal: memoryUsage.heapTotal,
                external: memoryUsage.external
            },
            requests: this.metrics.requests,
            errors: this.metrics.errors,
            errorRate: this.metrics.errors / this.metrics.requests
        });
    }
    
    incrementRequests() {
        this.metrics.requests++;
    }
    
    incrementErrors() {
        this.metrics.errors++;
    }
}

const healthMonitor = new HealthMonitor();

module.exports = {
    logger,
    performanceLogger,
    errorLogger,
    securityLogger,
    healthMonitor
};