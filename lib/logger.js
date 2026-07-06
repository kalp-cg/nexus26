/**
 * @fileoverview Nexus26 — Structured Logger Utility
 * @description Provides a centralized, timestamped logging function with
 *   severity levels (INFO, WARN, ERROR) and module tagging for consistent
 *   log output across the entire application.
 * @module lib/logger
 * @version 1.0.0
 */

'use strict';

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

module.exports = { log };
