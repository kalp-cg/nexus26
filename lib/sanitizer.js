/**
 * @fileoverview Nexus26 — Input Sanitization Utility
 * @description Provides XSS prevention by escaping dangerous HTML characters
 *   from all user-supplied input strings before storage or broadcast.
 * @module lib/sanitizer
 * @version 1.0.0
 */

'use strict';

/**
 * XSS Input Sanitizer — escapes dangerous HTML characters from user-supplied strings.
 * Applied to all POST body parameters before any database writes or broadcasts.
 * @param {*} val - The value to sanitize
 * @returns {string} Sanitized string safe for storage and display
 */
const sanitizeInput = (val) => {
  if (typeof val !== 'string') {return val;}
  return val
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
};

module.exports = { sanitizeInput };
