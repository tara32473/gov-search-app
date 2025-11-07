const { Pool } = require('pg');

class DatabaseService {
    constructor() {
        this.pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
            max: parseInt(process.env.DB_POOL_MAX) || 20,
            min: parseInt(process.env.DB_POOL_MIN) || 2,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 2000,
        });

        this.pool.on('error', (err) => {
            console.error('Unexpected error on idle client', err);
            process.exit(-1);
        });
    }

    async query(text, params) {
        const start = Date.now();
        const client = await this.pool.connect();
        
        try {
            const res = await client.query(text, params);
            const duration = Date.now() - start;
            
            if (duration > 1000) {
                console.warn(`Slow query detected: ${duration}ms - ${text}`);
            }
            
            return res;
        } finally {
            client.release();
        }
    }

    async transaction(callback) {
        const client = await this.pool.connect();
        
        try {
            await client.query('BEGIN');
            const result = await callback(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async createTables() {
        const createTablesSQL = `
            -- Users table with enhanced security
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                role VARCHAR(20) DEFAULT 'user',
                email_verified BOOLEAN DEFAULT FALSE,
                preferences JSONB DEFAULT '{}',
                alerts_enabled BOOLEAN DEFAULT TRUE,
                last_login TIMESTAMP,
                failed_login_attempts INTEGER DEFAULT 0,
                locked_until TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Congressional members with indexes
            CREATE TABLE IF NOT EXISTS congress_members (
                bioguide_id VARCHAR(20) PRIMARY KEY,
                first_name VARCHAR(50) NOT NULL,
                last_name VARCHAR(50) NOT NULL,
                party VARCHAR(20),
                state VARCHAR(2),
                chamber VARCHAR(20),
                district VARCHAR(10),
                in_office BOOLEAN DEFAULT TRUE,
                next_election DATE,
                phone VARCHAR(20),
                twitter_handle VARCHAR(50),
                website_url TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Bills with full-text search
            CREATE TABLE IF NOT EXISTS bills (
                bill_id VARCHAR(50) PRIMARY KEY,
                congress INTEGER NOT NULL,
                bill_type VARCHAR(20) NOT NULL,
                number INTEGER NOT NULL,
                title TEXT NOT NULL,
                summary TEXT,
                introduced_date DATE,
                latest_action TEXT,
                latest_action_date DATE,
                sponsor_id VARCHAR(20),
                status VARCHAR(50),
                subjects TEXT[],
                committees TEXT[],
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (sponsor_id) REFERENCES congress_members(bioguide_id)
            );

            -- Federal spending with proper indexing
            CREATE TABLE IF NOT EXISTS federal_spending (
                id SERIAL PRIMARY KEY,
                agency_name VARCHAR(200) NOT NULL,
                recipient_name VARCHAR(200) NOT NULL,
                amount DECIMAL(15,2) NOT NULL,
                award_type VARCHAR(100),
                description TEXT,
                date_signed DATE,
                fiscal_year INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Lobbying with enhanced tracking
            CREATE TABLE IF NOT EXISTS lobbying (
                id SERIAL PRIMARY KEY,
                registration_id VARCHAR(50),
                client_name VARCHAR(200) NOT NULL,
                client_description TEXT,
                registrant_name VARCHAR(200) NOT NULL,
                registrant_address TEXT,
                amount DECIMAL(15,2),
                report_year INTEGER NOT NULL,
                report_quarter INTEGER,
                report_type VARCHAR(50),
                lobbyist_names TEXT[],
                government_entities TEXT[],
                foreign_entities BOOLEAN DEFAULT FALSE,
                issues TEXT[],
                specific_issues TEXT,
                termination_date DATE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- User alerts and notifications
            CREATE TABLE IF NOT EXISTS user_alerts (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                alert_type VARCHAR(50) NOT NULL,
                entity_type VARCHAR(50) NOT NULL,
                entity_id VARCHAR(100) NOT NULL,
                keywords TEXT[],
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            -- API usage tracking
            CREATE TABLE IF NOT EXISTS api_usage (
                id SERIAL PRIMARY KEY,
                endpoint VARCHAR(200) NOT NULL,
                method VARCHAR(10) NOT NULL,
                ip_address INET,
                user_id INTEGER,
                response_time INTEGER,
                status_code INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
            );
        `;

        const indexSQL = `
            -- Performance indexes
            CREATE INDEX IF NOT EXISTS idx_congress_members_state ON congress_members(state);
            CREATE INDEX IF NOT EXISTS idx_congress_members_party ON congress_members(party);
            CREATE INDEX IF NOT EXISTS idx_congress_members_chamber ON congress_members(chamber);
            CREATE INDEX IF NOT EXISTS idx_congress_members_in_office ON congress_members(in_office);

            CREATE INDEX IF NOT EXISTS idx_bills_congress ON bills(congress);
            CREATE INDEX IF NOT EXISTS idx_bills_sponsor ON bills(sponsor_id);
            CREATE INDEX IF NOT EXISTS idx_bills_status ON bills(status);
            CREATE INDEX IF NOT EXISTS idx_bills_introduced_date ON bills(introduced_date);

            CREATE INDEX IF NOT EXISTS idx_spending_agency ON federal_spending(agency_name);
            CREATE INDEX IF NOT EXISTS idx_spending_fiscal_year ON federal_spending(fiscal_year);
            CREATE INDEX IF NOT EXISTS idx_spending_amount ON federal_spending(amount);

            CREATE INDEX IF NOT EXISTS idx_lobbying_client ON lobbying(client_name);
            CREATE INDEX IF NOT EXISTS idx_lobbying_year ON lobbying(report_year);
            CREATE INDEX IF NOT EXISTS idx_lobbying_amount ON lobbying(amount);

            CREATE INDEX IF NOT EXISTS idx_user_alerts_user ON user_alerts(user_id);
            CREATE INDEX IF NOT EXISTS idx_user_alerts_active ON user_alerts(is_active);

            CREATE INDEX IF NOT EXISTS idx_api_usage_endpoint ON api_usage(endpoint);
            CREATE INDEX IF NOT EXISTS idx_api_usage_created_at ON api_usage(created_at);
        `;

        const fullTextSearchSQL = `
            -- Full-text search indexes
            CREATE INDEX IF NOT EXISTS idx_bills_title_fts ON bills USING gin(to_tsvector('english', title));
            CREATE INDEX IF NOT EXISTS idx_bills_summary_fts ON bills USING gin(to_tsvector('english', summary));
            CREATE INDEX IF NOT EXISTS idx_lobbying_description_fts ON lobbying USING gin(to_tsvector('english', client_description));
        `;

        await this.query(createTablesSQL);
        await this.query(indexSQL);
        await this.query(fullTextSearchSQL);
        
        console.log('✅ Database tables and indexes created successfully');
    }

    async healthCheck() {
        try {
            const result = await this.query('SELECT 1 as health');
            return result.rows[0].health === 1;
        } catch (error) {
            console.error('Database health check failed:', error);
            return false;
        }
    }

    async close() {
        await this.pool.end();
    }
}

module.exports = DatabaseService;