const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'changeme';

app.use(cors());
app.use(express.json());

const db = new sqlite3.Database('./appdata.sqlite');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT UNIQUE,
        hash TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS congress (
        id TEXT PRIMARY KEY,
        name TEXT,
        party TEXT,
        state TEXT,
        data TEXT
    )`);
});

function genToken(user) {
    return jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '2d' });
}

function hashPass(p) {
    return bcrypt.hashSync(p, 10);
}

function checkPass(p, h) {
    return bcrypt.compareSync(p, h);
}

function auth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Missing token' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Invalid token' });
    }
}

app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
    db.run('INSERT INTO users (username, hash) VALUES (?, ?)', [username, hashPass(password)], function(err) {
        if (err) return res.status(400).json({ error: 'User exists' });
        res.json({ token: genToken({ id: this.lastID, username }) });
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (!user || !checkPass(password, user.hash)) return res.status(401).json({ error: 'Invalid credentials' });
        res.json({ token: genToken(user) });
    });
});

app.get('/api/search', auth, (req, res) => {
    const { name, state, party } = req.query;
    let q = 'SELECT * FROM congress WHERE 1=1', params = [];
    if (name) {
        q += ' AND name LIKE ?', params.push('%' + name + '%');
    }
    if (state) {
        q += ' AND state = ?', params.push(state);
    }
    if (party) {
        q += ' AND party = ?', params.push(party);
    }
    db.all(q, params, (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        res.json(rows.map(r => ({
            id: r.id,
            name: r.name,
            party: r.party,
            state: r.state,
            data: JSON.parse(r.data)
        }))); 
    });
});

app.post('/api/admin/addcongress', (req, res) => {
    const { id, name, party, state, data } = req.body;
    db.run('INSERT OR REPLACE INTO congress (id, name, party, state, data) VALUES (?, ?, ?, ?, ?)', [id, name, party, state, JSON.stringify(data || {})], function(err) {
        if (err) return res.status(400).json({ error: err.message });
        res.json({ ok: true });
    });
});

// Only start server if not in serverless environment
// Check both require.main and explicit serverless environment variable
const isServerless = process.env.SERVERLESS === 'true' || process.env.LAMBDA_TASK_ROOT || process.env.NETLIFY || process.env.VERCEL;

if (!isServerless && require.main === module) {
    app.listen(PORT, () => console.log(`API listening on http://localhost:${PORT}`));
}

// Export app for serverless environments
module.exports = app;
