#!/usr/bin/env node

/**
 * gov-search-cli: Search government GitHub repositories by keyword
 * Usage: node index.js <keyword> [maxResults]
 */

const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

function printUsageAndExit() {
  console.log('Usage: node index.js <keyword> [maxResults]');
  console.log('Example: node index.js justice 10');
  process.exit(1);
}

const [, , keyword, maxResultsArg] = process.argv;
const maxResults = parseInt(maxResultsArg, 10) || 10;
if (!keyword) printUsageAndExit();

const searchURL = `https://api.github.com/search/repositories?q=topic:government+${encodeURIComponent(
  keyword
)}&sort=stars&order=desc&per_page=${maxResults}`;

(async () => {
  console.log(`Searching GitHub for government repos matching: "${keyword}" ...`);
  try {
    const res = await fetch(searchURL, {
      headers: { 'User-Agent': 'gov-search-cli' }
    });
    if (!res.ok) {
      console.error(`GitHub API error: ${res.status} ${res.statusText}`);
      process.exit(1);
    }
    const { items } = await res.json();
    if (items.length === 0) {
      console.log('No results found!');
      return;
    }
    for (const repo of items) {
      console.log(`- \x1b[36m${repo.full_name}\x1b[0m (${repo.stargazers_count} ★)`);
      console.log(`  ${repo.description || 'No description.'}`);
      console.log(`  ${repo.html_url}`);
      console.log('');
    }
  } catch (err) {
    console.error('Failed to fetch results:', err.message);
    process.exit(1);
  }
})();
