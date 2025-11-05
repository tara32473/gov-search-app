# 🏛️ Government Watchdog Platform

A comprehensive government transparency and accountability platform that tracks Congress, federal spending, legislation, and lobbying activities.

![Platform](https://img.shields.io/badge/Platform-Government%20Watchdog-blue)
![Status](https://img.shields.io/badge/Status-Active-green)
![Members](https://img.shields.io/badge/Congressional%20Members-42+-orange)
[![License: MIT](https://img.shields.io/github/license/tara32473/gov-search-app)](LICENSE)

## 🌟 Overview

The Government Watchdog Platform provides citizens, journalists, and researchers with powerful tools to monitor government activities and promote transparency. Track everything from congressional voting records to federal spending patterns.

## 🚀 Quick Start

```bash
# Install dependencies
npm run setup

# Start the full platform
npm run dev

# Access the web interface
open http://localhost:4000
```

## 📊 Platform Features

### 🏛️ Congressional Oversight
- **42+ Congressional Members** including House, Senate, and Executive Branch
- **Real-time Member Search** by state, party, or chamber
- **Contact Information** including phone numbers
- **Leadership Tracking** including Speaker, Majority/Minority Leaders
- **Executive Branch Officials** including President, Cabinet members

### 💰 Federal Spending Monitoring  
- **Contract Tracking** - Monitor government contracts and expenditures
- **Agency Spending** - Search by awarding agency or recipient
- **Amount Filtering** - Find large-scale government investments
- **Multi-year Analysis** - Track spending trends over time

### 📋 Legislative Tracking
- **Bill Monitoring** - Track legislation through the entire process
- **Status Updates** - From introduction to enactment
- **Subject Classification** - Search bills by topic or keyword
- **Sponsor Tracking** - See who's introducing what legislation

### 🤝 Lobbying Transparency
- **Lobbying Activities** - Track lobbying registrations and expenditures  
- **Client Monitoring** - See which organizations are lobbying
- **Issue Tracking** - Monitor lobbying by specific issues
- **Expenditure Analysis** - Follow the money in lobbying

## 🏗️ Technical Architecture

### Backend API (Node.js/Express)
```
📁 backend/
├── server.js          # Main API server
├── watchdog.sqlite    # Government data database
└── package.json       # Dependencies
```

**Key Endpoints:**
- `GET /api/congress/members` - Congressional data
- `GET /api/legislation/bills` - Legislative tracking
- `GET /api/spending` - Federal spending data
- `GET /api/lobbying` - Lobbying activities
- `GET /api/dashboard/summary` - Platform statistics

### Frontend (Responsive Web App)
```
📁 frontend/dist/
└── index.html         # Complete web application
```

**Features:**
- 📱 Mobile-responsive design
- 🔍 Advanced search & filtering
- 📊 Real-time data visualization
- 👤 User accounts & preferences
- 🚨 Alert system (coming soon)

### Database Schema
```sql
congress_members    # Representatives, Senators, Executive officials
bills              # Legislative tracking
federal_spending   # Government contracts & expenditures  
lobbying          # Lobbying activities & registrations
users             # Platform user accounts
user_alerts       # Watchdog alert subscriptions
```

## 🎯 Use Cases

### 👥 For Citizens
- **Track Your Representatives** - See how your congressional delegation votes
- **Monitor Local Spending** - Find federal contracts in your area
- **Follow Legislation** - Track bills that affect your interests
- **Research Transparency** - Access comprehensive government data

### 📰 For Journalists  
- **Investigate Spending Patterns** - Find stories in government expenditures
- **Track Lobbying Influence** - Connect lobbying to legislative outcomes
- **Monitor Congressional Activity** - Report on representative actions
- **Export Data** - Get raw data for in-depth analysis

### 🔬 For Researchers
- **Academic Research** - Access structured government datasets  
- **Policy Analysis** - Study legislative and spending trends
- **Transparency Studies** - Measure government openness
- **Comparative Analysis** - Compare across time periods and agencies

## 🌐 Data Sources

The platform is designed to integrate with major government APIs:

- **📡 ProPublica Congress API** - Congressional data & voting records
- **💰 USASpending.gov** - Federal expenditure data
- **🏛️ Congress.gov** - Official legislative information
- **💼 OpenSecrets.org** - Campaign finance & lobbying data
- **🗳️ FEC API** - Election finance data
- **📋 Federal Register** - Regulatory information

## 🔧 Development

### Local Setup
```bash
# Clone repository
git clone <repository-url>
cd gov-search-app

# Install all dependencies  
npm run setup

# Start development server
npm run dev

# Access platform
open http://localhost:4000
```

### Available Scripts
```bash
npm run dev        # Start full platform
npm run backend    # API server only  
npm run cli        # Command-line interface
npm run setup      # Install dependencies
npm test          # Run tests (coming soon)
```

### Environment Variables
```bash
PORT=4000                    # Server port
JWT_SECRET=your-secret-key   # Authentication secret
PROPUBLICA_API_KEY=key      # Congress API access
FEC_API_KEY=key             # Campaign finance data
```

## 📈 Current Status

### ✅ Completed
- [x] Congressional member database (42+ officials)
- [x] Legislative tracking system
- [x] Federal spending monitoring  
- [x] User authentication & accounts
- [x] Responsive web interface
- [x] REST API with comprehensive endpoints
- [x] Executive branch officials tracking

### 🚧 In Development
- [ ] Real-time data feeds from government APIs
- [ ] Campaign finance integration
- [ ] Advanced analytics & visualizations  
- [ ] Alert system for legislation & spending
- [ ] Mobile app (React Native)
- [ ] Data export & reporting tools

### 🔮 Planned Features
- [ ] FOIA request tracking
- [ ] Ethics disclosure monitoring
- [ ] Regulatory change alerts
- [ ] State & local government expansion
- [ ] International transparency comparisons

## 🤝 Contributing

We welcome contributions to improve government transparency! 

### Priority Areas
1. **Data Integration** - Connect real government APIs
2. **Visualization** - Create compelling data displays
3. **Analytics** - Build trend analysis tools
4. **Mobile Experience** - Enhance mobile functionality
5. **Documentation** - Improve user guides

## 📄 License

MIT License - See [LICENSE](LICENSE) for details.

## 🌟 Mission

**Promoting government transparency and accountability through accessible, comprehensive data.**

Our goal is to make government activities visible and understandable to all citizens, fostering informed civic participation and democratic accountability.

---

### 📞 Support

For questions, feature requests, or bug reports:
- 🐛 [Issues](https://github.com/tara32473/gov-search-app/issues)
- 💬 [Discussions](https://github.com/tara32473/gov-search-app/discussions)
- 📧 Email: watchdog@transparency.gov (demo)

**🏛️ Democracy works best when government works in the open.**