/**
 * @fileoverview Nexus26 — Input Validation Utilities
 * @description Provides reusable validation helpers for numeric range parsing,
 *   chat history sanitization, and structural input checks used by route handlers.
 * @module lib/validators
 * @version 1.0.0
 */

'use strict';

const { sanitizeInput } = require('./sanitizer');
const { MAX_CHAT_HISTORY_ITEMS } = require('./constants');

/**
 * Converts a request body value to a finite number within an expected range.
 * Returns `undefined` when the value is absent, `null` when the value is
 * present but invalid, and the parsed number when it is valid.
 * @param {*} value - Raw request body value
 * @param {number} min - Inclusive minimum
 * @param {number} max - Inclusive maximum
 * @returns {number|null|undefined} Parsed number, null (invalid), or undefined (absent)
 */
const parseBoundedNumber = (value, min, max) => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < min || numberValue > max) {
    return null;
  }
  return numberValue;
};

/**
 * Normalizes and limits chat history supplied by the browser before it reaches
 * an AI provider or fallback agent. Sanitizes each entry's role and content
 * fields to prevent XSS injection through the conversation history channel.
 * @param {*} history - Raw request body history
 * @returns {Array<Object>|null} Sanitized history array, or null when the shape is invalid
 */
const sanitizeChatHistory = (history) => {
  if (history === undefined) {
    return [];
  }
  if (!Array.isArray(history) || history.length > MAX_CHAT_HISTORY_ITEMS) {
    return null;
  }
  return history.map((item) => ({
    role: sanitizeInput(item && item.role),
    content: sanitizeInput(item && item.content),
  }));
};

module.exports = {
  parseBoundedNumber,
  sanitizeChatHistory,
};
