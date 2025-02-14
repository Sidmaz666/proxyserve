// server.js
require('dotenv').config();
const http = require('http');
const axios = require('axios');
const tunnel = require('tunnel');
const winston = require('winston');
const { URL } = require('url');
const net = require('net');
const tls = require('tls');

// ====== Configuration ======
const PORT = process.env.PORT || 3000;
const PROXY_LIST_URL =
  process.env.PROXY_LIST_URL ||
  'https://raw.githubusercontent.com/zloi-user/hideip.me/refs/heads/master/https.txt';
const PROXY_REFRESH_INTERVAL = Number(process.env.PROXY_REFRESH_INTERVAL) || 600000; // 10 minutes
const MAX_RETRIES = Number(process.env.MAX_RETRIES) || 3;
const PROXY_TYPE = process.env.PROXY_TYPE || 'https'; // "http" for HTTP proxies; default is "https"
const DEFAULT_USER_AGENT =
  process.env.DEFAULT_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36';

// ====== Logger Setup ======
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      (info) => `${info.timestamp} ${info.level}: ${info.message}`
    )
  ),
  transports: [new winston.transports.Console()]
});

// ====== ProxyManager ======
// Fetches and rotates the list of upstream proxies.
// Each line from the proxy list (expected format "IP:port:Country") is parsed into a string of the form:
//   `${PROXY_TYPE}://IP:port`
class ProxyManager {
  constructor() {
    this.proxies = [];
    this.index = 0;
    this.refreshProxies();
    this.startAutoRefresh();
  }

  async refreshProxies() {
    try {
      logger.info(`Fetching proxy list from ${PROXY_LIST_URL}`);
      const response = await axios.get(PROXY_LIST_URL);
      if (response.status === 200 && response.data) {
        const lines = response.data.split('\n').filter((line) => line.trim() !== '');
        this.proxies = lines
          .map((line) => {
            const parts = line.split(':');
            if (parts.length >= 2) {
              return `${PROXY_TYPE}://${parts[0]}:${parts[1]}`;
            }
            return null;
          })
          .filter(Boolean);
        logger.info(`Updated proxy list with ${this.proxies.length} proxies.`);
      } else {
        logger.error(`Failed to fetch proxy list. Status: ${response.status}`);
      }
    } catch (error) {
      logger.error(`Error fetching proxy list: ${error.message}`);
    }
  }

  startAutoRefresh() {
    setInterval(() => this.refreshProxies(), PROXY_REFRESH_INTERVAL);
  }

  getNextProxy() {
    if (this.proxies.length === 0) return null;
    const proxy = this.proxies[this.index];
    this.index = (this.index + 1) % this.proxies.length;
    return proxy;
  }
}

const proxyManager = new ProxyManager();

// ====== Helper: Tunnel Agent ======
// Returns a tunneling agent (using the "tunnel" package) based on the target URL protocol
// and the proxy type. Supports both HTTP and HTTPS targets.
function getTunnelAgent(targetUrl, proxyUrl) {
  const parsedTarget = new URL(targetUrl);
  const targetProtocol = parsedTarget.protocol; // "http:" or "https:"
  const parsedProxy = new URL(proxyUrl);
  const proxyHost = parsedProxy.hostname;
  const proxyPort = Number(parsedProxy.port);
  let agent;

  if (targetProtocol === 'http:') {
    if (PROXY_TYPE === 'http') {
      agent = tunnel.httpOverHttp({ proxy: { host: proxyHost, port: proxyPort } });
    } else {
      agent = tunnel.httpOverHttps({
        proxy: { host: proxyHost, port: proxyPort, rejectUnauthorized: false }
      });
    }
  } else if (targetProtocol === 'https:') {
    if (PROXY_TYPE === 'http') {
      agent = tunnel.httpsOverHttp({ proxy: { host: proxyHost, port: proxyPort } });
    } else {
      agent = tunnel.httpsOverHttps({
        proxy: { host: proxyHost, port: proxyPort, rejectUnauthorized: false }
      });
    }
  }
  return agent;
}

// ====== HTTP Request Handler ======
// Handles non-CONNECT (HTTP) requests coming from clients (e.g. from a Chrome extension in proxy mode).
// Expects the full URL in the request line and tunnels the request via an upstream proxy.
const requestHandler = async (req, res) => {
  let targetUrl;
  try {
    targetUrl = new URL(req.url);
    if (!['http:', 'https:'].includes(targetUrl.protocol)) {
      throw new Error('Invalid protocol');
    }
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid or missing URL in request line');
    return;
  }

  // Sanitize and enhance headers.
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers['content-length'];
  headers['user-agent'] = headers['user-agent'] || DEFAULT_USER_AGENT;
  headers['accept'] = headers['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  headers['accept-language'] = headers['accept-language'] || 'en-US,en;q=0.5';

  let attempt = 0;
  let lastError;
  while (attempt < MAX_RETRIES) {
    const proxyUrl = proxyManager.getNextProxy();
    if (!proxyUrl) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No proxies available' }));
      return;
    }
    logger.info(`HTTP ${req.method} ${targetUrl.href} via upstream proxy ${proxyUrl}`);
    try {
      const agent = getTunnelAgent(targetUrl.href, proxyUrl);
      const axiosOptions = {
        method: req.method,
        url: targetUrl.href,
        headers: headers,
        data: req,
        responseType: 'stream',
        timeout: 10000,
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false
      };
      const response = await axios(axiosOptions);
      res.writeHead(response.status, response.headers);
      response.data.pipe(res);
      return;
    } catch (error) {
      logger.error(`Error via upstream proxy ${proxyUrl}: ${error.message}`);
      lastError = error;
      attempt++;
    }
  }
  res.writeHead(502, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Bad Gateway', details: lastError ? lastError.message : 'Unknown error' }));
};

// ====== Create the HTTP Server ======
const server = http.createServer(requestHandler);

// ====== HTTPS CONNECT Tunneling Handler ======
// Handles CONNECT requests (used for HTTPS connections via the proxy).
server.on('connect', (req, clientSocket, head) => {
  // req.url is in the form "targetHost:targetPort"
  const [targetHost, targetPortRaw] = req.url.split(':');
  const targetPort = Number(targetPortRaw) || 443;
  const proxyUrl = proxyManager.getNextProxy();
  if (!proxyUrl) {
    clientSocket.write("HTTP/1.1 500 No proxies available\r\n\r\n");
    clientSocket.end();
    return;
  }
  logger.info(`CONNECT ${req.url} via upstream proxy ${proxyUrl}`);
  const parsedProxy = new URL(proxyUrl);
  const proxyHost = parsedProxy.hostname;
  const proxyPort = Number(parsedProxy.port);

  // Build connection options. For HTTPS upstream proxies, use TLS.
  const connectionOptions = {
    host: proxyHost,
    port: proxyPort,
    rejectUnauthorized: false
  };
  // Only set SNI (servername) if proxyHost is not an IP address.
  if (PROXY_TYPE !== 'http' && !net.isIP(proxyHost)) {
    connectionOptions.servername = proxyHost;
  }

  const connectFunc = PROXY_TYPE === 'http' ? net.connect : tls.connect;
  const proxySocket = connectFunc(connectionOptions, () => {
    // Build a proper CONNECT request including Proxy-Connection header.
    const connectRequest =
      `CONNECT ${req.url} HTTP/1.1\r\n` +
      `Host: ${req.url}\r\n` +
      `Proxy-Connection: Keep-Alive\r\n\r\n`;
    proxySocket.write(connectRequest);
  });

  proxySocket.once('data', (data) => {
    const response = data.toString();
    if (response.indexOf('200') !== -1) {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length > 0) {
        proxySocket.write(head);
      }
      clientSocket.pipe(proxySocket);
      proxySocket.pipe(clientSocket);
    } else {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      clientSocket.end();
      proxySocket.end();
    }
  });

  proxySocket.on('error', (err) => {
    logger.error(`CONNECT error via upstream proxy ${proxyUrl}: ${err.message}`);
    clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    clientSocket.end();
  });
});

// ====== Start the Server ======
server.listen(PORT, () => {
  logger.info(`Forward proxy server listening on port ${PORT}`);
});
