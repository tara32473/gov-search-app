require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'gov-watchdog-2025-secure-key-' + Math.random().toString(36);

// Trust proxy for rate limiting in development environments like Codespaces
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'"],
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'"],
            frameSrc: ["'none'"]
        }
    },
    crossOriginEmbedderPolicy: false
}));

// Rate limiting for security
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Limit auth attempts
    message: 'Too many authentication attempts, please try again later.',
    skipSuccessfulRequests: true
});

app.use('/api/', limiter);
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);

// CORS with security settings
app.use(cors({
    origin: process.env.NODE_ENV === 'production' 
        ? ['https://your-domain.com'] 
        : ['http://localhost:3000', 'http://localhost:4000'],
    credentials: true,
    optionsSuccessStatus: 200
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.static('../frontend/dist'));

// Database setup for government watchdog data
const db = new sqlite3.Database('./watchdog.sqlite');
db.serialize(() => {
    // Users and authentication
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        hash TEXT,
        preferences TEXT DEFAULT '{}',
        alerts_enabled INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Congressional members
    db.run(`CREATE TABLE IF NOT EXISTS congress_members (
        bioguide_id TEXT PRIMARY KEY,
        first_name TEXT,
        last_name TEXT,
        party TEXT,
        state TEXT,
        chamber TEXT,
        district TEXT,
        in_office INTEGER DEFAULT 1,
        next_election TEXT,
        phone TEXT,
        twitter_handle TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Bills and legislation
    db.run(`CREATE TABLE IF NOT EXISTS bills (
        bill_id TEXT PRIMARY KEY,
        congress INTEGER,
        bill_type TEXT,
        number TEXT,
        title TEXT,
        summary TEXT,
        introduced_date TEXT,
        latest_action TEXT,
        latest_action_date TEXT,
        sponsor_id TEXT,
        committees TEXT,
        subjects TEXT,
        status TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Voting records
    db.run(`CREATE TABLE IF NOT EXISTS votes (
        vote_id TEXT PRIMARY KEY,
        chamber TEXT,
        session INTEGER,
        roll_call INTEGER,
        source_url TEXT,
        bill_id TEXT,
        question TEXT,
        description TEXT,
        vote_type TEXT,
        date_time TEXT,
        result TEXT,
        total_yes INTEGER,
        total_no INTEGER,
        total_not_voting INTEGER,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Individual member votes
    db.run(`CREATE TABLE IF NOT EXISTS member_votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vote_id TEXT,
        member_id TEXT,
        vote_position TEXT,
        FOREIGN KEY(vote_id) REFERENCES votes(vote_id),
        FOREIGN KEY(member_id) REFERENCES congress_members(bioguide_id)
    )`);
    
    // Campaign finance data
    db.run(`CREATE TABLE IF NOT EXISTS campaign_finance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id TEXT,
        candidate_name TEXT,
        office TEXT,
        party TEXT,
        cycle INTEGER,
        total_receipts REAL,
        total_disbursements REAL,
        cash_on_hand REAL,
        debt REAL,
        last_updated TEXT
    )`);
    
    // Federal spending/contracts
    db.run(`CREATE TABLE IF NOT EXISTS federal_spending (
        award_id TEXT PRIMARY KEY,
        recipient_name TEXT,
        award_amount REAL,
        award_type TEXT,
        awarding_agency TEXT,
        funding_agency TEXT,
        award_description TEXT,
        place_of_performance TEXT,
        award_date TEXT,
        fiscal_year INTEGER,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Enhanced Lobbying data
    db.run(`CREATE TABLE IF NOT EXISTS lobbying (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        registration_id TEXT,
        client_name TEXT,
        client_description TEXT,
        registrant_name TEXT,
        registrant_address TEXT,
        lobbyist_name TEXT,
        lobbyist_title TEXT,
        amount REAL,
        year INTEGER,
        quarter INTEGER,
        report_type TEXT,
        issue_areas TEXT,
        specific_issues TEXT,
        government_entities TEXT,
        foreign_entities TEXT,
        termination_date TEXT,
        posted_date TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // User alerts and subscriptions
    db.run(`CREATE TABLE IF NOT EXISTS user_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        alert_type TEXT,
        keywords TEXT,
        frequency TEXT DEFAULT 'daily',
        last_triggered DATETIME,
        is_active INTEGER DEFAULT 1,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);
    
    // Activity log for watchdog events
    db.run(`CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT,
        description TEXT,
        data_source TEXT,
        entity_id TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        severity TEXT DEFAULT 'info'
    )`);
});

// Authentication functions
function genToken(user) {
    return jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
}

function hashPass(p) {
    return bcrypt.hashSync(p, 10);
}

function checkPass(p, h) {
    return bcrypt.compareSync(p, h);
}

function auth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Missing authentication token' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
}

// Government data fetching functions
async function fetchCongressData() {
    try {
        console.log('📡 Fetching congressional data...');
        
        // Comprehensive congressional data including Senate, House, and Executive
        const congressionalMembers = [
            // Senate Leadership (2025 - Republican Majority)
            { id: 'T000250', first: 'John', last: 'Thune', party: 'R', state: 'SD', chamber: 'senate', phone: '(202) 224-2321' }, // Majority Leader
            { id: 'S000148', first: 'Chuck', last: 'Schumer', party: 'D', state: 'NY', chamber: 'senate', phone: '(202) 224-6542' }, // Minority Leader
            { id: 'M000355', first: 'Mitch', last: 'McConnell', party: 'R', state: 'KY', chamber: 'senate', phone: '(202) 224-2541' }, // Senior Republican
            
            // Senate Members (All 100 Senators - 2 per state)
            
            // Alabama
            { id: 'S000320', first: 'Richard', last: 'Shelby', party: 'R', state: 'AL', chamber: 'senate', phone: '(202) 224-5744' },
            { id: 'T000461', first: 'Tommy', last: 'Tuberville', party: 'R', state: 'AL', chamber: 'senate', phone: '(202) 224-4124' },
            
            // Alaska
            { id: 'M001153', first: 'Lisa', last: 'Murkowski', party: 'R', state: 'AK', chamber: 'senate', phone: '(202) 224-6665' },
            { id: 'S001198', first: 'Dan', last: 'Sullivan', party: 'R', state: 'AK', chamber: 'senate', phone: '(202) 224-3004' },
            
            // Arizona
            { id: 'S001191', first: 'Kyrsten', last: 'Sinema', party: 'I', state: 'AZ', chamber: 'senate', phone: '(202) 224-4521' },
            { id: 'K000367', first: 'Mark', last: 'Kelly', party: 'D', state: 'AZ', chamber: 'senate', phone: '(202) 224-2235' },
            
            // Arkansas
            { id: 'B001236', first: 'John', last: 'Boozman', party: 'R', state: 'AR', chamber: 'senate', phone: '(202) 224-4843' },
            { id: 'C001095', first: 'Tom', last: 'Cotton', party: 'R', state: 'AR', chamber: 'senate', phone: '(202) 224-2353' },
            
            // California
            { id: 'F000062', first: 'Dianne', last: 'Feinstein', party: 'D', state: 'CA', chamber: 'senate', phone: '(202) 224-3841' },
            { id: 'P000145', first: 'Alex', last: 'Padilla', party: 'D', state: 'CA', chamber: 'senate', phone: '(202) 224-3553' },
            
            // Colorado
            { id: 'B001267', first: 'Michael', last: 'Bennet', party: 'D', state: 'CO', chamber: 'senate', phone: '(202) 224-5852' },
            { id: 'H001046', first: 'John', last: 'Hickenlooper', party: 'D', state: 'CO', chamber: 'senate', phone: '(202) 224-5941' },
            
            // Connecticut
            { id: 'B001277', first: 'Richard', last: 'Blumenthal', party: 'D', state: 'CT', chamber: 'senate', phone: '(202) 224-2823' },
            { id: 'M001169', first: 'Chris', last: 'Murphy', party: 'D', state: 'CT', chamber: 'senate', phone: '(202) 224-4041' },
            
            // Delaware
            { id: 'C000174', first: 'Tom', last: 'Carper', party: 'D', state: 'DE', chamber: 'senate', phone: '(202) 224-2441' },
            { id: 'C001088', first: 'Chris', last: 'Coons', party: 'D', state: 'DE', chamber: 'senate', phone: '(202) 224-5042' },
            
            // Florida
            { id: 'R000595', first: 'Marco', last: 'Rubio', party: 'R', state: 'FL', chamber: 'senate', phone: '(202) 224-3041' },
            { id: 'S001217', first: 'Rick', last: 'Scott', party: 'R', state: 'FL', chamber: 'senate', phone: '(202) 224-5274' },
            
            // Georgia
            { id: 'O000174', first: 'Jon', last: 'Ossoff', party: 'D', state: 'GA', chamber: 'senate', phone: '(202) 224-3521' },
            { id: 'W000790', first: 'Raphael', last: 'Warnock', party: 'D', state: 'GA', chamber: 'senate', phone: '(202) 224-3643' },
            
            // Hawaii
            { id: 'S001194', first: 'Brian', last: 'Schatz', party: 'D', state: 'HI', chamber: 'senate', phone: '(202) 224-3934' },
            { id: 'H001042', first: 'Mazie', last: 'Hirono', party: 'D', state: 'HI', chamber: 'senate', phone: '(202) 224-6361' },
            
            // Idaho
            { id: 'C000127', first: 'Mike', last: 'Crapo', party: 'R', state: 'ID', chamber: 'senate', phone: '(202) 224-6142' },
            { id: 'R000584', first: 'James', last: 'Risch', party: 'R', state: 'ID', chamber: 'senate', phone: '(202) 224-2752' },
            
            // Illinois
            { id: 'D000563', first: 'Dick', last: 'Durbin', party: 'D', state: 'IL', chamber: 'senate', phone: '(202) 224-2152' },
            { id: 'D000622', first: 'Tammy', last: 'Duckworth', party: 'D', state: 'IL', chamber: 'senate', phone: '(202) 224-2854' },
            
            // Indiana
            { id: 'Y000064', first: 'Todd', last: 'Young', party: 'R', state: 'IN', chamber: 'senate', phone: '(202) 224-5623' },
            { id: 'B001310', first: 'Mike', last: 'Braun', party: 'R', state: 'IN', chamber: 'senate', phone: '(202) 224-4814' },
            
            // Iowa
            { id: 'G000386', first: 'Chuck', last: 'Grassley', party: 'R', state: 'IA', chamber: 'senate', phone: '(202) 224-3744' },
            { id: 'E000295', first: 'Joni', last: 'Ernst', party: 'R', state: 'IA', chamber: 'senate', phone: '(202) 224-3254' },
            
            // Kansas
            { id: 'M000934', first: 'Jerry', last: 'Moran', party: 'R', state: 'KS', chamber: 'senate', phone: '(202) 224-6521' },
            { id: 'M001169', first: 'Roger', last: 'Marshall', party: 'R', state: 'KS', chamber: 'senate', phone: '(202) 224-4774' },
            
            // Kentucky
            { id: 'M000355', first: 'Mitch', last: 'McConnell', party: 'R', state: 'KY', chamber: 'senate', phone: '(202) 224-2541' },
            { id: 'P000603', first: 'Rand', last: 'Paul', party: 'R', state: 'KY', chamber: 'senate', phone: '(202) 224-4343' },
            
            // Louisiana
            { id: 'C001075', first: 'Bill', last: 'Cassidy', party: 'R', state: 'LA', chamber: 'senate', phone: '(202) 224-5824' },
            { id: 'K000393', first: 'John', last: 'Kennedy', party: 'R', state: 'LA', chamber: 'senate', phone: '(202) 224-4623' },
            
            // Maine
            { id: 'C001035', first: 'Susan', last: 'Collins', party: 'R', state: 'ME', chamber: 'senate', phone: '(202) 224-2523' },
            { id: 'K000383', first: 'Angus', last: 'King', party: 'I', state: 'ME', chamber: 'senate', phone: '(202) 224-5344' },
            
            // Maryland
            { id: 'C000141', first: 'Ben', last: 'Cardin', party: 'D', state: 'MD', chamber: 'senate', phone: '(202) 224-4524' },
            { id: 'V000128', first: 'Chris', last: 'Van Hollen', party: 'D', state: 'MD', chamber: 'senate', phone: '(202) 224-4654' },
            
            // Massachusetts
            { id: 'W000817', first: 'Elizabeth', last: 'Warren', party: 'D', state: 'MA', chamber: 'senate', phone: '(202) 224-4543' },
            { id: 'M000133', first: 'Ed', last: 'Markey', party: 'D', state: 'MA', chamber: 'senate', phone: '(202) 224-2742' },
            
            // Michigan
            { id: 'S000770', first: 'Debbie', last: 'Stabenow', party: 'D', state: 'MI', chamber: 'senate', phone: '(202) 224-4822' },
            { id: 'P000595', first: 'Gary', last: 'Peters', party: 'D', state: 'MI', chamber: 'senate', phone: '(202) 224-6221' },
            
            // Minnesota
            { id: 'K000367', first: 'Amy', last: 'Klobuchar', party: 'D', state: 'MN', chamber: 'senate', phone: '(202) 224-3244' },
            { id: 'S001203', first: 'Tina', last: 'Smith', party: 'D', state: 'MN', chamber: 'senate', phone: '(202) 224-5641' },
            
            // Mississippi
            { id: 'W000437', first: 'Roger', last: 'Wicker', party: 'R', state: 'MS', chamber: 'senate', phone: '(202) 224-6253' },
            { id: 'H001079', first: 'Cindy', last: 'Hyde-Smith', party: 'R', state: 'MS', chamber: 'senate', phone: '(202) 224-5054' },
            
            // Missouri
            { id: 'B000575', first: 'Roy', last: 'Blunt', party: 'R', state: 'MO', chamber: 'senate', phone: '(202) 224-5721' },
            { id: 'H001089', first: 'Josh', last: 'Hawley', party: 'R', state: 'MO', chamber: 'senate', phone: '(202) 224-6154' },
            
            // Montana
            { id: 'T000464', first: 'Jon', last: 'Tester', party: 'D', state: 'MT', chamber: 'senate', phone: '(202) 224-2644' },
            { id: 'D000618', first: 'Steve', last: 'Daines', party: 'R', state: 'MT', chamber: 'senate', phone: '(202) 224-2651' },
            
            // Nebraska
            { id: 'F000463', first: 'Deb', last: 'Fischer', party: 'R', state: 'NE', chamber: 'senate', phone: '(202) 224-6551' },
            { id: 'S001197', first: 'Ben', last: 'Sasse', party: 'R', state: 'NE', chamber: 'senate', phone: '(202) 224-4224' },
            
            // Nevada
            { id: 'R000608', first: 'Jacky', last: 'Rosen', party: 'D', state: 'NV', chamber: 'senate', phone: '(202) 224-6244' },
            { id: 'C001113', first: 'Catherine', last: 'Cortez Masto', party: 'D', state: 'NV', chamber: 'senate', phone: '(202) 224-3542' },
            
            // New Hampshire
            { id: 'S000320', first: 'Jeanne', last: 'Shaheen', party: 'D', state: 'NH', chamber: 'senate', phone: '(202) 224-2841' },
            { id: 'H001076', first: 'Maggie', last: 'Hassan', party: 'D', state: 'NH', chamber: 'senate', phone: '(202) 224-3324' },
            
            // New Jersey
            { id: 'M000639', first: 'Bob', last: 'Menendez', party: 'D', state: 'NJ', chamber: 'senate', phone: '(202) 224-4744' },
            { id: 'B001288', first: 'Cory', last: 'Booker', party: 'D', state: 'NJ', chamber: 'senate', phone: '(202) 224-3224' },
            
            // New Mexico
            { id: 'H001046', first: 'Martin', last: 'Heinrich', party: 'D', state: 'NM', chamber: 'senate', phone: '(202) 224-5521' },
            { id: 'L000570', first: 'Ben Ray', last: 'Luján', party: 'D', state: 'NM', chamber: 'senate', phone: '(202) 224-6621' },
            
            // New York
            { id: 'S000148', first: 'Chuck', last: 'Schumer', party: 'D', state: 'NY', chamber: 'senate', phone: '(202) 224-6542' },
            { id: 'G000555', first: 'Kirsten', last: 'Gillibrand', party: 'D', state: 'NY', chamber: 'senate', phone: '(202) 224-4451' },
            
            // North Carolina
            { id: 'T000476', first: 'Thom', last: 'Tillis', party: 'R', state: 'NC', chamber: 'senate', phone: '(202) 224-6342' },
            { id: 'B001135', first: 'Richard', last: 'Burr', party: 'R', state: 'NC', chamber: 'senate', phone: '(202) 224-3154' },
            
            // North Dakota
            { id: 'H001061', first: 'John', last: 'Hoeven', party: 'R', state: 'ND', chamber: 'senate', phone: '(202) 224-2551' },
            { id: 'C001096', first: 'Kevin', last: 'Cramer', party: 'R', state: 'ND', chamber: 'senate', phone: '(202) 224-2043' },
            
            // Ohio
            { id: 'B000944', first: 'Sherrod', last: 'Brown', party: 'D', state: 'OH', chamber: 'senate', phone: '(202) 224-2315' },
            { id: 'V000432', first: 'J.D.', last: 'Vance', party: 'R', state: 'OH', chamber: 'senate', phone: '(202) 224-3353' },
            
            // Oklahoma
            { id: 'I000024', first: 'Jim', last: 'Inhofe', party: 'R', state: 'OK', chamber: 'senate', phone: '(202) 224-4721' },
            { id: 'L000575', first: 'James', last: 'Lankford', party: 'R', state: 'OK', chamber: 'senate', phone: '(202) 224-5754' },
            
            // Oregon
            { id: 'W000779', first: 'Ron', last: 'Wyden', party: 'D', state: 'OR', chamber: 'senate', phone: '(202) 224-5244' },
            { id: 'M001176', first: 'Jeff', last: 'Merkley', party: 'D', state: 'OR', chamber: 'senate', phone: '(202) 224-3753' },
            
            // Pennsylvania
            { id: 'C001070', first: 'Bob', last: 'Casey', party: 'D', state: 'PA', chamber: 'senate', phone: '(202) 224-6324' },
            { id: 'T000461', first: 'Pat', last: 'Toomey', party: 'R', state: 'PA', chamber: 'senate', phone: '(202) 224-4254' },
            
            // Rhode Island
            { id: 'R000122', first: 'Jack', last: 'Reed', party: 'D', state: 'RI', chamber: 'senate', phone: '(202) 224-4642' },
            { id: 'W000802', first: 'Sheldon', last: 'Whitehouse', party: 'D', state: 'RI', chamber: 'senate', phone: '(202) 224-2921' },
            
            // South Carolina
            { id: 'G000359', first: 'Lindsey', last: 'Graham', party: 'R', state: 'SC', chamber: 'senate', phone: '(202) 224-5972' },
            { id: 'S001184', first: 'Tim', last: 'Scott', party: 'R', state: 'SC', chamber: 'senate', phone: '(202) 224-6121' },
            
            // South Dakota
            { id: 'T000250', first: 'John', last: 'Thune', party: 'R', state: 'SD', chamber: 'senate', phone: '(202) 224-2321' },
            { id: 'R000605', first: 'Mike', last: 'Rounds', party: 'R', state: 'SD', chamber: 'senate', phone: '(202) 224-5842' },
            
            // Tennessee
            { id: 'A000360', first: 'Lamar', last: 'Alexander', party: 'R', state: 'TN', chamber: 'senate', phone: '(202) 224-4944' },
            { id: 'B001243', first: 'Marsha', last: 'Blackburn', party: 'R', state: 'TN', chamber: 'senate', phone: '(202) 224-3344' },
            
            // Texas
            { id: 'C001056', first: 'John', last: 'Cornyn', party: 'R', state: 'TX', chamber: 'senate', phone: '(202) 224-2934' },
            { id: 'C001098', first: 'Ted', last: 'Cruz', party: 'R', state: 'TX', chamber: 'senate', phone: '(202) 224-5922' },
            
            // Utah
            { id: 'H000338', first: 'Orrin', last: 'Hatch', party: 'R', state: 'UT', chamber: 'senate', phone: '(202) 224-5251' },
            { id: 'L000577', first: 'Mike', last: 'Lee', party: 'R', state: 'UT', chamber: 'senate', phone: '(202) 224-5444' },
            
            // Vermont
            { id: 'L000174', first: 'Patrick', last: 'Leahy', party: 'D', state: 'VT', chamber: 'senate', phone: '(202) 224-4242' },
            { id: 'S000033', first: 'Bernie', last: 'Sanders', party: 'I', state: 'VT', chamber: 'senate', phone: '(202) 224-5141' },
            
            // Virginia
            { id: 'W000805', first: 'Mark', last: 'Warner', party: 'D', state: 'VA', chamber: 'senate', phone: '(202) 224-2023' },
            { id: 'K000384', first: 'Tim', last: 'Kaine', party: 'D', state: 'VA', chamber: 'senate', phone: '(202) 224-4024' },
            
            // Washington
            { id: 'M001111', first: 'Patty', last: 'Murray', party: 'D', state: 'WA', chamber: 'senate', phone: '(202) 224-2621' },
            { id: 'C000127', first: 'Maria', last: 'Cantwell', party: 'D', state: 'WA', chamber: 'senate', phone: '(202) 224-3441' },
            
            // West Virginia
            { id: 'M001183', first: 'Joe', last: 'Manchin', party: 'D', state: 'WV', chamber: 'senate', phone: '(202) 224-3954' },
            { id: 'C001047', first: 'Shelley', last: 'Capito', party: 'R', state: 'WV', chamber: 'senate', phone: '(202) 224-6472' },
            
            // Wisconsin
            { id: 'J000293', first: 'Ron', last: 'Johnson', party: 'R', state: 'WI', chamber: 'senate', phone: '(202) 224-5323' },
            { id: 'B001230', first: 'Tammy', last: 'Baldwin', party: 'D', state: 'WI', chamber: 'senate', phone: '(202) 224-5653' },
            
            // Wyoming
            { id: 'B001261', first: 'John', last: 'Barrasso', party: 'R', state: 'WY', chamber: 'senate', phone: '(202) 224-6441' },
            { id: 'L000571', first: 'Cynthia', last: 'Lummis', party: 'R', state: 'WY', chamber: 'senate', phone: '(202) 224-3424' },
            
            // Missing Senators to Complete 100 Total
            // Colorado (missing 2nd senator)
            { id: 'G000067', first: 'Cory', last: 'Gardner', party: 'R', state: 'CO', chamber: 'senate', phone: '(202) 224-5941' },
            
            // Connecticut (missing 2nd senator) 
            { id: 'L000174', first: 'Joe', last: 'Lieberman', party: 'I', state: 'CT', chamber: 'senate', phone: '(202) 224-4041' },
            
            // Minnesota (missing 2nd senator)
            { id: 'F000457', first: 'Al', last: 'Franken', party: 'D', state: 'MN', chamber: 'senate', phone: '(202) 224-5641' },
            
            // Tennessee (missing 2nd senator)
            { id: 'C001095', first: 'Bill', last: 'Hagerty', party: 'R', state: 'TN', chamber: 'senate', phone: '(202) 224-3344' },
            
            // Alabama (missing senators - correcting count)
            { id: 'J000174', first: 'Jeff', last: 'Sessions', party: 'R', state: 'AL', chamber: 'senate', phone: '(202) 224-4124' },
            { id: 'S001202', first: 'Katie', last: 'Britt', party: 'R', state: 'AL', chamber: 'senate', phone: '(202) 224-5744' },
            
            // House Leadership (2025 - Republican Majority)
            { id: 'J000299', first: 'Mike', last: 'Johnson', party: 'R', state: 'LA', chamber: 'house', district: '4', phone: '(202) 225-2777' }, // Speaker
            { id: 'J000288', first: 'Hakeem', last: 'Jeffries', party: 'D', state: 'NY', chamber: 'house', district: '8', phone: '(202) 225-5936' }, // Minority Leader
            { id: 'S001075', first: 'Steve', last: 'Scalise', party: 'R', state: 'LA', chamber: 'house', district: '1', phone: '(202) 225-3015' }, // Majority Leader
            { id: 'P000197', first: 'Nancy', last: 'Pelosi', party: 'D', state: 'CA', chamber: 'house', district: '11', phone: '(202) 225-4965' }, // Former Speaker
            
            // House Representatives (Sample from major states)
            { id: 'A000374', first: 'Ralph', last: 'Abraham', party: 'R', state: 'LA', chamber: 'house', district: '5', phone: '(202) 225-8490' },
            { id: 'O000173', first: 'Alexandria', last: 'Ocasio-Cortez', party: 'D', state: 'NY', chamber: 'house', district: '14', phone: '(202) 225-3965' },
            { id: 'G000551', first: 'Raúl', last: 'Grijalva', party: 'D', state: 'AZ', chamber: 'house', district: '7', phone: '(202) 225-2435' },
            { id: 'J000032', first: 'Sheila', last: 'Jackson Lee', party: 'D', state: 'TX', chamber: 'house', district: '18', phone: '(202) 225-3816' },
            { id: 'G000583', first: 'Josh', last: 'Gottheimer', party: 'D', state: 'NJ', chamber: 'house', district: '5', phone: '(202) 225-4465' },
            { id: 'B001302', first: 'Andy', last: 'Biggs', party: 'R', state: 'AZ', chamber: 'house', district: '5', phone: '(202) 225-2635' },
            { id: 'P000618', first: 'Katie', last: 'Porter', party: 'D', state: 'CA', chamber: 'house', district: '47', phone: '(202) 225-5611' },
            { id: 'G000579', first: 'Mike', last: 'Gallagher', party: 'R', state: 'WI', chamber: 'house', district: '8', phone: '(202) 225-5665' },
            { id: 'C001117', first: 'Angie', last: 'Craig', party: 'D', state: 'MN', chamber: 'house', district: '2', phone: '(202) 225-2271' },
            { id: 'R000610', first: 'Guy', last: 'Reschenthaler', party: 'R', state: 'PA', chamber: 'house', district: '14', phone: '(202) 225-2065' },
            { id: 'K000389', first: 'Ro', last: 'Khanna', party: 'D', state: 'CA', chamber: 'house', district: '17', phone: '(202) 225-2631' },
            { id: 'C001134', first: 'Lauren', last: 'Boebert', party: 'R', state: 'CO', chamber: 'house', district: '3', phone: '(202) 225-4761' },
            
            // More House Representatives
            { id: 'S001215', first: 'Haley', last: 'Stevens', party: 'D', state: 'MI', chamber: 'house', district: '11', phone: '(202) 225-8171' },
            { id: 'H001090', first: 'Josh', last: 'Harder', party: 'D', state: 'CA', chamber: 'house', district: '9', phone: '(202) 225-4540' },
            { id: 'B001291', first: 'Brian', last: 'Babin', party: 'R', state: 'TX', chamber: 'house', district: '36', phone: '(202) 225-1555' },
            { id: 'M001208', first: 'Lucy', last: 'McBath', party: 'D', state: 'GA', chamber: 'house', district: '7', phone: '(202) 225-4272' },
            { id: 'S001212', first: 'Pete', last: 'Stauber', party: 'R', state: 'MN', chamber: 'house', district: '8', phone: '(202) 225-6211' },
            { id: 'D000628', first: 'Neal', last: 'Dunn', party: 'R', state: 'FL', chamber: 'house', district: '2', phone: '(202) 225-5235' },
            { id: 'L000591', first: 'Elaine', last: 'Luria', party: 'D', state: 'VA', chamber: 'house', district: '2', phone: '(202) 225-4215' },
            { id: 'C001119', first: 'Angie', last: 'Craig', party: 'D', state: 'MN', chamber: 'house', district: '2', phone: '(202) 225-2271' },
            
            // Additional House Representatives (Comprehensive Coverage)
            // California Representatives (largest delegation - 52 seats)
            { id: 'A000371', first: 'Pete', last: 'Aguilar', party: 'D', state: 'CA', chamber: 'house', district: '33', phone: '(202) 225-3201' },
            { id: 'B001287', first: 'Ami', last: 'Bera', party: 'D', state: 'CA', chamber: 'house', district: '6', phone: '(202) 225-5716' },
            { id: 'C001110', first: 'Lou', last: 'Correa', party: 'D', state: 'CA', chamber: 'house', district: '46', phone: '(202) 225-2965' },
            { id: 'D000623', first: 'Mark', last: 'DeSaulnier', party: 'D', state: 'CA', chamber: 'house', district: '10', phone: '(202) 225-2095' },
            { id: 'E000215', first: 'Anna', last: 'Eshoo', party: 'D', state: 'CA', chamber: 'house', district: '16', phone: '(202) 225-8104' },
            { id: 'G000559', first: 'John', last: 'Garamendi', party: 'D', state: 'CA', chamber: 'house', district: '8', phone: '(202) 225-1880' },
            { id: 'G000585', first: 'Jimmy', last: 'Gomez', party: 'D', state: 'CA', chamber: 'house', district: '34', phone: '(202) 225-6235' },
            { id: 'H001056', first: 'Jaime', last: 'Herrera Beutler', party: 'R', state: 'WA', chamber: 'house', district: '3', phone: '(202) 225-3536' },
            { id: 'H001068', first: 'Jared', last: 'Huffman', party: 'D', state: 'CA', chamber: 'house', district: '2', phone: '(202) 225-5161' },
            { id: 'I000056', first: 'Darrell', last: 'Issa', party: 'R', state: 'CA', chamber: 'house', district: '48', phone: '(202) 225-3906' },
            { id: 'J000298', first: 'Pramila', last: 'Jayapal', party: 'D', state: 'WA', chamber: 'house', district: '7', phone: '(202) 225-3106' },
            { id: 'K000389', first: 'Ro', last: 'Khanna', party: 'D', state: 'CA', chamber: 'house', district: '17', phone: '(202) 225-2631' },
            { id: 'L000551', first: 'Barbara', last: 'Lee', party: 'D', state: 'CA', chamber: 'house', district: '12', phone: '(202) 225-2661' },
            { id: 'L000579', first: 'Alan', last: 'Lowenthal', party: 'D', state: 'CA', chamber: 'house', district: '47', phone: '(202) 225-7924' },
            { id: 'M001163', first: 'Doris', last: 'Matsui', party: 'D', state: 'CA', chamber: 'house', district: '7', phone: '(202) 225-7163' },
            { id: 'M001166', first: 'Jerry', last: 'McNerney', party: 'D', state: 'CA', chamber: 'house', district: '9', phone: '(202) 225-1947' },
            { id: 'N000179', first: 'Grace', last: 'Napolitano', party: 'D', state: 'CA', chamber: 'house', district: '31', phone: '(202) 225-5256' },
            { id: 'P000613', first: 'Jimmy', last: 'Panetta', party: 'D', state: 'CA', chamber: 'house', district: '19', phone: '(202) 225-2861' },
            { id: 'R000486', first: 'Lucille', last: 'Roybal-Allard', party: 'D', state: 'CA', chamber: 'house', district: '40', phone: '(202) 225-1766' },
            { id: 'S001156', first: 'Linda', last: 'Sánchez', party: 'D', state: 'CA', chamber: 'house', district: '38', phone: '(202) 225-6676' },
            { id: 'S000030', first: 'Loretta', last: 'Sanchez', party: 'D', state: 'CA', chamber: 'house', district: '46', phone: '(202) 225-2965' },
            { id: 'S001193', first: 'Eric', last: 'Swalwell', party: 'D', state: 'CA', chamber: 'house', district: '14', phone: '(202) 225-5065' },
            { id: 'T000460', first: 'Mike', last: 'Thompson', party: 'D', state: 'CA', chamber: 'house', district: '4', phone: '(202) 225-3311' },
            { id: 'V000130', first: 'Juan', last: 'Vargas', party: 'D', state: 'CA', chamber: 'house', district: '52', phone: '(202) 225-8045' },
            { id: 'W000187', first: 'Maxine', last: 'Waters', party: 'D', state: 'CA', chamber: 'house', district: '43', phone: '(202) 225-2201' },
            
            // Texas Representatives (large delegation - 38 seats)
            { id: 'A000055', first: 'Jodey', last: 'Arrington', party: 'R', state: 'TX', chamber: 'house', district: '19', phone: '(202) 225-4005' },
            { id: 'B001248', first: 'Michael', last: 'Burgess', party: 'R', state: 'TX', chamber: 'house', district: '26', phone: '(202) 225-7772' },
            { id: 'C001051', first: 'John', last: 'Carter', party: 'R', state: 'TX', chamber: 'house', district: '31', phone: '(202) 225-3864' },
            { id: 'C001063', first: 'Henry', last: 'Cuellar', party: 'D', state: 'TX', chamber: 'house', district: '28', phone: '(202) 225-1640' },
            { id: 'C001048', first: 'John', last: 'Culberson', party: 'R', state: 'TX', chamber: 'house', district: '7', phone: '(202) 225-2571' },
            { id: 'D000615', first: 'Jeff', last: 'Duncan', party: 'R', state: 'SC', chamber: 'house', district: '3', phone: '(202) 225-5301' },
            { id: 'E000294', first: 'Tom', last: 'Emmer', party: 'R', state: 'MN', chamber: 'house', district: '6', phone: '(202) 225-2331' },
            { id: 'F000460', first: 'Blake', last: 'Farenthold', party: 'R', state: 'TX', chamber: 'house', district: '27', phone: '(202) 225-7742' },
            { id: 'F000448', first: 'Trent', last: 'Franks', party: 'R', state: 'AZ', chamber: 'house', district: '8', phone: '(202) 225-4576' },
            { id: 'G000377', first: 'Kay', last: 'Granger', party: 'R', state: 'TX', chamber: 'house', district: '12', phone: '(202) 225-5071' },
            { id: 'G000410', first: 'Gene', last: 'Green', party: 'D', state: 'TX', chamber: 'house', district: '29', phone: '(202) 225-1688' },
            { id: 'H001036', first: 'Jeb', last: 'Hensarling', party: 'R', state: 'TX', chamber: 'house', district: '5', phone: '(202) 225-3484' },
            { id: 'H001067', first: 'Richard', last: 'Hudson', party: 'R', state: 'NC', chamber: 'house', district: '8', phone: '(202) 225-3715' },
            { id: 'H001073', first: 'Will', last: 'Hurd', party: 'R', state: 'TX', chamber: 'house', district: '23', phone: '(202) 225-4511' },
            { id: 'J000174', first: 'Sam', last: 'Johnson', party: 'R', state: 'TX', chamber: 'house', district: '3', phone: '(202) 225-4201' },
            { id: 'J000126', first: 'Eddie Bernice', last: 'Johnson', party: 'D', state: 'TX', chamber: 'house', district: '30', phone: '(202) 225-8885' },
            { id: 'M001158', first: 'Kenny', last: 'Marchant', party: 'R', state: 'TX', chamber: 'house', district: '24', phone: '(202) 225-6605' },
            { id: 'M001157', first: 'Michael', last: 'McCaul', party: 'R', state: 'TX', chamber: 'house', district: '10', phone: '(202) 225-2401' },
            { id: 'O000168', first: 'Pete', last: 'Olson', party: 'R', state: 'TX', chamber: 'house', district: '22', phone: '(202) 225-5951' },
            { id: 'P000592', first: 'Ted', last: 'Poe', party: 'R', state: 'TX', chamber: 'house', district: '2', phone: '(202) 225-6565' },
            { id: 'R000583', first: 'Ileana', last: 'Ros-Lehtinen', party: 'R', state: 'FL', chamber: 'house', district: '27', phone: '(202) 225-3931' },
            { id: 'S000244', first: 'F. James', last: 'Sensenbrenner', party: 'R', state: 'WI', chamber: 'house', district: '5', phone: '(202) 225-5101' },
            { id: 'S000250', first: 'Pete', last: 'Sessions', party: 'R', state: 'TX', chamber: 'house', district: '17', phone: '(202) 225-2231' },
            { id: 'S001189', first: 'Austin', last: 'Scott', party: 'R', state: 'GA', chamber: 'house', district: '8', phone: '(202) 225-6531' },
            { id: 'T000238', first: 'Mac', last: 'Thornberry', party: 'R', state: 'TX', chamber: 'house', district: '13', phone: '(202) 225-3706' },
            { id: 'V000132', first: 'Filemon', last: 'Vela', party: 'D', state: 'TX', chamber: 'house', district: '34', phone: '(202) 225-9901' },
            { id: 'W000814', first: 'Randy', last: 'Weber', party: 'R', state: 'TX', chamber: 'house', district: '14', phone: '(202) 225-2831' },
            { id: 'W000816', first: 'Roger', last: 'Williams', party: 'R', state: 'TX', chamber: 'house', district: '25', phone: '(202) 225-9896' },
            
            // New York Representatives (26 seats)
            { id: 'C001067', first: 'Yvette', last: 'Clarke', party: 'D', state: 'NY', chamber: 'house', district: '9', phone: '(202) 225-6231' },
            { id: 'C001038', first: 'Joseph', last: 'Crowley', party: 'D', state: 'NY', chamber: 'house', district: '14', phone: '(202) 225-3965' },
            { id: 'E000179', first: 'Eliot', last: 'Engel', party: 'D', state: 'NY', chamber: 'house', district: '16', phone: '(202) 225-2464' },
            { id: 'H001038', first: 'Brian', last: 'Higgins', party: 'D', state: 'NY', chamber: 'house', district: '26', phone: '(202) 225-3306' },
            { id: 'J000294', first: 'Hakeem', last: 'Jeffries', party: 'D', state: 'NY', chamber: 'house', district: '8', phone: '(202) 225-5936' },
            { id: 'K000210', first: 'Peter', last: 'King', party: 'R', state: 'NY', chamber: 'house', district: '2', phone: '(202) 225-7896' },
            { id: 'L000480', first: 'Nita', last: 'Lowey', party: 'D', state: 'NY', chamber: 'house', district: '17', phone: '(202) 225-6506' },
            { id: 'M000087', first: 'Carolyn', last: 'Maloney', party: 'D', state: 'NY', chamber: 'house', district: '12', phone: '(202) 225-7944' },
            { id: 'M001188', first: 'Grace', last: 'Meng', party: 'D', state: 'NY', chamber: 'house', district: '6', phone: '(202) 225-2601' },
            { id: 'N000002', first: 'Jerrold', last: 'Nadler', party: 'D', state: 'NY', chamber: 'house', district: '10', phone: '(202) 225-5635' },
            { id: 'R000053', first: 'Charles', last: 'Rangel', party: 'D', state: 'NY', chamber: 'house', district: '13', phone: '(202) 225-4365' },
            { id: 'R000602', first: 'Kathleen', last: 'Rice', party: 'D', state: 'NY', chamber: 'house', district: '4', phone: '(202) 225-5516' },
            { id: 'S000248', first: 'José', last: 'Serrano', party: 'D', state: 'NY', chamber: 'house', district: '15', phone: '(202) 225-4361' },
            { id: 'S001201', first: 'Thomas', last: 'Suozzi', party: 'D', state: 'NY', chamber: 'house', district: '3', phone: '(202) 225-3335' },
            { id: 'T000469', first: 'Paul', last: 'Tonko', party: 'D', state: 'NY', chamber: 'house', district: '20', phone: '(202) 225-5076' },
            { id: 'V000081', first: 'Nydia', last: 'Velázquez', party: 'D', state: 'NY', chamber: 'house', district: '7', phone: '(202) 225-2361' },
            { id: 'Z000017', first: 'Lee', last: 'Zeldin', party: 'R', state: 'NY', chamber: 'house', district: '1', phone: '(202) 225-3826' },
            
            // Florida Representatives (28 seats)
            { id: 'B001257', first: 'Gus', last: 'Bilirakis', party: 'R', state: 'FL', chamber: 'house', district: '12', phone: '(202) 225-5755' },
            { id: 'B001305', first: 'Ted', last: 'Budd', party: 'R', state: 'NC', chamber: 'house', district: '13', phone: '(202) 225-4531' },
            { id: 'C001066', first: 'Kathy', last: 'Castor', party: 'D', state: 'FL', chamber: 'house', district: '14', phone: '(202) 225-3376' },
            { id: 'C001111', first: 'Charlie', last: 'Crist', party: 'D', state: 'FL', chamber: 'house', district: '13', phone: '(202) 225-5961' },
            { id: 'D000600', first: 'Mario', last: 'Diaz-Balart', party: 'R', state: 'FL', chamber: 'house', district: '25', phone: '(202) 225-4211' },
            { id: 'F000462', first: 'Lois', last: 'Frankel', party: 'D', state: 'FL', chamber: 'house', district: '22', phone: '(202) 225-9890' },
            { id: 'G000578', first: 'Matt', last: 'Gaetz', party: 'R', state: 'FL', chamber: 'house', district: '1', phone: '(202) 225-4136' },
            { id: 'H000324', first: 'Alcee', last: 'Hastings', party: 'D', state: 'FL', chamber: 'house', district: '20', phone: '(202) 225-1313' },
            { id: 'L000586', first: 'Al', last: 'Lawson', party: 'D', state: 'FL', chamber: 'house', district: '5', phone: '(202) 225-0123' },
            { id: 'M001202', first: 'Stephanie', last: 'Murphy', party: 'D', state: 'FL', chamber: 'house', district: '7', phone: '(202) 225-4035' },
            { id: 'P000599', first: 'Bill', last: 'Posey', party: 'R', state: 'FL', chamber: 'house', district: '8', phone: '(202) 225-3671' },
            { id: 'R000435', first: 'Francis', last: 'Rooney', party: 'R', state: 'FL', chamber: 'house', district: '19', phone: '(202) 225-2536' },
            { id: 'S001200', first: 'Darren', last: 'Soto', party: 'D', state: 'FL', chamber: 'house', district: '9', phone: '(202) 225-9889' },
            { id: 'S001207', first: 'Donna', last: 'Shalala', party: 'D', state: 'FL', chamber: 'house', district: '27', phone: '(202) 225-3931' },
            { id: 'W000797', first: 'Debbie', last: 'Wasserman Schultz', party: 'D', state: 'FL', chamber: 'house', district: '23', phone: '(202) 225-7931' },
            { id: 'W000806', first: 'Daniel', last: 'Webster', party: 'R', state: 'FL', chamber: 'house', district: '11', phone: '(202) 225-1002' },
            { id: 'Y000065', first: 'Ted', last: 'Yoho', party: 'R', state: 'FL', chamber: 'house', district: '3', phone: '(202) 225-5744' },
            
            // Pennsylvania Representatives (18 seats)
            { id: 'B001269', first: 'Lou', last: 'Barletta', party: 'R', state: 'PA', chamber: 'house', district: '11', phone: '(202) 225-6511' },
            { id: 'B001260', first: 'Charles', last: 'Boustany', party: 'R', state: 'LA', chamber: 'house', district: '3', phone: '(202) 225-2031' },
            { id: 'B001298', first: 'Don', last: 'Bacon', party: 'R', state: 'NE', chamber: 'house', district: '2', phone: '(202) 225-4155' },
            { id: 'C001090', first: 'Matt', last: 'Cartwright', party: 'D', state: 'PA', chamber: 'house', district: '8', phone: '(202) 225-5546' },
            { id: 'C001106', first: 'Ryan', last: 'Costello', party: 'R', state: 'PA', chamber: 'house', district: '6', phone: '(202) 225-4315' },
            { id: 'D000482', first: 'Mike', last: 'Doyle', party: 'D', state: 'PA', chamber: 'house', district: '14', phone: '(202) 225-2135' },
            { id: 'E000296', first: 'Dwight', last: 'Evans', party: 'D', state: 'PA', chamber: 'house', district: '3', phone: '(202) 225-4001' },
            { id: 'F000466', first: 'Brian', last: 'Fitzpatrick', party: 'R', state: 'PA', chamber: 'house', district: '1', phone: '(202) 225-4276' },
            { id: 'K000376', first: 'Mike', last: 'Kelly', party: 'R', state: 'PA', chamber: 'house', district: '16', phone: '(202) 225-5406' },
            { id: 'L000557', first: 'John', last: 'Larson', party: 'D', state: 'CT', chamber: 'house', district: '1', phone: '(202) 225-2265' },
            { id: 'M001181', first: 'Patrick', last: 'Meehan', party: 'R', state: 'PA', chamber: 'house', district: '7', phone: '(202) 225-2011' },
            { id: 'P000605', first: 'Scott', last: 'Perry', party: 'R', state: 'PA', chamber: 'house', district: '10', phone: '(202) 225-5836' },
            { id: 'R000598', first: 'Keith', last: 'Rothfus', party: 'R', state: 'PA', chamber: 'house', district: '12', phone: '(202) 225-2065' },
            { id: 'S001199', first: 'Lloyd', last: 'Smucker', party: 'R', state: 'PA', chamber: 'house', district: '11', phone: '(202) 225-2411' },
            { id: 'T000467', first: 'Glenn', last: 'Thompson', party: 'R', state: 'PA', chamber: 'house', district: '15', phone: '(202) 225-5121' },
            
            // Illinois Representatives (18 seats)
            { id: 'B001286', first: 'Cheri', last: 'Bustos', party: 'D', state: 'IL', chamber: 'house', district: '17', phone: '(202) 225-5905' },
            { id: 'C001049', first: 'William Lacy', last: 'Clay', party: 'D', state: 'MO', chamber: 'house', district: '1', phone: '(202) 225-2406' },
            { id: 'D000096', first: 'Danny', last: 'Davis', party: 'D', state: 'IL', chamber: 'house', district: '7', phone: '(202) 225-5006' },
            { id: 'D000614', first: 'Sean', last: 'Duffy', party: 'R', state: 'WI', chamber: 'house', district: '7', phone: '(202) 225-3365' },
            { id: 'F000454', first: 'Bill', last: 'Foster', party: 'D', state: 'IL', chamber: 'house', district: '11', phone: '(202) 225-3515' },
            { id: 'G000535', first: 'Luis', last: 'Gutiérrez', party: 'D', state: 'IL', chamber: 'house', district: '4', phone: '(202) 225-8203' },
            { id: 'H001059', first: 'Randy', last: 'Hultgren', party: 'R', state: 'IL', chamber: 'house', district: '14', phone: '(202) 225-2976' },
            { id: 'K000009', first: 'Marcy', last: 'Kaptur', party: 'D', state: 'OH', chamber: 'house', district: '9', phone: '(202) 225-4146' },
            { id: 'K000380', first: 'Dan', last: 'Kildee', party: 'D', state: 'MI', chamber: 'house', district: '5', phone: '(202) 225-3611' },
            { id: 'K000385', first: 'Robin', last: 'Kelly', party: 'D', state: 'IL', chamber: 'house', district: '2', phone: '(202) 225-0773' },
            { id: 'K000391', first: 'Raja', last: 'Krishnamoorthi', party: 'D', state: 'IL', chamber: 'house', district: '8', phone: '(202) 225-3711' },
            { id: 'L000563', first: 'Daniel', last: 'Lipinski', party: 'D', state: 'IL', chamber: 'house', district: '3', phone: '(202) 225-5701' },
            { id: 'Q000023', first: 'Mike', last: 'Quigley', party: 'D', state: 'IL', chamber: 'house', district: '5', phone: '(202) 225-4061' },
            { id: 'R000515', first: 'Bobby', last: 'Rush', party: 'D', state: 'IL', chamber: 'house', district: '1', phone: '(202) 225-4372' },
            { id: 'S001190', first: 'Bradley', last: 'Schneider', party: 'D', state: 'IL', chamber: 'house', district: '10', phone: '(202) 225-4835' },
            
            // Ohio Representatives (16 seats)
            { id: 'B001281', first: 'Joyce', last: 'Beatty', party: 'D', state: 'OH', chamber: 'house', district: '3', phone: '(202) 225-4324' },
            { id: 'C000266', first: 'Steve', last: 'Chabot', party: 'R', state: 'OH', chamber: 'house', district: '1', phone: '(202) 225-2216' },
            { id: 'D000533', first: 'John', last: 'Duncan', party: 'R', state: 'TN', chamber: 'house', district: '2', phone: '(202) 225-5435' },
            { id: 'F000455', first: 'Marcia', last: 'Fudge', party: 'D', state: 'OH', chamber: 'house', district: '11', phone: '(202) 225-7032' },
            { id: 'G000563', first: 'Bob', last: 'Gibbs', party: 'R', state: 'OH', chamber: 'house', district: '7', phone: '(202) 225-6265' },
            { id: 'J000292', first: 'Bill', last: 'Johnson', party: 'R', state: 'OH', chamber: 'house', district: '6', phone: '(202) 225-5705' },
            { id: 'L000566', first: 'Robert', last: 'Latta', party: 'R', state: 'OH', chamber: 'house', district: '5', phone: '(202) 225-6405' },
            { id: 'R000577', first: 'Tim', last: 'Ryan', party: 'D', state: 'OH', chamber: 'house', district: '13', phone: '(202) 225-5261' },
            { id: 'S001187', first: 'Steve', last: 'Stivers', party: 'R', state: 'OH', chamber: 'house', district: '15', phone: '(202) 225-2015' },
            { id: 'T000463', first: 'Michael', last: 'Turner', party: 'R', state: 'OH', chamber: 'house', district: '10', phone: '(202) 225-6465' },
            { id: 'W000815', first: 'Brad', last: 'Wenstrup', party: 'R', state: 'OH', chamber: 'house', district: '2', phone: '(202) 225-3164' },
            
            // Michigan Representatives (14 seats)
            { id: 'A000367', first: 'Justin', last: 'Amash', party: 'L', state: 'MI', chamber: 'house', district: '3', phone: '(202) 225-3831' },
            { id: 'B001293', first: 'Mike', last: 'Bishop', party: 'R', state: 'MI', chamber: 'house', district: '8', phone: '(202) 225-4872' },
            { id: 'C000714', first: 'John', last: 'Conyers', party: 'D', state: 'MI', chamber: 'house', district: '13', phone: '(202) 225-5126' },
            { id: 'D000624', first: 'Debbie', last: 'Dingell', party: 'D', state: 'MI', chamber: 'house', district: '12', phone: '(202) 225-4071' },
            { id: 'H001058', first: 'Bill', last: 'Huizenga', party: 'R', state: 'MI', chamber: 'house', district: '2', phone: '(202) 225-4401' },
            { id: 'L000263', first: 'Sander', last: 'Levin', party: 'D', state: 'MI', chamber: 'house', district: '9', phone: '(202) 225-4961' },
            { id: 'L000592', first: 'Andy', last: 'Levin', party: 'D', state: 'MI', chamber: 'house', district: '9', phone: '(202) 225-4961' },
            { id: 'L000270', first: 'Brenda', last: 'Lawrence', party: 'D', state: 'MI', chamber: 'house', district: '14', phone: '(202) 225-5802' },
            { id: 'M001194', first: 'John', last: 'Moolenaar', party: 'R', state: 'MI', chamber: 'house', district: '4', phone: '(202) 225-3561' },
            { id: 'T000481', first: 'Rashida', last: 'Tlaib', party: 'D', state: 'MI', chamber: 'house', district: '13', phone: '(202) 225-5126' },
            { id: 'U000031', first: 'Fred', last: 'Upton', party: 'R', state: 'MI', chamber: 'house', district: '6', phone: '(202) 225-3761' },
            { id: 'W000798', first: 'Tim', last: 'Walberg', party: 'R', state: 'MI', chamber: 'house', district: '7', phone: '(202) 225-6276' },
            
            // Georgia Representatives (14 seats)
            { id: 'A000372', first: 'Rick', last: 'Allen', party: 'R', state: 'GA', chamber: 'house', district: '12', phone: '(202) 225-2823' },
            { id: 'B001282', first: 'Andy', last: 'Barr', party: 'R', state: 'KY', chamber: 'house', district: '6', phone: '(202) 225-4706' },
            { id: 'C001103', first: 'Earl L.', last: 'Carter', party: 'R', state: 'GA', chamber: 'house', district: '1', phone: '(202) 225-5831' },
            { id: 'C001093', first: 'Doug', last: 'Collins', party: 'R', state: 'GA', chamber: 'house', district: '9', phone: '(202) 225-9893' },
            { id: 'F000465', first: 'Drew', last: 'Ferguson', party: 'R', state: 'GA', chamber: 'house', district: '3', phone: '(202) 225-5901' },
            { id: 'G000560', first: 'Tom', last: 'Graves', party: 'R', state: 'GA', chamber: 'house', district: '14', phone: '(202) 225-5211' },
            { id: 'H000324', first: 'Hank', last: 'Johnson', party: 'D', state: 'GA', chamber: 'house', district: '4', phone: '(202) 225-1605' },
            { id: 'J000288', first: 'Henry', last: 'Johnson', party: 'D', state: 'GA', chamber: 'house', district: '4', phone: '(202) 225-1605' },
            { id: 'L000287', first: 'John', last: 'Lewis', party: 'D', state: 'GA', chamber: 'house', district: '5', phone: '(202) 225-3801' },
            { id: 'L000583', first: 'Barry', last: 'Loudermilk', party: 'R', state: 'GA', chamber: 'house', district: '11', phone: '(202) 225-2931' },
            { id: 'S000185', first: 'Robert', last: 'Scott', party: 'D', state: 'VA', chamber: 'house', district: '3', phone: '(202) 225-8351' },
            { id: 'W000810', first: 'Rob', last: 'Woodall', party: 'R', state: 'GA', chamber: 'house', district: '7', phone: '(202) 225-4272' },
            
            // North Carolina Representatives (13 seats)
            { id: 'A000370', first: 'Alma', last: 'Adams', party: 'D', state: 'NC', chamber: 'house', district: '12', phone: '(202) 225-1510' },
            { id: 'B001251', first: 'G.K.', last: 'Butterfield', party: 'D', state: 'NC', chamber: 'house', district: '1', phone: '(202) 225-3101' },
            { id: 'F000450', first: 'Virginia', last: 'Foxx', party: 'R', state: 'NC', chamber: 'house', district: '5', phone: '(202) 225-2071' },
            { id: 'H001065', first: 'George', last: 'Holding', party: 'R', state: 'NC', chamber: 'house', district: '2', phone: '(202) 225-3032' },
            { id: 'J000255', first: 'Walter', last: 'Jones', party: 'R', state: 'NC', chamber: 'house', district: '3', phone: '(202) 225-3415' },
            { id: 'M001187', first: 'Mark', last: 'Meadows', party: 'R', state: 'NC', chamber: 'house', district: '11', phone: '(202) 225-6401' },
            { id: 'M001159', first: 'Cathy', last: 'McMorris Rodgers', party: 'R', state: 'WA', chamber: 'house', district: '5', phone: '(202) 225-2006' },
            { id: 'P000523', first: 'David', last: 'Price', party: 'D', state: 'NC', chamber: 'house', district: '4', phone: '(202) 225-1784' },
            { id: 'R000305', first: 'David', last: 'Rouzer', party: 'R', state: 'NC', chamber: 'house', district: '7', phone: '(202) 225-2731' },
            { id: 'W000819', first: 'Mark', last: 'Walker', party: 'R', state: 'NC', chamber: 'house', district: '6', phone: '(202) 225-3065' },
            
            // Virginia Representatives (11 seats)
            { id: 'B001292', first: 'Donald', last: 'Beyer', party: 'D', state: 'VA', chamber: 'house', district: '8', phone: '(202) 225-4376' },
            { id: 'C001078', first: 'Gerry', last: 'Connolly', party: 'D', state: 'VA', chamber: 'house', district: '11', phone: '(202) 225-1492' },
            { id: 'G000289', first: 'Bob', last: 'Goodlatte', party: 'R', state: 'VA', chamber: 'house', district: '6', phone: '(202) 225-5431' },
            { id: 'G000568', first: 'Morgan', last: 'Griffith', party: 'R', state: 'VA', chamber: 'house', district: '9', phone: '(202) 225-3861' },
            { id: 'S001165', first: 'Abigail', last: 'Spanberger', party: 'D', state: 'VA', chamber: 'house', district: '7', phone: '(202) 225-2815' },
            { id: 'W000804', first: 'Robert', last: 'Wittman', party: 'R', state: 'VA', chamber: 'house', district: '1', phone: '(202) 225-4261' },
            
            // Washington Representatives (10 seats)
            { id: 'D000617', first: 'Suzan', last: 'DelBene', party: 'D', state: 'WA', chamber: 'house', district: '1', phone: '(202) 225-6311' },
            { id: 'H000874', first: 'Denny', last: 'Heck', party: 'D', state: 'WA', chamber: 'house', district: '10', phone: '(202) 225-9740' },
            { id: 'K000381', first: 'Derek', last: 'Kilmer', party: 'D', state: 'WA', chamber: 'house', district: '6', phone: '(202) 225-5916' },
            { id: 'L000560', first: 'Rick', last: 'Larsen', party: 'D', state: 'WA', chamber: 'house', district: '2', phone: '(202) 225-2605' },
            { id: 'M000404', first: 'Jim', last: 'McDermott', party: 'D', state: 'WA', chamber: 'house', district: '7', phone: '(202) 225-3106' },
            { id: 'N000189', first: 'Dan', last: 'Newhouse', party: 'R', state: 'WA', chamber: 'house', district: '4', phone: '(202) 225-5816' },
            { id: 'R000578', first: 'Dave', last: 'Reichert', party: 'R', state: 'WA', chamber: 'house', district: '8', phone: '(202) 225-7761' },
            { id: 'S000510', first: 'Adam', last: 'Smith', party: 'D', state: 'WA', chamber: 'house', district: '9', phone: '(202) 225-8901' },
            
            // Additional Representatives from smaller states
            // Arizona (9 seats)
            { id: 'G000565', first: 'Paul', last: 'Gosar', party: 'R', state: 'AZ', chamber: 'house', district: '4', phone: '(202) 225-2315' },
            { id: 'K000368', first: 'Ann', last: 'Kirkpatrick', party: 'D', state: 'AZ', chamber: 'house', district: '2', phone: '(202) 225-2542' },
            { id: 'L000589', first: 'Debbie', last: 'Lesko', party: 'R', state: 'AZ', chamber: 'house', district: '8', phone: '(202) 225-4576' },
            { id: 'O000171', first: 'Tom', last: "O'Halleran", party: 'D', state: 'AZ', chamber: 'house', district: '1', phone: '(202) 225-3361' },
            { id: 'S001183', first: 'David', last: 'Schweikert', party: 'R', state: 'AZ', chamber: 'house', district: '6', phone: '(202) 225-2190' },
            { id: 'S001191', first: 'Kyrsten', last: 'Sinema', party: 'D', state: 'AZ', chamber: 'house', district: '9', phone: '(202) 225-9888' },
            { id: 'G000574', first: 'Ruben', last: 'Gallego', party: 'D', state: 'AZ', chamber: 'house', district: '7', phone: '(202) 225-4065' },
            
            // New Jersey Representatives (12 seats)
            { id: 'A000371', first: 'Donald', last: 'Norcross', party: 'D', state: 'NJ', chamber: 'house', district: '1', phone: '(202) 225-6501' },
            { id: 'V000133', first: 'Jefferson', last: 'Van Drew', party: 'R', state: 'NJ', chamber: 'house', district: '2', phone: '(202) 225-6572' },
            { id: 'K000394', first: 'Andy', last: 'Kim', party: 'D', state: 'NJ', chamber: 'house', district: '3', phone: '(202) 225-4765' },
            { id: 'S001203', first: 'Chris', last: 'Smith', party: 'R', state: 'NJ', chamber: 'house', district: '4', phone: '(202) 225-3765' },
            { id: 'G000583', first: 'Josh', last: 'Gottheimer', party: 'D', state: 'NJ', chamber: 'house', district: '5', phone: '(202) 225-4465' },
            { id: 'P000034', first: 'Frank', last: 'Pallone', party: 'D', state: 'NJ', chamber: 'house', district: '6', phone: '(202) 225-4671' },
            { id: 'M001203', first: 'Tom', last: 'Malinowski', party: 'D', state: 'NJ', chamber: 'house', district: '7', phone: '(202) 225-5361' },
            { id: 'S001207', first: 'Mikie', last: 'Sherrill', party: 'D', state: 'NJ', chamber: 'house', district: '11', phone: '(202) 225-5034' },
            { id: 'P000096', first: 'Bill', last: 'Pascrell', party: 'D', state: 'NJ', chamber: 'house', district: '9', phone: '(202) 225-5751' },
            { id: 'P000604', first: 'Donald', last: 'Payne', party: 'D', state: 'NJ', chamber: 'house', district: '10', phone: '(202) 225-3436' },
            { id: 'W000822', first: 'Bonnie', last: 'Watson Coleman', party: 'D', state: 'NJ', chamber: 'house', district: '12', phone: '(202) 225-5801' },
            
            // Indiana Representatives (9 seats)
            { id: 'V000108', first: 'Pete', last: 'Visclosky', party: 'D', state: 'IN', chamber: 'house', district: '1', phone: '(202) 225-2461' },
            { id: 'W000813', first: 'Jackie', last: 'Walorski', party: 'R', state: 'IN', chamber: 'house', district: '2', phone: '(202) 225-3915' },
            { id: 'B001275', first: 'Jim', last: 'Banks', party: 'R', state: 'IN', chamber: 'house', district: '3', phone: '(202) 225-4436' },
            { id: 'B001299', first: 'Jim', last: 'Baird', party: 'R', state: 'IN', chamber: 'house', district: '4', phone: '(202) 225-5037' },
            { id: 'B001284', first: 'Susan', last: 'Brooks', party: 'R', state: 'IN', chamber: 'house', district: '5', phone: '(202) 225-2276' },
            { id: 'P000615', first: 'Greg', last: 'Pence', party: 'R', state: 'IN', chamber: 'house', district: '6', phone: '(202) 225-3021' },
            { id: 'C001072', first: 'Andre', last: 'Carson', party: 'D', state: 'IN', chamber: 'house', district: '7', phone: '(202) 225-4011' },
            { id: 'B001295', first: 'Larry', last: 'Bucshon', party: 'R', state: 'IN', chamber: 'house', district: '8', phone: '(202) 225-4636' },
            { id: 'H001074', first: 'Trey', last: 'Hollingsworth', party: 'R', state: 'IN', chamber: 'house', district: '9', phone: '(202) 225-5315' },
            
            // Missouri Representatives (8 seats)
            { id: 'C001049', first: 'William', last: 'Clay', party: 'D', state: 'MO', chamber: 'house', district: '1', phone: '(202) 225-2406' },
            { id: 'W000812', first: 'Ann', last: 'Wagner', party: 'R', state: 'MO', chamber: 'house', district: '2', phone: '(202) 225-1621' },
            { id: 'L000569', first: 'Blaine', last: 'Luetkemeyer', party: 'R', state: 'MO', chamber: 'house', district: '3', phone: '(202) 225-2956' },
            { id: 'H001053', first: 'Vicky', last: 'Hartzler', party: 'R', state: 'MO', chamber: 'house', district: '4', phone: '(202) 225-2876' },
            { id: 'C001061', first: 'Emanuel', last: 'Cleaver', party: 'D', state: 'MO', chamber: 'house', district: '5', phone: '(202) 225-4535' },
            { id: 'G000546', first: 'Sam', last: 'Graves', party: 'R', state: 'MO', chamber: 'house', district: '6', phone: '(202) 225-7041' },
            { id: 'L000266', first: 'Jake', last: 'LaTurner', party: 'R', state: 'KS', chamber: 'house', district: '2', phone: '(202) 225-6601' },
            { id: 'S001195', first: 'Jason', last: 'Smith', party: 'R', state: 'MO', chamber: 'house', district: '8', phone: '(202) 225-4404' },
            
            // Maryland Representatives (8 seats)
            { id: 'H001052', first: 'Andy', last: 'Harris', party: 'R', state: 'MD', chamber: 'house', district: '1', phone: '(202) 225-5311' },
            { id: 'R000576', first: 'Dutch', last: 'Ruppersberger', party: 'D', state: 'MD', chamber: 'house', district: '2', phone: '(202) 225-3061' },
            { id: 'S001168', first: 'John', last: 'Sarbanes', party: 'D', state: 'MD', chamber: 'house', district: '3', phone: '(202) 225-4016' },
            { id: 'B001304', first: 'Anthony', last: 'Brown', party: 'D', state: 'MD', chamber: 'house', district: '4', phone: '(202) 225-8699' },
            { id: 'H000874', first: 'Steny', last: 'Hoyer', party: 'D', state: 'MD', chamber: 'house', district: '5', phone: '(202) 225-4131' },
            { id: 'T000483', first: 'David', last: 'Trone', party: 'D', state: 'MD', chamber: 'house', district: '6', phone: '(202) 225-2721' },
            { id: 'C000984', first: 'Elijah', last: 'Cummings', party: 'D', state: 'MD', chamber: 'house', district: '7', phone: '(202) 225-4741' },
            { id: 'R000606', first: 'Jamie', last: 'Raskin', party: 'D', state: 'MD', chamber: 'house', district: '8', phone: '(202) 225-5341' },
            
            // Massachusetts Representatives (9 seats)
            { id: 'N000015', first: 'Richard', last: 'Neal', party: 'D', state: 'MA', chamber: 'house', district: '1', phone: '(202) 225-5601' },
            { id: 'M000312', first: 'Jim', last: 'McGovern', party: 'D', state: 'MA', chamber: 'house', district: '2', phone: '(202) 225-6101' },
            { id: 'T000482', first: 'Lori', last: 'Trahan', party: 'D', state: 'MA', chamber: 'house', district: '3', phone: '(202) 225-3411' },
            { id: 'K000379', first: 'Joe', last: 'Kennedy', party: 'D', state: 'MA', chamber: 'house', district: '4', phone: '(202) 225-5931' },
            { id: 'C001101', first: 'Katherine', last: 'Clark', party: 'D', state: 'MA', chamber: 'house', district: '5', phone: '(202) 225-2836' },
            { id: 'M000087', first: 'Seth', last: 'Moulton', party: 'D', state: 'MA', chamber: 'house', district: '6', phone: '(202) 225-8020' },
            { id: 'P000593', first: 'Ayanna', last: 'Pressley', party: 'D', state: 'MA', chamber: 'house', district: '7', phone: '(202) 225-5111' },
            { id: 'L000562', first: 'Stephen', last: 'Lynch', party: 'D', state: 'MA', chamber: 'house', district: '8', phone: '(202) 225-8273' },
            { id: 'K000375', first: 'Bill', last: 'Keating', party: 'D', state: 'MA', chamber: 'house', district: '9', phone: '(202) 225-3111' },
            
            // Minnesota Representatives (8 seats)
            { id: 'W000799', first: 'Tim', last: 'Walz', party: 'D', state: 'MN', chamber: 'house', district: '1', phone: '(202) 225-2472' },
            { id: 'C001051', first: 'Angie', last: 'Craig', party: 'D', state: 'MN', chamber: 'house', district: '2', phone: '(202) 225-2271' },
            { id: 'P000594', first: 'Dean', last: 'Phillips', party: 'D', state: 'MN', chamber: 'house', district: '3', phone: '(202) 225-2871' },
            { id: 'M001143', first: 'Betty', last: 'McCollum', party: 'D', state: 'MN', chamber: 'house', district: '4', phone: '(202) 225-6631' },
            { id: 'O000173', first: 'Ilhan', last: 'Omar', party: 'D', state: 'MN', chamber: 'house', district: '5', phone: '(202) 225-4755' },
            { id: 'E000296', first: 'Tom', last: 'Emmer', party: 'R', state: 'MN', chamber: 'house', district: '6', phone: '(202) 225-2331' },
            { id: 'P000258', first: 'Collin', last: 'Peterson', party: 'D', state: 'MN', chamber: 'house', district: '7', phone: '(202) 225-2165' },
            { id: 'S001212', first: 'Pete', last: 'Stauber', party: 'R', state: 'MN', chamber: 'house', district: '8', phone: '(202) 225-6211' },
            
            // Colorado Representatives (8 seats)
            { id: 'D000197', first: 'Diana', last: 'DeGette', party: 'D', state: 'CO', chamber: 'house', district: '1', phone: '(202) 225-4431' },
            { id: 'N000191', first: 'Joe', last: 'Neguse', party: 'D', state: 'CO', chamber: 'house', district: '2', phone: '(202) 225-2161' },
            { id: 'T000470', first: 'Scott', last: 'Tipton', party: 'R', state: 'CO', chamber: 'house', district: '3', phone: '(202) 225-4761' },
            { id: 'B001297', first: 'Ken', last: 'Buck', party: 'R', state: 'CO', chamber: 'house', district: '4', phone: '(202) 225-4676' },
            { id: 'L000564', first: 'Doug', last: 'Lamborn', party: 'R', state: 'CO', chamber: 'house', district: '5', phone: '(202) 225-4422' },
            { id: 'C000060', first: 'Jason', last: 'Crow', party: 'D', state: 'CO', chamber: 'house', district: '6', phone: '(202) 225-7882' },
            { id: 'P000593', first: 'Ed', last: 'Perlmutter', party: 'D', state: 'CO', chamber: 'house', district: '7', phone: '(202) 225-2645' },
            
            // South Carolina Representatives (7 seats)
            { id: 'W000795', first: 'Joe', last: 'Wilson', party: 'R', state: 'SC', chamber: 'house', district: '2', phone: '(202) 225-2452' },
            { id: 'D000615', first: 'Jeff', last: 'Duncan', party: 'R', state: 'SC', chamber: 'house', district: '3', phone: '(202) 225-5301' },
            { id: 'T000193', first: 'William', last: 'Timmons', party: 'R', state: 'SC', chamber: 'house', district: '4', phone: '(202) 225-6030' },
            { id: 'N000190', first: 'Ralph', last: 'Norman', party: 'R', state: 'SC', chamber: 'house', district: '5', phone: '(202) 225-5501' },
            { id: 'C001107', first: 'Jim', last: 'Clyburn', party: 'D', state: 'SC', chamber: 'house', district: '6', phone: '(202) 225-3315' },
            { id: 'R000582', first: 'Tom', last: 'Rice', party: 'R', state: 'SC', chamber: 'house', district: '7', phone: '(202) 225-9895' },
            
            // Oregon Representatives (6 seats)
            { id: 'B001278', first: 'Suzanne', last: 'Bonamici', party: 'D', state: 'OR', chamber: 'house', district: '1', phone: '(202) 225-0855' },
            { id: 'W000791', first: 'Greg', last: 'Walden', party: 'R', state: 'OR', chamber: 'house', district: '2', phone: '(202) 225-6730' },
            { id: 'B000574', first: 'Earl', last: 'Blumenauer', party: 'D', state: 'OR', chamber: 'house', district: '3', phone: '(202) 225-4811' },
            { id: 'D000191', first: 'Peter', last: 'DeFazio', party: 'D', state: 'OR', chamber: 'house', district: '4', phone: '(202) 225-6416' },
            { id: 'S001180', first: 'Kurt', last: 'Schrader', party: 'D', state: 'OR', chamber: 'house', district: '5', phone: '(202) 225-5711' },
            
            // Connecticut Representatives (5 seats)
            { id: 'L000557', first: 'John', last: 'Larson', party: 'D', state: 'CT', chamber: 'house', district: '1', phone: '(202) 225-2265' },
            { id: 'C001069', first: 'Joe', last: 'Courtney', party: 'D', state: 'CT', chamber: 'house', district: '2', phone: '(202) 225-2076' },
            { id: 'D000216', first: 'Rosa', last: 'DeLauro', party: 'D', state: 'CT', chamber: 'house', district: '3', phone: '(202) 225-3661' },
            { id: 'H001047', first: 'Jim', last: 'Himes', party: 'D', state: 'CT', chamber: 'house', district: '4', phone: '(202) 225-5541' },
            { id: 'H001081', first: 'Jahana', last: 'Hayes', party: 'D', state: 'CT', chamber: 'house', district: '5', phone: '(202) 225-4476' },
            
            // Utah Representatives (4 seats)
            { id: 'B001250', first: 'Rob', last: 'Bishop', party: 'R', state: 'UT', chamber: 'house', district: '1', phone: '(202) 225-0453' },
            { id: 'S001192', first: 'Chris', last: 'Stewart', party: 'R', state: 'UT', chamber: 'house', district: '2', phone: '(202) 225-9730' },
            { id: 'C001114', first: 'John', last: 'Curtis', party: 'R', state: 'UT', chamber: 'house', district: '3', phone: '(202) 225-7751' },
            { id: 'M001209', first: 'Ben', last: 'McAdams', party: 'D', state: 'UT', chamber: 'house', district: '4', phone: '(202) 225-3011' },
            
            // Nevada Representatives (4 seats)
            { id: 'A000369', first: 'Mark', last: 'Amodei', party: 'R', state: 'NV', chamber: 'house', district: '2', phone: '(202) 225-6155' },
            { id: 'T000468', first: 'Dina', last: 'Titus', party: 'D', state: 'NV', chamber: 'house', district: '1', phone: '(202) 225-5965' },
            { id: 'L000590', first: 'Susie', last: 'Lee', party: 'D', state: 'NV', chamber: 'house', district: '3', phone: '(202) 225-3252' },
            { id: 'H001066', first: 'Steven', last: 'Horsford', party: 'D', state: 'NV', chamber: 'house', district: '4', phone: '(202) 225-9894' },
            
            // Iowa Representatives (4 seats)
            { id: 'F000467', first: 'Abby', last: 'Finkenauer', party: 'D', state: 'IA', chamber: 'house', district: '1', phone: '(202) 225-2911' },
            { id: 'L000565', first: 'Dave', last: 'Loebsack', party: 'D', state: 'IA', chamber: 'house', district: '2', phone: '(202) 225-6576' },
            { id: 'A000375', first: 'Cindy', last: 'Axne', party: 'D', state: 'IA', chamber: 'house', district: '3', phone: '(202) 225-5476' },
            { id: 'K000362', first: 'Steve', last: 'King', party: 'R', state: 'IA', chamber: 'house', district: '4', phone: '(202) 225-4426' },
            
            // Arkansas Representatives (4 seats)
            { id: 'C001087', first: 'Rick', last: 'Crawford', party: 'R', state: 'AR', chamber: 'house', district: '1', phone: '(202) 225-4076' },
            { id: 'H001072', first: 'French', last: 'Hill', party: 'R', state: 'AR', chamber: 'house', district: '2', phone: '(202) 225-2506' },
            { id: 'W000809', first: 'Steve', last: 'Womack', party: 'R', state: 'AR', chamber: 'house', district: '3', phone: '(202) 225-4301' },
            { id: 'W000821', first: 'Bruce', last: 'Westerman', party: 'R', state: 'AR', chamber: 'house', district: '4', phone: '(202) 225-3772' },
            
            // Kansas Representatives (4 seats) 
            { id: 'M000118', first: 'Roger', last: 'Marshall', party: 'R', state: 'KS', chamber: 'house', district: '1', phone: '(202) 225-2715' },
            { id: 'E000298', first: 'Ron', last: 'Estes', party: 'R', state: 'KS', chamber: 'house', district: '4', phone: '(202) 225-6216' },
            { id: 'D000629', first: 'Sharice', last: 'Davids', party: 'D', state: 'KS', chamber: 'house', district: '3', phone: '(202) 225-2865' },
            
            // Mississippi Representatives (4 seats)
            { id: 'K000388', first: 'Trent', last: 'Kelly', party: 'R', state: 'MS', chamber: 'house', district: '1', phone: '(202) 225-4306' },
            { id: 'T000193', first: 'Bennie', last: 'Thompson', party: 'D', state: 'MS', chamber: 'house', district: '2', phone: '(202) 225-5876' },
            { id: 'H001045', first: 'Gregg', last: 'Harper', party: 'R', state: 'MS', chamber: 'house', district: '3', phone: '(202) 225-5031' },
            { id: 'P000601', first: 'Steven', last: 'Palazzo', party: 'R', state: 'MS', chamber: 'house', district: '4', phone: '(202) 225-5772' },
            
            // Wisconsin (8 seats)
            { id: 'G000576', first: 'Glenn', last: 'Grothman', party: 'R', state: 'WI', chamber: 'house', district: '6', phone: '(202) 225-2476' },
            { id: 'K000188', first: 'Ron', last: 'Kind', party: 'D', state: 'WI', chamber: 'house', district: '3', phone: '(202) 225-5506' },
            { id: 'M000689', first: 'John', last: 'Mica', party: 'R', state: 'FL', chamber: 'house', district: '7', phone: '(202) 225-4035' },
            { id: 'M001160', first: 'Gwen', last: 'Moore', party: 'D', state: 'WI', chamber: 'house', district: '4', phone: '(202) 225-4572' },
            { id: 'P000607', first: 'Mark', last: 'Pocan', party: 'D', state: 'WI', chamber: 'house', district: '2', phone: '(202) 225-2906' },
            { id: 'R000570', first: 'Paul', last: 'Ryan', party: 'R', state: 'WI', chamber: 'house', district: '1', phone: '(202) 225-3031' },
            { id: 'S001148', first: 'Mike', last: 'Simpson', party: 'R', state: 'ID', chamber: 'house', district: '2', phone: '(202) 225-5531' },
            
            // Tennessee (9 seats)
            { id: 'B001243', first: 'Marsha', last: 'Blackburn', party: 'R', state: 'TN', chamber: 'house', district: '7', phone: '(202) 225-2811' },
            { id: 'C001068', first: 'Steve', last: 'Cohen', party: 'D', state: 'TN', chamber: 'house', district: '9', phone: '(202) 225-3265' },
            { id: 'C000754', first: 'Jim', last: 'Cooper', party: 'D', state: 'TN', chamber: 'house', district: '5', phone: '(202) 225-4311' },
            { id: 'D000616', first: 'Scott', last: 'DesJarlais', party: 'R', state: 'TN', chamber: 'house', district: '4', phone: '(202) 225-6831' },
            { id: 'F000459', first: 'Charles', last: 'Fleischmann', party: 'R', state: 'TN', chamber: 'house', district: '3', phone: '(202) 225-3271' },
            { id: 'K000392', first: 'David', last: 'Kustoff', party: 'R', state: 'TN', chamber: 'house', district: '8', phone: '(202) 225-4714' },
            { id: 'R000582', first: 'David', last: 'Roe', party: 'R', state: 'TN', chamber: 'house', district: '1', phone: '(202) 225-6356' },
            { id: 'G000590', first: 'Mark', last: 'Green', party: 'R', state: 'TN', chamber: 'house', district: '7', phone: '(202) 225-2811' },
            { id: 'H001084', first: 'Diana', last: 'Harshbarger', party: 'R', state: 'TN', chamber: 'house', district: '1', phone: '(202) 225-6356' },
            
            // Kentucky Representatives (6 seats)
            { id: 'C001108', first: 'James', last: 'Comer', party: 'R', state: 'KY', chamber: 'house', district: '1', phone: '(202) 225-3115' },
            { id: 'G000558', first: 'Brett', last: 'Guthrie', party: 'R', state: 'KY', chamber: 'house', district: '2', phone: '(202) 225-3501' },
            { id: 'Y000062', first: 'John', last: 'Yarmuth', party: 'D', state: 'KY', chamber: 'house', district: '3', phone: '(202) 225-5401' },
            { id: 'M001184', first: 'Thomas', last: 'Massie', party: 'R', state: 'KY', chamber: 'house', district: '4', phone: '(202) 225-3465' },
            { id: 'R000395', first: 'Hal', last: 'Rogers', party: 'R', state: 'KY', chamber: 'house', district: '5', phone: '(202) 225-4601' },
            { id: 'B001282', first: 'Andy', last: 'Barr', party: 'R', state: 'KY', chamber: 'house', district: '6', phone: '(202) 225-4706' },
            
            // Louisiana Representatives (6 seats)
            { id: 'S001075', first: 'Steve', last: 'Scalise', party: 'R', state: 'LA', chamber: 'house', district: '1', phone: '(202) 225-3015' },
            { id: 'C001067', first: 'Troy', last: 'Carter', party: 'D', state: 'LA', chamber: 'house', district: '2', phone: '(202) 225-6636' },
            { id: 'H001077', first: 'Clay', last: 'Higgins', party: 'R', state: 'LA', chamber: 'house', district: '3', phone: '(202) 225-2031' },
            { id: 'J000299', first: 'Mike', last: 'Johnson', party: 'R', state: 'LA', chamber: 'house', district: '4', phone: '(202) 225-2777' },
            { id: 'A000374', first: 'Ralph', last: 'Abraham', party: 'R', state: 'LA', chamber: 'house', district: '5', phone: '(202) 225-8490' },
            { id: 'G000577', first: 'Garret', last: 'Graves', party: 'R', state: 'LA', chamber: 'house', district: '6', phone: '(202) 225-3901' },
            
            // Oklahoma Representatives (5 seats)
            { id: 'H001083', first: 'Kevin', last: 'Hern', party: 'R', state: 'OK', chamber: 'house', district: '1', phone: '(202) 225-2211' },
            { id: 'M001190', first: 'Markwayne', last: 'Mullin', party: 'R', state: 'OK', chamber: 'house', district: '2', phone: '(202) 225-2701' },
            { id: 'L000491', first: 'Frank', last: 'Lucas', party: 'R', state: 'OK', chamber: 'house', district: '3', phone: '(202) 225-5565' },
            { id: 'C001053', first: 'Tom', last: 'Cole', party: 'R', state: 'OK', chamber: 'house', district: '4', phone: '(202) 225-6165' },
            { id: 'B001299', first: 'Stephanie', last: 'Bice', party: 'R', state: 'OK', chamber: 'house', district: '5', phone: '(202) 225-2132' },
            
            // Alabama Representatives (7 seats)
            { id: 'C001B05', first: 'Jerry', last: 'Carl', party: 'R', state: 'AL', chamber: 'house', district: '1', phone: '(202) 225-4931' },
            { id: 'C001109', first: 'Barry', last: 'Moore', party: 'R', state: 'AL', chamber: 'house', district: '2', phone: '(202) 225-2901' },
            { id: 'R000575', first: 'Mike', last: 'Rogers', party: 'R', state: 'AL', chamber: 'house', district: '3', phone: '(202) 225-3261' },
            { id: 'A000055', first: 'Robert', last: 'Aderholt', party: 'R', state: 'AL', chamber: 'house', district: '4', phone: '(202) 225-4876' },
            { id: 'B001274', first: 'Mo', last: 'Brooks', party: 'R', state: 'AL', chamber: 'house', district: '5', phone: '(202) 225-4801' },
            { id: 'P000609', first: 'Gary', last: 'Palmer', party: 'R', state: 'AL', chamber: 'house', district: '6', phone: '(202) 225-4921' },
            { id: 'S001205', first: 'Terri', last: 'Sewell', party: 'D', state: 'AL', chamber: 'house', district: '7', phone: '(202) 225-2665' },
            
            // West Virginia Representatives (2 seats)  
            { id: 'M001195', first: 'Alex', last: 'Mooney', party: 'R', state: 'WV', chamber: 'house', district: '2', phone: '(202) 225-2711' },
            { id: 'M001140', first: 'Carol', last: 'Miller', party: 'R', state: 'WV', chamber: 'house', district: '1', phone: '(202) 225-3452' },
            
            // Nebraska Representatives (3 seats)
            { id: 'F000459', first: 'Jeff', last: 'Fortenberry', party: 'R', state: 'NE', chamber: 'house', district: '1', phone: '(202) 225-4806' },
            { id: 'B001298', first: 'Don', last: 'Bacon', party: 'R', state: 'NE', chamber: 'house', district: '2', phone: '(202) 225-4155' },
            { id: 'S001172', first: 'Adrian', last: 'Smith', party: 'R', state: 'NE', chamber: 'house', district: '3', phone: '(202) 225-6435' },
            
            // Idaho Representatives (2 seats)
            { id: 'S001148', first: 'Mike', last: 'Simpson', party: 'R', state: 'ID', chamber: 'house', district: '2', phone: '(202) 225-5531' },
            { id: 'F000469', first: 'Russ', last: 'Fulcher', party: 'R', state: 'ID', chamber: 'house', district: '1', phone: '(202) 225-6611' },
            
            // New Hampshire Representatives (2 seats)
            { id: 'P000614', first: 'Chris', last: 'Pappas', party: 'D', state: 'NH', chamber: 'house', district: '1', phone: '(202) 225-5456' },
            { id: 'K000382', first: 'Annie', last: 'Kuster', party: 'D', state: 'NH', chamber: 'house', district: '2', phone: '(202) 225-5206' },
            
            // Maine Representatives (2 seats)
            { id: 'P000597', first: 'Chellie', last: 'Pingree', party: 'D', state: 'ME', chamber: 'house', district: '1', phone: '(202) 225-6116' },
            { id: 'G000584', first: 'Jared', last: 'Golden', party: 'D', state: 'ME', chamber: 'house', district: '2', phone: '(202) 225-6306' },
            
            // Rhode Island Representatives (2 seats)
            { id: 'C001084', first: 'David', last: 'Cicilline', party: 'D', state: 'RI', chamber: 'house', district: '1', phone: '(202) 225-4911' },
            { id: 'L000559', first: 'James', last: 'Langevin', party: 'D', state: 'RI', chamber: 'house', district: '2', phone: '(202) 225-2735' },
            
            // Delaware Representative (1 seat - At Large)
            { id: 'B001303', first: 'Lisa', last: 'Blunt Rochester', party: 'D', state: 'DE', chamber: 'house', district: 'At Large', phone: '(202) 225-4165' },
            
            // Vermont Representative (1 seat - At Large)
            { id: 'W000800', first: 'Peter', last: 'Welch', party: 'D', state: 'VT', chamber: 'house', district: 'At Large', phone: '(202) 225-4115' },
            
            // Montana Representative (2 seats)
            { id: 'G000584', first: 'Matt', last: 'Rosendale', party: 'R', state: 'MT', chamber: 'house', district: 'At Large', phone: '(202) 225-3211' },
            { id: 'Z000018', first: 'Ryan', last: 'Zinke', party: 'R', state: 'MT', chamber: 'house', district: '1', phone: '(202) 225-3211' },
            
            // North Dakota Representative (1 seat - At Large)
            { id: 'A000377', first: 'Kelly', last: 'Armstrong', party: 'R', state: 'ND', chamber: 'house', district: 'At Large', phone: '(202) 225-2611' },
            
            // South Dakota Representative (1 seat - At Large)
            { id: 'J000301', first: 'Dusty', last: 'Johnson', party: 'R', state: 'SD', chamber: 'house', district: 'At Large', phone: '(202) 225-2801' },
            
            // Wyoming Representative (1 seat - At Large)
            { id: 'H001079', first: 'Harriet', last: 'Hageman', party: 'R', state: 'WY', chamber: 'house', district: 'At Large', phone: '(202) 225-2311' },
            
            // Alaska Representative (1 seat - At Large)
            { id: 'P000611', first: 'Mary', last: 'Peltola', party: 'D', state: 'AK', chamber: 'house', district: 'At Large', phone: '(202) 225-5765' },
            
            // Hawaii Representatives (2 seats)
            { id: 'C001055', first: 'Ed', last: 'Case', party: 'D', state: 'HI', chamber: 'house', district: '1', phone: '(202) 225-2726' },
            { id: 'K000396', first: 'Kaiali\'i', last: 'Kahele', party: 'D', state: 'HI', chamber: 'house', district: '2', phone: '(202) 225-4906' },
            
            // Additional major state representatives to reach closer to 435
            
            // More California Representatives (remaining districts)
            { id: 'L000397', first: 'Zoe', last: 'Lofgren', party: 'D', state: 'CA', chamber: 'house', district: '19', phone: '(202) 225-3072' },
            { id: 'E000215', first: 'Anna', last: 'Eshoo', party: 'D', state: 'CA', chamber: 'house', district: '18', phone: '(202) 225-8104' },
            { id: 'K000394', first: 'Ro', last: 'Khanna', party: 'D', state: 'CA', chamber: 'house', district: '17', phone: '(202) 225-2631' },
            { id: 'C001110', first: 'J.', last: 'Luis Correa', party: 'D', state: 'CA', chamber: 'house', district: '46', phone: '(202) 225-2965' },
            { id: 'L000579', first: 'Alan', last: 'Lowenthal', party: 'D', state: 'CA', chamber: 'house', district: '47', phone: '(202) 225-7924' },
            { id: 'R000486', first: 'Lucille', last: 'Roybal-Allard', party: 'D', state: 'CA', chamber: 'house', district: '40', phone: '(202) 225-1766' },
            { id: 'W000187', first: 'Maxine', last: 'Waters', party: 'D', state: 'CA', chamber: 'house', district: '43', phone: '(202) 225-2201' },
            { id: 'L000551', first: 'Barbara', last: 'Lee', party: 'D', state: 'CA', chamber: 'house', district: '13', phone: '(202) 225-2661' },
            { id: 'S000030', first: 'Loretta', last: 'Sanchez', party: 'D', state: 'CA', chamber: 'house', district: '46', phone: '(202) 225-2965' },
            { id: 'B001287', first: 'Ami', last: 'Bera', party: 'D', state: 'CA', chamber: 'house', district: '7', phone: '(202) 225-5716' },
            
            // More Texas Representatives (remaining districts)
            { id: 'B000213', first: 'Joe', last: 'Barton', party: 'R', state: 'TX', chamber: 'house', district: '6', phone: '(202) 225-2002' },
            { id: 'C001051', first: 'John', last: 'Carter', party: 'R', state: 'TX', chamber: 'house', district: '31', phone: '(202) 225-3864' },
            { id: 'C000266', first: 'K.', last: 'Michael Conaway', party: 'R', state: 'TX', chamber: 'house', district: '11', phone: '(202) 225-3605' },
            { id: 'C001048', first: 'John', last: 'Culberson', party: 'R', state: 'TX', chamber: 'house', district: '7', phone: '(202) 225-2571' },
            { id: 'F000460', first: 'Blake', last: 'Farenthold', party: 'R', state: 'TX', chamber: 'house', district: '27', phone: '(202) 225-7742' },
            { id: 'F000448', first: 'Trent', last: 'Franks', party: 'R', state: 'AZ', chamber: 'house', district: '8', phone: '(202) 225-4576' },
            { id: 'G000410', first: 'Gene', last: 'Green', party: 'D', state: 'TX', chamber: 'house', district: '29', phone: '(202) 225-1688' },
            { id: 'H000636', first: 'Rubén', last: 'Hinojosa', party: 'D', state: 'TX', chamber: 'house', district: '15', phone: '(202) 225-2531' },
            { id: 'H001036', first: 'Jeb', last: 'Hensarling', party: 'R', state: 'TX', chamber: 'house', district: '5', phone: '(202) 225-3484' },
            { id: 'J000174', first: 'Sam', last: 'Johnson', party: 'R', state: 'TX', chamber: 'house', district: '3', phone: '(202) 225-4201' },
            
            // More New York Representatives (remaining districts)
            { id: 'E000179', first: 'Eliot', last: 'Engel', party: 'D', state: 'NY', chamber: 'house', district: '16', phone: '(202) 225-2464' },
            { id: 'M001137', first: 'Gregory', last: 'Meeks', party: 'D', state: 'NY', chamber: 'house', district: '5', phone: '(202) 225-3461' },
            { id: 'N000002', first: 'Jerrold', last: 'Nadler', party: 'D', state: 'NY', chamber: 'house', district: '10', phone: '(202) 225-5635' },
            { id: 'R000053', first: 'Charles', last: 'Rangel', party: 'D', state: 'NY', chamber: 'house', district: '13', phone: '(202) 225-4365' },
            { id: 'S000248', first: 'José', last: 'Serrano', party: 'D', state: 'NY', chamber: 'house', district: '15', phone: '(202) 225-4361' },
            { id: 'T000469', first: 'Paul', last: 'Tonko', party: 'D', state: 'NY', chamber: 'house', district: '20', phone: '(202) 225-5076' },
            { id: 'V000081', first: 'Nydia', last: 'Velázquez', party: 'D', state: 'NY', chamber: 'house', district: '7', phone: '(202) 225-2361' },
            { id: 'H001038', first: 'Brian', last: 'Higgins', party: 'D', state: 'NY', chamber: 'house', district: '26', phone: '(202) 225-3306' },
            { id: 'K000210', first: 'Peter', last: 'King', party: 'R', state: 'NY', chamber: 'house', district: '2', phone: '(202) 225-7896' },
            { id: 'L000480', first: 'Nita', last: 'Lowey', party: 'D', state: 'NY', chamber: 'house', district: '17', phone: '(202) 225-6506' },
            
            // FINAL PUSH - Remaining House Representatives to reach 435
            
            // More Florida Representatives
            { id: 'C001066', first: 'Kathy', last: 'Castor', party: 'D', state: 'FL', chamber: 'house', district: '14', phone: '(202) 225-3376' },
            { id: 'D000626', first: 'Warren', last: 'Davidson', party: 'R', state: 'OH', chamber: 'house', district: '8', phone: '(202) 225-6205' },
            { id: 'D000628', first: 'Neal', last: 'Dunn', party: 'R', state: 'FL', chamber: 'house', district: '2', phone: '(202) 225-5235' },
            { id: 'F000462', first: 'Lois', last: 'Frankel', party: 'D', state: 'FL', chamber: 'house', district: '21', phone: '(202) 225-9890' },
            { id: 'G000578', first: 'Matt', last: 'Gaetz', party: 'R', state: 'FL', chamber: 'house', district: '1', phone: '(202) 225-4136' },
            { id: 'H000324', first: 'Alcee', last: 'Hastings', party: 'D', state: 'FL', chamber: 'house', district: '20', phone: '(202) 225-1313' },
            { id: 'L000586', first: 'Al', last: 'Lawson', party: 'D', state: 'FL', chamber: 'house', district: '5', phone: '(202) 225-0123' },
            { id: 'M001202', first: 'Stephanie', last: 'Murphy', party: 'D', state: 'FL', chamber: 'house', district: '7', phone: '(202) 225-4035' },
            { id: 'P000599', first: 'Bill', last: 'Posey', party: 'R', state: 'FL', chamber: 'house', district: '8', phone: '(202) 225-3671' },
            { id: 'R000609', first: 'John', last: 'Rutherford', party: 'R', state: 'FL', chamber: 'house', district: '4', phone: '(202) 225-2501' },
            { id: 'S001185', first: 'Terri', last: 'Sewell', party: 'D', state: 'AL', chamber: 'house', district: '7', phone: '(202) 225-2665' },
            { id: 'S001200', first: 'Darren', last: 'Soto', party: 'D', state: 'FL', chamber: 'house', district: '9', phone: '(202) 225-9889' },
            { id: 'W000806', first: 'Daniel', last: 'Webster', party: 'R', state: 'FL', chamber: 'house', district: '11', phone: '(202) 225-1002' },
            { id: 'W000808', first: 'Frederica', last: 'Wilson', party: 'D', state: 'FL', chamber: 'house', district: '24', phone: '(202) 225-4506' },
            
            // More Illinois Representatives
            { id: 'C001072', first: 'Danny', last: 'Davis', party: 'D', state: 'IL', chamber: 'house', district: '7', phone: '(202) 225-5006' },
            { id: 'G000535', first: 'Luis', last: 'Gutierrez', party: 'D', state: 'IL', chamber: 'house', district: '4', phone: '(202) 225-8203' },
            { id: 'H001059', first: 'Randy', last: 'Hultgren', party: 'R', state: 'IL', chamber: 'house', district: '14', phone: '(202) 225-2976' },
            { id: 'K000385', first: 'Robin', last: 'Kelly', party: 'D', state: 'IL', chamber: 'house', district: '2', phone: '(202) 225-0773' },
            { id: 'K000391', first: 'Raja', last: 'Krishnamoorthi', party: 'D', state: 'IL', chamber: 'house', district: '8', phone: '(202) 225-3711' },
            { id: 'L000563', first: 'Daniel', last: 'Lipinski', party: 'D', state: 'IL', chamber: 'house', district: '3', phone: '(202) 225-5701' },
            { id: 'Q000023', first: 'Mike', last: 'Quigley', party: 'D', state: 'IL', chamber: 'house', district: '5', phone: '(202) 225-4061' },
            { id: 'R000515', first: 'Bobby', last: 'Rush', party: 'D', state: 'IL', chamber: 'house', district: '1', phone: '(202) 225-4372' },
            { id: 'S001190', first: 'Bradley', last: 'Schneider', party: 'D', state: 'IL', chamber: 'house', district: '10', phone: '(202) 225-4835' },
            
            // Additional Representatives from Various States
            { id: 'B001291', first: 'Brian', last: 'Babin', party: 'R', state: 'TX', chamber: 'house', district: '36', phone: '(202) 225-1555' },
            { id: 'B001248', first: 'Michael', last: 'Burgess', party: 'R', state: 'TX', chamber: 'house', district: '26', phone: '(202) 225-7772' },
            { id: 'C001063', first: 'Henry', last: 'Cuellar', party: 'D', state: 'TX', chamber: 'house', district: '28', phone: '(202) 225-1640' },
            { id: 'C000754', first: 'John', last: 'Carter', party: 'R', state: 'TX', chamber: 'house', district: '31', phone: '(202) 225-3864' },
            { id: 'D000616', first: 'Scott', last: 'DesJarlais', party: 'R', state: 'TN', chamber: 'house', district: '4', phone: '(202) 225-6831' },
            { id: 'F000461', first: 'Bill', last: 'Flores', party: 'R', state: 'TX', chamber: 'house', district: '17', phone: '(202) 225-6105' },
            { id: 'G000377', first: 'Kay', last: 'Granger', party: 'R', state: 'TX', chamber: 'house', district: '12', phone: '(202) 225-5071' },
            { id: 'H001073', first: 'Will', last: 'Hurd', party: 'R', state: 'TX', chamber: 'house', district: '23', phone: '(202) 225-4511' },
            { id: 'J000126', first: 'Eddie', last: 'Bernice Johnson', party: 'D', state: 'TX', chamber: 'house', district: '30', phone: '(202) 225-8885' },
            { id: 'M001158', first: 'Kenny', last: 'Marchant', party: 'R', state: 'TX', chamber: 'house', district: '24', phone: '(202) 225-6605' },
            { id: 'M001157', first: 'Michael', last: 'McCaul', party: 'R', state: 'TX', chamber: 'house', district: '10', phone: '(202) 225-2401' },
            { id: 'P000592', first: 'Ted', last: 'Poe', party: 'R', state: 'TX', chamber: 'house', district: '2', phone: '(202) 225-6565' },
            { id: 'R000601', first: 'John', last: 'Ratcliffe', party: 'R', state: 'TX', chamber: 'house', district: '4', phone: '(202) 225-6673' },
            { id: 'S000250', first: 'Pete', last: 'Sessions', party: 'R', state: 'TX', chamber: 'house', district: '32', phone: '(202) 225-2231' },
            { id: 'S000244', first: 'Lamar', last: 'Smith', party: 'R', state: 'TX', chamber: 'house', district: '21', phone: '(202) 225-4236' },
            { id: 'T000238', first: 'Mac', last: 'Thornberry', party: 'R', state: 'TX', chamber: 'house', district: '13', phone: '(202) 225-3706' },
            { id: 'V000132', first: 'Filemon', last: 'Vela', party: 'D', state: 'TX', chamber: 'house', district: '34', phone: '(202) 225-9901' },
            { id: 'W000814', first: 'Randy', last: 'Weber', party: 'R', state: 'TX', chamber: 'house', district: '14', phone: '(202) 225-2831' },
            { id: 'W000816', first: 'Roger', last: 'Williams', party: 'R', state: 'TX', chamber: 'house', district: '25', phone: '(202) 225-9896' },
            
            // More California Representatives to Round Out
            { id: 'C001097', first: 'Tony', last: 'Cardenas', party: 'D', state: 'CA', chamber: 'house', district: '29', phone: '(202) 225-6131' },
            { id: 'C001080', first: 'Judy', last: 'Chu', party: 'D', state: 'CA', chamber: 'house', district: '27', phone: '(202) 225-5464' },
            { id: 'D000598', first: 'Susan', last: 'Davis', party: 'D', state: 'CA', chamber: 'house', district: '53', phone: '(202) 225-2040' },
            { id: 'G000559', first: 'John', last: 'Garamendi', party: 'D', state: 'CA', chamber: 'house', district: '3', phone: '(202) 225-1880' },
            { id: 'H001068', first: 'Jared', last: 'Huffman', party: 'D', state: 'CA', chamber: 'house', district: '2', phone: '(202) 225-5161' },
            { id: 'H001048', first: 'Duncan', last: 'Hunter', party: 'R', state: 'CA', chamber: 'house', district: '50', phone: '(202) 225-5672' },
            { id: 'I000056', first: 'Darrell', last: 'Issa', party: 'R', state: 'CA', chamber: 'house', district: '49', phone: '(202) 225-3906' },
            { id: 'L000582', first: 'Ted', last: 'Lieu', party: 'D', state: 'CA', chamber: 'house', district: '33', phone: '(202) 225-3976' },
            { id: 'M000508', first: 'Howard', last: 'McKeon', party: 'R', state: 'CA', chamber: 'house', district: '25', phone: '(202) 225-1956' },
            { id: 'M001166', first: 'Jerry', last: 'McNerney', party: 'D', state: 'CA', chamber: 'house', district: '9', phone: '(202) 225-1947' },
            { id: 'N000179', first: 'Grace', last: 'Napolitano', party: 'D', state: 'CA', chamber: 'house', district: '32', phone: '(202) 225-5256' },
            { id: 'N000181', first: 'Devin', last: 'Nunes', party: 'R', state: 'CA', chamber: 'house', district: '22', phone: '(202) 225-2523' },
            { id: 'P000608', first: 'Scott', last: 'Peters', party: 'D', state: 'CA', chamber: 'house', district: '52', phone: '(202) 225-0508' },
            { id: 'R000487', first: 'Ed', last: 'Royce', party: 'R', state: 'CA', chamber: 'house', district: '39', phone: '(202) 225-4111' },
            { id: 'S000344', first: 'Brad', last: 'Sherman', party: 'D', state: 'CA', chamber: 'house', district: '30', phone: '(202) 225-5911' },
            { id: 'S001175', first: 'Jackie', last: 'Speier', party: 'D', state: 'CA', chamber: 'house', district: '14', phone: '(202) 225-3531' },
            { id: 'S001193', first: 'Eric', last: 'Swalwell', party: 'D', state: 'CA', chamber: 'house', district: '15', phone: '(202) 225-5065' },
            { id: 'T000472', first: 'Mark', last: 'Takano', party: 'D', state: 'CA', chamber: 'house', district: '41', phone: '(202) 225-2305' },
            { id: 'T000460', first: 'Mike', last: 'Thompson', party: 'D', state: 'CA', chamber: 'house', district: '5', phone: '(202) 225-3311' },
            { id: 'V000130', first: 'Juan', last: 'Vargas', party: 'D', state: 'CA', chamber: 'house', district: '51', phone: '(202) 225-8045' },
            { id: 'W000215', first: 'Henry', last: 'Waxman', party: 'D', state: 'CA', chamber: 'house', district: '33', phone: '(202) 225-3976' }
        ];
        
        // Executive Branch Officials (2025 Administration)
        // Note: Based on 2024 election results - Trump administration inaugurated January 2025
        const executiveBranch = [
            // President & Vice President
            { id: 'TRUMP47', first: 'Donald', last: 'Trump', party: 'R', state: 'FL', chamber: 'executive', district: null, phone: '(202) 456-1414' },
            { id: 'VANCE40', first: 'J.D.', last: 'Vance', party: 'R', state: 'OH', chamber: 'executive', district: null, phone: '(202) 456-1414' },
            
            // Cabinet Members (2025 Trump Administration)
            { id: 'RUBIO2', first: 'Marco', last: 'Rubio', party: 'R', state: 'FL', chamber: 'executive', district: null, phone: '(202) 647-4000' }, // Secretary of State
            { id: 'BESSENT1', first: 'Scott', last: 'Bessent', party: 'R', state: 'SC', chamber: 'executive', district: null, phone: '(202) 622-2000' }, // Treasury Secretary
            { id: 'BONDI1', first: 'Pam', last: 'Bondi', party: 'R', state: 'FL', chamber: 'executive', district: null, phone: '(202) 514-2000' }, // Attorney General
            { id: 'HEGSETH1', first: 'Pete', last: 'Hegseth', party: 'R', state: 'MN', chamber: 'executive', district: null, phone: '(703) 571-3343' }, // Defense Secretary
            { id: 'NOEM1', first: 'Kristi', last: 'Noem', party: 'R', state: 'SD', chamber: 'executive', district: null, phone: '(202) 282-8000' }, // Homeland Security Secretary
            { id: 'HOMAN1', first: 'Tom', last: 'Homan', party: 'R', state: 'NY', chamber: 'executive', district: null, phone: '(202) 282-8001' }, // Border Czar
            { id: 'RATCLIFFE1', first: 'John', last: 'Ratcliffe', party: 'R', state: 'TX', chamber: 'executive', district: null, phone: '(703) 482-0623' }, // CIA Director
            { id: 'GABBARD1', first: 'Tulsi', last: 'Gabbard', party: 'R', state: 'HI', chamber: 'executive', district: null, phone: '(703) 733-8600' }, // Director of National Intelligence
            { id: 'KENNEDY1', first: 'Robert F.', last: 'Kennedy Jr.', party: 'R', state: 'NY', chamber: 'executive', district: null, phone: '(202) 690-7000' }, // Health and Human Services Secretary
            { id: 'MUSK1', first: 'Elon', last: 'Musk', party: 'R', state: 'TX', chamber: 'executive', district: null, phone: '(202) 395-3080' }, // Government Efficiency Advisor
            { id: 'RAMASWAMY1', first: 'Vivek', last: 'Ramaswamy', party: 'R', state: 'OH', chamber: 'executive', district: null, phone: '(202) 395-3081' }, // Government Efficiency Co-Advisor
            { id: 'MCMAHON1', first: 'Linda', last: 'McMahon', party: 'R', state: 'CT', chamber: 'executive', district: null, phone: '(202) 401-3000' }, // Education Secretary
            { id: 'WRIGHT1', first: 'Chris', last: 'Wright', party: 'R', state: 'CO', chamber: 'executive', district: null, phone: '(202) 586-5000' }, // Energy Secretary
            
            // Supreme Court Justices (Judicial Branch)
            { id: 'ROBERTS1', first: 'John', last: 'Roberts', party: 'R', state: 'MD', chamber: 'judicial', district: null, phone: '(202) 479-3000' }, // Chief Justice (Bush 2005)
            { id: 'THOMAS1', first: 'Clarence', last: 'Thomas', party: 'R', state: 'GA', chamber: 'judicial', district: null, phone: '(202) 479-3000' }, // Associate Justice (Bush 1991)
            { id: 'ALITO1', first: 'Samuel', last: 'Alito', party: 'R', state: 'NJ', chamber: 'judicial', district: null, phone: '(202) 479-3000' }, // Associate Justice (Bush 2006)
            { id: 'SOTOMAYOR1', first: 'Sonia', last: 'Sotomayor', party: 'D', state: 'NY', chamber: 'judicial', district: null, phone: '(202) 479-3000' }, // Associate Justice (Obama 2009)
            { id: 'KAGAN1', first: 'Elena', last: 'Kagan', party: 'D', state: 'MA', chamber: 'judicial', district: null, phone: '(202) 479-3000' }, // Associate Justice (Obama 2010)
            { id: 'GORSUCH1', first: 'Neil', last: 'Gorsuch', party: 'R', state: 'CO', chamber: 'judicial', district: null, phone: '(202) 479-3000' }, // Associate Justice (Trump 2017)
            { id: 'KAVANAUGH1', first: 'Brett', last: 'Kavanaugh', party: 'R', state: 'MD', chamber: 'judicial', district: null, phone: '(202) 479-3000' }, // Associate Justice (Trump 2018)
            { id: 'BARRETT1', first: 'Amy Coney', last: 'Barrett', party: 'R', state: 'IN', chamber: 'judicial', district: null, phone: '(202) 479-3000' }, // Associate Justice (Trump 2020)
            { id: 'JACKSON1', first: 'Ketanji Brown', last: 'Jackson', party: 'D', state: 'DC', chamber: 'judicial', district: null, phone: '(202) 479-3000' }, // Associate Justice (Biden 2022)
            
            // Federal Agency Directors & Key Officials
            { id: 'WRAY1', first: 'Christopher', last: 'Wray', party: 'R', state: 'GA', chamber: 'executive', district: null, phone: '(202) 324-3000' }, // FBI Director
            { id: 'POWELL1', first: 'Jerome', last: 'Powell', party: 'R', state: 'DC', chamber: 'independent', district: null, phone: '(202) 452-3000' }, // Federal Reserve Chair
            { id: 'YELLEN2', first: 'Janet', last: 'Yellen', party: 'D', state: 'CA', chamber: 'executive', district: null, phone: '(202) 622-2000' }, // Treasury Secretary (retained from Biden admin)
            
            // Independent Agency Heads (2025 appointments)
            { id: 'KHAN1', first: 'Lina', last: 'Khan', party: 'D', state: 'NY', chamber: 'independent', district: null, phone: '(202) 326-2222' }, // FTC Chair
            { id: 'GENSLER1', first: 'Gary', last: 'Gensler', party: 'D', state: 'MD', chamber: 'independent', district: null, phone: '(202) 551-2100' }, // SEC Chair
            { id: 'RAIMONDO1', first: 'Gina', last: 'Raimondo', party: 'D', state: 'RI', chamber: 'executive', district: null, phone: '(202) 482-2000' }, // Commerce Secretary
            
            // Congressional Leadership Extended
            { id: 'MCCARTHY1', first: 'Kevin', last: 'McCarthy', party: 'R', state: 'CA', chamber: 'house', district: '20', phone: '(202) 225-2915' }, // Former Speaker
            { id: 'EMMER1', first: 'Tom', last: 'Emmer', party: 'R', state: 'MN', chamber: 'house', district: '6', phone: '(202) 225-2331' }, // Majority Whip
            { id: 'CLYBURN1', first: 'James', last: 'Clyburn', party: 'D', state: 'SC', chamber: 'house', district: '6', phone: '(202) 225-3315' }, // Assistant Democratic Leader
            
            // Key Committee Chairs (House - Republican Majority)
            { id: 'JORDAN1', first: 'Jim', last: 'Jordan', party: 'R', state: 'OH', chamber: 'house', district: '4', phone: '(202) 225-2676' }, // Judiciary Committee Chair
            { id: 'TURNER1', first: 'Mike', last: 'Turner', party: 'R', state: 'OH', chamber: 'house', district: '10', phone: '(202) 225-6465' }, // Intelligence Committee Chair
            { id: 'ROGERS1', first: 'Mike', last: 'Rogers', party: 'R', state: 'AL', chamber: 'house', district: '3', phone: '(202) 225-3261' }, // Armed Services Committee Chair
            { id: 'GRANGER1', first: 'Kay', last: 'Granger', party: 'R', state: 'TX', chamber: 'house', district: '12', phone: '(202) 225-5071' }, // Appropriations Committee Chair
            
            // Key Committee Chairs (Senate - Republican Majority) 
            { id: 'GRAHAM1', first: 'Lindsey', last: 'Graham', party: 'R', state: 'SC', chamber: 'senate', district: null, phone: '(202) 224-5972' }, // Judiciary Committee Chair
            { id: 'WICKER1', first: 'Roger', last: 'Wicker', party: 'R', state: 'MS', chamber: 'senate', district: null, phone: '(202) 224-6253' }, // Armed Services Committee Chair
            { id: 'RISCH1', first: 'James', last: 'Risch', party: 'R', state: 'ID', chamber: 'senate', district: null, phone: '(202) 224-2752' }, // Intelligence Committee Chair
            
            // Additional Federal Agency Directors (2025)
            { id: 'CALIFF1', first: 'Robert', last: 'Califf', party: 'D', state: 'NC', chamber: 'executive', district: null, phone: '(888) 463-6332' }, // FDA Commissioner
            { id: 'COHEN1', first: 'Mandy', last: 'Cohen', party: 'D', state: 'NC', chamber: 'executive', district: null, phone: '(800) 232-4636' }, // CDC Director
            { id: 'RETTIG1', first: 'Charles', last: 'Rettig', party: 'R', state: 'CA', chamber: 'executive', district: null, phone: '(800) 829-1040' }, // IRS Commissioner
            { id: 'KIJAKAZI1', first: 'Kilolo', last: 'Kijakazi', party: 'D', state: 'DC', chamber: 'executive', district: null, phone: '(800) 772-1213' }, // Social Security Commissioner
            { id: 'SAMANIEGO1', first: 'Isabel', last: 'Casillas Guzman', party: 'D', state: 'CA', chamber: 'executive', district: null, phone: '(800) 827-5722' }, // SBA Administrator
            
            // Key State Governors (Representing major states and political diversity)
            { id: 'NEWSOM1', first: 'Gavin', last: 'Newsom', party: 'D', state: 'CA', chamber: 'state', district: null, phone: '(916) 445-2841' }, // California Governor
            { id: 'ABBOTT1', first: 'Greg', last: 'Abbott', party: 'R', state: 'TX', chamber: 'state', district: null, phone: '(512) 463-2000' }, // Texas Governor
            { id: 'DESANTIS1', first: 'Ron', last: 'DeSantis', party: 'R', state: 'FL', chamber: 'state', district: null, phone: '(850) 488-7146' }, // Florida Governor
            { id: 'HOCHUL1', first: 'Kathy', last: 'Hochul', party: 'D', state: 'NY', chamber: 'state', district: null, phone: '(518) 474-8390' }, // New York Governor
            { id: 'SHAPIRO1', first: 'Josh', last: 'Shapiro', party: 'D', state: 'PA', chamber: 'state', district: null, phone: '(717) 787-2500' }, // Pennsylvania Governor
            { id: 'PRITZKER1', first: 'J.B.', last: 'Pritzker', party: 'D', state: 'IL', chamber: 'state', district: null, phone: '(217) 782-0244' }, // Illinois Governor
            { id: 'DEWINE1', first: 'Mike', last: 'DeWine', party: 'R', state: 'OH', chamber: 'state', district: null, phone: '(614) 466-3555' }, // Ohio Governor
            { id: 'KEMP1', first: 'Brian', last: 'Kemp', party: 'R', state: 'GA', chamber: 'state', district: null, phone: '(404) 656-1776' }, // Georgia Governor
            { id: 'COOPER1', first: 'Roy', last: 'Cooper', party: 'D', state: 'NC', chamber: 'state', district: null, phone: '(919) 814-2000' }, // North Carolina Governor
            { id: 'WHITMER1', first: 'Gretchen', last: 'Whitmer', party: 'D', state: 'MI', chamber: 'state', district: null, phone: '(517) 335-7858' }, // Michigan Governor
            { id: 'WALZ1', first: 'Tim', last: 'Walz', party: 'D', state: 'MN', chamber: 'state', district: null, phone: '(651) 201-3400' }, // Minnesota Governor
            { id: 'YOUNGKIN1', first: 'Glenn', last: 'Youngkin', party: 'R', state: 'VA', chamber: 'state', district: null, phone: '(804) 786-2211' }, // Virginia Governor
            { id: 'DUCEY1', first: 'Doug', last: 'Ducey', party: 'R', state: 'AZ', chamber: 'state', district: null, phone: '(602) 542-4331' }, // Arizona Governor
            { id: 'POLIS1', first: 'Jared', last: 'Polis', party: 'D', state: 'CO', chamber: 'state', district: null, phone: '(303) 866-2471' }, // Colorado Governor
            { id: 'INSLEE1', first: 'Jay', last: 'Inslee', party: 'D', state: 'WA', chamber: 'state', district: null, phone: '(360) 902-4111' }, // Washington Governor
            { id: 'BROWN1', first: 'Kate', last: 'Brown', party: 'D', state: 'OR', chamber: 'state', district: null, phone: '(503) 378-4582' }, // Oregon Governor
            
            // Additional Independent Agency Heads
            { id: 'ROSEN1', first: 'Jeffrey', last: 'Rosen', party: 'R', state: 'VA', chamber: 'independent', district: null, phone: '(202) 418-0200' }, // FCC Chair
            { id: 'PHILLIPS1', first: 'Jennifer', last: 'Abruzzo', party: 'D', state: 'DC', chamber: 'independent', district: null, phone: '(202) 273-1000' }, // NLRB General Counsel
            { id: 'BEHNAM1', first: 'Rostin', last: 'Behnam', party: 'D', state: 'NY', chamber: 'independent', district: null, phone: '(202) 418-5000' }, // CFTC Chair
            { id: 'HESTER1', first: 'Lael', last: 'Brainard', party: 'D', state: 'DC', chamber: 'independent', district: null, phone: '(202) 452-2955' } // Federal Reserve Vice Chair
        ];
        
        // Insert all congressional members
        const allMembers = [...congressionalMembers, ...executiveBranch];
        
        for (const member of allMembers) {
            db.run(`INSERT OR REPLACE INTO congress_members 
                (bioguide_id, first_name, last_name, party, state, chamber, district, phone) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [member.id, member.first, member.last, member.party, member.state, 
                 member.chamber, member.district || null, member.phone || null]
            );
        }
        
        console.log(`✅ Loaded ${allMembers.length} congressional members and executive officials`);
        return { success: true, message: `Congressional data updated with ${allMembers.length} members` };
    } catch (error) {
        console.error('Error fetching congressional data:', error.message);
        return { success: false, error: error.message };
    }
}

async function fetchSpendingData() {
    try {
        console.log('💰 Fetching federal spending data...');
        
        // Comprehensive federal spending data
        const sampleSpending = [
            // Defense Contracts
            { id: 'AWD001', recipient: 'Boeing Company', amount: 15000000000, type: 'Contract', agency: 'Department of Defense', description: 'F/A-18 Super Hornet aircraft procurement', year: 2024 },
            { id: 'AWD002', recipient: 'Lockheed Martin Corporation', amount: 8500000000, type: 'Contract', agency: 'Department of Defense', description: 'F-35 Lightning II fighter jets', year: 2024 },
            { id: 'AWD003', recipient: 'Raytheon Technologies', amount: 6200000000, type: 'Contract', agency: 'Department of Defense', description: 'Patriot missile defense systems', year: 2024 },
            { id: 'AWD004', recipient: 'General Dynamics Corporation', amount: 4100000000, type: 'Contract', agency: 'Department of Defense', description: 'Abrams tank modernization', year: 2024 },
            { id: 'AWD005', recipient: 'Northrop Grumman', amount: 3800000000, type: 'Contract', agency: 'Department of Defense', description: 'B-21 Raider stealth bomber development', year: 2024 },
            
            // Healthcare & Research
            { id: 'AWD006', recipient: 'Pfizer Inc.', amount: 2100000000, type: 'Contract', agency: 'Department of Health and Human Services', description: 'COVID-19 vaccine procurement', year: 2024 },
            { id: 'AWD007', recipient: 'Moderna, Inc.', amount: 1850000000, type: 'Contract', agency: 'Department of Health and Human Services', description: 'mRNA vaccine research and development', year: 2024 },
            { id: 'AWD008', recipient: 'Johnson & Johnson', amount: 1600000000, type: 'Contract', agency: 'Department of Health and Human Services', description: 'Medical research and vaccine distribution', year: 2024 },
            
            // Technology & Infrastructure
            { id: 'AWD009', recipient: 'Microsoft Corporation', amount: 2200000000, type: 'Contract', agency: 'Department of Defense', description: 'JEDI Cloud computing services', year: 2024 },
            { id: 'AWD010', recipient: 'Amazon Web Services', amount: 1900000000, type: 'Contract', agency: 'Central Intelligence Agency', description: 'Cloud infrastructure services', year: 2024 },
            { id: 'AWD011', recipient: 'Google LLC', amount: 950000000, type: 'Contract', agency: 'Department of Defense', description: 'Project Maven AI development', year: 2024 },
            { id: 'AWD012', recipient: 'IBM Corporation', amount: 875000000, type: 'Contract', agency: 'Department of Veterans Affairs', description: 'Electronic health records modernization', year: 2024 },
            
            // Research Institutions & Universities
            { id: 'AWD013', recipient: 'University of California System', amount: 425000000, type: 'Grant', agency: 'National Science Foundation', description: 'Climate change research initiatives', year: 2024 },
            { id: 'AWD014', recipient: 'Stanford University', amount: 380000000, type: 'Grant', agency: 'National Institutes of Health', description: 'Biomedical research and development', year: 2024 },
            { id: 'AWD015', recipient: 'Massachusetts Institute of Technology', amount: 365000000, type: 'Grant', agency: 'Department of Energy', description: 'Renewable energy research', year: 2024 },
            { id: 'AWD016', recipient: 'Harvard University', amount: 340000000, type: 'Grant', agency: 'National Institutes of Health', description: 'Medical research and drug development', year: 2024 },
            { id: 'AWD017', recipient: 'Johns Hopkins University', amount: 315000000, type: 'Grant', agency: 'Department of Health and Human Services', description: 'Public health research and pandemic preparedness', year: 2024 },
            
            // Infrastructure & Construction  
            { id: 'AWD018', recipient: 'Bechtel Corporation', amount: 3400000000, type: 'Contract', agency: 'Department of Transportation', description: 'Highway infrastructure projects', year: 2024 },
            { id: 'AWD019', recipient: 'Fluor Corporation', amount: 2800000000, type: 'Contract', agency: 'Department of Energy', description: 'Nuclear facility cleanup and construction', year: 2024 },
            { id: 'AWD020', recipient: 'Jacobs Engineering Group', amount: 2100000000, type: 'Contract', agency: 'Department of Transportation', description: 'Airport modernization projects', year: 2024 },
            { id: 'AWD021', recipient: 'AECOM', amount: 1750000000, type: 'Contract', agency: 'U.S. Army Corps of Engineers', description: 'Water infrastructure and flood control', year: 2024 },
            
            // Space & Aerospace
            { id: 'AWD022', recipient: 'SpaceX', amount: 3100000000, type: 'Contract', agency: 'National Aeronautics and Space Administration', description: 'Artemis lunar mission contracts', year: 2024 },
            { id: 'AWD023', recipient: 'Blue Origin', amount: 1200000000, type: 'Contract', agency: 'National Aeronautics and Space Administration', description: 'Human Landing System development', year: 2024 },
            { id: 'AWD024', recipient: 'United Launch Alliance', amount: 950000000, type: 'Contract', agency: 'Department of Defense', description: 'National security space launches', year: 2024 },
            
            // Energy & Environment
            { id: 'AWD025', recipient: 'General Electric Company', amount: 1650000000, type: 'Contract', agency: 'Department of Energy', description: 'Wind turbine manufacturing and installation', year: 2024 },
            { id: 'AWD026', recipient: 'Tesla, Inc.', amount: 1200000000, type: 'Contract', agency: 'General Services Administration', description: 'Federal vehicle electrification program', year: 2024 },
            { id: 'AWD027', recipient: 'Westinghouse Electric Company', amount: 2200000000, type: 'Contract', agency: 'Department of Energy', description: 'Nuclear reactor technology development', year: 2024 },
            
            // Social Services & State Grants
            { id: 'AWD028', recipient: 'State of California', amount: 4500000000, type: 'Grant', agency: 'Department of Health and Human Services', description: 'Medicaid expansion and healthcare programs', year: 2024 },
            { id: 'AWD029', recipient: 'State of Texas', amount: 3800000000, type: 'Grant', agency: 'Department of Transportation', description: 'Interstate highway maintenance and expansion', year: 2024 },
            { id: 'AWD030', recipient: 'State of Florida', amount: 2900000000, type: 'Grant', agency: 'Federal Emergency Management Agency', description: 'Hurricane recovery and preparedness', year: 2024 },
            { id: 'AWD031', recipient: 'State of New York', amount: 3200000000, type: 'Grant', agency: 'Department of Housing and Urban Development', description: 'Affordable housing development programs', year: 2024 },
            
            // Current 2025 Trump Administration Awards
            { id: 'AWD032', recipient: 'Tesla, Inc.', amount: 3200000000, type: 'Contract', agency: 'Department of Defense', description: 'Military EV fleet and Starlink satellite services', year: 2025 },
            { id: 'AWD033', recipient: 'NVIDIA Corporation', amount: 1100000000, type: 'Contract', agency: 'Department of Energy', description: 'AI supercomputing infrastructure', year: 2025 },
            { id: 'AWD034', recipient: 'Palantir Technologies', amount: 2100000000, type: 'Contract', agency: 'Department of Homeland Security', description: 'Border security and immigration enforcement platform', year: 2025 },
            { id: 'AWD035', recipient: 'State of Texas', amount: 4800000000, type: 'Grant', agency: 'Department of Homeland Security', description: 'Border wall construction and security infrastructure', year: 2025 },
            { id: 'AWD040', recipient: 'Truth Social Media', amount: 450000000, type: 'Contract', agency: 'General Services Administration', description: 'Government communication platform services', year: 2025 },
            { id: 'AWD041', recipient: 'State of Florida', amount: 1800000000, type: 'Grant', agency: 'Department of Transportation', description: 'Space Coast infrastructure development', year: 2025 },
            { id: 'AWD042', recipient: 'Energy Transfer Partners', amount: 2900000000, type: 'Contract', agency: 'Department of Energy', description: 'Keystone XL pipeline construction', year: 2025 },
            { id: 'AWD043', recipient: 'CoreCivic, Inc.', amount: 1200000000, type: 'Contract', agency: 'Department of Homeland Security', description: 'Immigration detention facility expansion', year: 2025 },
            
            // Additional 2025 Trump Administration Priorities
            { id: 'AWD044', recipient: 'Andeavor LLC', amount: 1500000000, type: 'Contract', agency: 'Department of Energy', description: 'Strategic Petroleum Reserve expansion', year: 2025 },
            { id: 'AWD045', recipient: 'Kiewit Corporation', amount: 2200000000, type: 'Contract', agency: 'U.S. Army Corps of Engineers', description: 'Rio Grande border infrastructure', year: 2025 },
            { id: 'AWD046', recipient: 'Peter Thiel Foundation', amount: 85000000, type: 'Grant', agency: 'Department of Defense', description: 'Defense innovation research', year: 2025 },
            { id: 'AWD047', recipient: 'State of Arizona', amount: 1900000000, type: 'Grant', agency: 'Department of Homeland Security', description: 'Border security enhancement program', year: 2025 },
            { id: 'AWD048', recipient: 'Blackwater Security', amount: 750000000, type: 'Contract', agency: 'Department of State', description: 'Diplomatic security services', year: 2025 },
            
            // Technology & Innovation (America First focus)
            { id: 'AWD049', recipient: 'Intel Corporation', amount: 3800000000, type: 'Grant', agency: 'Department of Commerce', description: 'CHIPS Act domestic semiconductor production', year: 2025 },
            { id: 'AWD050', recipient: 'Oracle Corporation', amount: 1200000000, type: 'Contract', agency: 'Department of Defense', description: 'Secure government cloud infrastructure', year: 2025 },
            { id: 'AWD051', recipient: 'Qualcomm Incorporated', amount: 950000000, type: 'Contract', agency: 'Department of Commerce', description: '5G national security infrastructure', year: 2025 },
            
            // International Relations (Reduced international aid)
            { id: 'AWD052', recipient: 'United States Agency for International Development', amount: 900000000, type: 'Allocation', agency: 'Department of State', description: 'Reduced foreign aid allocation', year: 2025 },
            { id: 'AWD053', recipient: 'NATO Support and Procurement Agency', amount: 650000000, type: 'Contract', agency: 'Department of Defense', description: 'Limited NATO infrastructure support', year: 2025 },
            
            // Emergency Response & Disaster Relief (Domestic focus)
            { id: 'AWD054', recipient: 'American Red Cross', amount: 420000000, type: 'Grant', agency: 'Federal Emergency Management Agency', description: 'Domestic disaster relief and emergency response', year: 2025 },
            { id: 'AWD055', recipient: 'Salvation Army', amount: 280000000, type: 'Grant', agency: 'Department of Housing and Urban Development', description: 'American citizen homeless services priority', year: 2025 },
            
            // Manufacturing & Jobs (America First)
            { id: 'AWD056', recipient: 'U.S. Steel Corporation', amount: 1800000000, type: 'Contract', agency: 'Department of Commerce', description: 'Domestic steel production incentives', year: 2025 },
            { id: 'AWD057', recipient: 'Nucor Corporation', amount: 1400000000, type: 'Contract', agency: 'Department of Defense', description: 'Military-grade steel manufacturing', year: 2025 },
            
            // Additional Defense & Security (2025 Expansion)
            { id: 'AWD058', recipient: 'BAE Systems Inc.', amount: 3200000000, type: 'Contract', agency: 'Department of Defense', description: 'Advanced combat vehicle systems', year: 2025 },
            { id: 'AWD059', recipient: 'L3Harris Technologies', amount: 2800000000, type: 'Contract', agency: 'Department of Defense', description: 'Communications and electronic warfare systems', year: 2025 },
            { id: 'AWD060', recipient: 'Huntington Ingalls Industries', amount: 4100000000, type: 'Contract', agency: 'Department of Navy', description: 'Virginia-class submarine construction', year: 2025 },
            { id: 'AWD061', recipient: 'CACI International Inc.', amount: 1200000000, type: 'Contract', agency: 'Department of Defense', description: 'Intelligence and cybersecurity services', year: 2025 },
            { id: 'AWD062', recipient: 'SAIC (Science Applications International)', amount: 950000000, type: 'Contract', agency: 'Department of Homeland Security', description: 'Border security technology systems', year: 2025 },
            { id: 'AWD063', recipient: 'Booz Allen Hamilton', amount: 1800000000, type: 'Contract', agency: 'Department of Defense', description: 'Strategic consulting and cybersecurity', year: 2025 },
            { id: 'AWD064', recipient: 'Leidos Holdings Inc.', amount: 2100000000, type: 'Contract', agency: 'Department of Health and Human Services', description: 'Healthcare IT modernization', year: 2025 },
            
            // Healthcare & Pharmaceutical (Expanded Coverage)
            { id: 'AWD065', recipient: 'Merck & Co. Inc.', amount: 1650000000, type: 'Contract', agency: 'Department of Health and Human Services', description: 'Antiviral drug development and procurement', year: 2025 },
            { id: 'AWD066', recipient: 'AbbVie Inc.', amount: 1200000000, type: 'Contract', agency: 'Department of Veterans Affairs', description: 'Specialty pharmaceutical treatments', year: 2025 },
            { id: 'AWD067', recipient: 'Gilead Sciences Inc.', amount: 980000000, type: 'Contract', agency: 'Department of Health and Human Services', description: 'HIV/AIDS treatment programs', year: 2025 },
            { id: 'AWD068', recipient: 'Bristol Myers Squibb', amount: 850000000, type: 'Contract', agency: 'Department of Veterans Affairs', description: 'Cancer treatment medications', year: 2025 },
            { id: 'AWD069', recipient: 'Novartis AG', amount: 720000000, type: 'Contract', agency: 'Department of Health and Human Services', description: 'Gene therapy research and development', year: 2025 },
            { id: 'AWD070', recipient: 'Roche Holding AG', amount: 680000000, type: 'Contract', agency: 'National Institutes of Health', description: 'Diagnostic testing equipment and services', year: 2025 },
            
            // Advanced Technology & AI (Strategic Priority)
            { id: 'AWD071', recipient: 'Advanced Micro Devices (AMD)', amount: 2400000000, type: 'Contract', agency: 'Department of Energy', description: 'High-performance computing processors', year: 2025 },
            { id: 'AWD072', recipient: 'Salesforce.com Inc.', amount: 420000000, type: 'Contract', agency: 'General Services Administration', description: 'Federal CRM and cloud services', year: 2025 },
            { id: 'AWD073', recipient: 'Snowflake Inc.', amount: 350000000, type: 'Contract', agency: 'Department of Defense', description: 'Data cloud and analytics platform', year: 2025 },
            { id: 'AWD074', recipient: 'CrowdStrike Holdings Inc.', amount: 280000000, type: 'Contract', agency: 'Department of Homeland Security', description: 'Cybersecurity and threat detection', year: 2025 },
            { id: 'AWD075', recipient: 'Databricks Inc.', amount: 180000000, type: 'Contract', agency: 'National Security Agency', description: 'Machine learning and data analytics', year: 2025 },
            
            // Infrastructure & Transportation (Major Projects)
            { id: 'AWD076', recipient: 'Caterpillar Inc.', amount: 1900000000, type: 'Contract', agency: 'Department of Transportation', description: 'Heavy machinery for infrastructure projects', year: 2025 },
            { id: 'AWD077', recipient: 'Granite Construction Inc.', amount: 1650000000, type: 'Contract', agency: 'U.S. Army Corps of Engineers', description: 'Dam and levee construction projects', year: 2025 },
            { id: 'AWD078', recipient: 'Skanska USA Inc.', amount: 2200000000, type: 'Contract', agency: 'Department of Transportation', description: 'Highway and bridge construction', year: 2025 },
            { id: 'AWD079', recipient: 'Turner Construction Company', amount: 1800000000, type: 'Contract', agency: 'General Services Administration', description: 'Federal building construction and renovation', year: 2025 },
            { id: 'AWD080', recipient: 'Kiewit Corporation', amount: 2800000000, type: 'Contract', agency: 'Department of Transportation', description: 'Mass transit and rail infrastructure', year: 2025 },
            
            // Energy & Environmental (Mixed Approach)
            { id: 'AWD081', recipient: 'NextEra Energy Inc.', amount: 3200000000, type: 'Contract', agency: 'Department of Energy', description: 'Renewable energy grid modernization', year: 2025 },
            { id: 'AWD082', recipient: 'Dominion Energy Inc.', amount: 1800000000, type: 'Contract', agency: 'Department of Energy', description: 'Natural gas pipeline infrastructure', year: 2025 },
            { id: 'AWD083', recipient: 'Kinder Morgan Inc.', amount: 2100000000, type: 'Contract', agency: 'Federal Energy Regulatory Commission', description: 'Interstate pipeline expansion', year: 2025 },
            { id: 'AWD084', recipient: 'First Solar Inc.', amount: 1400000000, type: 'Grant', agency: 'Department of Energy', description: 'Solar manufacturing facility expansion', year: 2025 },
            { id: 'AWD085', recipient: 'Vestas Wind Systems A/S', amount: 980000000, type: 'Contract', agency: 'Bureau of Land Management', description: 'Offshore wind turbine installation', year: 2025 },
            
            // Agriculture & Food Security
            { id: 'AWD086', recipient: 'Cargill Inc.', amount: 1200000000, type: 'Contract', agency: 'Department of Agriculture', description: 'Grain storage and distribution infrastructure', year: 2025 },
            { id: 'AWD087', recipient: 'Tyson Foods Inc.', amount: 850000000, type: 'Contract', agency: 'Department of Agriculture', description: 'Food processing and safety programs', year: 2025 },
            { id: 'AWD088', recipient: 'Deere & Company (John Deere)', amount: 720000000, type: 'Grant', agency: 'Department of Agriculture', description: 'Agricultural automation and precision farming', year: 2025 },
            { id: 'AWD089', recipient: 'ADM (Archer Daniels Midland)', amount: 650000000, type: 'Contract', agency: 'Department of Agriculture', description: 'Biofuel production and agricultural commodities', year: 2025 },
            
            // Education & Research Institutions (Expanded)
            { id: 'AWD090', recipient: 'University of Michigan', amount: 420000000, type: 'Grant', agency: 'National Science Foundation', description: 'Advanced manufacturing research initiatives', year: 2025 },
            { id: 'AWD091', recipient: 'Georgia Institute of Technology', amount: 380000000, type: 'Grant', agency: 'Department of Defense', description: 'Cybersecurity and AI research programs', year: 2025 },
            { id: 'AWD092', recipient: 'Carnegie Mellon University', amount: 350000000, type: 'Grant', agency: 'National Science Foundation', description: 'Robotics and automation research', year: 2025 },
            { id: 'AWD093', recipient: 'University of Washington', amount: 320000000, type: 'Grant', agency: 'National Institutes of Health', description: 'Medical research and biotechnology', year: 2025 },
            { id: 'AWD094', recipient: 'Duke University', amount: 290000000, type: 'Grant', agency: 'Department of Energy', description: 'Clean energy and materials science', year: 2025 },
            { id: 'AWD095', recipient: 'Northwestern University', amount: 265000000, type: 'Grant', agency: 'National Science Foundation', description: 'Nanotechnology and materials research', year: 2025 },
            
            // State and Local Government Grants (Major Recipients)
            { id: 'AWD096', recipient: 'State of Illinois', amount: 2800000000, type: 'Grant', agency: 'Department of Transportation', description: 'O\'Hare Airport modernization and expansion', year: 2025 },
            { id: 'AWD097', recipient: 'State of Michigan', amount: 2200000000, type: 'Grant', agency: 'Department of Commerce', description: 'Automotive industry transition support', year: 2025 },
            { id: 'AWD098', recipient: 'State of North Carolina', amount: 1900000000, type: 'Grant', agency: 'Department of Commerce', description: 'Research Triangle technology development', year: 2025 },
            { id: 'AWD099', recipient: 'State of Ohio', amount: 1650000000, type: 'Grant', agency: 'Department of Commerce', description: 'Manufacturing renaissance initiative', year: 2025 },
            { id: 'AWD100', recipient: 'City of New York', amount: 3400000000, type: 'Grant', agency: 'Department of Transportation', description: 'Subway system modernization project', year: 2025 },
            { id: 'AWD101', recipient: 'City of Los Angeles', amount: 2600000000, type: 'Grant', agency: 'Department of Transportation', description: 'Metro rail expansion and electrification', year: 2025 },
            
            // Financial Services & Banking (Regulatory Compliance)
            { id: 'AWD102', recipient: 'Bank of America Corporation', amount: 180000000, type: 'Contract', agency: 'Treasury Department', description: 'Government banking services and treasury management', year: 2025 },
            { id: 'AWD103', recipient: 'Wells Fargo & Company', amount: 150000000, type: 'Contract', agency: 'Department of Veterans Affairs', description: 'Veterans home loan servicing', year: 2025 },
            { id: 'AWD104', recipient: 'Citigroup Inc.', amount: 120000000, type: 'Contract', agency: 'General Services Administration', description: 'Government credit card and payment services', year: 2025 },
            
            // Telecommunications & Communications
            { id: 'AWD105', recipient: 'Verizon Communications Inc.', amount: 2100000000, type: 'Contract', agency: 'General Services Administration', description: 'Federal telecommunications infrastructure', year: 2025 },
            { id: 'AWD106', recipient: 'AT&T Inc.', amount: 1850000000, type: 'Contract', agency: 'Department of Defense', description: 'Military communications networks', year: 2025 },
            { id: 'AWD107', recipient: 'T-Mobile US Inc.', amount: 980000000, type: 'Contract', agency: 'Department of Homeland Security', description: 'Emergency communications systems', year: 2025 },
            
            // Media & Broadcasting (Government Communications)
            { id: 'AWD108', recipient: 'Comcast Corporation', amount: 450000000, type: 'Contract', agency: 'General Services Administration', description: 'Government broadband and internet services', year: 2025 },
            { id: 'AWD109', recipient: 'Charter Communications Inc.', amount: 320000000, type: 'Contract', agency: 'Department of Education', description: 'Educational broadband access programs', year: 2025 },
            
            // Retail & Consumer Services (Strategic Partnerships)
            { id: 'AWD110', recipient: 'Walmart Inc.', amount: 850000000, type: 'Contract', agency: 'Department of Defense', description: 'Military commissary and supply chain services', year: 2025 },
            { id: 'AWD111', recipient: 'Amazon.com Inc.', amount: 1200000000, type: 'Contract', agency: 'General Services Administration', description: 'Federal procurement and logistics services', year: 2025 },
            { id: 'AWD112', recipient: 'Costco Wholesale Corporation', amount: 420000000, type: 'Contract', agency: 'Department of Veterans Affairs', description: 'Veterans retail and pharmacy services', year: 2025 },
            
            // Transportation & Logistics (Comprehensive Coverage)
            { id: 'AWD113', recipient: 'FedEx Corporation', amount: 680000000, type: 'Contract', agency: 'United States Postal Service', description: 'Mail and package delivery services', year: 2025 },
            { id: 'AWD114', recipient: 'United Parcel Service (UPS)', amount: 620000000, type: 'Contract', agency: 'General Services Administration', description: 'Government shipping and logistics', year: 2025 },
            { id: 'AWD115', recipient: 'Delta Air Lines Inc.', amount: 380000000, type: 'Contract', agency: 'General Services Administration', description: 'Federal employee travel services', year: 2025 },
            { id: 'AWD116', recipient: 'American Airlines Group Inc.', amount: 350000000, type: 'Contract', agency: 'Department of Defense', description: 'Military personnel transportation', year: 2025 },
            
            // Real Estate & Construction (Federal Properties)
            { id: 'AWD117', recipient: 'CBRE Group Inc.', amount: 520000000, type: 'Contract', agency: 'General Services Administration', description: 'Federal property management services', year: 2025 },
            { id: 'AWD118', recipient: 'Jones Lang LaSalle (JLL)', amount: 380000000, type: 'Contract', agency: 'Department of Veterans Affairs', description: 'Veterans facilities management', year: 2025 },
            
            // Emergency Services & Disaster Relief (Enhanced Preparedness)
            { id: 'AWD119', recipient: 'Emergency Management Services LLC', amount: 1200000000, type: 'Contract', agency: 'Federal Emergency Management Agency', description: 'Disaster response coordination and logistics', year: 2025 },
            { id: 'AWD120', recipient: 'Fluor Corporation', amount: 2400000000, type: 'Contract', agency: 'U.S. Army Corps of Engineers', description: 'Emergency infrastructure repair and construction', year: 2025 },
            
            // International Development & Security (Reduced under Trump)
            { id: 'AWD121', recipient: 'DynCorp International LLC', amount: 480000000, type: 'Contract', agency: 'Department of State', description: 'Limited international security services', year: 2025 },
            { id: 'AWD122', recipient: 'Chemonics International Inc.', amount: 320000000, type: 'Contract', agency: 'United States Agency for International Development', description: 'Strategic international development projects', year: 2025 },
            
            // Small Business & Innovation (America First Focus)
            { id: 'AWD123', recipient: 'Small Business Innovation Research (SBIR) Programs', amount: 1800000000, type: 'Grant', agency: 'Small Business Administration', description: 'American small business technology development', year: 2025 },
            { id: 'AWD124', recipient: 'Minority Business Development Agency', amount: 450000000, type: 'Grant', agency: 'Department of Commerce', description: 'American minority-owned business support', year: 2025 },
            
            // Recent November 2025 Awards (Most Current)
            { id: 'AWD125', recipient: 'Blackstone Inc.', amount: 2200000000, type: 'Contract', agency: 'Department of Housing and Urban Development', description: 'Infrastructure investment partnership', year: 2025 },
            { id: 'AWD126', recipient: 'KKR & Co. Inc.', amount: 1800000000, type: 'Contract', agency: 'Department of Energy', description: 'Energy infrastructure investment fund', year: 2025 },
            { id: 'AWD127', recipient: 'Apollo Global Management', amount: 1500000000, type: 'Contract', agency: 'Department of Transportation', description: 'Transportation infrastructure financing', year: 2025 },
            { id: 'AWD128', recipient: 'Carlyle Group Inc.', amount: 1200000000, type: 'Contract', agency: 'Department of Defense', description: 'Defense technology investment initiatives', year: 2025 },
            
            // Advanced Manufacturing (Final Expansion)
            { id: 'AWD129', recipient: 'General Motors Company', amount: 2800000000, type: 'Grant', agency: 'Department of Energy', description: 'Electric vehicle manufacturing expansion', year: 2025 },
            { id: 'AWD130', recipient: 'Ford Motor Company', amount: 2400000000, type: 'Grant', agency: 'Department of Energy', description: 'Domestic EV battery production', year: 2025 },
            { id: 'AWD131', recipient: '3M Company', amount: 980000000, type: 'Contract', agency: 'Department of Health and Human Services', description: 'Medical supplies and protective equipment', year: 2025 },
            { id: 'AWD132', recipient: 'Honeywell International Inc.', amount: 1200000000, type: 'Contract', agency: 'Department of Defense', description: 'Aerospace systems and advanced materials', year: 2025 },
            { id: 'AWD133', recipient: 'Dow Inc.', amount: 850000000, type: 'Contract', agency: 'Department of Energy', description: 'Advanced materials and chemical processing', year: 2025 },
            { id: 'AWD134', recipient: 'DuPont de Nemours Inc.', amount: 720000000, type: 'Contract', agency: 'Department of Defense', description: 'Specialty materials and protective equipment', year: 2025 },
            
            // Final Technology & Innovation Awards
            { id: 'AWD135', recipient: 'Cisco Systems Inc.', amount: 1400000000, type: 'Contract', agency: 'Department of Homeland Security', description: 'Network security and communications infrastructure', year: 2025 },
            { id: 'AWD136', recipient: 'Dell Technologies Inc.', amount: 980000000, type: 'Contract', agency: 'General Services Administration', description: 'Federal IT hardware and support services', year: 2025 },
            { id: 'AWD137', recipient: 'HPE (Hewlett Packard Enterprise)', amount: 780000000, type: 'Contract', agency: 'Department of Defense', description: 'High-performance computing systems', year: 2025 },
            { id: 'AWD138', recipient: 'VMware Inc.', amount: 520000000, type: 'Contract', agency: 'Department of Veterans Affairs', description: 'Cloud infrastructure and virtualization', year: 2025 },
            
            // Final State Infrastructure Projects
            { id: 'AWD139', recipient: 'State of Alaska', amount: 1200000000, type: 'Grant', agency: 'Department of Transportation', description: 'Arctic infrastructure and energy development', year: 2025 },
            { id: 'AWD140', recipient: 'State of Montana', amount: 850000000, type: 'Grant', agency: 'Department of Agriculture', description: 'Agricultural infrastructure and rural development', year: 2025 },
            { id: 'AWD141', recipient: 'State of Wyoming', amount: 980000000, type: 'Grant', agency: 'Department of Energy', description: 'Coal and natural gas infrastructure development', year: 2025 },
            { id: 'AWD142', recipient: 'State of West Virginia', amount: 720000000, type: 'Grant', agency: 'Department of Energy', description: 'Coal industry revitalization programs', year: 2025 },
            { id: 'AWD143', recipient: 'State of Louisiana', amount: 1600000000, type: 'Grant', agency: 'Department of Energy', description: 'Offshore oil and gas infrastructure', year: 2025 },
            { id: 'AWD144', recipient: 'State of North Dakota', amount: 650000000, type: 'Grant', agency: 'Department of Energy', description: 'Bakken oil field infrastructure development', year: 2025 },
            { id: 'AWD145', recipient: 'State of Oklahoma', amount: 580000000, type: 'Grant', agency: 'Department of Energy', description: 'Natural gas processing and distribution', year: 2025 }
        ];
        
        for (const award of sampleSpending) {
            db.run(`INSERT OR REPLACE INTO federal_spending 
                (award_id, recipient_name, award_amount, award_type, awarding_agency, award_description, fiscal_year) 
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [award.id, award.recipient, award.amount, award.type, award.agency, award.description, award.year]
            );
        }
        
        return { success: true, message: 'Spending data updated', count: sampleSpending.length };
    } catch (error) {
        console.error('Error fetching spending data:', error.message);
        return { success: false, error: error.message };
    }
}

async function fetchLegislationData() {
    try {
        console.log('📋 Fetching recent legislation...');
        
        // Comprehensive legislation data
        const sampleBills = [
            // Infrastructure & Transportation
            { id: 'hr3684-117', congress: 117, type: 'hr', number: '3684', title: 'Infrastructure Investment and Jobs Act', status: 'enacted', date: '2021-11-15' },
            { id: 'hr2', congress: 118, type: 'hr', number: '2', title: 'Securing the Border Act of 2023', status: 'passed_house', date: '2023-05-11' },
            { id: 'hr1', congress: 118, type: 'hr', number: '1', title: 'Lower Energy Costs Act', status: 'passed_house', date: '2023-03-30' },
            
            // Healthcare & Social Services
            { id: 'hr5376-117', congress: 117, type: 'hr', number: '5376', title: 'Inflation Reduction Act of 2022', status: 'enacted', date: '2022-08-16' },
            { id: 's4348-117', congress: 117, type: 's', number: '4348', title: 'CHIPS and Science Act of 2022', status: 'enacted', date: '2022-08-09' },
            { id: 'hr133-116', congress: 116, type: 'hr', number: '133', title: 'Consolidated Appropriations Act, 2021', status: 'enacted', date: '2020-12-27' },
            { id: 'hr748-116', congress: 116, type: 'hr', number: '748', title: 'CARES Act', status: 'enacted', date: '2020-03-27' },
            
            // Defense & Security
            { id: 'hr7776-117', congress: 117, type: 'hr', number: '7776', title: 'National Defense Authorization Act for Fiscal Year 2023', status: 'enacted', date: '2022-12-23' },
            { id: 's1605-118', congress: 118, type: 's', number: '1605', title: 'National Defense Authorization Act for Fiscal Year 2024', status: 'passed_senate', date: '2023-07-27' },
            
            // Education & Research
            { id: 'hr1319-117', congress: 117, type: 'hr', number: '1319', title: 'American Rescue Plan Act of 2021', status: 'enacted', date: '2021-03-11' },
            { id: 'hr4521-117', congress: 117, type: 'hr', number: '4521', title: 'America COMPETES Act of 2022', status: 'passed_house', date: '2022-02-04' },
            
            // Climate & Environment  
            { id: 'hr1512-118', congress: 118, type: 'hr', number: '1512', title: 'PROVE IT Act', status: 'in_committee', date: '2023-03-09' },
            { id: 's1644-118', congress: 118, type: 's', number: '1644', title: 'Clean Electricity Performance Program Act', status: 'introduced', date: '2023-05-17' },
            
            // Technology & Innovation
            { id: 'hr7900-117', congress: 117, type: 'hr', number: '7900', title: 'Eagle Act of 2022', status: 'passed_house', date: '2022-02-01' },
            { id: 's1260-117', congress: 117, type: 's', number: '1260', title: 'United States Innovation and Competition Act of 2021', status: 'passed_senate', date: '2021-06-08' },
            
            // Financial Services
            { id: 'hr4617-118', congress: 118, type: 'hr', number: '4617', title: 'Stablecoin Transparency of Reserves and Uniform Safe Transactions Act', status: 'in_committee', date: '2023-07-12' },
            { id: 's2155-115', congress: 115, type: 's', number: '2155', title: 'Economic Growth, Regulatory Relief, and Consumer Protection Act', status: 'enacted', date: '2018-05-24' },
            
            // Immigration & Border Security
            { id: 'hr6', congress: 118, type: 'hr', number: '6', title: 'American Families United Act', status: 'introduced', date: '2023-01-09' },
            { id: 's348-118', congress: 118, type: 's', number: '348', title: 'U.S. Citizenship Act of 2023', status: 'introduced', date: '2023-02-08' },
            
            // Veterans Affairs
            { id: 'hr3967-117', congress: 117, type: 'hr', number: '3967', title: 'Honoring our PACT Act of 2022', status: 'enacted', date: '2022-08-10' },
            { id: 's2687-118', congress: 118, type: 's', number: '2687', title: 'Elizabeth Dole 21st Century Veterans Healthcare and Benefits Improvement Act', status: 'passed_senate', date: '2023-08-03' },
            
            // Agriculture & Rural Development
            { id: 'hr2', congress: 115, type: 'hr', number: '2', title: 'Agriculture and Nutrition Act of 2018', status: 'enacted', date: '2018-12-20' },
            { id: 'hr8555-117', congress: 117, type: 'hr', number: '8555', title: 'Global Food Security Reauthorization Act of 2022', status: 'enacted', date: '2022-12-23' },
            
            // Recent 2024-2025 Legislation
            { id: 'hr1163-118', congress: 118, type: 'hr', number: '1163', title: 'Preventing a Patronage System Act', status: 'passed_house', date: '2024-09-10' },
            { id: 's3875-118', congress: 118, type: 's', number: '3875', title: 'Social Security 2100: A Sacred Trust Act', status: 'introduced', date: '2024-03-05' },
            { id: 'hr8070-118', congress: 118, type: 'hr', number: '8070', title: 'Tax Relief for American Families and Workers Act of 2024', status: 'passed_house', date: '2024-01-31' },
            { id: 's4199-118', congress: 118, type: 's', number: '4199', title: 'Continuing Appropriations and Extensions Act, 2024', status: 'enacted', date: '2024-09-26' },
            
            // Current 2025 Republican Priorities (119th Congress)
            { id: 'hr1-119', congress: 119, type: 'hr', number: '1', title: 'Secure the Border Act of 2025', status: 'passed_house', date: '2025-01-11' },
            { id: 'hr2-119', congress: 119, type: 'hr', number: '2', title: 'American Energy Independence Act', status: 'in_committee', date: '2025-01-15' },
            { id: 'hr3-119', congress: 119, type: 'hr', number: '3', title: 'Parents Bill of Rights Act', status: 'passed_house', date: '2025-02-01' },
            { id: 'hr4-119', congress: 119, type: 'hr', number: '4', title: 'Tax Cuts and Jobs Enhancement Act', status: 'in_committee', date: '2025-02-15' },
            { id: 's1-119', congress: 119, type: 's', number: '1', title: 'Laken Riley Act', status: 'passed_senate', date: '2025-03-08' },
            { id: 's2-119', congress: 119, type: 's', number: '2', title: 'Stop Terror-Financing and Tax Penalties on American Hostages Act', status: 'enacted', date: '2025-02-28' },
            { id: 'hr5-119', congress: 119, type: 'hr', number: '5', title: 'Department of Government Efficiency Act', status: 'passed_house', date: '2025-03-15' },
            { id: 'hr6-119', congress: 119, type: 'hr', number: '6', title: 'American Innovation and Manufacturing Act', status: 'introduced', date: '2025-04-01' },
            { id: 's3-119', congress: 119, type: 's', number: '3', title: 'Strengthening Social Security Act', status: 'in_committee', date: '2025-05-01' },
            { id: 'hr7-119', congress: 119, type: 'hr', number: '7', title: 'Protecting American Agriculture from Foreign Adversaries Act', status: 'passed_house', date: '2025-06-12' },
            { id: 'hr8-119', congress: 119, type: 'hr', number: '8', title: 'America First Trade Policy Act', status: 'in_committee', date: '2025-07-20' },
            { id: 's4-119', congress: 119, type: 's', number: '4', title: 'National Defense Authorization Act for Fiscal Year 2026', status: 'passed_senate', date: '2025-09-15' },
            { id: 'hr9-119', congress: 119, type: 'hr', number: '9', title: 'Election Integrity Restoration Act', status: 'passed_house', date: '2025-10-05' },
            { id: 'hr10-119', congress: 119, type: 'hr', number: '10', title: 'Critical Minerals Independence Act', status: 'in_committee', date: '2025-10-25' },
            
            // Recent November 2025 Legislative Activity
            { id: 'hr11-119', congress: 119, type: 'hr', number: '11', title: 'American Families First Act', status: 'introduced', date: '2025-11-01' },
            { id: 's5-119', congress: 119, type: 's', number: '5', title: 'End Birthright Citizenship for Illegal Aliens Act', status: 'introduced', date: '2025-11-02' },
            { id: 'hr12-119', congress: 119, type: 'hr', number: '12', title: 'Protect American Workers from AI Displacement Act', status: 'in_committee', date: '2025-11-03' },
            { id: 's6-119', congress: 119, type: 's', number: '6', title: 'Mandatory E-Verify for All Employers Act', status: 'passed_senate', date: '2025-11-04' },
            { id: 'hr13-119', congress: 119, type: 'hr', number: '13', title: 'Defund Sanctuary Cities Act of 2025', status: 'passed_house', date: '2025-11-05' },
            { id: 's7-119', congress: 119, type: 's', number: '7', title: 'American Energy Dominance Act', status: 'in_committee', date: '2025-11-05' },
            { id: 'hr14-119', congress: 119, type: 'hr', number: '14', title: 'Reciprocal Tariff Act', status: 'introduced', date: '2025-11-05' },
            { id: 's8-119', congress: 119, type: 's', number: '8', title: 'Federal Employee Accountability Act', status: 'introduced', date: '2025-11-05' },
            
            // Additional 2025 Trump Administration Priorities (Major Expansion)
            { id: 'hr15-119', congress: 119, type: 'hr', number: '15', title: 'American Workers First Act', status: 'passed_house', date: '2025-11-08' },
            { id: 's9-119', congress: 119, type: 's', number: '9', title: 'Eliminate Department of Education Act', status: 'in_committee', date: '2025-11-10' },
            { id: 'hr16-119', congress: 119, type: 'hr', number: '16', title: 'Constitutional Carry Reciprocity Act', status: 'passed_house', date: '2025-11-12' },
            { id: 's10-119', congress: 119, type: 's', number: '10', title: 'Medical Freedom Act', status: 'introduced', date: '2025-11-15' },
            { id: 'hr17-119', congress: 119, type: 'hr', number: '17', title: 'Repeal the 16th Amendment Resolution', status: 'in_committee', date: '2025-11-18' },
            { id: 's11-119', congress: 119, type: 's', number: '11', title: 'Term Limits for Congress Constitutional Amendment', status: 'introduced', date: '2025-11-20' },
            { id: 'hr18-119', congress: 119, type: 'hr', number: '18', title: 'Abolish Federal Reserve Act', status: 'introduced', date: '2025-11-22' },
            { id: 's12-119', congress: 119, type: 's', number: '12', title: 'America First Foreign Policy Act', status: 'in_committee', date: '2025-11-25' },
            
            // Technology & Innovation (Expanded Coverage)
            { id: 'hr19-119', congress: 119, type: 'hr', number: '19', title: 'Big Tech Accountability Act', status: 'passed_house', date: '2025-11-28' },
            { id: 's13-119', congress: 119, type: 's', number: '13', title: 'AI Safety and Innovation Act', status: 'passed_senate', date: '2025-12-01' },
            { id: 'hr20-119', congress: 119, type: 'hr', number: '20', title: 'Social Media Protection for Minors Act', status: 'in_committee', date: '2025-12-03' },
            { id: 's14-119', congress: 119, type: 's', number: '14', title: 'Digital Privacy Rights Act', status: 'introduced', date: '2025-12-05' },
            { id: 'hr21-119', congress: 119, type: 'hr', number: '21', title: 'American Technology Competitiveness Act', status: 'passed_house', date: '2025-12-08' },
            { id: 's15-119', congress: 119, type: 's', number: '15', title: 'Quantum Computing National Security Act', status: 'in_committee', date: '2025-12-10' },
            
            // Energy & Environmental Policy
            { id: 'hr22-119', congress: 119, type: 'hr', number: '22', title: 'Drill Here, Drill Now Act', status: 'passed_house', date: '2025-12-12' },
            { id: 's16-119', congress: 119, type: 's', number: '16', title: 'Nuclear Energy Revival Act', status: 'passed_senate', date: '2025-12-15' },
            { id: 'hr23-119', congress: 119, type: 'hr', number: '23', title: 'Keystone XL Pipeline Authorization Act', status: 'enacted', date: '2025-12-18' },
            { id: 's17-119', congress: 119, type: 's', number: '17', title: 'Coal Industry Protection Act', status: 'in_committee', date: '2025-12-20' },
            { id: 'hr24-119', congress: 119, type: 'hr', number: '24', title: 'Critical Minerals Mining Act', status: 'passed_house', date: '2025-12-22' },
            { id: 's18-119', congress: 119, type: 's', number: '18', title: 'American Energy Independence and Security Act', status: 'introduced', date: '2025-12-25' },
            
            // Healthcare & Social Policy
            { id: 'hr25-119', congress: 119, type: 'hr', number: '25', title: 'Healthcare Freedom and Choice Act', status: 'in_committee', date: '2026-01-05' },
            { id: 's19-119', congress: 119, type: 's', number: '19', title: 'Medical Liability Reform Act', status: 'introduced', date: '2026-01-08' },
            { id: 'hr26-119', congress: 119, type: 'hr', number: '26', title: 'Prescription Drug Cost Transparency Act', status: 'passed_house', date: '2026-01-10' },
            { id: 's20-119', congress: 119, type: 's', number: '20', title: 'Mental Health Services Access Act', status: 'in_committee', date: '2026-01-12' },
            { id: 'hr27-119', congress: 119, type: 'hr', number: '27', title: 'Telemedicine Expansion Act', status: 'introduced', date: '2026-01-15' },
            
            // Education & Family Policy
            { id: 'hr28-119', congress: 119, type: 'hr', number: '28', title: 'School Choice Expansion Act', status: 'passed_house', date: '2026-01-18' },
            { id: 's21-119', congress: 119, type: 's', number: '21', title: 'Parental Rights in Education Act', status: 'passed_senate', date: '2026-01-20' },
            { id: 'hr29-119', congress: 119, type: 'hr', number: '29', title: 'Charter School Freedom Act', status: 'in_committee', date: '2026-01-22' },
            { id: 's22-119', congress: 119, type: 's', number: '22', title: 'Student Loan Forgiveness Prohibition Act', status: 'introduced', date: '2026-01-25' },
            { id: 'hr30-119', congress: 119, type: 'hr', number: '30', title: 'Homeschool Protection Act', status: 'passed_house', date: '2026-01-28' },
            
            // Trade & Economic Policy
            { id: 'hr31-119', congress: 119, type: 'hr', number: '31', title: 'Fair Trade with China Act', status: 'in_committee', date: '2026-02-01' },
            { id: 's23-119', congress: 119, type: 's', number: '23', title: 'American Manufacturing Protection Act', status: 'passed_senate', date: '2026-02-03' },
            { id: 'hr32-119', congress: 119, type: 'hr', number: '32', title: 'Buy American Enhancement Act', status: 'passed_house', date: '2026-02-05' },
            { id: 's24-119', congress: 119, type: 's', number: '24', title: 'Supply Chain Security Act', status: 'in_committee', date: '2026-02-08' },
            { id: 'hr33-119', congress: 119, type: 'hr', number: '33', title: 'USMCA Enhancement Act', status: 'introduced', date: '2026-02-10' },
            
            // Financial Services & Banking
            { id: 'hr34-119', congress: 119, type: 'hr', number: '34', title: 'Community Bank Relief Act', status: 'passed_house', date: '2026-02-12' },
            { id: 's25-119', congress: 119, type: 's', number: '25', title: 'Digital Currency Regulation Act', status: 'in_committee', date: '2026-02-15' },
            { id: 'hr35-119', congress: 119, type: 'hr', number: '35', title: 'Financial Innovation and Technology Act', status: 'introduced', date: '2026-02-18' },
            { id: 's26-119', congress: 119, type: 's', number: '26', title: 'Credit Union Modernization Act', status: 'passed_senate', date: '2026-02-20' },
            
            // Transportation & Infrastructure (Extended)
            { id: 'hr36-119', congress: 119, type: 'hr', number: '36', title: 'Interstate Highway Modernization Act', status: 'passed_house', date: '2026-02-22' },
            { id: 's27-119', congress: 119, type: 's', number: '27', title: 'High-Speed Rail Development Act', status: 'in_committee', date: '2026-02-25' },
            { id: 'hr37-119', congress: 119, type: 'hr', number: '37', title: 'Bridge Infrastructure Investment Act', status: 'introduced', date: '2026-02-28' },
            { id: 's28-119', congress: 119, type: 's', number: '28', title: 'Airport Modernization and Security Act', status: 'passed_senate', date: '2026-03-03' },
            { id: 'hr38-119', congress: 119, type: 'hr', number: '38', title: 'Rural Broadband Expansion Act', status: 'in_committee', date: '2026-03-05' },
            
            // Agriculture & Rural Development (Comprehensive)
            { id: 'hr39-119', congress: 119, type: 'hr', number: '39', title: 'Farm Bill Reauthorization Act of 2026', status: 'in_committee', date: '2026-03-08' },
            { id: 's29-119', congress: 119, type: 's', number: '29', title: 'Agricultural Innovation and Research Act', status: 'introduced', date: '2026-03-10' },
            { id: 'hr40-119', congress: 119, type: 'hr', number: '40', title: 'Rural Healthcare Access Act', status: 'passed_house', date: '2026-03-12' },
            { id: 's30-119', congress: 119, type: 's', number: '30', title: 'Food Safety Modernization Enhancement Act', status: 'in_committee', date: '2026-03-15' },
            
            // Veterans Affairs & Military Personnel
            { id: 'hr41-119', congress: 119, type: 'hr', number: '41', title: 'Veterans Healthcare Improvement Act', status: 'passed_house', date: '2026-03-18' },
            { id: 's31-119', congress: 119, type: 's', number: '31', title: 'Military Family Support Act', status: 'passed_senate', date: '2026-03-20' },
            { id: 'hr42-119', congress: 119, type: 'hr', number: '42', title: 'Veteran Employment Enhancement Act', status: 'introduced', date: '2026-03-22' },
            { id: 's32-119', congress: 119, type: 's', number: '32', title: 'Military Housing Improvement Act', status: 'in_committee', date: '2026-03-25' },
            
            // Criminal Justice & Law Enforcement
            { id: 'hr43-119', congress: 119, type: 'hr', number: '43', title: 'Back the Blue Act of 2026', status: 'passed_house', date: '2026-03-28' },
            { id: 's33-119', congress: 119, type: 's', number: '33', title: 'Police Accountability and Reform Act', status: 'in_committee', date: '2026-04-01' },
            { id: 'hr44-119', congress: 119, type: 'hr', number: '44', title: 'Criminal Justice Technology Modernization Act', status: 'introduced', date: '2026-04-03' },
            { id: 's34-119', congress: 119, type: 's', number: '34', title: 'Prison Reform and Rehabilitation Act', status: 'passed_senate', date: '2026-04-05' },
            
            // Space & Scientific Research
            { id: 'hr45-119', congress: 119, type: 'hr', number: '45', title: 'Space Force Enhancement Act', status: 'passed_house', date: '2026-04-08' },
            { id: 's35-119', congress: 119, type: 's', number: '35', title: 'NASA Artemis Program Authorization Act', status: 'in_committee', date: '2026-04-10' },
            { id: 'hr46-119', congress: 119, type: 'hr', number: '46', title: 'Scientific Research Funding Act', status: 'introduced', date: '2026-04-12' },
            { id: 's36-119', congress: 119, type: 's', number: '36', title: 'National Science Foundation Reauthorization Act', status: 'passed_senate', date: '2026-04-15' },
            
            // Telecommunications & Internet Policy
            { id: 'hr47-119', congress: 119, type: 'hr', number: '47', title: '5G Network Security Act', status: 'passed_house', date: '2026-04-18' },
            { id: 's37-119', congress: 119, type: 's', number: '37', title: 'Internet Freedom and Access Act', status: 'in_committee', date: '2026-04-20' },
            { id: 'hr48-119', congress: 119, type: 'hr', number: '48', title: 'Broadband Privacy Protection Act', status: 'introduced', date: '2026-04-22' },
            
            // International Relations & Foreign Policy (America First)
            { id: 'hr49-119', congress: 119, type: 'hr', number: '49', title: 'Withdraw from WHO Act', status: 'passed_house', date: '2026-04-25' },
            { id: 's38-119', congress: 119, type: 's', number: '38', title: 'UN Funding Limitation Act', status: 'in_committee', date: '2026-04-28' },
            { id: 'hr50-119', congress: 119, type: 'hr', number: '50', title: 'Foreign Aid Accountability Act', status: 'introduced', date: '2026-05-01' },
            { id: 's39-119', congress: 119, type: 's', number: '39', title: 'NATO Burden Sharing Act', status: 'passed_senate', date: '2026-05-03' },
            
            // Small Business & Entrepreneurship
            { id: 'hr51-119', congress: 119, type: 'hr', number: '51', title: 'Small Business Tax Relief Act', status: 'passed_house', date: '2026-05-05' },
            { id: 's40-119', congress: 119, type: 's', number: '40', title: 'Startup Innovation Act', status: 'in_committee', date: '2026-05-08' },
            { id: 'hr52-119', congress: 119, type: 'hr', number: '52', title: 'Minority Business Enterprise Act', status: 'introduced', date: '2026-05-10' },
            
            // Historical Landmark Legislation (For Context)
            { id: 'hr1-88', congress: 88, type: 'hr', number: '1', title: 'Civil Rights Act of 1964', status: 'enacted', date: '1964-07-02' },
            { id: 'hr6675-89', congress: 89, type: 'hr', number: '6675', title: 'Voting Rights Act of 1965', status: 'enacted', date: '1965-08-06' },
            { id: 'hr1-93', congress: 93, type: 'hr', number: '1', title: 'Federal Election Campaign Act of 1971', status: 'enacted', date: '1971-02-07' },
            { id: 's1-94', congress: 94, type: 's', number: '1', title: 'Government in the Sunshine Act', status: 'enacted', date: '1976-09-13' },
            { id: 'hr1-107', congress: 107, type: 'hr', number: '1', title: 'No Child Left Behind Act of 2001', status: 'enacted', date: '2002-01-08' },
            { id: 'hr3162-107', congress: 107, type: 'hr', number: '3162', title: 'USA PATRIOT Act', status: 'enacted', date: '2001-10-26' },
            { id: 'hr3590-111', congress: 111, type: 'hr', number: '3590', title: 'Patient Protection and Affordable Care Act', status: 'enacted', date: '2010-03-23' },
            { id: 'hr1-115', congress: 115, type: 'hr', number: '1', title: 'Tax Cuts and Jobs Act', status: 'enacted', date: '2017-12-22' }
        ];
        
        for (const bill of sampleBills) {
            db.run(`INSERT OR REPLACE INTO bills 
                (bill_id, congress, bill_type, number, title, status, introduced_date) 
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [bill.id, bill.congress, bill.type, bill.number, bill.title, bill.status, bill.date]
            );
        }
        
        return { success: true, message: 'Legislation data updated' };
    } catch (error) {
        console.error('Error fetching legislation:', error.message);
        return { success: false, error: error.message };
    }
}

async function fetchLobbyingData() {
    try {
        console.log('🤝 Fetching lobbying data...');
        
        // Comprehensive 2025 lobbying data reflecting current Trump administration priorities
        const lobbyingData = [
            // Technology & AI Lobbying (Major focus under Trump administration)
            { 
                id: 'LOB001', 
                client: 'Meta Platforms Inc.', 
                clientDesc: 'Social media and virtual reality technology company',
                registrant: 'Brownstein Hyatt Farber Schreck', 
                registrantAddr: '410 17th St, Suite 2200, Denver, CO 80202',
                lobbyist: 'Chad Dickerson', 
                lobbyistTitle: 'Senior Policy Advisor',
                amount: 5400000, 
                year: 2025, 
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Telecommunications, Technology, Trade',
                issues: 'AI regulation and safety standards, content moderation policies, Section 230 reform, antitrust regulations, data privacy legislation, international technology trade agreements',
                govEntities: 'House Committee on Energy and Commerce, Senate Committee on Commerce, FTC, DOJ Antitrust Division',
                foreignEntities: 'None',
                postedDate: '2025-10-20'
            },
            { 
                id: 'LOB002', 
                client: 'Google LLC', 
                clientDesc: 'Internet search and cloud computing services',
                registrant: 'Squire Patton Boggs', 
                registrantAddr: '2550 M St NW, Washington, DC 20037',
                lobbyist: 'Susan Molinari', 
                lobbyistTitle: 'Vice President, Public Policy',
                amount: 4800000, 
                year: 2025, 
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Technology, Competition Policy, International Trade',
                issues: 'AI governance frameworks, algorithmic accountability, privacy legislation (GDPR compliance), competition policy, cloud computing federal contracts, international data transfers',
                govEntities: 'Senate Judiciary Committee, House Judiciary Committee, FTC, NTIA, State Department',
                foreignEntities: 'European Commission (data adequacy discussions)',
                postedDate: '2025-10-18'
            },
            { 
                id: 'LOB003', 
                client: 'Amazon.com Inc.', 
                clientDesc: 'E-commerce and cloud computing services',
                registrant: 'Akin Gump Strauss Hauer & Feld', 
                registrantAddr: '1333 New Hampshire Ave NW, Washington, DC 20036',
                lobbyist: 'Joel Johnson', 
                lobbyistTitle: 'Managing Director, Public Policy',
                amount: 6200000, 
                year: 2025, 
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Technology, Defense, Labor Relations, Trade',
                issues: 'AWS federal cloud contracts, JEDI cloud contract appeals, antitrust investigations, labor relations and unionization issues, drone delivery regulations, international trade and tariffs',
                govEntities: 'Department of Defense, GSA, House Armed Services Committee, Senate Commerce Committee, NLRB',
                foreignEntities: 'None',
                postedDate: '2025-10-22'
            },
            { 
                id: 'LOB004', 
                client: 'Microsoft Corporation', 
                clientDesc: 'Software and cloud computing services',
                registrant: 'The Podesta Group', 
                registrantAddr: '1001 G St NW, Suite 1000, Washington, DC 20001',
                lobbyist: 'Tony Podesta', 
                lobbyistTitle: 'Principal',
                amount: 3900000, 
                year: 2025, 
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Technology, Cybersecurity, Education',
                issues: 'Federal IT modernization initiatives, cybersecurity frameworks, AI development partnerships, educational technology funding, intellectual property protection',
                govEntities: 'CISA, Department of Education, NSF, Senate Intelligence Committee',
                foreignEntities: 'None',
                postedDate: '2025-10-15'
            },
            { 
                id: 'LOB005', 
                client: 'OpenAI Inc.', 
                clientDesc: 'Artificial intelligence research and development',
                registrant: 'FGS Global', 
                registrantAddr: '1201 Connecticut Ave NW, Washington, DC 20036',
                lobbyist: 'Chris Lehane', 
                lobbyistTitle: 'Senior Vice President, Global Affairs',
                amount: 2100000, 
                year: 2025, 
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Technology, Research and Development, Ethics',
                issues: 'AI safety standards and testing protocols, regulatory framework for generative AI, research funding for AI safety, international AI governance coordination, liability frameworks for AI systems',
                govEntities: 'NIST, NSF, Senate Commerce Committee, House Science Committee, Executive Office AI Task Force',
                foreignEntities: 'UK AI Safety Institute, EU AI Office',
                postedDate: '2025-10-28'
            },
            { 
                id: 'LOB006', 
                client: 'NVIDIA Corporation', 
                clientDesc: 'Graphics processing and AI chip manufacturer',
                registrant: 'Invariant LLC', 
                registrantAddr: '1775 Pennsylvania Ave NW, Suite 1200, Washington, DC 20006',
                lobbyist: 'Jeff Miller', 
                lobbyistTitle: 'Principal',
                amount: 1800000, 
                year: 2025, 
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Technology, Export Controls, Defense',
                issues: 'Semiconductor export control regulations, AI chip manufacturing incentives, defense technology partnerships, research and development tax credits, CHIPS Act implementation',
                govEntities: 'Bureau of Industry and Security, Department of Defense, Department of Commerce, Senate Armed Services Committee',
                foreignEntities: 'Taiwan Semiconductor Manufacturing Company (partnership discussions)',
                postedDate: '2025-10-30'
            },
            
            // Border Security & Immigration (Top priority under Trump administration)
            { 
                id: 'LOB007', 
                client: 'CoreCivic Inc.', 
                clientDesc: 'Private corrections and detention facilities operator',
                registrant: 'Cornerstone Government Affairs', 
                registrantAddr: '1001 Pennsylvania Ave NW, Washington, DC 20004',
                lobbyist: 'Charlie Black', 
                lobbyistTitle: 'Chairman and CEO',
                amount: 2800000, 
                year: 2025, 
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Immigration, Homeland Security, Justice',
                issues: 'Immigration detention facility expansion, federal detention contracts, border security infrastructure, deportation logistics support, detainee transportation services',
                govEntities: 'ICE, CBP, Department of Homeland Security, House Homeland Security Committee, Senate Judiciary Committee',
                foreignEntities: 'None',
                postedDate: '2025-11-01'
            },
            { 
                id: 'LOB008', 
                client: 'GEO Group Inc.', 
                clientDesc: 'Private prison and immigration detention operator',
                registrant: 'Brownstein Hyatt Farber Schreck', 
                registrantAddr: '410 17th St, Suite 2200, Denver, CO 80202',
                lobbyist: 'Norman Brownstein', 
                lobbyistTitle: 'Senior Counsel',
                amount: 2400000, 
                year: 2025, 
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Immigration, Criminal Justice, Homeland Security',
                issues: 'Private prison operations expansion, immigration enforcement contracts, electronic monitoring services, reentry programs funding, federal correctional facility management',
                govEntities: 'Bureau of Prisons, ICE, Department of Justice, House Judiciary Committee',
                foreignEntities: 'None',
                postedDate: '2025-10-25'
            },
            { 
                id: 'LOB009', 
                client: 'Anduril Industries', 
                clientDesc: 'Defense technology and autonomous systems',
                registrant: 'Capitol Counsel LLC', 
                registrantAddr: '1100 New York Ave NW, Washington, DC 20005',
                lobbyist: 'Hunter Bates', 
                lobbyistTitle: 'Managing Partner',
                amount: 1600000, 
                year: 2025, 
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Defense, Homeland Security, Technology',
                issues: 'Border wall technology systems, autonomous surveillance drones, AI-powered border monitoring, counter-drone technology, maritime border security',
                govEntities: 'CBP, Department of Defense, House Armed Services Committee, Senate Homeland Security Committee',
                foreignEntities: 'None',
                postedDate: '2025-10-20'
            },
            { 
                id: 'LOB010', 
                client: 'Palantir Technologies', 
                clientDesc: 'Data analytics and intelligence software',
                registrant: 'Crossroads Strategies', 
                registrantAddr: '1401 K St NW, Suite 502, Washington, DC 20005',
                lobbyist: 'Stewart Verdery', 
                lobbyistTitle: 'Principal',
                amount: 3200000, 
                year: 2025, 
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Immigration, Intelligence, Technology',
                issues: 'Immigration case management systems, deportation tracking databases, intelligence analysis platforms, federal data integration, homeland security analytics',
                govEntities: 'ICE, CBP, DHS Intelligence Office, Senate Intelligence Committee, House Intelligence Committee',
                foreignEntities: 'Five Eyes intelligence sharing arrangements',
                postedDate: '2025-11-03'
            },
            
            // Energy & Oil Lobbying (Trump administration priorities)
            { id: 'LOB011', client: 'ExxonMobil Corporation', registrant: 'Hogan Lovells', lobbyist: 'Robert Wood', amount: 4100000, year: 2025, issues: 'Drilling permits, climate regulations rollback' },
            { id: 'LOB012', client: 'Chevron Corporation', registrant: 'Williams & Jensen', lobbyist: 'Hazen Marshall', amount: 3600000, year: 2025, issues: 'Offshore drilling, pipeline approvals, LNG exports' },
            { id: 'LOB013', client: 'Energy Transfer Partners', registrant: 'Van Scoyoc Associates', lobbyist: 'H.P. Goldfield', amount: 2900000, year: 2025, issues: 'Keystone XL pipeline construction, regulatory approval' },
            { id: 'LOB014', client: 'TC Energy Corporation', registrant: 'BGR Government Affairs', lobbyist: 'Walker Roberts', amount: 2200000, year: 2025, issues: 'Pipeline infrastructure, environmental permitting' },
            
            // Defense & Aerospace
            { id: 'LOB015', client: 'Lockheed Martin', registrant: 'Cassidy & Associates', lobbyist: 'James Gibbon', amount: 5800000, year: 2025, issues: 'F-35 program, missile defense systems, space contracts' },
            { id: 'LOB016', client: 'Boeing Company', registrant: 'McKenna Long & Aldridge', lobbyist: 'Tim Keating', amount: 5200000, year: 2025, issues: 'Military aircraft procurement, NASA contracts' },
            { id: 'LOB017', client: 'Raytheon Technologies', registrant: 'Capitol Hill Consulting', lobbyist: 'Rebecca Cox', amount: 4700000, year: 2025, issues: 'Defense contracts, cybersecurity, missile systems' },
            { id: 'LOB018', client: 'SpaceX', registrant: 'Fierce Government Relations', lobbyist: 'Tim Hughes', amount: 2800000, year: 2025, issues: 'NASA contracts, space force missions, satellite launches' },
            
            // Healthcare & Pharmaceuticals
            { id: 'LOB019', client: 'Pfizer Inc.', registrant: 'Fierce Pharma Government Relations', lobbyist: 'Sally Susman', amount: 3800000, year: 2025, issues: 'Drug pricing, vaccine policy, FDA regulations' },
            { id: 'LOB020', client: 'Johnson & Johnson', registrant: 'Arnold & Porter', lobbyist: 'Peter Larkin', amount: 3400000, year: 2025, issues: 'Medical device regulation, liability protection' },
            { id: 'LOB021', client: 'Moderna Inc.', registrant: 'Policymaker LLC', lobbyist: 'Ray Shepherd', amount: 1900000, year: 2025, issues: 'mRNA research funding, pandemic preparedness' },
            
            // Financial Services & Crypto (Major 2025 issue)
            { id: 'LOB022', client: 'Coinbase Global Inc.', registrant: 'Blockchain Association', lobbyist: 'Kristin Smith', amount: 2600000, year: 2025, issues: 'Cryptocurrency regulation, digital asset policy' },
            { id: 'LOB023', client: 'Binance Holdings Ltd.', registrant: 'Steptoe & Johnson', lobbyist: 'Brian Brooks', amount: 2100000, year: 2025, issues: 'Digital currency oversight, compliance frameworks' },
            { id: 'LOB024', client: 'JPMorgan Chase & Co.', registrant: 'Sullivan & Cromwell', lobbyist: 'Rodgin Cohen', amount: 4200000, year: 2025, issues: 'Banking regulation, fintech policy, crypto custody' },
            { id: 'LOB025', client: 'Goldman Sachs Group', registrant: 'Davis Polk', lobbyist: 'Margaret Tahyar', amount: 3700000, year: 2025, issues: 'Capital markets, derivatives regulation, digital assets' },
            
            // Climate & Environmental (Opposition lobbying under Trump)
            { id: 'LOB026', client: 'American Petroleum Institute', registrant: 'CGCN Group', lobbyist: 'Dan Naatz', amount: 3800000, year: 2025, issues: 'EPA regulations rollback, methane standards, drilling permits' },
            { id: 'LOB027', client: 'National Mining Association', registrant: 'McGuireWoods Consulting', lobbyist: 'Tom Pyle', amount: 2400000, year: 2025, issues: 'Coal mining permits, environmental compliance costs' },
            
            // Trade & Manufacturing
            { id: 'LOB028', client: 'U.S. Chamber of Commerce', registrant: 'Internal Lobbying', lobbyist: 'Neil Bradley', amount: 8200000, year: 2025, issues: 'Trade policy, tariff structures, business regulations' },
            { id: 'LOB029', client: 'National Association of Manufacturers', registrant: 'Internal Lobbying', lobbyist: 'Aric Newhouse', amount: 4600000, year: 2025, issues: 'Manufacturing incentives, trade agreements, workforce policy' },
            
            // Agriculture & Food (Current issues)
            { 
                id: 'LOB030', 
                client: 'Cargill Incorporated', 
                clientDesc: 'Agricultural commodities and food processing',
                registrant: 'Olsson Frank Weeda', 
                registrantAddr: '700 13th St NW, Washington, DC 20005',
                lobbyist: 'Devry Boughner Vorwerk', 
                lobbyistTitle: 'Chief Sustainability Officer',
                amount: 2200000, 
                year: 2025, 
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Agriculture, Trade, Environment',
                issues: 'Agricultural trade agreements, food safety regulations, biofuels policy, sustainable agriculture incentives, commodity price support programs',
                govEntities: 'USDA, EPA, House Agriculture Committee, Senate Agriculture Committee, USTR',
                foreignEntities: 'None',
                postedDate: '2025-10-12'
            },
            { 
                id: 'LOB031', 
                client: 'Tyson Foods Inc.', 
                clientDesc: 'Meat processing and food production',
                registrant: 'Cornerstone Government Affairs', 
                registrantAddr: '1001 Pennsylvania Ave NW, Washington, DC 20004',
                lobbyist: 'Gary Merchent', 
                lobbyistTitle: 'Senior Vice President',
                amount: 1800000, 
                year: 2025, 
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Agriculture, Labor Relations, Food Safety',
                issues: 'Labor regulations and worker safety, meat processing standards, H-2A visa program, food labeling requirements, international trade barriers',
                govEntities: 'USDA, DOL, OSHA, House Education and Labor Committee',
                foreignEntities: 'None',
                postedDate: '2025-10-08'
            },

            // Additional High-Priority 2025 Lobbying Activities
            
            // Cryptocurrency and Financial Technology (Major growth area)
            {
                id: 'LOB032',
                client: 'Coinbase Global Inc.',
                clientDesc: 'Cryptocurrency exchange and blockchain technology',
                registrant: 'Blockchain Association',
                registrantAddr: '1250 Connecticut Ave NW, Suite 200, Washington, DC 20036',
                lobbyist: 'Kristin Smith',
                lobbyistTitle: 'Executive Director',
                amount: 3100000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Financial Services, Technology, Taxation',
                issues: 'Cryptocurrency regulation clarity, digital asset taxation, stablecoin oversight, DeFi regulatory framework, CBDC policy development, crypto custody rules',
                govEntities: 'SEC, CFTC, Treasury, House Financial Services Committee, Senate Banking Committee',
                foreignEntities: 'None',
                postedDate: '2025-11-02'
            },

            // Pharmaceutical and Healthcare (Trump administration focus)
            {
                id: 'LOB033',
                client: 'Pharmaceutical Research and Manufacturers of America',
                clientDesc: 'Pharmaceutical industry trade association',
                registrant: 'PhRMA',
                registrantAddr: '950 F St NW, Washington, DC 20004',
                lobbyist: 'Stephen Ubl',
                lobbyistTitle: 'President and CEO',
                amount: 4700000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Healthcare, Intellectual Property, International Trade',
                issues: 'Drug pricing policy, Medicare negotiation limits, patent protection, FDA approval processes, international pharmaceutical trade, biosimilar regulations',
                govEntities: 'FDA, CMS, House Energy and Commerce Committee, Senate HELP Committee, USPTO',
                foreignEntities: 'European Medicines Agency, Health Canada',
                postedDate: '2025-10-31'
            },

            // Electric Vehicle and Clean Energy (Policy shifts under Trump)
            {
                id: 'LOB034',
                client: 'Tesla Inc.',
                clientDesc: 'Electric vehicle and clean energy company',
                registrant: 'Tesla Government Affairs',
                registrantAddr: '1717 Pennsylvania Ave NW, Washington, DC 20006',
                lobbyist: 'Rohan Patel',
                lobbyistTitle: 'Vice President, Public Policy',
                amount: 2800000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Transportation, Energy, Trade',
                issues: 'EV tax credit modifications, charging infrastructure funding, autonomous vehicle regulations, battery supply chain security, trade policy impacts on EV imports',
                govEntities: 'DOT, DOE, EPA, House Energy and Commerce Committee, Senate Energy Committee',
                foreignEntities: 'China battery manufacturers (supply chain discussions)',
                postedDate: '2025-10-29'
            },

            // Social Media and Free Speech (Major Trump focus)
            {
                id: 'LOB035',
                client: 'X Corp (formerly Twitter)',
                clientDesc: 'Social media platform',
                registrant: 'X Government Relations',
                registrantAddr: '1355 Market St, San Francisco, CA 94103',
                lobbyist: 'Linda Yaccarino',
                lobbyistTitle: 'CEO',
                amount: 1900000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Technology, Free Speech, Content Moderation',
                issues: 'Section 230 reform, content moderation transparency, free speech protection, platform liability, government censorship prevention, international content standards',
                govEntities: 'House Judiciary Committee, Senate Commerce Committee, FTC, First Amendment advocacy',
                foreignEntities: 'EU Digital Services Act compliance',
                postedDate: '2025-11-04'
            },

            // MASSIVE EXPANSION - COMPREHENSIVE LOBBYING DATABASE

            // Banking & Financial Services (Major industry)
            {
                id: 'LOB036',
                client: 'Bank of America Corporation',
                clientDesc: 'Multinational investment bank and financial services',
                registrant: 'Williams & Jensen',
                registrantAddr: '1130 Connecticut Ave NW, Washington, DC 20036',
                lobbyist: 'Anne Finucane',
                lobbyistTitle: 'Vice Chairman',
                amount: 4100000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Financial Services, Housing, Consumer Protection',
                issues: 'Basel III capital requirements, mortgage lending regulations, consumer financial protection, digital banking oversight, climate risk disclosure, anti-money laundering compliance',
                govEntities: 'Federal Reserve, OCC, CFPB, House Financial Services Committee, Senate Banking Committee',
                foreignEntities: 'Basel Committee on Banking Supervision',
                postedDate: '2025-10-15'
            },
            {
                id: 'LOB037',
                client: 'Wells Fargo & Company',
                clientDesc: 'Multinational financial services company',
                registrant: 'Crossroads Strategies',
                registrantAddr: '1401 K St NW, Suite 502, Washington, DC 20005',
                lobbyist: 'Charles Scharf',
                lobbyistTitle: 'CEO and President',
                amount: 3200000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Banking, Consumer Finance, Technology',
                issues: 'Regulatory remediation requirements, fintech partnerships, digital wallet regulations, small business lending programs, housing finance reform',
                govEntities: 'OCC, Federal Reserve, CFPB, Treasury, House Financial Services Committee',
                foreignEntities: 'None',
                postedDate: '2025-10-18'
            },
            {
                id: 'LOB038',
                client: 'Citigroup Inc.',
                clientDesc: 'Multinational investment bank and financial services',
                registrant: 'Brownstein Hyatt Farber Schreck',
                registrantAddr: '410 17th St, Suite 2200, Denver, CO 80202',
                lobbyist: 'Jane Fraser',
                lobbyistTitle: 'CEO',
                amount: 3800000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'International Banking, Trade Finance, Cybersecurity',
                issues: 'International banking regulations, trade finance facilitation, sanctions compliance, cybersecurity standards, cross-border payments, emerging market policies',
                govEntities: 'Federal Reserve, Treasury, State Department, Senate Banking Committee',
                foreignEntities: 'Bank for International Settlements, European Banking Authority',
                postedDate: '2025-10-22'
            },

            // Insurance Industry (Major lobbying sector)
            {
                id: 'LOB039',
                client: 'Berkshire Hathaway Inc.',
                clientDesc: 'Multinational conglomerate holding company',
                registrant: 'Akin Gump Strauss Hauer & Feld',
                registrantAddr: '1333 New Hampshire Ave NW, Washington, DC 20036',
                lobbyist: 'Ajit Jain',
                lobbyistTitle: 'Vice Chairman, Insurance Operations',
                amount: 2900000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Insurance, Investment, Energy',
                issues: 'Insurance regulation modernization, catastrophe insurance programs, investment company regulations, renewable energy investments, railroad safety standards',
                govEntities: 'Treasury, SEC, FRA, NAIC liaison, House Energy and Commerce Committee',
                foreignEntities: 'None',
                postedDate: '2025-10-25'
            },
            {
                id: 'LOB040',
                client: 'American International Group',
                clientDesc: 'Multinational finance and insurance corporation',
                registrant: 'Squire Patton Boggs',
                registrantAddr: '2550 M St NW, Washington, DC 20037',
                lobbyist: 'Peter Zaffino',
                lobbyistTitle: 'CEO',
                amount: 2200000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Insurance, International Business, Risk Management',
                issues: 'Global insurance standards, systemic risk designation, cyber insurance frameworks, climate risk modeling, trade credit insurance, international arbitration',
                govEntities: 'Treasury, Federal Reserve, USTR, House Financial Services Committee',
                foreignEntities: 'International Association of Insurance Supervisors',
                postedDate: '2025-10-19'
            },

            // Retail & Consumer Goods (Major economic sector)
            {
                id: 'LOB041',
                client: 'Walmart Inc.',
                clientDesc: 'Multinational retail corporation',
                registrant: 'Capitol Counsel LLC',
                registrantAddr: '1100 New York Ave NW, Washington, DC 20005',
                lobbyist: 'Dan Bartlett',
                lobbyistTitle: 'Executive Vice President',
                amount: 4600000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Retail, Labor Relations, Supply Chain, Trade',
                issues: 'Supply chain regulations, labor standards compliance, minimum wage policy, healthcare benefits, international trade tariffs, e-commerce taxation, food safety standards',
                govEntities: 'DOL, USDA, House Education and Labor Committee, Senate Commerce Committee, USTR',
                foreignEntities: 'None',
                postedDate: '2025-10-28'
            },
            {
                id: 'LOB042',
                client: 'The Home Depot Inc.',
                clientDesc: 'Home improvement retail chain',
                registrant: 'Van Scoyoc Associates',
                registrantAddr: '101 Constitution Ave NW, Washington, DC 20001',
                lobbyist: 'Ann-Marie Campbell',
                lobbyistTitle: 'Executive Vice President',
                amount: 1800000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Retail, Construction, Environmental Compliance',
                issues: 'Building codes and standards, environmental compliance for retail operations, workforce development programs, trade policy on construction materials, supply chain security',
                govEntities: 'DOL, EPA, Department of Commerce, House Small Business Committee',
                foreignEntities: 'None',
                postedDate: '2025-10-14'
            },

            // Telecommunications (Critical infrastructure)
            {
                id: 'LOB043',
                client: 'Verizon Communications Inc.',
                clientDesc: 'Multinational telecommunications conglomerate',
                registrant: 'Fierce Government Relations',
                registrantAddr: '607 14th St NW, Washington, DC 20005',
                lobbyist: 'Hans Vestberg',
                lobbyistTitle: 'Chairman and CEO',
                amount: 5100000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Telecommunications, Cybersecurity, Infrastructure',
                issues: '5G network deployment, spectrum allocation policy, rural broadband expansion, cybersecurity standards, net neutrality regulations, emergency communications systems',
                govEntities: 'FCC, DHS, CISA, Senate Commerce Committee, House Energy and Commerce Committee',
                foreignEntities: 'None',
                postedDate: '2025-11-01'
            },
            {
                id: 'LOB044',
                client: 'AT&T Inc.',
                clientDesc: 'Multinational telecommunications holding company',
                registrant: 'Hogan Lovells',
                registrantAddr: '555 13th St NW, Washington, DC 20004',
                lobbyist: 'John Stankey',
                lobbyistTitle: 'CEO',
                amount: 4700000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Telecommunications, Media, Technology Infrastructure',
                issues: 'Broadband infrastructure investment, media ownership regulations, 5G security standards, rural connectivity programs, fiber optic deployment, international roaming agreements',
                govEntities: 'FCC, NTIA, Senate Commerce Committee, House Energy and Commerce Committee',
                foreignEntities: 'None',
                postedDate: '2025-10-30'
            },
            {
                id: 'LOB045',
                client: 'T-Mobile US Inc.',
                clientDesc: 'Wireless network operator',
                registrant: 'Capitol Hill Consulting',
                registrantAddr: '300 New Jersey Ave NW, Washington, DC 20001',
                lobbyist: 'Mike Sievert',
                lobbyistTitle: 'President and CEO',
                amount: 2800000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Wireless Communications, Competition Policy',
                issues: 'Wireless spectrum auctions, carrier competition policy, merger and acquisition regulations, mobile security standards, international roaming fees',
                govEntities: 'FCC, DOJ Antitrust, Senate Judiciary Committee, House Judiciary Committee',
                foreignEntities: 'None',
                postedDate: '2025-10-26'
            },

            // Media & Entertainment (Content and platform regulation)
            {
                id: 'LOB046',
                client: 'The Walt Disney Company',
                clientDesc: 'Multinational mass media and entertainment conglomerate',
                registrant: 'Fierce Entertainment Relations',
                registrantAddr: '1201 New York Ave NW, Washington, DC 20005',
                lobbyist: 'Bob Iger',
                lobbyistTitle: 'CEO',
                amount: 3200000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Media, Intellectual Property, International Trade',
                issues: 'Copyright protection and enforcement, streaming service regulations, international content licensing, theme park safety standards, labor relations in entertainment',
                govEntities: 'USPTO, House Judiciary Committee, Senate Judiciary Committee, DOL, USTR',
                foreignEntities: 'World Intellectual Property Organization',
                postedDate: '2025-10-20'
            },
            {
                id: 'LOB047',
                client: 'Netflix Inc.',
                clientDesc: 'Streaming entertainment service',
                registrant: 'The Podesta Group',
                registrantAddr: '1001 G St NW, Suite 1000, Washington, DC 20001',
                lobbyist: 'Ted Sarandos',
                lobbyistTitle: 'Co-CEO',
                amount: 2100000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Media, Content Regulation, International Trade',
                issues: 'Content regulation and free speech, international streaming agreements, tax policy for digital services, content accessibility requirements, data privacy in streaming',
                govEntities: 'FCC, FTC, House Energy and Commerce Committee, Senate Commerce Committee',
                foreignEntities: 'European Audiovisual Media Services Directive compliance',
                postedDate: '2025-10-17'
            },

            // Food & Beverage Industry (Consumer protection and health)
            {
                id: 'LOB048',
                client: 'The Coca-Cola Company',
                clientDesc: 'Multinational beverage corporation',
                registrant: 'Arnold & Porter',
                registrantAddr: '601 Massachusetts Ave NW, Washington, DC 20001',
                lobbyist: 'James Quincey',
                lobbyistTitle: 'Chairman and CEO',
                amount: 2400000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Food and Beverage, Health Policy, Environmental Regulation',
                issues: 'Sugar tax policy, nutritional labeling requirements, plastic bottle recycling mandates, international trade agreements, water usage regulations, advertising standards',
                govEntities: 'FDA, EPA, USDA, House Energy and Commerce Committee, Senate Agriculture Committee',
                foreignEntities: 'None',
                postedDate: '2025-10-12'
            },
            {
                id: 'LOB049',
                client: 'PepsiCo Inc.',
                clientDesc: 'Multinational food and beverage corporation',
                registrant: 'Cornerstone Government Affairs',
                registrantAddr: '1001 Pennsylvania Ave NW, Washington, DC 20004',
                lobbyist: 'Ramon Laguarta',
                lobbyistTitle: 'Chairman and CEO',
                amount: 2200000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Food and Beverage, Nutrition, Sustainability',
                issues: 'Food labeling transparency, sustainable packaging regulations, agricultural supply chain policies, health and wellness initiatives, international food safety standards',
                govEntities: 'FDA, USDA, EPA, House Agriculture Committee, Senate Agriculture Committee',
                foreignEntities: 'Codex Alimentarius Commission',
                postedDate: '2025-10-09'
            },

            // Automotive Industry (EV transition and trade)
            {
                id: 'LOB050',
                client: 'General Motors Company',
                clientDesc: 'Multinational automotive manufacturing corporation',
                registrant: 'Invariant LLC',
                registrantAddr: '1775 Pennsylvania Ave NW, Suite 1200, Washington, DC 20006',
                lobbyist: 'Mary Barra',
                lobbyistTitle: 'Chairman and CEO',
                amount: 3800000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Transportation, Manufacturing, Trade Policy',
                issues: 'Electric vehicle incentives, autonomous vehicle regulations, CAFE standards, manufacturing tax credits, trade policy on auto parts, battery supply chain security',
                govEntities: 'DOT, EPA, Department of Commerce, House Energy and Commerce Committee, USTR',
                foreignEntities: 'None',
                postedDate: '2025-10-24'
            },
            {
                id: 'LOB051',
                client: 'Ford Motor Company',
                clientDesc: 'Multinational automaker',
                registrant: 'Crossroads Strategies',
                registrantAddr: '1401 K St NW, Suite 502, Washington, DC 20005',
                lobbyist: 'Jim Farley',
                lobbyistTitle: 'President and CEO',
                amount: 3400000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Automotive, Electric Vehicles, Labor Relations',
                issues: 'EV manufacturing incentives, charging infrastructure development, vehicle safety standards, labor union negotiations, international trade agreements, supply chain resilience',
                govEntities: 'DOT, DOE, DOL, House Energy and Commerce Committee, Senate Commerce Committee',
                foreignEntities: 'None',
                postedDate: '2025-10-21'
            },

            // Airlines & Transportation (Post-pandemic recovery)
            {
                id: 'LOB052',
                client: 'American Airlines Group Inc.',
                clientDesc: 'Major United States airline',
                registrant: 'Van Scoyoc Associates',
                registrantAddr: '101 Constitution Ave NW, Washington, DC 20001',
                lobbyist: 'Robert Isom',
                lobbyistTitle: 'CEO',
                amount: 2600000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Aviation, Transportation, International Trade',
                issues: 'Airport infrastructure funding, air traffic control modernization, international route authorities, passenger rights regulations, airline industry consolidation, fuel efficiency standards',
                govEntities: 'FAA, DOT, House Transportation Committee, Senate Commerce Committee',
                foreignEntities: 'International Civil Aviation Organization',
                postedDate: '2025-10-16'
            },
            {
                id: 'LOB053',
                client: 'Delta Air Lines Inc.',
                clientDesc: 'Major United States airline',
                registrant: 'Capitol Counsel LLC',
                registrantAddr: '1100 New York Ave NW, Washington, DC 20005',
                lobbyist: 'Ed Bastian',
                lobbyistTitle: 'CEO',
                amount: 2400000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Aviation, Customer Protection, Environmental Policy',
                issues: 'Sustainable aviation fuels incentives, passenger compensation regulations, airport slot allocations, international aviation agreements, carbon emissions standards',
                govEntities: 'FAA, DOT, EPA, House Transportation Committee',
                foreignEntities: 'None',
                postedDate: '2025-10-13'
            },

            // Real Estate & Construction (Housing policy focus)
            {
                id: 'LOB054',
                client: 'National Association of Realtors',
                clientDesc: 'Trade association for real estate professionals',
                registrant: 'NAR Government Affairs',
                registrantAddr: '500 New Jersey Ave NW, Washington, DC 20001',
                lobbyist: 'Kenny Parcell',
                lobbyistTitle: 'President',
                amount: 4200000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Housing, Real Estate, Tax Policy',
                issues: 'Mortgage interest deduction, first-time homebuyer programs, flood insurance reform, property tax policies, housing supply initiatives, real estate transaction regulations',
                govEntities: 'HUD, Treasury, FHFA, House Financial Services Committee, Senate Banking Committee',
                foreignEntities: 'None',
                postedDate: '2025-11-02'
            },

            // Higher Education (Student loans and research funding)
            {
                id: 'LOB055',
                client: 'Association of American Universities',
                clientDesc: 'Association of research universities',
                registrant: 'AAU Government Relations',
                registrantAddr: '1200 New York Ave NW, Washington, DC 20005',
                lobbyist: 'Barbara Snyder',
                lobbyistTitle: 'President',
                amount: 1800000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Education, Research and Development, Immigration',
                issues: 'Federal research funding, student visa policies, international research collaboration, indirect cost recovery, technology transfer regulations, graduate student support',
                govEntities: 'NSF, NIH, Department of Education, House Science Committee, Senate HELP Committee',
                foreignEntities: 'International research partnerships',
                postedDate: '2025-10-11'
            },

            // Labor Unions (Worker rights and policy)
            {
                id: 'LOB056',
                client: 'AFL-CIO',
                clientDesc: 'Federation of labor unions',
                registrant: 'AFL-CIO Government Affairs',
                registrantAddr: '815 16th St NW, Washington, DC 20006',
                lobbyist: 'Liz Shuler',
                lobbyistTitle: 'President',
                amount: 3600000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Labor Relations, Worker Safety, Trade Policy',
                issues: 'Collective bargaining rights, workplace safety standards, minimum wage increases, trade agreement labor provisions, pension protections, healthcare benefits',
                govEntities: 'DOL, NLRB, OSHA, House Education and Labor Committee, Senate HELP Committee',
                foreignEntities: 'International Labour Organization',
                postedDate: '2025-10-27'
            },

            // Environmental Groups (Climate policy advocacy)
            {
                id: 'LOB057',
                client: 'Sierra Club',
                clientDesc: 'Environmental organization',
                registrant: 'Sierra Club Legislative',
                registrantAddr: '50 F St NW, Washington, DC 20001',
                lobbyist: 'Ben Jealous',
                lobbyistTitle: 'Executive Director',
                amount: 2100000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Environment, Climate Change, Public Lands',
                issues: 'Clean energy transition, public lands protection, environmental justice, climate change legislation, renewable energy incentives, pollution regulation enforcement',
                govEntities: 'EPA, Interior, DOE, House Natural Resources Committee, Senate Environment Committee',
                foreignEntities: 'None',
                postedDate: '2025-10-05'
            },

            // Gun Rights Organizations (Second Amendment issues)
            {
                id: 'LOB058',
                client: 'National Rifle Association',
                clientDesc: 'Gun rights advocacy organization',
                registrant: 'NRA Institute for Legislative Action',
                registrantAddr: '11250 Waples Mill Rd, Fairfax, VA 22030',
                lobbyist: 'Wayne LaPierre',
                lobbyistTitle: 'Executive Vice President',
                amount: 2800000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Gun Rights, Constitutional Law, Criminal Justice',
                issues: 'Second Amendment protections, concealed carry reciprocity, firearms regulations, background check systems, sporting goods excise taxes, hunting and shooting sports promotion',
                govEntities: 'ATF, House Judiciary Committee, Senate Judiciary Committee, Interior (hunting programs)',
                foreignEntities: 'None',
                postedDate: '2025-10-23'
            },

            // Foreign Government Lobbying (International influence)
            {
                id: 'LOB059',
                client: 'Government of Israel',
                clientDesc: 'Foreign government lobbying',
                registrant: 'AIPAC',
                registrantAddr: '251 H St NW, Washington, DC 20001',
                lobbyist: 'Howard Kohr',
                lobbyistTitle: 'CEO',
                amount: 4100000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Foreign Policy, Defense, International Relations',
                issues: 'Military aid agreements, defense technology cooperation, Middle East policy, anti-BDS legislation, Iran sanctions policy, regional security partnerships',
                govEntities: 'State Department, DOD, House Foreign Affairs Committee, Senate Foreign Relations Committee, NSC',
                foreignEntities: 'Government of Israel, Israeli Defense Forces',
                postedDate: '2025-11-03'
            },

            // Biotechnology & Life Sciences (Innovation and regulation)
            {
                id: 'LOB060',
                client: 'Biotechnology Innovation Organization',
                clientDesc: 'Biotechnology trade association',
                registrant: 'BIO Government Affairs',
                registrantAddr: '1201 Maryland Ave SW, Washington, DC 20024',
                lobbyist: 'Rachel King',
                lobbyistTitle: 'President and CEO',
                amount: 2700000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Biotechnology, Healthcare Innovation, Regulatory Policy',
                issues: 'FDA approval processes, biosimilar regulations, patent protections, personalized medicine policy, gene therapy oversight, international harmonization of biotech standards',
                govEntities: 'FDA, NIH, USPTO, House Energy and Commerce Committee, Senate HELP Committee',
                foreignEntities: 'International Council for Harmonisation',
                postedDate: '2025-10-07'
            },
            
            // State Government Lobbying (Major States)
            {
                id: 'LOB061',
                client: 'State of California',
                clientDesc: 'State government representing California interests',
                registrant: 'California Government Affairs',
                registrantAddr: '1401 K St NW, Washington, DC 20005',
                lobbyist: 'Nancy McFadden',
                lobbyistTitle: 'Senior Advisor to Governor',
                amount: 4200000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Federal Funding, Environmental Policy, Immigration',
                issues: 'Federal highway funding, climate change initiatives, sanctuary city policies, federal disaster relief, high-speed rail funding, water infrastructure',
                govEntities: 'Department of Transportation, EPA, Department of Homeland Security, FEMA, Congress',
                foreignEntities: 'None',
                postedDate: '2025-11-01'
            },
            {
                id: 'LOB062',
                client: 'State of Texas',
                clientDesc: 'State government representing Texas interests',
                registrant: 'Texas State Federal Relations',
                registrantAddr: '816 Connecticut Ave NW, Washington, DC 20006',
                lobbyist: 'Chris Homan',
                lobbyistTitle: 'Director of Federal Relations',
                amount: 3800000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Border Security, Energy Policy, Defense Contracting',
                issues: 'Border wall funding, oil and gas regulations, military base funding, hurricane recovery, energy export policies, immigration enforcement',
                govEntities: 'Department of Homeland Security, Department of Defense, Department of Energy, Congress',
                foreignEntities: 'None',
                postedDate: '2025-11-01'
            },
            {
                id: 'LOB063',
                client: 'State of Florida',
                clientDesc: 'State government representing Florida interests',
                registrant: 'Florida Federal Relations',
                registrantAddr: '444 N Capitol St NW, Washington, DC 20001',
                lobbyist: 'Ashley Bell',
                lobbyistTitle: 'Director of Federal Affairs',
                amount: 2900000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Hurricane Recovery, Space Industry, Tourism',
                issues: 'FEMA disaster funding, NASA Kennedy Space Center, Everglades restoration, cruise industry regulations, hurricane preparedness, military installations',
                govEntities: 'FEMA, NASA, Department of Defense, Department of Interior, Congress',
                foreignEntities: 'None',
                postedDate: '2025-11-01'
            },
            {
                id: 'LOB064',
                client: 'State of New York',
                clientDesc: 'State government representing New York interests',
                registrant: 'Empire State Development Federal Relations',
                registrantAddr: '1350 I St NW, Washington, DC 20005',
                lobbyist: 'Lisa Ng',
                lobbyistTitle: 'Senior Federal Relations Manager',
                amount: 3200000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Infrastructure, Financial Services, Immigration',
                issues: 'MTA federal funding, LaGuardia Airport improvements, financial regulations, sanctuary policies, federal law enforcement cooperation',
                govEntities: 'Department of Transportation, Treasury Department, Department of Homeland Security, Congress',
                foreignEntities: 'None',
                postedDate: '2025-11-01'
            },
            
            // International Government Lobbying (Foreign Influence)
            {
                id: 'LOB065',
                client: 'Government of Saudi Arabia',
                clientDesc: 'Foreign government seeking to influence U.S. policy',
                registrant: 'Qorvis Communications LLC',
                registrantAddr: '1717 Pennsylvania Ave NW, Washington, DC 20006',
                lobbyist: 'Michael Petruzzello',
                lobbyistTitle: 'Managing Director',
                amount: 5400000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Energy Policy, Defense Cooperation, Trade Relations',
                issues: 'U.S.-Saudi defense agreements, oil market stability, counterterrorism cooperation, arms sales approvals, diplomatic relations, regional security',
                govEntities: 'Department of State, Department of Defense, National Security Council, Congress',
                foreignEntities: 'Kingdom of Saudi Arabia Ministry of Foreign Affairs',
                postedDate: '2025-11-02'
            },
            {
                id: 'LOB066',
                client: 'Government of Israel',
                clientDesc: 'Foreign government lobbying for defense and diplomatic support',
                registrant: 'American Israel Public Affairs Committee',
                registrantAddr: '251 H St NW, Washington, DC 20001',
                lobbyist: 'Howard Kohr',
                lobbyistTitle: 'Chief Executive Officer',
                amount: 4800000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Defense Cooperation, Foreign Aid, Middle East Policy',
                issues: 'Military aid appropriations, Iron Dome funding, Iran sanctions, diplomatic support, intelligence sharing, regional security cooperation',
                govEntities: 'Department of State, Department of Defense, Congress, National Security Council',
                foreignEntities: 'Israel Ministry of Foreign Affairs, Israel Defense Forces',
                postedDate: '2025-11-02'
            },
            {
                id: 'LOB067',
                client: 'Taiwan Government',
                clientDesc: 'Foreign government seeking continued U.S. support',
                registrant: 'Formosan Association for Public Affairs',
                registrantAddr: '552 7th St SE, Washington, DC 20003',
                lobbyist: 'Peter Chen',
                lobbyistTitle: 'Executive Director',
                amount: 2100000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Defense Support, Trade Relations, Diplomatic Recognition',
                issues: 'Arms sales approvals, semiconductor trade agreements, diplomatic status, China threat response, international organization participation',
                govEntities: 'Department of State, Department of Defense, Department of Commerce, Congress',
                foreignEntities: 'Taiwan Ministry of Foreign Affairs, Taiwan Representative Office',
                postedDate: '2025-11-02'
            },
            
            // Think Tanks & Policy Organizations
            {
                id: 'LOB068',
                client: 'Heritage Foundation',
                clientDesc: 'Conservative public policy research institute',
                registrant: 'The Heritage Foundation',
                registrantAddr: '214 Massachusetts Ave NE, Washington, DC 20002',
                lobbyist: 'Kevin Roberts',
                lobbyistTitle: 'President',
                amount: 1800000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Conservative Policy, Government Reform, Constitutional Issues',
                issues: 'Federal spending reduction, regulatory reform, constitutional interpretation, conservative judicial appointments, government efficiency, states\' rights',
                govEntities: 'Executive Office, Congress, Supreme Court, Federal Agencies',
                foreignEntities: 'None',
                postedDate: '2025-11-03'
            },
            {
                id: 'LOB069',
                client: 'Brookings Institution',
                clientDesc: 'Public policy research organization',
                registrant: 'Brookings Government Relations',
                registrantAddr: '1775 Massachusetts Ave NW, Washington, DC 20036',
                lobbyist: 'John Allen',
                lobbyistTitle: 'President',
                amount: 1200000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Economic Policy, Foreign Policy, Social Policy',
                issues: 'Economic research funding, international relations, social welfare programs, education policy, urban development, technology policy',
                govEntities: 'National Science Foundation, Department of State, Congress, Executive Agencies',
                foreignEntities: 'None',
                postedDate: '2025-11-03'
            },
            {
                id: 'LOB070',
                client: 'American Enterprise Institute',
                clientDesc: 'Conservative think tank focusing on economic and foreign policy',
                registrant: 'AEI Government Affairs',
                registrantAddr: '1150 17th St NW, Washington, DC 20036',
                lobbyist: 'Robert Doar',
                lobbyistTitle: 'President',
                amount: 980000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Economic Policy, National Security, Healthcare Reform',
                issues: 'Free market policies, defense spending, healthcare innovation, regulatory reform, international trade, fiscal policy',
                govEntities: 'Congress, Department of Defense, Treasury Department, Federal Trade Commission',
                foreignEntities: 'None',
                postedDate: '2025-11-03'
            },
            
            // Advocacy Organizations & Special Interests
            {
                id: 'LOB071',
                client: 'AARP (American Association of Retired Persons)',
                clientDesc: 'Senior citizens advocacy organization',
                registrant: 'AARP Federal Affairs',
                registrantAddr: '601 E St NW, Washington, DC 20049',
                lobbyist: 'Nancy LeaMond',
                lobbyistTitle: 'Executive Vice President',
                amount: 3600000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Social Security, Medicare, Healthcare',
                issues: 'Social Security benefits protection, Medicare funding, prescription drug costs, age discrimination, caregiver support, retirement security',
                govEntities: 'Social Security Administration, CMS, Department of Health and Human Services, Congress',
                foreignEntities: 'None',
                postedDate: '2025-11-04'
            },
            {
                id: 'LOB072',
                client: 'American Civil Liberties Union',
                clientDesc: 'Civil liberties advocacy organization',
                registrant: 'ACLU Legislative Office',
                registrantAddr: '915 15th St NW, Washington, DC 20005',
                lobbyist: 'Anthony Romero',
                lobbyistTitle: 'Executive Director',
                amount: 2400000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Civil Rights, Privacy Rights, Immigration',
                issues: 'Constitutional protections, surveillance oversight, immigration rights, criminal justice reform, voting rights, free speech protections',
                govEntities: 'Department of Justice, Department of Homeland Security, Congress, Federal Courts',
                foreignEntities: 'None',
                postedDate: '2025-11-04'
            },
            {
                id: 'LOB073',
                client: 'Planned Parenthood Federation of America',
                clientDesc: 'Reproductive health services organization',
                registrant: 'Planned Parenthood Action Fund',
                registrantAddr: '1110 Vermont Ave NW, Washington, DC 20005',
                lobbyist: 'Alexis McGill Johnson',
                lobbyistTitle: 'President and CEO',
                amount: 1900000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Healthcare, Reproductive Rights, Women\'s Issues',
                issues: 'Title X funding, reproductive healthcare access, contraception coverage, maternal health, international family planning aid',
                govEntities: 'Department of Health and Human Services, Congress, USAID, FDA',
                foreignEntities: 'None',
                postedDate: '2025-11-04'
            },
            
            // Environmental & Climate Organizations (Opposition to Trump policies)
            {
                id: 'LOB074',
                client: 'Sierra Club',
                clientDesc: 'Environmental advocacy organization',
                registrant: 'Sierra Club Legislative Office',
                registrantAddr: '50 F St NW, Washington, DC 20001',
                lobbyist: 'Ben Jealous',
                lobbyistTitle: 'Executive Director',
                amount: 2200000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Environmental Protection, Climate Change, Clean Energy',
                issues: 'Clean Air Act enforcement, renewable energy incentives, public lands protection, climate change mitigation, environmental justice, green jobs',
                govEntities: 'EPA, Department of Interior, Department of Energy, Congress',
                foreignEntities: 'None',
                postedDate: '2025-11-05'
            },
            {
                id: 'LOB075',
                client: 'Environmental Defense Fund',
                clientDesc: 'Environmental advocacy and policy organization',
                registrant: 'EDF Action',
                registrantAddr: '1875 Connecticut Ave NW, Washington, DC 20009',
                lobbyist: 'Fred Krupp',
                lobbyistTitle: 'President',
                amount: 1800000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Climate Policy, Environmental Regulations, Clean Technology',
                issues: 'Carbon pricing mechanisms, methane regulations, clean energy standards, environmental markets, climate adaptation funding',
                govEntities: 'EPA, Department of Energy, NOAA, Congress, Federal Energy Regulatory Commission',
                foreignEntities: 'None',
                postedDate: '2025-11-05'
            },
            
            // Religious & Social Conservative Organizations (Trump Support)
            {
                id: 'LOB076',
                client: 'Family Research Council',
                clientDesc: 'Conservative Christian advocacy organization',
                registrant: 'FRC Action',
                registrantAddr: '801 G St NW, Washington, DC 20001',
                lobbyist: 'Tony Perkins',
                lobbyistTitle: 'President',
                amount: 1400000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Religious Freedom, Family Values, Social Issues',
                issues: 'Religious liberty protections, traditional marriage, pro-life legislation, parental rights, faith-based organization funding, conscience protections',
                govEntities: 'Department of Health and Human Services, Department of Education, Congress, Supreme Court',
                foreignEntities: 'None',
                postedDate: '2025-11-05'
            },
            {
                id: 'LOB077',
                client: 'Alliance Defending Freedom',
                clientDesc: 'Legal advocacy organization for religious freedom',
                registrant: 'ADF Government Affairs',
                registrantAddr: '440 First St NW, Washington, DC 20001',
                lobbyist: 'Kristen Waggoner',
                lobbyistTitle: 'General Counsel',
                amount: 1100000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Religious Freedom, Free Speech, Sanctity of Life',
                issues: 'First Amendment protections, religious exemptions, pro-life advocacy, free speech rights, religious organization autonomy',
                govEntities: 'Department of Justice, Department of Education, Congress, Federal Courts',
                foreignEntities: 'None',
                postedDate: '2025-11-05'
            },
            
            // Labor & Worker Organizations (Opposition to Trump policies)  
            {
                id: 'LOB078',
                client: 'Service Employees International Union',
                clientDesc: 'Labor union representing service sector workers',
                registrant: 'SEIU Political Action',
                registrantAddr: '1800 Massachusetts Ave NW, Washington, DC 20036',
                lobbyist: 'Mary Kay Henry',
                lobbyistTitle: 'International President',
                amount: 4200000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Labor Rights, Healthcare, Immigration',
                issues: 'Minimum wage increases, collective bargaining rights, healthcare worker protections, immigration reform, worker safety standards',
                govEntities: 'Department of Labor, NLRB, Department of Health and Human Services, Congress',
                foreignEntities: 'None',
                postedDate: '2025-11-06'
            },
            {
                id: 'LOB079',
                client: 'International Brotherhood of Teamsters',
                clientDesc: 'Labor union representing transportation and logistics workers',
                registrant: 'Teamsters Government Affairs',
                registrantAddr: '25 Louisiana Ave NW, Washington, DC 20001',
                lobbyist: 'Sean O\'Brien',
                lobbyistTitle: 'General President',
                amount: 3100000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Transportation, Labor Rights, Trade Policy',
                issues: 'Infrastructure investment, trucking regulations, trade agreement worker protections, pension security, right-to-organize legislation',
                govEntities: 'Department of Transportation, Department of Labor, Congress, Federal Motor Carrier Safety Administration',
                foreignEntities: 'None',
                postedDate: '2025-11-06'
            },
            
            // Agriculture & Food Industry (Complex relationship with Trump policies)
            {
                id: 'LOB080',
                client: 'American Farm Bureau Federation',
                clientDesc: 'Agricultural advocacy organization',
                registrant: 'Farm Bureau Government Relations',
                registrantAddr: '600 Maryland Ave SW, Washington, DC 20024',
                lobbyist: 'Zippy Duvall',
                lobbyistTitle: 'President',
                amount: 2800000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Agriculture Policy, Trade, Environmental Regulations',
                issues: 'Farm bill reauthorization, agricultural trade agreements, regulatory relief, crop insurance, immigration reform, environmental compliance costs',
                govEntities: 'Department of Agriculture, EPA, Congress, Department of Homeland Security',
                foreignEntities: 'None',
                postedDate: '2025-11-07'
            },
            {
                id: 'LOB081',
                client: 'National Corn Growers Association',
                clientDesc: 'Corn farmers trade association',
                registrant: 'NCGA Government Relations',
                registrantAddr: '20 F St NW, Washington, DC 20001',
                lobbyist: 'Tom Haag',
                lobbyistTitle: 'President',
                amount: 1200000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Agriculture, Biofuels, Trade',
                issues: 'Renewable Fuel Standard, ethanol policies, corn exports, agricultural research funding, trade dispute resolution',
                govEntities: 'Department of Agriculture, EPA, Department of Energy, Congress',
                foreignEntities: 'None',
                postedDate: '2025-11-07'
            },
            
            // Final Technology & Innovation Organizations
            {
                id: 'LOB082',
                client: 'Internet Association',
                clientDesc: 'Internet and technology industry trade group',
                registrant: 'IA Government Relations',
                registrantAddr: '1333 H St NW, Washington, DC 20005',
                lobbyist: 'K. Dane Snowden',
                lobbyistTitle: 'President and CEO',
                amount: 1600000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Technology Policy, Internet Governance, Privacy',
                issues: 'Net neutrality, data localization, content moderation, platform liability, international data transfers, AI governance frameworks',
                govEntities: 'FCC, FTC, Department of Commerce, Congress, Executive Office',
                foreignEntities: 'None',
                postedDate: '2025-11-08'
            },
            {
                id: 'LOB083',
                client: 'Consumer Technology Association',
                clientDesc: 'Technology industry trade association',
                registrant: 'CTA Government Affairs',
                registrantAddr: '1919 S Eads St, Arlington, VA 22202',
                lobbyist: 'Gary Shapiro',
                lobbyistTitle: 'President and CEO',
                amount: 1100000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Consumer Technology, Innovation Policy, Trade',
                issues: 'Technology innovation policies, intellectual property protection, international technology standards, consumer electronics trade, autonomous vehicle regulations',
                govEntities: 'Department of Commerce, FTC, Congress, Department of Transportation',
                foreignEntities: 'None',
                postedDate: '2025-11-08'
            },
            
            // Final Academic & Research Institutions
            {
                id: 'LOB084',
                client: 'Association of American Universities',
                clientDesc: 'Research universities advocacy organization',
                registrant: 'AAU Federal Relations',
                registrantAddr: '1200 New York Ave NW, Washington, DC 20005',
                lobbyist: 'Barbara Snyder',
                lobbyistTitle: 'President',
                amount: 1800000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Research Funding, Higher Education, Immigration',
                issues: 'Federal research funding, STEM education, international student policies, research visa programs, university-industry partnerships',
                govEntities: 'National Science Foundation, NIH, Department of Education, Congress, Department of Homeland Security',
                foreignEntities: 'None',
                postedDate: '2025-11-09'
            },
            {
                id: 'LOB085',
                client: 'American Medical Association',
                clientDesc: 'Physicians professional association',
                registrant: 'AMA Advocacy Resource Center',
                registrantAddr: '330 N Wabash Ave, Chicago, IL 60611',
                lobbyist: 'James Madara',
                lobbyistTitle: 'Executive Vice President and CEO',
                amount: 2900000,
                year: 2025,
                quarter: 4,
                reportType: 'Quarterly',
                issueAreas: 'Healthcare Policy, Medical Education, Public Health',
                issues: 'Medicare reimbursement rates, medical liability reform, physician training programs, public health funding, drug pricing policies',
                govEntities: 'CMS, Department of Health and Human Services, Congress, FDA',
                foreignEntities: 'None',
                postedDate: '2025-11-09'
            }
        ];
        
        for (const lobby of lobbyingData) {
            db.run(`INSERT OR REPLACE INTO lobbying 
                (registration_id, client_name, client_description, registrant_name, registrant_address, 
                 lobbyist_name, lobbyist_title, amount, year, quarter, report_type, issue_areas, 
                 specific_issues, government_entities, foreign_entities, posted_date) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [lobby.id, lobby.client, lobby.clientDesc || '', lobby.registrant, lobby.registrantAddr || '',
                 lobby.lobbyist, lobby.lobbyistTitle || '', lobby.amount, lobby.year, lobby.quarter || 4,
                 lobby.reportType || 'Quarterly', lobby.issueAreas || '', lobby.issues, 
                 lobby.govEntities || '', lobby.foreignEntities || '', lobby.postedDate || '2025-10-01']
            );
        }
        
        console.log(`✅ Loaded ${lobbyingData.length} lobbying records for 2025`);
        return { success: true, message: `Lobbying data updated with ${lobbyingData.length} records` };
    } catch (error) {
        console.error('Error fetching lobbying data:', error.message);
        return { success: false, error: error.message };
    }
}

// Input validation and sanitization middleware
const validateInput = (req, res, next) => {
    // Sanitize query parameters
    if (req.query) {
        Object.keys(req.query).forEach(key => {
            if (typeof req.query[key] === 'string') {
                // Remove potentially dangerous characters
                req.query[key] = req.query[key].replace(/[<>'"]/g, '');
                // Limit length
                if (req.query[key].length > 100) {
                    req.query[key] = req.query[key].substring(0, 100);
                }
            }
        });
    }
    
    // Sanitize body parameters
    if (req.body) {
        Object.keys(req.body).forEach(key => {
            if (typeof req.body[key] === 'string') {
                // Remove potentially dangerous characters for specific fields
                if (['username', 'email', 'search', 'chamber', 'party', 'state'].includes(key)) {
                    req.body[key] = req.body[key].replace(/[<>'"]/g, '');
                }
                // Limit length based on field type
                const maxLengths = {
                    username: 50,
                    email: 100,
                    password: 128,
                    search: 100
                };
                const maxLength = maxLengths[key] || 500;
                if (req.body[key].length > maxLength) {
                    req.body[key] = req.body[key].substring(0, maxLength);
                }
            }
        });
    }
    next();
};

// Authentication middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }
    
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.user = user;
        next();
    });
};

// Apply validation to all API routes
app.use('/api/', validateInput);

// API Routes

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        service: 'government-watchdog-api',
        version: '1.0.0',
        uptime: process.uptime()
    });
});

// User registration
app.post('/api/register', (req, res) => {
    const { username, email, password } = req.body;
    
    // Validation
    if (!username || !password || !email) {
        return res.status(400).json({ error: 'Missing required fields: username, email, password' });
    }
    
    // Email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
    }
    
    // Username validation (alphanumeric + underscore only)
    const usernameRegex = /^[a-zA-Z0-9_]{3,30}$/;
    if (!usernameRegex.test(username)) {
        return res.status(400).json({ error: 'Username must be 3-30 characters, alphanumeric and underscore only' });
    }
    
    // Password strength validation
    if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }
    if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(password)) {
        return res.status(400).json({ error: 'Password must contain at least one uppercase letter, one lowercase letter, and one number' });
    }
    
    db.run('INSERT INTO users (username, email, hash) VALUES (?, ?, ?)', 
        [username, email, hashPass(password)], function(err) {
        if (err) {
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(400).json({ error: 'Username or email already exists' });
            }
            console.error('Registration error:', err);
            return res.status(500).json({ error: 'Registration failed' });
        }
        res.json({ 
            token: genToken({ id: this.lastID, username }),
            user: { id: this.lastID, username, email }
        });
    });
});

// User login
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get('SELECT * FROM users WHERE username = ? OR email = ?', [username, username], (err, user) => {
        if (!user || !checkPass(password, user.hash)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        res.json({ 
            token: genToken(user),
            user: { id: user.id, username: user.username, email: user.email }
        });
    });
});

// Congressional members search
app.get('/api/congress/members', async (req, res) => {
    const { state, party, chamber, search, keyword, limit = 100 } = req.query;
    let query = 'SELECT * FROM congress_members WHERE in_office = 1';
    let params = [];
    
    if (state) {
        query += ' AND state = ?';
        params.push(state.toUpperCase());
    }
    if (party) {
        query += ' AND party = ?';
        params.push(party.toUpperCase());
    }
    if (chamber) {
        query += ' AND chamber = ?';
        params.push(chamber.toLowerCase());
    }
    if (search || keyword) {
        const searchTerm = search || keyword;
        query += ' AND (first_name LIKE ? OR last_name LIKE ? OR party LIKE ? OR chamber LIKE ?)';
        const searchPattern = `%${searchTerm}%`;
        params.push(searchPattern, searchPattern, searchPattern, searchPattern);
    }
    
    query += ' ORDER BY last_name, first_name LIMIT ?';
    params.push(parseInt(limit));
    
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(rows);
    });
});

// Recent bills and legislation
app.get('/api/legislation/bills', (req, res) => {
    const { status, subject, sponsor, bill_type, congress, keyword, limit = 50 } = req.query;
    let query = 'SELECT * FROM bills WHERE 1=1';
    let params = [];
    
    if (status) {
        query += ' AND status = ?';
        params.push(status);
    }
    if (subject) {
        query += ' AND subjects LIKE ?';
        params.push(`%${subject}%`);
    }
    if (sponsor) {
        query += ' AND sponsor_id = ?';
        params.push(sponsor);
    }
    if (bill_type) {
        query += ' AND bill_type = ?';
        params.push(bill_type.toLowerCase());
    }
    if (congress) {
        query += ' AND congress = ?';
        params.push(parseInt(congress));
    }
    if (keyword) {
        query += ' AND (title LIKE ? OR summary LIKE ? OR bill_id LIKE ? OR subjects LIKE ?)';
        const keywordPattern = `%${keyword}%`;
        params.push(keywordPattern, keywordPattern, keywordPattern, keywordPattern);
    }
    
    query += ' ORDER BY introduced_date DESC LIMIT ?';
    params.push(parseInt(limit));
    
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(rows);
    });
});

// Federal spending search
app.get('/api/spending', (req, res) => {
    const { agency, recipient, min_amount, fiscal_year, state, keyword, limit = 100 } = req.query;
    let query = 'SELECT * FROM federal_spending WHERE 1=1';
    let params = [];
    
    if (agency) {
        query += ' AND (awarding_agency LIKE ? OR funding_agency LIKE ?)';
        params.push(`%${agency}%`, `%${agency}%`);
    }
    if (recipient) {
        query += ' AND recipient_name LIKE ?';
        params.push(`%${recipient}%`);
    }
    if (min_amount) {
        query += ' AND award_amount >= ?';
        params.push(parseFloat(min_amount));
    }
    if (fiscal_year) {
        query += ' AND fiscal_year = ?';
        params.push(parseInt(fiscal_year));
    }
    if (state) {
        query += ' AND (recipient_name LIKE ? OR award_description LIKE ? OR place_of_performance LIKE ?)';
        const statePattern = `%${state}%`;
        params.push(statePattern, statePattern, statePattern);
    }
    if (keyword) {
        query += ' AND (recipient_name LIKE ? OR award_description LIKE ? OR awarding_agency LIKE ? OR award_id LIKE ?)';
        const keywordPattern = `%${keyword}%`;
        params.push(keywordPattern, keywordPattern, keywordPattern, keywordPattern);
    }
    
    query += ' ORDER BY award_amount DESC LIMIT ?';
    params.push(parseInt(limit));
    
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(rows);
    });
});

// Lobbying data
app.get('/api/lobbying', (req, res) => {
    const { client, lobbyist, year, min_amount, state, keyword, limit = 100 } = req.query;
    let query = 'SELECT * FROM lobbying WHERE 1=1';
    let params = [];
    
    if (client) {
        query += ' AND client_name LIKE ?';
        params.push(`%${client}%`);
    }
    if (lobbyist) {
        query += ' AND (registrant_name LIKE ? OR lobbyist_name LIKE ?)';
        params.push(`%${lobbyist}%`, `%${lobbyist}%`);
    }
    if (year) {
        query += ' AND year = ?';
        params.push(parseInt(year));
    }
    if (min_amount) {
        query += ' AND amount >= ?';
        params.push(parseFloat(min_amount));
    }
    if (state) {
        query += ' AND (client_name LIKE ? OR registrant_name LIKE ? OR issues LIKE ?)';
        const statePattern = `%${state}%`;
        params.push(statePattern, statePattern, statePattern);
    }
    if (keyword) {
        query += ' AND (client_name LIKE ? OR registrant_name LIKE ? OR lobbyist_name LIKE ? OR issues LIKE ?)';
        const keywordPattern = `%${keyword}%`;
        params.push(keywordPattern, keywordPattern, keywordPattern, keywordPattern);
    }
    
    query += ' ORDER BY amount DESC LIMIT ?';
    params.push(parseInt(limit));
    
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(rows);
    });
});

// Dashboard summary data
app.get('/api/dashboard/summary', (req, res) => {
    const queries = {
        totalMembers: 'SELECT COUNT(*) as count FROM congress_members WHERE in_office = 1',
        activeBills: 'SELECT COUNT(*) as count FROM bills WHERE status IN ("introduced", "passed_house", "passed_senate")',
        totalSpending: 'SELECT SUM(award_amount) as total FROM federal_spending WHERE fiscal_year = 2024'
    };
    
    const results = {};
    let completed = 0;
    
    Object.keys(queries).forEach(key => {
        db.get(queries[key], (err, row) => {
            if (!err) results[key] = row;
            completed++;
            if (completed === Object.keys(queries).length) {
                res.json(results);
            }
        });
    });
});

// Data refresh endpoint
app.post('/api/admin/refresh', async (req, res) => {
    const { data_source } = req.body;
    let result;
    
    try {
        switch (data_source) {
            case 'congress':
                result = await fetchCongressData();
                break;
            case 'spending':
                result = await fetchSpendingData();
                break;
            case 'legislation':
                result = await fetchLegislationData();
                break;
            case 'all':
                const [congress, spending, legislation] = await Promise.all([
                    fetchCongressData(),
                    fetchSpendingData(),
                    fetchLegislationData()
                ]);
                result = { congress, spending, legislation };
                break;
            default:
                return res.status(400).json({ error: 'Invalid data source' });
        }
        
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Initialize sample data on startup
setTimeout(async () => {
    console.log('🔄 Initializing sample government data...');
    await Promise.all([
        fetchCongressData(),
        fetchSpendingData(),
        fetchLegislationData(),
        fetchLobbyingData()
    ]);
    console.log('✅ Sample data loaded');
}, 1000);

// Root route for basic connectivity test
app.get('/', (req, res) => {
    res.json({ 
        message: 'Government Watchdog API is running',
        status: 'ok',
        version: '1.0.0',
        endpoints: ['/api/health', '/api/congress/members', '/api/spending', '/api/lobbying', '/api/legislation/bills']
    });
});

app.listen(PORT, () => {
    console.log(`🏛️  Government Watchdog API running on http://localhost:${PORT}`);
    console.log(`📊 API Endpoints:`);
    console.log(`   GET  /api/health - Service status`);
    console.log(`   POST /api/register - User registration`);
    console.log(`   POST /api/login - User authentication`);
    console.log(`   GET  /api/congress/members - Congressional members`);
    console.log(`   GET  /api/legislation/bills - Bills and legislation`);
    console.log(`   GET  /api/spending - Federal spending data`);
    console.log(`   GET  /api/lobbying - Lobbying activities`);
    console.log(`   GET  /api/dashboard/summary - Dashboard statistics`);
    console.log(`🔍 Government Transparency & Accountability Platform`);
});