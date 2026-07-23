const http = require('http');

const data = JSON.stringify({ seed_id: 'BENIH001' });

const options = {
  hostname: 'ai-service',
  port: 8000,
  path: '/predict',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = http.request(options, (res) => {
  res.on('data', (d) => process.stdout.write(d));
});

req.write(data);
req.end();
