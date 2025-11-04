#!/usr/bin/env node

const { Octokit } = require('@octokit/rest');

// Initialize Octokit (GitHub API client)
const octokit = new Octokit();

/**
 * Mock data for demonstration when API is unavailable
 */
function getMockData(limit) {
  return {
    total_count: 15432,
    items: [
      {
        full_name: 'github/government.github.com',
        description: 'Gather, curate, and feature stories of public servants and civic hackers using GitHub',
        stargazers_count: 1234,
        html_url: 'https://github.com/github/government.github.com',
        language: 'JavaScript'
      },
      {
        full_name: 'usagov/usagov-2021',
        description: 'USA.gov is the official guide to government information and services',
        stargazers_count: 987,
        html_url: 'https://github.com/usagov/usagov-2021',
        language: 'Ruby'
      },
      {
        full_name: 'GSA/data.gov',
        description: 'The home of the U.S. Government\'s open data',
        stargazers_count: 856,
        html_url: 'https://github.com/GSA/data.gov',
        language: 'Python'
      },
      {
        full_name: 'opengovfoundation/free-law-founders-site',
        description: 'Free Law Founders - Making the law more accessible',
        stargazers_count: 654,
        html_url: 'https://github.com/opengovfoundation/free-law-founders-site',
        language: 'HTML'
      },
      {
        full_name: 'unitedstates/congress',
        description: 'Public domain data about the U.S. Congress',
        stargazers_count: 543,
        html_url: 'https://github.com/unitedstates/congress',
        language: 'Python'
      }
    ].slice(0, limit)
  };
}

/**
 * Pull government repositories from GitHub
 * @param {number} limit - Maximum number of repositories to fetch
 */
async function pullFromGitHub(limit = 10) {
  let data;
  let usedMockData = false;

  try {
    console.log('Pulling government repositories from GitHub...\n');
    
    // Try to search for government repositories
    const response = await octokit.search.repos({
      q: 'government OR gov in:topics',
      sort: 'stars',
      order: 'desc',
      per_page: limit
    });
    data = response.data;
  } catch (error) {
    console.log('Note: Could not connect to GitHub API. Using sample data for demonstration.\n');
    data = getMockData(limit);
    usedMockData = true;
  }

  console.log(`Found ${data.total_count} government-related repositories\n`);
  console.log(`Displaying top ${Math.min(limit, data.items.length)} results:\n`);

  // Display repository information
  data.items.forEach((repo, index) => {
    console.log(`${index + 1}. ${repo.full_name}`);
    console.log(`   Description: ${repo.description || 'No description'}`);
    console.log(`   Stars: ${repo.stargazers_count}`);
    console.log(`   URL: ${repo.html_url}`);
    console.log(`   Language: ${repo.language || 'N/A'}`);
    console.log('');
  });

  if (usedMockData) {
    console.log('Note: This data is for demonstration purposes. Connect to the internet to fetch real GitHub data.\n');
  }

  return data.items;
}

// Parse command line arguments
const args = process.argv.slice(2);
let limit = 10;

if (args[0]) {
  const parsedLimit = parseInt(args[0], 10);
  if (isNaN(parsedLimit) || parsedLimit <= 0) {
    console.error('Error: Limit must be a positive number');
    process.exit(1);
  }
  limit = parsedLimit;
}

// Execute the pull
pullFromGitHub(limit);
