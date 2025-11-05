const http = require('http');

const options = {
  hostname: 'localhost',
  port: process.env.PORT || 4000,
  path: '/api/health',
  timeout: 2000,
  method: 'GET'
};

const request = http.request(options, (res) => {
  if (res.statusCode === 200) {
    process.exit(0);
  } else {
    process.exit(1);
  }
});

request.on('error', () => {
  process.exit(1);
});

request.on('timeout', () => {
  request.destroy();
  process.exit(1);
});

request.end();