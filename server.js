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
const PROXY_DOMAIN_CACHE_TTL =
  Number(process.env.PROXY_DOMAIN_CACHE_TTL) || 600000; // 10 minutes for domain mapping cache
const MAX_RETRIES = Number(process.env.MAX_RETRIES) || 5;
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
// Manages the list of upstream proxies and caches which proxy worked for each domain.
class ProxyManager {
  constructor() {
    this.proxies = [];
    this.index = 0;
    this.domainCache = new Map(); // domain -> { proxy, timestamp }
    this.refreshProxies();
    this.startAutoRefresh();
    // Flush domain cache at the same interval.
    setInterval(() => this.flushDomainCache(), PROXY_REFRESH_INTERVAL);
  }

  async refreshProxies() {
    try {
      logger.info(`Fetching proxy list from ${PROXY_LIST_URL}`);
      const response = await axios.get(PROXY_LIST_URL);
      if (response.status === 200 && response.data) {
        const lines = response.data
          .split('\n')
          .filter((line) => line.trim() !== '');
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

  // Returns the next proxy in round-robin.
  getNextProxy() {
    if (this.proxies.length === 0) return null;
    const proxy = this.proxies[this.index];
    this.index = (this.index + 1) % this.proxies.length;
    return proxy;
  }

  // Returns a cached proxy for a domain if still valid.
  getProxyForDomain(domain) {
    const mapping = this.domainCache.get(domain);
    if (mapping && Date.now() - mapping.timestamp < PROXY_DOMAIN_CACHE_TTL) {
      return mapping.proxy;
    }
    this.domainCache.delete(domain);
    return null;
  }

  // Cache a successful proxy for a domain.
  setDomainForDomain(domain, proxy) {
    this.domainCache.set(domain, { proxy, timestamp: Date.now() });
  }

  // Remove a domain mapping.
  removeDomainMapping(domain) {
    this.domainCache.delete(domain);
  }

  // Flush all domain mappings.
  flushDomainCache() {
    this.domainCache.clear();
    logger.info('Flushed all domain-to-proxy mappings.');
  }
}

const proxyManager = new ProxyManager();

// ====== Helper: Tunnel Agent ======
// Returns a tunneling agent (using the "tunnel" package) based on the target URL protocol
// and the proxy type.
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
// Handles HTTP requests coming from clients.
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

  // Ensure headers are set properly.
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers['content-length'];
  headers['user-agent'] = headers['user-agent'] || DEFAULT_USER_AGENT;
  headers['accept'] =
    headers['accept'] ||
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  headers['accept-language'] =
    headers['accept-language'] || 'en-US,en;q=0.5';

  const domain = targetUrl.hostname;
  let attempt = 0;
  let lastError;
  while (attempt < MAX_RETRIES) {
    let proxyUrl;
    if (attempt === 0) {
      proxyUrl = proxyManager.getProxyForDomain(domain) || proxyManager.getNextProxy();
    } else {
      proxyUrl = proxyManager.getNextProxy();
    }
    logger.info(
      `HTTP ${req.method} ${targetUrl.href} via upstream proxy ${proxyUrl} (attempt ${attempt + 1})`
    );
    try {
      const agent = getTunnelAgent(targetUrl.href, proxyUrl);
      const axiosOptions = {
        method: req.method,
        url: targetUrl.href,
        headers: headers,
        data: req, // stream body if any
        responseType: 'stream',
        timeout: 10000,
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false
      };
      const response = await axios(axiosOptions);
      // Cache this proxy for the domain on success.
      proxyManager.setDomainForDomain(domain, proxyUrl);

      // Pipe the response stream to the client.
      res.writeHead(response.status, response.headers);
      response.data.pipe(res);

      // Attach an error handler to avoid unhandled stream errors.
      response.data.on('error', (err) => {
        logger.error(`Response stream error: ${err.message}`);
        res.end();
      });
      return;
    } catch (error) {
      logger.error(`Error via upstream proxy ${proxyUrl}: ${error.message}`);
      // If the cached proxy failed, remove it.
      if (attempt === 0 && proxyManager.getProxyForDomain(domain) === proxyUrl) {
        proxyManager.removeDomainMapping(domain);
      }
      lastError = error;
      attempt++;
    }
  }
  res.writeHead(502, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({ error: 'Bad Gateway', details: lastError ? lastError.message : 'Unknown error' })
  );
};

// ====== HTTPS CONNECT Tunneling Handler ======
// Handles CONNECT requests used for HTTPS connections.
const serverOnConnect = (req, clientSocket, head) => {
  // Ensure clientSocket errors are caught.
  clientSocket.on('error', (err) => {
    if (err.code !== 'EPIPE') {
      logger.error(`Client socket error: ${err.message}`);
    }
    clientSocket.destroy();
  });

  // req.url is in the form "targetHost:targetPort"
  const [targetHost, targetPortRaw] = req.url.split(':');
  const targetPort = Number(targetPortRaw) || 443;
  const domain = targetHost;

  const attemptConnect = (attempt = 0) => {
    if (attempt >= MAX_RETRIES) {
      try {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      } catch (writeErr) {
        logger.error(`Error writing to client socket: ${writeErr.message}`);
      }
      clientSocket.end();
      return;
    }
    let proxyUrl =
      attempt === 0
        ? (proxyManager.getProxyForDomain(domain) || proxyManager.getNextProxy())
        : proxyManager.getNextProxy();

    logger.info(`CONNECT ${req.url} via upstream proxy ${proxyUrl} (attempt ${attempt + 1})`);

    const parsedProxy = new URL(proxyUrl);
    const proxyHost = parsedProxy.hostname;
    const proxyPort = Number(parsedProxy.port);

    const connectionOptions = {
      host: proxyHost,
      port: proxyPort,
      rejectUnauthorized: false
    };
    // Set SNI if using TLS and the proxy host is a domain.
    if (PROXY_TYPE !== 'http' && !net.isIP(proxyHost)) {
      connectionOptions.servername = proxyHost;
    }

    const connectFunc = PROXY_TYPE === 'http' ? net.connect : tls.connect;
    const proxySocket = connectFunc(connectionOptions, () => {
      // Send a CONNECT request to the upstream proxy.
      const connectRequest =
        `CONNECT ${req.url} HTTP/1.1\r\n` +
        `Host: ${req.url}\r\n` +
        `Proxy-Connection: Keep-Alive\r\n\r\n`;
      try {
        proxySocket.write(connectRequest);
      } catch (err) {
        logger.error(`Error writing CONNECT request: ${err.message}`);
        proxySocket.destroy();
      }
    });

    // Attach error handlers to the proxy socket.
    proxySocket.on('error', (err) => {
      if (err.code !== 'EPIPE') {
        logger.error(`Proxy socket error via ${proxyUrl}: ${err.message}`);
      }
      proxySocket.destroy();
      attemptConnect(attempt + 1);
    });

    // Listen for data from the proxy.
    proxySocket.once('data', (data) => {
      const response = data.toString();
      if (response.indexOf('200') !== -1) {
        try {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        } catch (err) {
          logger.error(`Error writing 200 response: ${err.message}`);
          proxySocket.destroy();
          clientSocket.destroy();
          return;
        }
        // If there's any remaining data from the client, forward it.
        if (head && head.length > 0) {
          proxySocket.write(head);
        }
        // Pipe data between the client and proxy.
        clientSocket.pipe(proxySocket);
        proxySocket.pipe(clientSocket);
        // Attach error handlers to avoid unhandled errors.
        proxySocket.on('error', (err) => {
          if (err.code !== 'EPIPE') {
            logger.error(`Proxy socket pipe error: ${err.message}`);
          }
          clientSocket.destroy();
        });
        clientSocket.on('error', (err) => {
          if (err.code !== 'EPIPE') {
            logger.error(`Client socket pipe error: ${err.message}`);
          }
          proxySocket.destroy();
        });
        // Cache the successful proxy for this domain.
        proxyManager.setDomainForDomain(domain, proxyUrl);
      } else {
        logger.error(`CONNECT attempt ${attempt + 1} via ${proxyUrl} failed. Response: ${response}`);
        proxySocket.destroy();
        attemptConnect(attempt + 1);
      }
    });
  };

  attemptConnect();
};

// ====== Create the HTTP Server ======
const server = http.createServer(requestHandler);
server.on('connect', serverOnConnect);

// Catch any server-level errors.
server.on('error', (err) => {
  logger.error(`Server error: ${err.message}`);
});

// ====== Start the Server ======
server.listen(PORT, () => {
  logger.info(`Forward proxy server listening on port ${PORT}`);
});
