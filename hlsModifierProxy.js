const express = require('express');
const http = require('http');
const httpProxy = require('http-proxy');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const proxy = httpProxy.createProxyServer({});

const TARGET_SERVER = 'http://127.0.0.1:3000'; // Changed from localhost to 127.0.0.1
const PROXY_PORT = 3001;

let modificationEnabled = false;

// Enable CORS for all routes
app.use(cors());

// Function to modify segment data
function modifySegmentData(data) {
  // Modify a byte in the middle of the data
  const middleIndex = Math.floor(data.length / 2);
  data[middleIndex] = (data[middleIndex] + 1) % 256;
  return data;
}

app.get('/toggleModification', (req, res) => {
  modificationEnabled = !modificationEnabled;
  console.log(`Modification ${modificationEnabled ? 'enabled' : 'disabled'}`);
  res.json({ modificationEnabled });
});

app.use('/media/:streamKey/:file', (req, res) => {
  const { streamKey, file } = req.params;
  const targetUrl = `${TARGET_SERVER}/media/${streamKey}/${file}`;

  console.log(`Proxying request to: ${targetUrl}`);

  if (file.endsWith('.m4s') && modificationEnabled) {
    // For segment files, intercept and modify if enabled
    http.get(targetUrl, (response) => {
      let data = [];
      response.on('data', (chunk) => data.push(chunk));
      response.on('end', () => {
        let buffer = Buffer.concat(data);
        buffer = modifySegmentData(buffer);
        
        res.writeHead(response.statusCode, response.headers);
        res.end(buffer);
      });
    }).on('error', (err) => {
      console.error('Error fetching segment:', err);
      res.status(500).send('Error fetching segment');
    });
  } else {
    // For other files or when modification is disabled, proxy as-is
    proxy.web(req, res, { target: targetUrl }, (err) => {
      if (err) {
        console.error('Proxy error:', err);
        res.status(500).send('Proxy error');
      }
    });
  }
});

// Proxy all other requests
app.use('/', (req, res) => {
  console.log(`Proxying request to: ${TARGET_SERVER}${req.url}`);
  proxy.web(req, res, { target: TARGET_SERVER }, (err) => {
    if (err) {
      console.error('Proxy error:', err);
      res.status(500).send('Proxy error');
    }
  });
});


server.listen(PROXY_PORT, '127.0.0.1', () => {  // Added '127.0.0.1' here
  console.log(`HLS Stream Modifier Proxy running on http://127.0.0.1:${PROXY_PORT}`);
}).on('error', (err) => {
  console.error('Failed to start server:', err);
});

// Error handling for the proxy
proxy.on('error', (err, req, res) => {
  console.error('Proxy error:', err);
  res.writeHead(500, {
    'Content-Type': 'text/plain'
  });
  res.end('Something went wrong with the proxy.');
});