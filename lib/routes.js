/**
 * @fileoverview Nexus26 — Express REST API Route Handlers
 * @description Defines all REST API endpoints for sensor updates, transit feeds,
 *   volunteer report management, dispatch operations, system reset, emergency
 *   broadcasts, health checks, sustainability metrics, and AI chat integration.
 * @module lib/routes
 * @version 1.0.0
 */

'use strict';

const express = require('express');
const { log } = require('./logger');
const { sanitizeInput } = require('./sanitizer');
const { readJSON, writeJSON } = require('./database');
const { parseBoundedNumber, sanitizeChatHistory } = require('./validators');
const { runGeminiAgent, runFallbackMockAgent } = require('./ai');
const {
  VALID_PERSONAS,
  VALID_TRANSIT_STATUSES,
  VALID_CONGESTION_LEVELS,
  VALID_ISSUE_TYPES,
  MAX_CHAT_MESSAGE_LENGTH,
  MAX_CHAT_HISTORY_ITEMS,
  MAX_GATE_COUNT,
  MAX_WAIT_MINUTES,
  VOLUNTEER_POOL,
  DEFAULT_SENSOR_DATA,
  DEFAULT_REPORTS,
  DEFAULT_TRANSIT_DATA,
  APP_VERSION,
} = require('./constants');

const router = express.Router();

/** @type {Function} WebSocket broadcast function, set via initRoutes */
let broadcastFn = () => {};

/** @type {string} Application base directory, set via initRoutes */
let appBaseDir = __dirname;

/**
 * Initializes the routes module with runtime dependencies.
 * @param {Function} broadcast - WebSocket broadcast callback
 * @param {string} baseDir - Application base directory
 */
const initRoutes = (broadcast, baseDir) => {
  if (typeof broadcast === 'function') {
    broadcastFn = broadcast;
  }
  if (baseDir) {
    appBaseDir = baseDir;
  }
};

/**
 * Local wrapper for writeJSON passing the current base directory.
 * @param {string} fileName - Target data file name
 * @param {Object} data - Data to write
 * @returns {boolean} True if the write succeeded
 */
const localWriteJSON = (fileName, data) => writeJSON(fileName, data, appBaseDir);

// ─── Health & Status ────────────────────────────────────────────────────────

/** @route GET /api/health - Application health check and system status */
router.get('/api/health', (req, res) => {
  const sensorData = readJSON('gate_sensors.json');
  const reports = readJSON('volunteer_reports.json') || [];
  const transitData = readJSON('transit_feeds.json');

  const openReports = reports.filter((r) => r.status === 'open').length;
  const avgWait = sensorData && sensorData.gates
    ? (sensorData.gates.reduce((sum, g) => sum + g.avg_wait_min, 0) / sensorData.gates.length).toFixed(1)
    : 0;

  res.json({
    status: 'operational',
    version: APP_VERSION,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    subsystems: {
      database: sensorData ? 'healthy' : 'degraded',
      transit: transitData ? 'healthy' : 'degraded',
      websocket: 'active',
    },
    metrics: {
      open_incidents: openReports,
      avg_gate_wait_min: Number(avgWait),
      total_gates: sensorData ? sensorData.gates.length : 0,
    },
  });
});

/** @route GET /api/sustainability - Stadium sustainability and waste metrics */
router.get('/api/sustainability', (req, res) => {
  const reports = readJSON('volunteer_reports.json') || [];

  const wasteReports = reports.filter((r) => r.issue_type === 'overflowing_bin');
  const openWaste = wasteReports.filter((r) => r.status === 'open');
  const resolvedWaste = wasteReports.filter((r) => r.status === 'dispatched');

  const zoneBreakdown = {};
  wasteReports.forEach((r) => {
    zoneBreakdown[r.zone] = (zoneBreakdown[r.zone] || 0) + 1;
  });

  res.json({
    timestamp: new Date().toISOString(),
    waste_management: {
      total_reports: wasteReports.length,
      open: openWaste.length,
      dispatched: resolvedWaste.length,
      response_rate: wasteReports.length > 0
        ? `${Math.round((resolvedWaste.length / wasteReports.length) * 100)}%`
        : '100%',
      zone_breakdown: zoneBreakdown,
    },
    sustainability_score: openWaste.length === 0 ? 'excellent' : openWaste.length <= 2 ? 'good' : 'needs_attention',
  });
});

// ─── Sensors Endpoints ──────────────────────────────────────────────────────

/** @route GET /api/sensors - Retrieve live gate congestion sensor data */
router.get('/api/sensors', (req, res) => {
  res.json(readJSON('gate_sensors.json'));
});

/** @route POST /api/sensors/update - Update gate congestion level and crowd count */
router.post('/api/sensors/update', (req, res) => {
  const gate_id = sanitizeInput(req.body.gate_id);
  const congestion_level = sanitizeInput(req.body.congestion_level);
  const current_count = parseBoundedNumber(req.body.current_count, 0, MAX_GATE_COUNT);
  const avg_wait_min = parseBoundedNumber(req.body.avg_wait_min, 0, MAX_WAIT_MINUTES);

  if (!gate_id) {
    return res.status(400).json({ error: 'gate_id is required' });
  }
  if (congestion_level && !VALID_CONGESTION_LEVELS.includes(congestion_level)) {
    return res.status(400).json({ error: `congestion_level must be one of: ${VALID_CONGESTION_LEVELS.join(', ')}` });
  }
  if (current_count === null) {
    return res.status(400).json({ error: 'current_count must be a number between 0 and 100000' });
  }
  if (avg_wait_min === null) {
    return res.status(400).json({ error: 'avg_wait_min must be a number between 0 and 240' });
  }

  const sensorData = readJSON('gate_sensors.json');
  if (!sensorData) {
    return res.status(500).json({ error: 'Failed to read sensor data' });
  }

  const gate = sensorData.gates.find((g) => g.gate_id === gate_id);
  if (!gate) {
    return res.status(404).json({ error: `Gate '${gate_id}' not found` });
  }

  if (congestion_level) {
    gate.congestion_level = congestion_level;
  }
  if (current_count !== undefined) {
    gate.current_count = Number(current_count);
  }
  if (avg_wait_min !== undefined) {
    gate.avg_wait_min = Number(avg_wait_min);
  }
  sensorData.timestamp = new Date().toISOString();

  if (localWriteJSON('gate_sensors.json', sensorData)) {
    log('INFO', 'SENSOR', `Gate ${gate_id} updated to ${congestion_level}`);
    broadcastFn({ type: 'SENSOR_UPDATE', data: sensorData });
    return res.json({ success: true, data: sensorData });
  }
  return res.status(500).json({ error: 'Failed to save sensor data' });
});

// ─── Transit Endpoints ──────────────────────────────────────────────────────

/** @route GET /api/transit - Retrieve live transit line schedule and delays */
router.get('/api/transit', (req, res) => {
  res.json(readJSON('transit_feeds.json'));
});

/** @route POST /api/transit/update - Update a transit line's delay status */
router.post('/api/transit/update', (req, res) => {
  const line = sanitizeInput(req.body.line);
  const status = sanitizeInput(req.body.status);
  const delay_min = parseBoundedNumber(req.body.delay_min, 0, MAX_WAIT_MINUTES);

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
  if (!transitData) {
    return res.status(500).json({ error: 'Failed to read transit data' });
  }

  const matchedLine = transitData.lines.find((l) => l.line === line);
  if (!matchedLine) {
    return res.status(404).json({ error: `Line '${line}' not found` });
  }

  matchedLine.status = status;
  matchedLine.delay_min = delay_min;
  localWriteJSON('transit_feeds.json', transitData);
  log('INFO', 'TRANSIT', `Line: ${line}, Status: ${status}, Delay: ${delay_min} mins`);
  broadcastFn({ type: 'TRANSIT_UPDATE', data: transitData });
  return res.json({ success: true, data: transitData });
});

// ─── Reports Endpoints ──────────────────────────────────────────────────────

/** @route GET /api/reports - Retrieve all volunteer incident reports */
router.get('/api/reports', (req, res) => {
  res.json(readJSON('volunteer_reports.json'));
});

/** @route POST /api/reports - File a new on-ground volunteer incident report */
router.post('/api/reports', (req, res) => {
  const zone = sanitizeInput(req.body.zone);
  const issue_type = sanitizeInput(req.body.issue_type);
  const text_raw = sanitizeInput(req.body.text_raw);

  if (issue_type && !VALID_ISSUE_TYPES.includes(issue_type)) {
    return res.status(400).json({ error: `issue_type must be one of: ${VALID_ISSUE_TYPES.join(', ')}` });
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
    broadcastFn({ type: 'NEW_REPORT', data: newReport });
    return res.json(newReport);
  }
  return res.status(500).json({ error: 'Failed to save report' });
});

// ─── Dispatch Endpoints ─────────────────────────────────────────────────────

/** @route POST /api/dispatch - Assign a volunteer to a specific incident report */
router.post('/api/dispatch', (req, res) => {
  const report_id = sanitizeInput(req.body.report_id);

  if (!report_id) {
    return res.status(400).json({ error: 'report_id is required' });
  }

  const reports = readJSON('volunteer_reports.json');
  if (!reports) {
    return res.status(500).json({ error: 'Failed to read reports' });
  }

  const report = reports.find((r) => r.report_id === report_id);
  if (!report) {
    return res.status(404).json({ error: `Report '${report_id}' not found` });
  }

  const assigned = VOLUNTEER_POOL[Math.floor(Math.random() * VOLUNTEER_POOL.length)];
  report.status = 'dispatched';
  report.assigned_volunteer = assigned;

  if (localWriteJSON('volunteer_reports.json', reports)) {
    log('INFO', 'DISPATCH', `Report ${report_id} assigned to ${assigned}`);
    broadcastFn({ type: 'DISPATCH_VOLUNTEER', data: report });
    return res.json({ success: true, data: report });
  }
  return res.status(500).json({ error: 'Failed to save dispatch' });
});

// ─── System Control Endpoints ───────────────────────────────────────────────

/** @route POST /api/reset - Reset all data stores to baseline defaults */
router.post('/api/reset', (req, res) => {
  const defaultSensors = {
    ...DEFAULT_SENSOR_DATA,
    timestamp: new Date().toISOString(),
  };

  const defaultReports = DEFAULT_REPORTS.map((r) => ({
    ...r,
    timestamp: new Date().toISOString(),
  }));

  const defaultTransit = { ...DEFAULT_TRANSIT_DATA };

  localWriteJSON('gate_sensors.json', defaultSensors);
  localWriteJSON('volunteer_reports.json', defaultReports);
  localWriteJSON('transit_feeds.json', defaultTransit);

  log('INFO', 'RESET', 'Data reset to baseline settings');
  broadcastFn({
    type: 'RESET_SYSTEM',
    data: { sensors: defaultSensors, reports: defaultReports, transit: defaultTransit },
  });
  res.json({ success: true });
});

/** @route POST /api/broadcast - Send an emergency broadcast to all connected fans */
router.post('/api/broadcast', (req, res) => {
  const message = sanitizeInput(req.body.message);
  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }
  log('WARN', 'BROADCAST', `Emergency: "${message}"`);
  broadcastFn({ type: 'EMERGENCY_BROADCAST', data: { message, timestamp: new Date().toISOString() } });
  return res.json({ success: true });
});

// ─── AI Chat Endpoint ───────────────────────────────────────────────────────

/** @route POST /api/chat/:persona - AI Agent Chat Integration router */
router.post('/api/chat/:persona', async (req, res) => {
  const persona = sanitizeInput(req.params.persona);
  const message = sanitizeInput(req.body.message);
  const history = req.body.history;
  const userApiKey = req.body.userApiKey;
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
  return res.json({ text: fallbackResponse, mode: 'fallback-agent' });
});

module.exports = {
  router,
  initRoutes,
};
