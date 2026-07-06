/**
 * @fileoverview Nexus26 - FIFA World Cup 2026 AI Operations Spine Server
 * @description Real-time WebSocket event bus connecting the Fan Companion and
 *   Command Center dashboards. Handles REST API data operations, Gemini AI
 *   function-calling integration, input sanitization, and security enforcement.
 * @version 2.5.0
 * @author Nexus26 Team
 */

'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { GoogleGenerativeAI } = require('@google/generative-ai');

dotenv.config();

/**
 * Structured Logger — prefixes all log output with ISO timestamp, severity, and module tag.
 * @param {'INFO'|'WARN'|'ERROR'} level - Severity level
 * @param {string} module - Module or subsystem originating the log
 * @param {string} message - Human-readable log content
 */
const log = (level, module, message) => {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level}] [${module}]`;
  if (level === 'ERROR') {
    console.error(`${prefix} ${message}`);
  } else if (level === 'WARN') {
    console.warn(`${prefix} ${message}`);
  } else {
    console.log(`${prefix} ${message}`);
  }
};

/**
 * Validates required environment variables on server startup.
 * Logs warnings for missing optional config and confirms runtime mode.
 */
const validateEnvironment = () => {
  const port = process.env.PORT || 3000;
  if (!process.env.GEMINI_API_KEY) {
    log('WARN', 'ENV', 'GEMINI_API_KEY not set — running in Fallback Mock-Agent mode');
  } else {
    log('INFO', 'ENV', 'GEMINI_API_KEY detected — Gemini function-calling enabled');
  }
  log('INFO', 'ENV', `PORT resolved to ${port}`);
};
validateEnvironment();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/** @constant {number|string} PORT - Server listening port from env or default 3000 */
const PORT = process.env.PORT || 3000;

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
  const allowedOrigins = [
    'https://nexus26.onrender.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ];
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
 * XSS Input Sanitizer — escapes dangerous HTML characters from user-supplied strings.
 * Applied to all POST body parameters before any database writes or broadcasts.
 * @param {*} val - The value to sanitize
 * @returns {string} Sanitized string safe for storage and display
 */
const sanitizeInput = (val) => {
  if (typeof val !== 'string') return val;
  return val
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
};

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
  ipRequestCounts[ip] = ipRequestCounts[ip].filter(t => now - t < 60000);
  if (ipRequestCounts[ip].length >= 180) {
    return res.status(429).json({
      error: 'Too many requests. Please try again in a moment.',
      retryAfter: 60
    });
  }
  ipRequestCounts[ip].push(now);
  next();
});

// Parse JSON bodies with a 100kb size limit to prevent large payload attacks
app.use(express.json({ limit: '100kb' }));

app.use(express.static(path.join(__dirname, 'public')));


// Whitelist of permitted JSON database files
const ALLOWED_FILES = [
  'gate_sensors.json',
  'volunteer_reports.json',
  'transit_feeds.json',
  'accessibility_routes.json',
  'stadium_map_coords.json'
];

// O(1) In-Memory DB cache
const dbCache = {};

// Load baseline JSONs into memory cache
ALLOWED_FILES.forEach(fileName => {
  try {
    const filePath = path.join(__dirname, 'data', fileName);
    const content = fs.readFileSync(filePath, 'utf8');
    dbCache[fileName] = JSON.parse(content);
  } catch (error) {
    console.error(`[DB Cache Seed Failed] ${fileName}:`, error);
    dbCache[fileName] = null;
  }
});

/**
 * Reads a JSON data file from the in-memory cache.
 * Protected against path traversal by ALLOWED_FILES whitelist.
 * @param {string} fileName - The filename to read (must be in ALLOWED_FILES)
 * @returns {Object|null} Parsed JSON object or null if not found / not permitted
 */
const readJSON = (fileName) => {
  if (!ALLOWED_FILES.includes(fileName)) {
    console.error(`[Security Warning] Blocked unauthorized read of: ${fileName}`);
    return null;
  }
  return dbCache[fileName];
};

/**
 * Writes a JSON data object to the in-memory cache and asynchronously persists to disk.
 * Protected against path traversal by ALLOWED_FILES whitelist.
 * @param {string} fileName - The target filename (must be in ALLOWED_FILES)
 * @param {Object} data - The data object to serialize and store
 * @returns {boolean} True if write succeeded, false if blocked
 */
const writeJSON = (fileName, data) => {
  if (!ALLOWED_FILES.includes(fileName)) {
    console.error(`[Security Warning] Blocked unauthorized write to: ${fileName}`);
    return false;
  }

  // Update in-memory cache instantly — O(1) read path
  dbCache[fileName] = data;

  // Non-blocking async disk persistence — prevents event loop stalls
  const filePath = path.join(__dirname, 'data', fileName);
  fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8', (err) => {
    if (err) {
      console.error(`[Async Disk Write Failed] ${fileName}:`, err);
    }
  });
  return true;
};

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

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  ws.send(JSON.stringify({ type: 'WELCOME', message: 'Connected to Nexus26 Live Spine' }));
  
  ws.on('close', () => {
    console.log('[WS] Client disconnected');
  });
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
  const current_count = req.body.current_count;
  const avg_wait_min = req.body.avg_wait_min;

  // Input validation
  if (!gate_id) {
    return res.status(400).json({ error: 'gate_id is required' });
  }
  const validLevels = ['low', 'medium', 'high', 'critical'];
  if (congestion_level && !validLevels.includes(congestion_level)) {
    return res.status(400).json({ error: `congestion_level must be one of: ${validLevels.join(', ')}` });
  }

  const sensorData = readJSON('gate_sensors.json');
  if (!sensorData) return res.status(500).json({ error: 'Failed to read sensor data' });

  const gate = sensorData.gates.find(g => g.gate_id === gate_id);
  if (!gate) return res.status(404).json({ error: `Gate '${gate_id}' not found` });

  if (congestion_level) gate.congestion_level = congestion_level;
  if (current_count !== undefined) gate.current_count = Number(current_count);
  if (avg_wait_min !== undefined) gate.avg_wait_min = Number(avg_wait_min);
  sensorData.timestamp = new Date().toISOString();

  if (writeJSON('gate_sensors.json', sensorData)) {
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
  const delay_min = Number(req.body.delay_min) || 0;

  // Input validation
  if (!line) {
    return res.status(400).json({ error: 'line is required' });
  }
  if (!status) {
    return res.status(400).json({ error: 'status is required' });
  }

  const transitData = readJSON('transit_feeds.json');
  if (!transitData) return res.status(500).json({ error: 'Failed to read transit data' });

  const matchedLine = transitData.lines.find(l => l.line === line);
  if (!matchedLine) {
    return res.status(404).json({ error: `Line '${line}' not found` });
  }

  matchedLine.status = status;
  matchedLine.delay_min = delay_min;
  writeJSON('transit_feeds.json', transitData);
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
    assigned_volunteer: null
  };

  reports.unshift(newReport);
  if (writeJSON('volunteer_reports.json', reports)) {
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

  const report = reports.find(r => r.report_id === report_id);
  if (!report) return res.status(404).json({ error: `Report '${report_id}' not found` });

  const volunteers = ['Dave (Section 104)', 'Maria (Gate A2)', 'Carlos (Transit Hub)', 'Alex (Section 118)'];
  const assigned = volunteers[Math.floor(Math.random() * volunteers.length)];

  report.status = 'dispatched';
  report.assigned_volunteer = assigned;

  if (writeJSON('volunteer_reports.json', reports)) {
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
      { gate_id: 'B1', capacity: 3500, current_count: 1500, congestion_level: 'low', avg_wait_min: 4 }
    ]
  };

  const defaultReports = [{
    report_id: 'VR-1042',
    volunteer_id: 'V-118',
    zone: 'North Concourse',
    issue_type: 'overflowing_bin',
    text_raw: 'Bins near section 118 are overflowing, getting messy',
    timestamp: new Date().toISOString(),
    status: 'open',
    assigned_volunteer: null
  }];

  const defaultTransit = {
    city: 'Inglewood, CA',
    lines: [
      { line: 'K Line', status: 'on_time', delay_min: 0, next_departure: '21:26' },
      { line: 'Shuttle Bus 3', status: 'on_time', next_departure: '21:18' }
    ]
  };

  writeJSON('gate_sensors.json', defaultSensors);
  writeJSON('volunteer_reports.json', defaultReports);
  writeJSON('transit_feeds.json', defaultTransit);

  log('INFO', 'RESET', 'Data reset to baseline settings');
  broadcast({ type: 'RESET_SYSTEM', data: { sensors: defaultSensors, reports: defaultReports, transit: defaultTransit } });
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

// ─── Gemini AI System Prompts ────────────────────────────────────────────────
const FAN_SYSTEM_PROMPT = `You are Nexus26, the official FIFA World Cup 2026 fan navigation assistant.

You help fans in their native language with: finding their seat/section, 
avoiding crowded gates, catching the right transit connection, and finding 
wheelchair-accessible or rideshare paths.

Rules:
1. Always call check_gate_congestion before recommending a route — never guess 
   congestion levels from memory.
2. If a fan's stated destination has a gate at "high" or "critical" congestion, 
   call generate_reroute with avoid_congestion_above set accordingly, and 
   explain the alternate path in one short, friendly sentence plus walking 
   time.
3. If a fan asks about transit, call get_transit_status before answering 
   with departure times.
4. If a fan mentions a wheelchair, stroller, or mobility need, call 
   get_accessible_route automatically without being asked twice.
5. Respond in the same language the fan used to speak or type to you. Keep 
   spoken responses under 3 sentences — they will be converted to audio.
6. Never invent gate numbers, wait times, or transit times that didn't come 
   from a tool call.
7. If systems are down or data is missing, say so plainly and suggest asking 
   a nearby staff member — do not fabricate reassurance.`;

const COMMAND_SYSTEM_PROMPT = `You are the Nexus26 Command Center Intelligence Agent, supporting venue 
operations staff during FIFA World Cup 2026 matches.

Your job is to turn natural-language staff questions into the correct tool 
calls and return concise, actionable answers — never vague summaries.

Rules:
1. For congestion questions ("which gates are backing up?"), call 
   check_gate_congestion across all gates and rank by severity.
2. For resource/waste/report questions ("which zones have overflowing bins?"), 
   call query_open_reports filtered appropriately.
3. If a staff member asks you to send help, call dispatch_volunteer with the 
   relevant report_id — confirm the assignment back to them in one sentence.
4. Always state your answer as: [severity/count] → [specific zone/gate] → 
   [recommended action]. Staff are triaging under time pressure; do not 
   editorialize or pad the response.
5. If a query spans both crowd and sustainability domains (e.g. "give me a 
   full status of the North Concourse"), call both check_gate_congestion and 
   query_open_reports and merge into one short brief.
6. Flag anything classified as "medical" or "crowd_surge" at the top of any 
   response, regardless of what was asked — safety signals are never buried.`;

// ─── Local Tool Functions (Gemini Function-Calling Handlers) ─────────────────

/**
 * Checks live gate congestion for one or all gates.
 * @param {string} stadium_id - Stadium identifier
 * @param {string} [gate_id] - Optional specific gate to query
 * @returns {Promise<Object|Array>} Single gate object or array of all gates
 */
const local_check_gate_congestion = async (stadium_id, gate_id) => {
  const data = readJSON('gate_sensors.json');
  if (!data) return { error: 'Data unavailable' };
  if (gate_id) {
    const gate = data.gates.find(g => g.gate_id.toLowerCase() === gate_id.toLowerCase());
    return gate || { error: `Gate ${gate_id} not found` };
  }
  return data.gates;
};

/**
 * Retrieves live transit schedule and delay data.
 * @param {string} city - City name for transit lookup
 * @returns {Promise<Object>} Transit feed object with lines array
 */
const local_get_transit_status = async (city) => {
  return readJSON('transit_feeds.json') || { error: 'Transit data unavailable' };
};

/**
 * Looks up wheelchair/accessibility route information for a specific gate.
 * @param {string} gate_id - Gate identifier to look up accessibility paths for
 * @returns {Promise<Object>} Accessibility route details or error
 */
const local_get_accessible_route = async (gate_id) => {
  const data = readJSON('accessibility_routes.json');
  if (!data) return { error: 'Accessibility data unavailable' };
  const route = data[gate_id];
  return route ? { gate_id, ...route } : { error: `No accessibility information for gate ${gate_id}` };
};

/**
 * Logs a new volunteer incident report from an AI-triggered action.
 * @param {string} zone - Location zone of the incident
 * @param {string} issue_type - Category of the issue
 * @param {string} text_raw - Detailed description text
 * @returns {Promise<Object>} The newly created report object
 */
const local_log_volunteer_report = async (zone, issue_type, text_raw) => {
  const reports = readJSON('volunteer_reports.json') || [];
  const newReport = {
    report_id: `VR-${Math.floor(1000 + Math.random() * 9000)}`,
    volunteer_id: `V-AI`,
    zone: zone || 'Unknown Concourse',
    issue_type: issue_type || 'other',
    text_raw: text_raw || 'Unspecified report',
    timestamp: new Date().toISOString(),
    status: 'open',
    assigned_volunteer: null
  };
  reports.unshift(newReport);
  writeJSON('volunteer_reports.json', reports);
  broadcast({ type: 'NEW_REPORT', data: newReport });
  return newReport;
};

/**
 * Queries volunteer reports filtered by issue type, zone, and status.
 * @param {string} [issue_type] - Filter by issue category
 * @param {string} [zone] - Filter by zone name (partial match)
 * @param {string} [status] - Filter by report status ('open', 'dispatched', 'all')
 * @returns {Promise<Array>} Filtered array of matching reports
 */
const local_query_open_reports = async (issue_type, zone, status) => {
  const reports = readJSON('volunteer_reports.json') || [];
  return reports.filter(r => {
    let match = true;
    if (issue_type && r.issue_type !== issue_type) match = false;
    if (zone && !r.zone.toLowerCase().includes(zone.toLowerCase())) match = false;
    if (status && status !== 'all' && r.status !== status) match = false;
    return match;
  });
};

/**
 * Dispatches a volunteer to handle a specific incident report.
 * @param {string} report_id - The report to assign a volunteer to
 * @param {string} [zone] - Override zone for assignment label
 * @returns {Promise<Object>} Updated report with assigned volunteer or error
 */
const local_dispatch_volunteer = async (report_id, zone) => {
  const reports = readJSON('volunteer_reports.json') || [];
  const report = reports.find(r => r.report_id === report_id);
  if (!report) return { error: `Report ${report_id} not found` };
  
  const names = ['Dave', 'Carlos', 'Sarah', 'Jessica', 'Amir'];
  const volunteer = names[Math.floor(Math.random() * names.length)];
  report.status = 'dispatched';
  report.assigned_volunteer = `${volunteer} (Area ${zone || report.zone})`;
  
  writeJSON('volunteer_reports.json', reports);
  broadcast({ type: 'DISPATCH_VOLUNTEER', data: report });
  return report;
};

/**
 * Generates an optimized walking route, rerouting around congested gates.
 * @param {string} stadium_id - Stadium identifier
 * @param {string|number} destination_section - Target seat section number
 * @param {Array<number>} [current_location_coords] - Fan's current [x, y] position
 * @param {string} [avoid_congestion_above] - Congestion threshold ('high' or 'critical')
 * @returns {Promise<Object>} Route with path coordinates, distance, duration, and instructions
 */
const local_generate_reroute = async (stadium_id, destination_section, current_location_coords, avoid_congestion_above) => {
  const mapCoords = readJSON('stadium_map_coords.json');
  const sensorData = readJSON('gate_sensors.json');
  if (!mapCoords || !sensorData) return { error: 'Map coordinates or sensor data unavailable' };

  // Map destination section to gates
  const section = String(destination_section);
  let originalGateId = 'A1'; // Default gate mapping
  if (['103', '104', '110'].includes(section)) {
    originalGateId = 'A2';
  } else if (['115', '118', '120'].includes(section)) {
    originalGateId = 'B1';
  }

  // Find gate congestion
  const checkGateCongestion = (gId) => sensorData.gates.find(g => g.gate_id === gId);
  const origGate = checkGateCongestion(originalGateId);
  
  let gateUsedId = originalGateId;
  let rerouted = false;
  
  const threshold = avoid_congestion_above || 'high';
  const isCongested = (g) => {
    if (!g) return false;
    if (threshold === 'high') {
      return g.congestion_level === 'high' || g.congestion_level === 'critical';
    }
    return g.congestion_level === 'critical';
  };

  // If congested, check for alternatives
  if (origGate && isCongested(origGate)) {
    const alternatives = ['A1', 'A2', 'B1'].filter(gId => gId !== originalGateId);
    for (const altId of alternatives) {
      const altGate = checkGateCongestion(altId);
      if (altGate && !isCongested(altGate)) {
        gateUsedId = altId;
        rerouted = true;
        break;
      }
    }
  }

  const gateCoords = mapCoords.gates[gateUsedId];
  const sectionCoords = mapCoords.sections[section] || mapCoords.sections['101'];
  
  // Format coordinate paths
  // Start from current_location (e.g. Transit center [200, 420] or Rideshare [380, 380])
  const startPt = current_location_coords || [200, 420];
  const path = [startPt, [gateCoords.x, gateCoords.y], [sectionCoords.x, sectionCoords.y]];
  
  const duration = rerouted ? 11 : 6;
  const distance = rerouted ? 850 : 450;
  
  const response = {
    stadium_id,
    destination_section: section,
    gate_used: gateUsedId,
    original_gate: originalGateId,
    rerouted,
    path,
    distance_meters: distance,
    duration_minutes: duration,
    instructions: rerouted 
      ? `Rerouted via ${gateUsedId} to avoid ${origGate.congestion_level} congestion at ${originalGateId}. Walking time is approx. ${duration} mins.`
      : `Route clear. Walk through ${gateUsedId} directly to Section ${section}. Walking time is approx. ${duration} mins.`
  };
  
  broadcast({ type: 'REROUTE_FAN', data: response });
  return response;
};

// GEMINI INTEGRATION & FALLBACK ROUTER
app.post('/api/chat/:persona', async (req, res) => {
  const persona = sanitizeInput(req.params.persona); // 'fan' or 'command'
  const message = sanitizeInput(req.body.message);
  const history = req.body.history;
  const userApiKey = req.body.userApiKey; // Keep API Key raw, never leak or mutate
  const current_location = req.body.current_location;
  const accessibility_enabled = req.body.accessibility_enabled;
  
  const activeKey = userApiKey || process.env.GEMINI_API_KEY;
  const sanitizedHistory = (history || []).map(h => ({
    role: sanitizeInput(h.role),
    content: sanitizeInput(h.content)
  }));

  console.log(`[Chat Request] Persona: ${persona} | Key present: ${!!activeKey} | Msg: "${message}"`);

  if (activeKey) {
    try {
      const responseText = await runGeminiAgent(persona, message, sanitizedHistory, activeKey, current_location, accessibility_enabled);
      return res.json({ text: responseText, mode: 'gemini' });
    } catch (err) {
      console.error('[Gemini API Error] Falling back to Mock-Agent:', err);
      // Fall through to fallback mock router
    }
  }

  // FALLBACK MOCK-AGENT
  const fallbackResponse = await runFallbackMockAgent(persona, message, current_location, accessibility_enabled);
  res.json({ text: fallbackResponse, mode: 'fallback-agent' });
});

// Run Gemini Chat Agent with Function Calling Loop
async function runGeminiAgent(persona, message, history, apiKey, currentLocation, accessibilityEnabled) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const sysPrompt = persona === 'fan' 
    ? FAN_SYSTEM_PROMPT + (accessibilityEnabled ? "\nNote: Fan has accessibility needs. Prioritize get_accessible_route." : "")
    : COMMAND_SYSTEM_PROMPT;

  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    systemInstruction: sysPrompt,
  });

  const tools = [{
    functionDeclarations: [
      {
        name: "check_gate_congestion",
        description: "Returns live congestion level, wait time, and capacity for one or all gates at SoFi Stadium.",
        parameters: {
          type: "OBJECT",
          properties: {
            stadium_id: { type: "STRING" },
            gate_id: { type: "STRING", description: "Optional. Omit to get all gates." }
          },
          required: ["stadium_id"]
        }
      },
      {
        name: "get_transit_status",
        description: "Returns live delay/status for transit lines serving a given stadium/city.",
        parameters: {
          type: "OBJECT",
          properties: {
            city: { type: "STRING" }
          },
          required: ["city"]
        }
      },
      {
        name: "generate_reroute",
        description: "Given a destination section and current location, returns walking coordinates and routing directions that avoid gates above a congestion threshold.",
        parameters: {
          type: "OBJECT",
          properties: {
            stadium_id: { type: "STRING" },
            destination_section: { type: "STRING" },
            current_location_coords: {
              type: "ARRAY",
              items: { type: "NUMBER" },
              description: "Array of two numbers [x, y]. Coordinates on stadium grid."
            },
            avoid_congestion_above: { type: "STRING", enum: ["high", "critical"] }
          },
          required: ["stadium_id", "destination_section", "current_location_coords"]
        }
      },
      {
        name: "get_accessible_route",
        description: "Returns wheelchair-accessible ramp and rideshare pickup coordinates nearest to a gate.",
        parameters: {
          type: "OBJECT",
          properties: {
            gate_id: { type: "STRING" }
          },
          required: ["gate_id"]
        }
      },
      {
        name: "log_volunteer_report",
        description: "Files a structured issue report from a volunteer's free-text input, classified by issue type and zone.",
        parameters: {
          type: "OBJECT",
          properties: {
            zone: { type: "STRING" },
            issue_type: {
              type: "STRING",
              enum: ["overflowing_bin", "crowd_surge", "medical", "accessibility_blocked", "other"]
            },
            text_raw: { type: "STRING" }
          },
          required: ["zone", "issue_type", "text_raw"]
        }
      },
      {
        name: "query_open_reports",
        description: "Lets Command Center staff ask questions about open reports, filtered by zone or issue type.",
        parameters: {
          type: "OBJECT",
          properties: {
            issue_type: { type: "STRING" },
            zone: { type: "STRING" },
            status: { type: "STRING", enum: ["open", "resolved", "all"] }
          }
        }
      },
      {
        name: "dispatch_volunteer",
        description: "Assigns the nearest available volunteer to an open report.",
        parameters: {
          type: "OBJECT",
          properties: {
            report_id: { type: "STRING" },
            zone: { type: "STRING" }
          },
          required: ["report_id"]
        }
      }
    ]
  }];

  // Filter history to ensure it starts with a 'user' message as required by Gemini
  const formattedHistory = [];
  let userSeen = false;
  for (const h of (history || [])) {
    if (h.role === 'user') userSeen = true;
    if (userSeen) {
      formattedHistory.push({
        role: h.role === 'assistant' ? 'model' : h.role,
        parts: [{ text: h.content }]
      });
    }
  }

  const chat = model.startChat({
    history: formattedHistory,
    generationConfig: { temperature: 0.1 },
    tools: tools
  });

  let result = await chat.sendMessage(message);
  let functionCalls = result.response.getFunctionCalls();
  let loops = 0;

  while (functionCalls && functionCalls.length > 0 && loops < 5) {
    loops++;
    const functionResponses = [];

    for (const call of functionCalls) {
      const name = call.name;
      const args = call.args;
      let toolResult;

      console.log(`[Gemini Tool] Executing: ${name}`, args);

      try {
        if (name === "check_gate_congestion") {
          toolResult = await local_check_gate_congestion(args.stadium_id, args.gate_id);
        } else if (name === "get_transit_status") {
          toolResult = await local_get_transit_status(args.city);
        } else if (name === "generate_reroute") {
          // If coords not supplied, inject a reasonable default based on fan context
          const coords = args.current_location_coords || currentLocation || [200, 420];
          toolResult = await local_generate_reroute(args.stadium_id, args.destination_section, coords, args.avoid_congestion_above);
        } else if (name === "get_accessible_route") {
          toolResult = await local_get_accessible_route(args.gate_id);
        } else if (name === "log_volunteer_report") {
          toolResult = await local_log_volunteer_report(args.zone, args.issue_type, args.text_raw);
        } else if (name === "query_open_reports") {
          toolResult = await local_query_open_reports(args.issue_type, args.zone, args.status);
        } else if (name === "dispatch_volunteer") {
          toolResult = await local_dispatch_volunteer(args.report_id, args.zone);
        } else {
          toolResult = { error: 'Unknown function' };
        }
      } catch (err) {
        console.error(`Tool execution error: ${name}`, err);
        toolResult = { error: err.message };
      }

      functionResponses.push({
        functionResponse: {
          name: name,
          response: { content: toolResult }
        }
      });
    }

    result = await chat.sendMessage(functionResponses);
    functionCalls = result.response.getFunctionCalls();
  }

  return result.response.text();
}

// Local Fallback Mock Agent with Rules Matching the Persona System Prompts
async function runFallbackMockAgent(persona, message, currentLocation, accessibilityEnabled) {
  const msgLower = message.toLowerCase();
  const location = currentLocation || [200, 420]; // Default transit center

  if (persona === 'fan') {
    // Detect Language
    const isSpanish = (msgLower.includes('como') || msgLower.includes('puerta') || msgLower.includes('seccion') || msgLower.includes('estadio') || msgLower.includes('congestion') || msgLower.includes('ayuda'));
    const isFrench = (msgLower.includes('comment') || msgLower.includes('porte') || msgLower.includes('section') || msgLower.includes('retard') || msgLower.includes('metro'));
    
    // Check for Wheelchair/Stroller Access
    if (accessibilityEnabled || msgLower.includes('wheelchair') || msgLower.includes('silla') || msgLower.includes('stroller') || msgLower.includes('ramp') || msgLower.includes('rampe')) {
      const dataA2 = await local_get_accessible_route('A2');
      if (isSpanish) {
        return `He verificado las rutas de accesibilidad. La Puerta A2 está equipada con una rampa accesible en las coordenadas [${dataA2.nearest_ramp_coords.join(', ')}] y la zona de transporte compartido está en las coordenadas [${dataA2.rideshare_zone_coords.join(', ')}].`;
      } else if (isFrench) {
        return `J'ai vérifié les voies d'accès. La Porte A2 est équipée d'une rampe accessible aux coordonnées [${dataA2.nearest_ramp_coords.join(', ')}] et la zone de covoiturage se trouve à [${dataA2.rideshare_zone_coords.join(', ')}].`;
      } else {
        return `Accessibility route verified. Gate A2 features a wheelchair ramp at coordinates [${dataA2.nearest_ramp_coords.join(', ')}] and the rideshare pick-up point is situated at [${dataA2.rideshare_zone_coords.join(', ')}].`;
      }
    }

    // Check for Transit
    if (msgLower.includes('transit') || msgLower.includes('train') || msgLower.includes('metro') || msgLower.includes('bus') || msgLower.includes('shuttle') || msgLower.includes('transporte')) {
      const status = await local_get_transit_status('Inglewood');
      const linesText = status.lines.map(l => `${l.line}: ${l.status === 'delayed' ? `Delayed by ${l.delay_min} mins` : 'On Time'} (Next: ${l.next_departure})`).join(', ');
      if (isSpanish) {
        return `Estado de tránsito en tiempo real para Inglewood: ${linesText.replace('Delayed', 'Retrasado').replace('On Time', 'A tiempo')}.`;
      } else if (isFrench) {
        return `État des transports en temps réel à Inglewood: ${linesText.replace('Delayed', 'Retardé').replace('On Time', 'À l\'heure')}.`;
      } else {
        return `Real-time transit feed for Inglewood: ${linesText}.`;
      }
    }

    // Check for Section Routing
    const sectionMatch = msgLower.match(/(?:section|sección|seccion)\s*(\d+)/);
    if (sectionMatch) {
      const section = sectionMatch[1];
      const routeInfo = await local_generate_reroute('sofi_stadium', section, location, 'high');
      
      // Let's fire a WebSocket command to update client route
      broadcast({ type: 'REROUTE_FAN', data: routeInfo });

      if (isSpanish) {
        return `${routeInfo.instructions.replace('Rerouted via', 'Redirigido por').replace('to avoid', 'para evitar').replace('congestion at', 'congestión en').replace('Walking time is approx.', 'El tiempo de caminata es aprox.')} (Sección ${section})`;
      } else if (isFrench) {
        return `${routeInfo.instructions.replace('Rerouted via', 'Redirigé via').replace('to avoid', 'pour éviter').replace('congestion at', 'encombrement à').replace('Walking time is approx.', 'Le temps de marche est d\'environ')} (Section ${section})`;
      } else {
        return `${routeInfo.instructions}`;
      }
    }

    // Conversational Intents for Fallback Agent
    if (msgLower.includes('hello') || msgLower.includes('hi') || msgLower.includes('hey') || msgLower.includes('hola') || msgLower.includes('bonjour')) {
      if (isSpanish) {
        return `¡Hola! Soy tu asistente de estadio Nexus26. ¿A qué sección vas hoy o qué información de transporte necesitas?`;
      } else if (isFrench) {
        return `Bonjour! Je suis Nexus26, votre compagnon de stade. Quelle section ou porte cherchez-vous?`;
      } else {
        return `Hello! I am Nexus26, your stadium operations companion. Which seat section or gate are you looking for?`;
      }
    }
    
    if (msgLower.includes('food') || msgLower.includes('drink') || msgLower.includes('concession') || msgLower.includes('hungry') || msgLower.includes('restroom') || msgLower.includes('baño') || msgLower.includes('comida')) {
      if (isSpanish) {
        return `Las concesiones de comida y los baños están disponibles en todos los niveles principales. El punto de comida más cercano está cerca de la Sección 102 (cerca de la entrada de la Puerta A1).`;
      } else if (isFrench) {
        return `Des concessions alimentaires et des toilettes sont situées à tous les niveaux. Le stand de nourriture le plus proche se trouve à côté de la Section 102.`;
      } else {
        return `Concessions, snacks, and restrooms are situated on all main stadium levels. The nearest beverage station is adjacent to Section 102.`;
      }
    }

    if (msgLower.includes('exit') || msgLower.includes('leave') || msgLower.includes('salida') || msgLower.includes('salir') || msgLower.includes('sortir')) {
      if (isSpanish) {
        return `Las salidas principales del estadio están ubicadas en las Puertas A1, A2 y B1. Consulta la ruta en el mapa para dirigirte a la salida más conveniente.`;
      } else if (isFrench) {
        return `Les sorties principales du stade sont situées aux Portes A1, A2 et B1. Veuillez consulter la carte pour l'itinéraire de sortie le plus proche.`;
      } else {
        return `Main stadium exits are located at Gate A1, Gate A2, and Gate B1. Check your map coordinates for the closest exit route from your section.`;
      }
    }

    if (msgLower.includes('thank') || msgLower.includes('gracias') || msgLower.includes('merci') || msgLower.includes('danke')) {
      if (isSpanish) {
        return `¡De nada! Disfruta del partido y avísame si necesitas algo más.`;
      } else if (isFrench) {
        return `De rien! Bon match et n'hésitez pas si vous avez d'autres questions!`;
      } else {
        return `You are very welcome! Have a safe match day and let me know if you need anything else!`;
      }
    }

    // Check for capabilities query
    if (msgLower.includes('what') && (msgLower.includes('do') || msgLower.includes('can') || msgLower.includes('help') || msgLower.includes('feature') || msgLower.includes('service') || msgLower.includes('capability'))) {
      if (isSpanish) {
        return `Puedo ayudarte a: 1. Navegar a cualquier sección (ej. 'Ir a la Sección 102') | 2. Ver retrasos de metro (ej. '¿El metro está retrasado?') | 3. Encontrar rampas accesibles (ej. 'Rampa de silla de ruedas') | 4. Ubicar puestos de comida.`;
      } else {
        return `I can help you: 1. Navigate to seat sections (e.g. 'Route to Section 102') | 2. Check live transit schedules ('Is the subway delayed?') | 3. Find accessibility ramps ('Wheelchair ramp') | 4. Locate concessions and exits.`;
      }
    }

    // Check for match details
    if (msgLower.includes('match') || msgLower.includes('game') || msgLower.includes('who') || msgLower.includes('play') || msgLower.includes('stadium') || msgLower.includes('partido') || msgLower.includes('juego') || msgLower.includes('equipo')) {
      if (isSpanish) {
        return `El partido de hoy es USA contra México en el Estadio SoFi. El inicio es a las 20:00.`;
      } else {
        return `Today's match is USA vs. Mexico here at SoFi Stadium. Kickoff is scheduled for 20:00 local time.`;
      }
    }

    if (isSpanish) {
      return `Modo de contingencia Nexus26. Intenta escribir una de estas opciones: \n1. 'Ir a la Sección 102' (Navegación)\n2. 'Estado del metro' (Transporte)\n3. 'Rampa de silla de ruedas' (Accesibilidad)\n4. '¿Dónde hay comida?' (Servicios)`;
    } else {
      return `Nexus26 Offline Contingency Mode. Try typing one of these exact queries to test features:\n1. 'Route to Section 102' (Plotted maps)\n2. 'Is the subway delayed?' (Transit logs)\n3. 'Wheelchair access ramp' (Accessibility path)\n4. 'Where is the food?' (Concession guidelines)`;
    }
  }

  // COMMAND CENTER PERSONA MOCK AGENT
  // State answer format: [severity/count] → [specific zone/gate] → [recommended action]
  if (persona === 'command') {
    // 1. Congestion Questions
    if (msgLower.includes('congestion') || msgLower.includes('gate') || msgLower.includes('back') || msgLower.includes('crowd')) {
      const gates = await local_check_gate_congestion('sofi_stadium');
      const criticalGates = gates.filter(g => g.congestion_level === 'critical');
      const highGates = gates.filter(g => g.congestion_level === 'high');

      if (criticalGates.length > 0) {
        return `CRITICAL → Gate ${criticalGates[0].gate_id} is reporting ${criticalGates[0].current_count} count (${criticalGates[0].avg_wait_min}m wait) → Recommended Action: Immediately trigger fan rerouting to Gate A2 and hold subway bus departures.`;
      } else if (highGates.length > 0) {
        return `HIGH → Gate ${highGates[0].gate_id} shows ${highGates[0].current_count} count (${highGates[0].avg_wait_min}m wait) → Recommended Action: Monitor gate queue closely; prepare to direct volunteers to assist crowd flow.`;
      } else {
        return `NORMAL → All gates showing low congestion (average wait < 4 mins) → Recommended Action: Maintain current staffing configurations.`;
      }
    }

    // 2. Resource/Bin Reports
    if (msgLower.includes('bin') || msgLower.includes('trash') || msgLower.includes('overflow') || msgLower.includes('waste') || msgLower.includes('report') || msgLower.includes('alert')) {
      const reports = await local_query_open_reports(null, null, 'open');
      const binReports = reports.filter(r => r.issue_type === 'overflowing_bin');
      const surgeReports = reports.filter(r => r.issue_type === 'crowd_surge');

      if (surgeReports.length > 0) {
        return `CRITICAL → Crowd surge reported in ${surgeReports[0].zone} (${surgeReports[0].text_raw}) → Recommended Action: Dispatch security team and nearest supervisor immediately.`;
      } else if (binReports.length > 0) {
        return `ATTENTION → ${binReports.length} overflowing bin reports in ${binReports[0].zone} → Recommended Action: Dispatch sanitation crew using ID ${binReports[0].report_id} to clean the area.`;
      } else if (reports.length > 0) {
        return `WARNING → ${reports.length} pending operations reports in ${reports[0].zone} → Recommended Action: Review report ${reports[0].report_id} and dispatch volunteer.`;
      } else {
        return `STABLE → 0 open operation reports on the logs → Recommended Action: No dispatch actions required.`;
      }
    }

    // 3. Dispatch Volunteer
    const hasDispatchWord = msgLower.includes('dispatch') || msgLower.includes('send') || msgLower.includes('assign');
    const idMatch = msgLower.match(/(vr-\d+)/i);
    if (hasDispatchWord && idMatch) {
      const repId = idMatch[1].toUpperCase();
      const res = await local_dispatch_volunteer(repId, 'General Zone');
      if (res.error) {
        return `ERROR → Dispatch failed → Action: Report ID ${repId} not found in database.`;
      }
      return `DISPATCHED → Report ${repId} assigned to ${res.assigned_volunteer} → Action: Volunteer en route; tracking status.`;
    }

    return `COMMAND CORE → Nexus26 Active. Provide query:\n- Ask: "Which gates are backing up?"\n- Ask: "Which zones have overflowing bins?"\n- Command: "Dispatch volunteer to VR-1042"`;
  }

  return `System active. Configured for ${persona}.`;
}

// ─── 404 Not Found Handler ──────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.originalUrl,
    method: req.method
  });
});

// ─── Global Error Handler ────────────────────────────────────────────────────
// Catches any unhandled errors thrown in route handlers via next(err)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[Unhandled Server Error]', err);
  const status = err.status || 500;
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : err.message
  });
});

// Start Server
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(` Nexus26 - World Cup Operations Spine Server`);
    console.log(` Running on: http://localhost:${PORT}`);
    console.log(` WebSocket Spine: ws://localhost:${PORT}`);
    console.log(`=======================================================`);
  });
}

module.exports = { app, server };
