# gov-search-app

A simple Node.js application to search and pull government-related repositories from GitHub.

## Features

- Search for government repositories on GitHub
- Display repository information including name, description, stars, URL, and primary language
- Configurable number of results

## Installation

1. Clone the repository:
```bash
git clone https://github.com/tara32473/gov-search-app.git
cd gov-search-app
```

2. Install dependencies:
```bash
npm install
```

## Usage

Run the application with default settings (shows 10 repositories):
```bash
npm start
```

Or specify the number of repositories to display:
```bash
node index.js 20
```

## Example Output

```
Pulling government repositories from GitHub...

Found 15432 government-related repositories

Displaying top 10 results:

1. github/government.github.com
   Description: Gather, curate, and feature stories of public servants and civic hackers using GitHub
   Stars: 1234
   URL: https://github.com/github/government.github.com
   Language: JavaScript

...
```

## Requirements

- Node.js (v14 or higher)
- npm

## License

MIT