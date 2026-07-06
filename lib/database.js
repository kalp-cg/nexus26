/**
 * @fileoverview Nexus26 — Memory-Cached Database Manager
 * @description Manages baseline data loading, in-memory caching (O(1) read latency),
 *   security-enforced path traversal prevention, and non-blocking asynchronous file writes.
 * @module lib/database
 * @version 1.0.0
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

// Whitelist of permitted JSON database and compliance files
const ALLOWED_FILES = [
  'gate_sensors.json',
  'volunteer_reports.json',
  'transit_feeds.json',
  'accessibility_routes.json',
  'stadium_map_coords.json',
  'fifa_compliance_manual.md'
];

// O(1) In-Memory DB cache
const dbCache = {};

/**
 * Initializes the database cache by loading all baseline files.
 * @param {string} baseDir - Directory path containing the data files
 */
const initDatabase = (baseDir) => {
  ALLOWED_FILES.forEach(fileName => {
    try {
      const filePath = path.join(baseDir, 'data', fileName);
      const content = fs.readFileSync(filePath, 'utf8');
      if (fileName.endsWith('.json')) {
        dbCache[fileName] = JSON.parse(content);
      } else {
        dbCache[fileName] = content;
      }
    } catch (error) {
      log('ERROR', 'DB', `Cache seed failed for ${fileName}: ${error.message}`);
      dbCache[fileName] = null;
    }
  });
};

/**
 * Reads a JSON or Markdown file from the in-memory cache.
 * Protected against path traversal by ALLOWED_FILES whitelist.
 * @param {string} fileName - The filename to read (must be in ALLOWED_FILES)
 * @returns {Object|string|null} Cached contents or null if not found / not permitted
 */
const readJSON = (fileName) => {
  if (!ALLOWED_FILES.includes(fileName)) {
    log('WARN', 'SECURITY', `Blocked unauthorized read of: ${fileName}`);
    return null;
  }
  return dbCache[fileName];
};

/**
 * Writes a JSON data object to the in-memory cache and asynchronously persists to disk.
 * Protected against path traversal by ALLOWED_FILES whitelist.
 * @param {string} fileName - The target filename (must be in ALLOWED_FILES)
 * @param {Object} data - The data object to serialize and store
 * @param {string} baseDir - Base directory path
 * @returns {boolean} True if write succeeded, false if blocked
 */
const writeJSON = (fileName, data, baseDir) => {
  if (!ALLOWED_FILES.includes(fileName)) {
    log('WARN', 'SECURITY', `Blocked unauthorized write to: ${fileName}`);
    return false;
  }

  // Update in-memory cache instantly — O(1) read path
  dbCache[fileName] = data;

  // Non-blocking async disk persistence — prevents event loop stalls
  const filePath = path.join(baseDir, 'data', fileName);
  fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8', (err) => {
    if (err) {
      log('ERROR', 'DB', `Async disk write failed for ${fileName}: ${err.message}`);
    }
  });
  return true;
};

module.exports = {
  initDatabase,
  readJSON,
  writeJSON,
  ALLOWED_FILES
};
