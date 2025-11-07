// Real Government API Integration Service
const fetch = require('node-fetch');

class GovernmentAPIService {
    constructor() {
        this.congressAPI = process.env.CONGRESS_API_KEY;
        this.openSecretsAPI = process.env.OPENSECRETS_API_KEY;
        this.usaSpendingAPI = process.env.USASPENDING_API_KEY;
        this.propublicaAPI = process.env.PROPUBLICA_API_KEY;
    }

    // Congress.gov API Integration
    async fetchCongressMembers() {
        try {
            const response = await fetch(`https://api.congress.gov/v3/member?api_key=${this.congressAPI}&limit=250&format=json`);
            const data = await response.json();
            
            return data.members?.map(member => ({
                bioguide_id: member.bioguideId,
                first_name: member.firstName,
                last_name: member.lastName,
                party: member.partyName,
                state: member.state,
                chamber: member.terms?.[0]?.chamber,
                district: member.district,
                in_office: member.terms?.[0]?.endYear >= new Date().getFullYear(),
                phone: member.officialWebsiteUrl,
                updated_at: new Date().toISOString()
            })) || [];
        } catch (error) {
            console.error('Congress API Error:', error);
            return [];
        }
    }

    // ProPublica Congress API for detailed info
    async fetchCongressDetails() {
        try {
            const [houseResponse, senateResponse] = await Promise.all([
                fetch('https://api.propublica.org/congress/v1/118/house/members.json', {
                    headers: { 'X-API-Key': this.propublicaAPI }
                }),
                fetch('https://api.propublica.org/congress/v1/118/senate/members.json', {
                    headers: { 'X-API-Key': this.propublicaAPI }
                })
            ]);

            const houseData = await houseResponse.json();
            const senateData = await senateResponse.json();

            const allMembers = [
                ...(houseData.results?.[0]?.members || []),
                ...(senateData.results?.[0]?.members || [])
            ];

            return allMembers.map(member => ({
                bioguide_id: member.id,
                first_name: member.first_name,
                last_name: member.last_name,
                party: member.party,
                state: member.state,
                chamber: member.chamber,
                district: member.district,
                phone: member.phone,
                twitter_handle: member.twitter_account,
                next_election: member.next_election,
                in_office: member.in_office
            }));
        } catch (error) {
            console.error('ProPublica API Error:', error);
            return [];
        }
    }

    // OpenSecrets.org API for lobbying data
    async fetchLobbyingData(year = new Date().getFullYear()) {
        try {
            const response = await fetch(`https://www.opensecrets.org/api/?method=getLobbyingForClient&apikey=${this.openSecretsAPI}&year=${year}&output=json`);
            const data = await response.json();
            
            return data.response?.lob_client?.map(record => ({
                client_name: record.client,
                registrant_name: record.registrant,
                amount: parseInt(record.total) || 0,
                report_year: year,
                report_type: 'Annual',
                issues: record.specific_issues,
                updated_at: new Date().toISOString()
            })) || [];
        } catch (error) {
            console.error('OpenSecrets API Error:', error);
            return [];
        }
    }

    // USAspending.gov API for federal spending
    async fetchFederalSpending() {
        try {
            const response = await fetch('https://api.usaspending.gov/api/v2/spending/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    filters: {
                        time_period: [
                            {
                                start_date: `${new Date().getFullYear()}-01-01`,
                                end_date: `${new Date().getFullYear()}-12-31`
                            }
                        ]
                    },
                    category: 'awarding_agency',
                    limit: 100
                })
            });
            
            const data = await response.json();
            
            return data.results?.map(record => ({
                agency_name: record.Agency,
                recipient_name: record.Recipient,
                amount: record.Award_Amount,
                award_type: record.Award_Type,
                description: record.Description,
                date_signed: record.Start_Date,
                fiscal_year: new Date().getFullYear()
            })) || [];
        } catch (error) {
            console.error('USAspending API Error:', error);
            return [];
        }
    }

    // Congress.gov API for legislation
    async fetchLegislation() {
        try {
            const response = await fetch(`https://api.congress.gov/v3/bill?api_key=${this.congressAPI}&limit=50&format=json&sort=updateDate+desc`);
            const data = await response.json();
            
            return data.bills?.map(bill => ({
                bill_id: `${bill.congress}-${bill.type}-${bill.number}`,
                congress: bill.congress,
                bill_type: bill.type,
                number: bill.number,
                title: bill.title,
                introduced_date: bill.introducedDate,
                latest_action: bill.latestAction?.text,
                latest_action_date: bill.latestAction?.actionDate,
                sponsor_id: bill.sponsors?.[0]?.bioguideId,
                status: bill.latestAction?.text?.includes('Enacted') ? 'Enacted' : 'In Progress'
            })) || [];
        } catch (error) {
            console.error('Congress Bills API Error:', error);
            return [];
        }
    }

    // Rate limiting helper
    async rateLimitedFetch(url, options = {}, delay = 1000) {
        await new Promise(resolve => setTimeout(resolve, delay));
        return fetch(url, options);
    }
}

module.exports = GovernmentAPIService;