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
            
            // Senate Members (Sample from various states)
            { id: 'B000944', first: 'Sherrod', last: 'Brown', party: 'D', state: 'OH', chamber: 'senate', phone: '(202) 224-2315' },
            { id: 'C001075', first: 'Bill', last: 'Cassidy', party: 'R', state: 'LA', chamber: 'senate', phone: '(202) 224-5824' },
            { id: 'W000817', first: 'Elizabeth', last: 'Warren', party: 'D', state: 'MA', chamber: 'senate', phone: '(202) 224-4543' },
            { id: 'C001098', first: 'Ted', last: 'Cruz', party: 'R', state: 'TX', chamber: 'senate', phone: '(202) 224-5922' },
            { id: 'S000033', first: 'Bernie', last: 'Sanders', party: 'I', state: 'VT', chamber: 'senate', phone: '(202) 224-5141' },
            { id: 'R000595', first: 'Marco', last: 'Rubio', party: 'R', state: 'FL', chamber: 'senate', phone: '(202) 224-3041' },
            { id: 'F000062', first: 'Dianne', last: 'Feinstein', party: 'D', state: 'CA', chamber: 'senate', phone: '(202) 224-3841' },
            { id: 'G000359', first: 'Lindsey', last: 'Graham', party: 'R', state: 'SC', chamber: 'senate', phone: '(202) 224-5972' },
            { id: 'K000367', first: 'Amy', last: 'Klobuchar', party: 'D', state: 'MN', chamber: 'senate', phone: '(202) 224-3244' },
            { id: 'C001056', first: 'John', last: 'Cornyn', party: 'R', state: 'TX', chamber: 'senate', phone: '(202) 224-2934' },
            
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
            { id: 'C001119', first: 'Angie', last: 'Craig', party: 'D', state: 'MN', chamber: 'house', district: '2', phone: '(202) 225-2271' }
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
            { id: 'AWD057', recipient: 'Nucor Corporation', amount: 1400000000, type: 'Contract', agency: 'Department of Defense', description: 'Military-grade steel manufacturing', year: 2025 }
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
            { id: 's8-119', congress: 119, type: 's', number: '8', title: 'Federal Employee Accountability Act', status: 'introduced', date: '2025-11-05' }
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
    const { state, party, chamber, search } = req.query;
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
    if (search) {
        query += ' AND (first_name LIKE ? OR last_name LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
    }
    
    query += ' ORDER BY last_name, first_name';
    
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(rows);
    });
});

// Recent bills and legislation
app.get('/api/legislation/bills', (req, res) => {
    const { status, subject, sponsor, limit = 50 } = req.query;
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
    
    query += ' ORDER BY introduced_date DESC LIMIT ?';
    params.push(parseInt(limit));
    
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(rows);
    });
});

// Federal spending search
app.get('/api/spending', (req, res) => {
    const { agency, recipient, min_amount, fiscal_year, limit = 100 } = req.query;
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
    
    query += ' ORDER BY award_amount DESC LIMIT ?';
    params.push(parseInt(limit));
    
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(rows);
    });
});

// Lobbying data
app.get('/api/lobbying', (req, res) => {
    const { client, lobbyist, year, min_amount, limit = 100 } = req.query;
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