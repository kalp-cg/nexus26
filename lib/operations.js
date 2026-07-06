/**
 * @fileoverview Nexus26 — Local Venue Operations Handlers
 * @description Implements the business logic for gate congestion analysis,
 *   live transit schedules, accessibility routes, volunteer report logs, and
 *   dynamic crowd rerouting.
 * @module lib/operations
 * @version 1.0.0
 */

'use strict';

const { readJSON, writeJSON } = require('./database');

let broadcastFn = () => {};
let appBaseDir = __dirname;

/**
 * Initializes the operations module with necessary dependencies.
 * @param {Function} broadcast - WebSocket broadcast callback
 * @param {string} baseDir - Base application directory
 */
const initOperations = (broadcast, baseDir) => {
  if (typeof broadcast === 'function') {
    broadcastFn = broadcast;
  }
  if (baseDir) {
    appBaseDir = baseDir;
  }
};

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
const local_get_transit_status = async (_city) => {
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
    volunteer_id: 'V-AI',
    zone: zone || 'Unknown Concourse',
    issue_type: issue_type || 'other',
    text_raw: text_raw || 'Unspecified report',
    timestamp: new Date().toISOString(),
    status: 'open',
    assigned_volunteer: null
  };
  reports.unshift(newReport);
  writeJSON('volunteer_reports.json', reports, appBaseDir);
  broadcastFn({ type: 'NEW_REPORT', data: newReport });
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

  writeJSON('volunteer_reports.json', reports, appBaseDir);
  broadcastFn({ type: 'DISPATCH_VOLUNTEER', data: report });
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

  broadcastFn({ type: 'REROUTE_FAN', data: response });
  return response;
};

module.exports = {
  initOperations,
  local_check_gate_congestion,
  local_get_transit_status,
  local_get_accessible_route,
  local_log_volunteer_report,
  local_query_open_reports,
  local_dispatch_volunteer,
  local_generate_reroute
};
