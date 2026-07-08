/**
 * @fileoverview Nexus26 — Centralized Application Constants
 * @description Provides a single source of truth for configuration values,
 *   validation enums, rate-limit thresholds, and default data templates
 *   used across the server, routes, and validation modules.
 * @module lib/constants
 * @version 1.0.0
 */

'use strict';

/** @constant {number} PORT - Server listening port */
const PORT = process.env.PORT || 3000;

/** @constant {number} MAX_CHAT_MESSAGE_LENGTH - Max characters allowed in a single chat message */
const MAX_CHAT_MESSAGE_LENGTH = 1200;

/** @constant {number} MAX_CHAT_HISTORY_ITEMS - Max conversation history items per request */
const MAX_CHAT_HISTORY_ITEMS = 12;

/** @constant {string[]} VALID_PERSONAS - Supported AI chat personas */
const VALID_PERSONAS = ['fan', 'command'];

/** @constant {string[]} VALID_TRANSIT_STATUSES - Allowed transit line status values */
const VALID_TRANSIT_STATUSES = ['on_time', 'delayed', 'suspended', 'crowded'];

/** @constant {string[]} VALID_CONGESTION_LEVELS - Allowed gate congestion level values */
const VALID_CONGESTION_LEVELS = ['low', 'medium', 'high', 'critical'];

/** @constant {string[]} VALID_ISSUE_TYPES - Allowed volunteer report issue types */
const VALID_ISSUE_TYPES = ['overflowing_bin', 'crowd_surge', 'accessibility_blocked', 'medical', 'other'];

/** @constant {number} RATE_LIMIT_WINDOW_MS - Sliding window duration for rate limiting (ms) */
const RATE_LIMIT_WINDOW_MS = 60000;

/** @constant {number} RATE_LIMIT_MAX_REQUESTS - Max requests per IP per window */
const RATE_LIMIT_MAX_REQUESTS = 180;

/** @constant {number} RATE_LIMIT_CLEANUP_THRESHOLD - IP count before triggering stale entry cleanup */
const RATE_LIMIT_CLEANUP_THRESHOLD = 10000;

/** @constant {number} MAX_GATE_COUNT - Upper bound for gate current_count validation */
const MAX_GATE_COUNT = 100000;

/** @constant {number} MAX_WAIT_MINUTES - Upper bound for avg_wait_min / delay_min validation */
const MAX_WAIT_MINUTES = 240;

/** @constant {string} JSON_BODY_LIMIT - Express body-parser size limit */
const JSON_BODY_LIMIT = '100kb';

/** @constant {number} WS_HEARTBEAT_INTERVAL_MS - WebSocket heartbeat ping interval */
const WS_HEARTBEAT_INTERVAL_MS = 30000;

/** @constant {string[]} ALLOWED_ORIGINS - Whitelisted CORS origins */
const ALLOWED_ORIGINS = [
  'https://nexus26.onrender.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

/** @constant {string[]} VOLUNTEER_POOL - Available volunteer names for dispatch simulation */
const VOLUNTEER_POOL = [
  'Dave (Section 104)',
  'Maria (Gate A2)',
  'Carlos (Transit Hub)',
  'Alex (Section 118)',
];

/**
 * @constant {Object} DEFAULT_SENSOR_DATA - Baseline gate sensor state used on reset
 */
const DEFAULT_SENSOR_DATA = {
  stadium_id: 'sofi_stadium',
  gates: [
    { gate_id: 'A1', capacity: 4000, current_count: 1200, congestion_level: 'low', avg_wait_min: 3 },
    { gate_id: 'A2', capacity: 4000, current_count: 1100, congestion_level: 'low', avg_wait_min: 3 },
    { gate_id: 'B1', capacity: 3500, current_count: 1500, congestion_level: 'low', avg_wait_min: 4 },
  ],
};

/**
 * @constant {Array} DEFAULT_REPORTS - Baseline volunteer reports used on reset
 */
const DEFAULT_REPORTS = [
  {
    report_id: 'VR-1042',
    volunteer_id: 'V-118',
    zone: 'North Concourse',
    issue_type: 'overflowing_bin',
    text_raw: 'Bins near section 118 are overflowing, getting messy',
    status: 'open',
    assigned_volunteer: null,
  },
];

/**
 * @constant {Object} DEFAULT_TRANSIT_DATA - Baseline transit schedule used on reset
 */
const DEFAULT_TRANSIT_DATA = {
  city: 'Inglewood, CA',
  lines: [
    { line: 'K Line', status: 'on_time', delay_min: 0, next_departure: '21:26' },
    { line: 'Shuttle Bus 3', status: 'on_time', next_departure: '21:18' },
  ],
};

/** @constant {string} APP_VERSION - Current application version */
const APP_VERSION = '1.2.0';

module.exports = {
  PORT,
  MAX_CHAT_MESSAGE_LENGTH,
  MAX_CHAT_HISTORY_ITEMS,
  VALID_PERSONAS,
  VALID_TRANSIT_STATUSES,
  VALID_CONGESTION_LEVELS,
  VALID_ISSUE_TYPES,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_CLEANUP_THRESHOLD,
  MAX_GATE_COUNT,
  MAX_WAIT_MINUTES,
  JSON_BODY_LIMIT,
  WS_HEARTBEAT_INTERVAL_MS,
  ALLOWED_ORIGINS,
  VOLUNTEER_POOL,
  DEFAULT_SENSOR_DATA,
  DEFAULT_REPORTS,
  DEFAULT_TRANSIT_DATA,
  APP_VERSION,
};
