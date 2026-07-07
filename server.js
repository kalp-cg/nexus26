/**
 * @fileoverview Nexus26 - FIFA World Cup 2026 AI Operations Spine Server
 * @description Real-time WebSocket event bus connecting the Fan Companion and
 *   Command Center dashboards. Handles REST API data operations, Gemini AI
 *   function-calling integration, input sanitization, and security enforcement.
 * @version 1.1.0
 * @author Nexus26 Team
 */

'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

// Import modular subsystems
const { log } = require('./lib/logger');
const { sanitizeInput } = require('./lib/sanitizer');
const { initDatabase, readJSON, writeJSON } = require('./lib/database');
const { initOperations } = require('./lib/operations');
const { runGeminiAgent, runFallbackMockAgent } = require('./lib/ai');

/**
 * Validates required environment variables on server startup.
 * Logs warnings for missing optional config and confirms runtime mode.
 */
const validateEnvironment = () => {
  const port = process.env.PORT || 3000;
  const nodeEnv = process.env.NODE_ENV || 'development';
  if (!process.env.GEMINI_API_KEY) {
    log('WARN', 'ENV', 'GEMINI_API_KEY not set — running in Fallback Mock-Agent mode');
  } else {
    log('INFO', 'ENV', 'GEMINI_API_KEY detected — Gemini function-calling enabled');
  }
  log('INFO', 'ENV', `PORT resolved to ${port}`);
  log('INFO', 'ENV', `NODE_ENV: ${nodeEnv}`);
};
validateEnvironment();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/** @constant {number|string} PORT - Server listening port from env or default 3000 */
const PORT = process.env.PORT || 3000;
const MAX_CHAT_MESSAGE_LENGTH = 1200;
const MAX_CHAT_HISTORY_ITEMS = 12;
const VALID_PERSONAS = ['fan', 'command'];
const VALID_TRANSIT_STATUSES = ['on_time', 'delayed', 'suspended', 'crowded'];

// Local wrapper for writeJSON passing current directory as baseDir
const localWriteJSON = (fileName, data) => writeJSON(fileName, data, __dirname);

/**
 * Converts a request body value to a finite number within an expected range.
 * @param {*} value - Raw request body value
 * @param {number} min - Inclusive minimum
 * @param {number} max - Inclusive maximum
 * @returns {number|null} Parsed number or null when invalid
 */
const parseBoundedNumber = (value, min, max) => {
  if (value === undefined || value === null || value === '') return undefined;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < min || numberValue > max) {
    return null;
  }
  return numberValue;
};

/**
 * Normalizes and limits chat history supplied by the browser before it reaches
 * an AI provider or fallback agent.
 * @param {*} history - Raw request body history
 * @returns {Array<Object>|null} Sanitized history or null when the shape is invalid
 */
const sanitizeChatHistory = (history) => {
  if (history === undefined) return [];
  if (!Array.isArray(history) || history.length > MAX_CHAT_HISTORY_ITEMS) {
    return null;
  }
  return history.map((item) => ({
    role: sanitizeInput(item && item.role),
    content: sanitizeInput(item && item.content),
  }));
};

/**
 * HTTP Security Headers Middleware
 * Sets industry-standard headers to protect against XSS, clickjacking,
 * MIME-sniffing, information leakage, and code injection attacks.
 */
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; " +
      "connect-src 'self' ws: wss: https://generativelanguage.googleapis.com; " +
      "img-src 'self' data:; " +
      "frame-ancestors 'none';"
  );
  next();
});

/**
 * CORS Middleware - Restrict cross-origin access to known safe origins.
 * Allows the Render deployment and localhost development origins.
 */
app.use((req, res, next) => {
  const allowedOrigins = ['https://nexus26.onrender.com', 'http://localhost:3000', 'http://127.0.0.1:3000'];
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

/**
 * Memory-based API Rate Limiter.
 * Limits each IP address to 180 requests per 60-second sliding window.
 * Prevents denial-of-service and brute-force abuse.
 */
const ipRequestCounts = {};
app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  if (!ipRequestCounts[ip]) {
    ipRequestCounts[ip] = [];
  }
  ipRequestCounts[ip] = ipRequestCounts[ip].filter((t) => now - t < 60000);
  if (ipRequestCounts[ip].length >= 180) {
    return res.status(429).json({
      error: 'Too many requests. Please try again in a moment.',
      retryAfter: 60,
    });
  }
  ipRequestCounts[ip].push(now);
  // Periodic cleanup of stale IP entries to prevent memory leak
  if (Object.keys(ipRequestCounts).length > 10000) {
    const cutoff = now - 120000;
    Object.keys(ipRequestCounts).forEach((k) => {
      ipRequestCounts[k] = ipRequestCounts[k].filter((t) => t > cutoff);
      if (ipRequestCounts[k].length === 0) delete ipRequestCounts[k];
    });
  }
  next();
});

// Parse JSON bodies with a 100kb size limit to prevent large payload attacks
app.use(express.json({ limit: '100kb' }));

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Malformed JSON request body' });
  }
  next(err);
});

app.use(express.static(path.join(__dirname, 'public')));

// Initialize memory-cached database
initDatabase(__dirname);

/**
 * Broadcasts a JSON event to all connected WebSocket clients.
 * Only delivers to clients with OPEN readyState to avoid stale connection errors.
 * @param {Object} data - Event payload with a `type` discriminator and `data` body
 */
const broadcast = (data) => {
  const messageStr = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
    }
  });
};

// Initialize operations module dependency
initOperations(broadcast, __dirname);

// WebSocket connection handler
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  log('INFO', 'WS', 'Client connected');
  ws.send(JSON.stringify({ type: 'WELCOME', message: 'Connected to Nexus26 Live Spine' }));

  ws.on('close', () => {
    log('INFO', 'WS', 'Client disconnected');
  });
});

// Heartbeat interval to prune dead sockets
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      log('INFO', 'WS', 'Terminating dead WebSocket connection');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.on('close', () => {
  clearInterval(heartbeatInterval);
  wss.close();
});

// ─── REST API Endpoints ──────────────────────────────────────────────────────

/** @route GET /api/sensors - Retrieve live gate congestion sensor data */
app.get('/api/sensors', (req, res) => {
  res.json(readJSON('gate_sensors.json'));
});

/** @route POST /api/sensors/update - Update gate congestion level and crowd count */
app.post('/api/sensors/update', (req, res) => {
  const gate_id = sanitizeInput(req.body.gate_id);
  const congestion_level = sanitizeInput(req.body.congestion_level);
  const current_count = parseBoundedNumber(req.body.current_count, 0, 100000);
  const avg_wait_min = parseBoundedNumber(req.body.avg_wait_min, 0, 240);

  // Input validation
  if (!gate_id) {
    return res.status(400).json({ error: 'gate_id is required' });
  }
  const validLevels = ['low', 'medium', 'high', 'critical'];
  if (congestion_level && !validLevels.includes(congestion_level)) {
    return res.status(400).json({ error: `congestion_level must be one of: ${validLevels.join(', ')}` });
  }
  if (current_count === null) {
    return res.status(400).json({ error: 'current_count must be a number between 0 and 100000' });
  }
  if (avg_wait_min === null) {
    return res.status(400).json({ error: 'avg_wait_min must be a number between 0 and 240' });
  }

  const sensorData = readJSON('gate_sensors.json');
  if (!sensorData) return res.status(500).json({ error: 'Failed to read sensor data' });

  const gate = sensorData.gates.find((g) => g.gate_id === gate_id);
  if (!gate) return res.status(404).json({ error: `Gate '${gate_id}' not found` });

  if (congestion_level) gate.congestion_level = congestion_level;
  if (current_count !== undefined) gate.current_count = Number(current_count);
  if (avg_wait_min !== undefined) gate.avg_wait_min = Number(avg_wait_min);
  sensorData.timestamp = new Date().toISOString();

  if (localWriteJSON('gate_sensors.json', sensorData)) {
    log('INFO', 'SENSOR', `Gate ${gate_id} updated to ${congestion_level}`);
    broadcast({ type: 'SENSOR_UPDATE', data: sensorData });
    res.json({ success: true, data: sensorData });
  } else {
    res.status(500).json({ error: 'Failed to save sensor data' });
  }
});

/** @route GET /api/transit - Retrieve live transit line schedule and delays */
app.get('/api/transit', (req, res) => {
  res.json(readJSON('transit_feeds.json'));
});

/** @route POST /api/transit/update - Update a transit line's delay status */
app.post('/api/transit/update', (req, res) => {
  const line = sanitizeInput(req.body.line);
  const status = sanitizeInput(req.body.status);
  const delay_min = parseBoundedNumber(req.body.delay_min, 0, 240);

  // Input validation
  if (!line) {
    return res.status(400).json({ error: 'line is required' });
  }
  if (!status) {
    return res.status(400).json({ error: 'status is required' });
  }
  if (!VALID_TRANSIT_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_TRANSIT_STATUSES.join(', ')}` });
  }
  if (delay_min === null) {
    return res.status(400).json({ error: 'delay_min must be a number between 0 and 240' });
  }

  const transitData = readJSON('transit_feeds.json');
  if (!transitData) return res.status(500).json({ error: 'Failed to read transit data' });

  const matchedLine = transitData.lines.find((l) => l.line === line);
  if (!matchedLine) {
    return res.status(404).json({ error: `Line '${line}' not found` });
  }

  matchedLine.status = status;
  matchedLine.delay_min = delay_min;
  localWriteJSON('transit_feeds.json', transitData);
  log('INFO', 'TRANSIT', `Line: ${line}, Status: ${status}, Delay: ${delay_min} mins`);
  broadcast({ type: 'TRANSIT_UPDATE', data: transitData });
  res.json({ success: true, data: transitData });
});

/** @route GET /api/reports - Retrieve all volunteer incident reports */
app.get('/api/reports', (req, res) => {
  res.json(readJSON('volunteer_reports.json'));
});

/** @route POST /api/reports - File a new on-ground volunteer incident report */
app.post('/api/reports', (req, res) => {
  const zone = sanitizeInput(req.body.zone);
  const issue_type = sanitizeInput(req.body.issue_type);
  const text_raw = sanitizeInput(req.body.text_raw);

  // Input validation
  const validIssueTypes = ['overflowing_bin', 'crowd_surge', 'accessibility_blocked', 'medical', 'other'];
  if (issue_type && !validIssueTypes.includes(issue_type)) {
    return res.status(400).json({ error: `issue_type must be one of: ${validIssueTypes.join(', ')}` });
  }

  const reports = readJSON('volunteer_reports.json') || [];

  const newReport = {
    report_id: `VR-${Math.floor(1000 + Math.random() * 9000)}`,
    volunteer_id: `V-${Math.floor(100 + Math.random() * 900)}`,
    zone: zone || 'General Area',
    issue_type: issue_type || 'other',
    text_raw: text_raw || 'No details provided',
    timestamp: new Date().toISOString(),
    status: 'open',
    assigned_volunteer: null,
  };

  reports.unshift(newReport);
  if (localWriteJSON('volunteer_reports.json', reports)) {
    log('INFO', 'REPORT', `New report registered: ${newReport.report_id} in ${newReport.zone}`);
    broadcast({ type: 'NEW_REPORT', data: newReport });
    res.json(newReport);
  } else {
    res.status(500).json({ error: 'Failed to save report' });
  }
});

/** @route POST /api/dispatch - Assign a volunteer to a specific incident report */
app.post('/api/dispatch', (req, res) => {
  const report_id = sanitizeInput(req.body.report_id);

  // Input validation
  if (!report_id) {
    return res.status(400).json({ error: 'report_id is required' });
  }

  const reports = readJSON('volunteer_reports.json');
  if (!reports) return res.status(500).json({ error: 'Failed to read reports' });

  const report = reports.find((r) => r.report_id === report_id);
  if (!report) return res.status(404).json({ error: `Report '${report_id}' not found` });

  const volunteers = ['Dave (Section 104)', 'Maria (Gate A2)', 'Carlos (Transit Hub)', 'Alex (Section 118)'];
  const assigned = volunteers[Math.floor(Math.random() * volunteers.length)];

  report.status = 'dispatched';
  report.assigned_volunteer = assigned;

  if (localWriteJSON('volunteer_reports.json', reports)) {
    log('INFO', 'DISPATCH', `Report ${report_id} assigned to ${assigned}`);
    broadcast({ type: 'DISPATCH_VOLUNTEER', data: report });
    res.json({ success: true, data: report });
  } else {
    res.status(500).json({ error: 'Failed to save dispatch' });
  }
});

/** @route POST /api/reset - Reset all data stores to baseline defaults */
app.post('/api/reset', (req, res) => {
  const defaultSensors = {
    stadium_id: 'sofi_stadium',
    timestamp: new Date().toISOString(),
    gates: [
      { gate_id: 'A1', capacity: 4000, current_count: 1200, congestion_level: 'low', avg_wait_min: 3 },
      { gate_id: 'A2', capacity: 4000, current_count: 1100, congestion_level: 'low', avg_wait_min: 3 },
      { gate_id: 'B1', capacity: 3500, current_count: 1500, congestion_level: 'low', avg_wait_min: 4 },
    ],
  };

  const defaultReports = [
    {
      report_id: 'VR-1042',
      volunteer_id: 'V-118',
      zone: 'North Concourse',
      issue_type: 'overflowing_bin',
      text_raw: 'Bins near section 118 are overflowing, getting messy',
      timestamp: new Date().toISOString(),
      status: 'open',
      assigned_volunteer: null,
    },
  ];

  const defaultTransit = {
    city: 'Inglewood, CA',
    lines: [
      { line: 'K Line', status: 'on_time', delay_min: 0, next_departure: '21:26' },
      { line: 'Shuttle Bus 3', status: 'on_time', next_departure: '21:18' },
    ],
  };

  localWriteJSON('gate_sensors.json', defaultSensors);
  localWriteJSON('volunteer_reports.json', defaultReports);
  localWriteJSON('transit_feeds.json', defaultTransit);

  log('INFO', 'RESET', 'Data reset to baseline settings');
  broadcast({
    type: 'RESET_SYSTEM',
    data: { sensors: defaultSensors, reports: defaultReports, transit: defaultTransit },
  });
  res.json({ success: true });
});

/** @route POST /api/broadcast - Send an emergency broadcast to all connected fans */
app.post('/api/broadcast', (req, res) => {
  const message = sanitizeInput(req.body.message);
  if (!message) return res.status(400).json({ error: 'message is required' });
  log('WARN', 'BROADCAST', `Emergency: "${message}"`);
  broadcast({ type: 'EMERGENCY_BROADCAST', data: { message, timestamp: new Date().toISOString() } });
  res.json({ success: true });
});

/** @route POST /api/chat/:persona - AI Agent Chat Integration router */
app.post('/api/chat/:persona', async (req, res) => {
  const persona = sanitizeInput(req.params.persona); // 'fan' or 'command'
  const message = sanitizeInput(req.body.message);
  const history = req.body.history;
  const userApiKey = req.body.userApiKey; // Keep API Key raw, never leak or mutate
  const current_location = req.body.current_location;
  const accessibility_enabled = Boolean(req.body.accessibility_enabled);

  if (!VALID_PERSONAS.includes(persona)) {
    return res.status(404).json({ error: `Persona '${persona}' is not supported` });
  }
  if (!message || message.length > MAX_CHAT_MESSAGE_LENGTH) {
    return res
      .status(400)
      .json({ error: `message is required and must be ${MAX_CHAT_MESSAGE_LENGTH} characters or fewer` });
  }

  const activeKey = userApiKey || process.env.GEMINI_API_KEY;
  const sanitizedHistory = sanitizeChatHistory(history);
  if (!sanitizedHistory) {
    return res.status(400).json({ error: `history must be an array with at most ${MAX_CHAT_HISTORY_ITEMS} items` });
  }

  log('INFO', 'API', `Chat Request | Persona: ${persona} | Key present: ${!!activeKey}`);

  if (activeKey) {
    try {
      const responseText = await runGeminiAgent(
        persona,
        message,
        sanitizedHistory,
        activeKey,
        current_location,
        accessibility_enabled
      );
      return res.json({ text: responseText, mode: 'gemini' });
    } catch (err) {
      log('ERROR', 'API', `Gemini API Error: ${err.message}. Falling back.`);
    }
  }

  // FALLBACK MOCK-AGENT
  const fallbackResponse = await runFallbackMockAgent(persona, message, current_location, accessibility_enabled);
  res.json({ text: fallbackResponse, mode: 'fallback-agent' });
});

// ─── 404 Not Found Handler ──────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.originalUrl,
    method: req.method,
  });
});

// ─── Global Error Handler ────────────────────────────────────────────────────
// Catches any unhandled errors thrown in route handlers via next(err)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  log('ERROR', 'SYSTEM', `Unhandled server error: ${err.message}`);
  const status = err.status || 500;
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : err.message,
  });
});

// Start Server
if (require.main === module) {
  server.listen(PORT, () => {
    console.log('=======================================================');
    console.log(' Nexus26 - World Cup Operations Spine Server');
    console.log(` Running on: http://localhost:${PORT}`);
    console.log(` WebSocket Spine: ws://localhost:${PORT}`);
    console.log('=======================================================');
  });
}

module.exports = { app, server };
