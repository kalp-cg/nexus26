/**
 * @fileoverview Nexus26 — Express Middleware Stack
 * @description Provides security headers, CORS enforcement, memory-based
 *   rate limiting, JSON body parsing with error handling, and static file
 *   serving as composable Express middleware functions.
 * @module lib/middleware
 * @version 1.0.0
 */

'use strict';

const express = require('express');
const path = require('path');
const { log } = require('./logger');
const {
  ALLOWED_ORIGINS,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_CLEANUP_THRESHOLD,
  JSON_BODY_LIMIT,
} = require('./constants');

/**
 * HTTP Security Headers Middleware.
 * Sets industry-standard headers to protect against XSS, clickjacking,
 * MIME-sniffing, information leakage, and code injection attacks.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const securityHeaders = (req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
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
};

/**
 * CORS Middleware — restricts cross-origin access to known safe origins.
 * Allows the Render deployment and localhost development origins only.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const corsMiddleware = (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  return next();
};

/**
 * Memory-based API Rate Limiter.
 * Limits each IP address to RATE_LIMIT_MAX_REQUESTS requests per
 * RATE_LIMIT_WINDOW_MS sliding window. Prevents denial-of-service
 * and brute-force abuse.
 * @returns {Function} Express middleware function
 */
const createRateLimiter = () => {
  const ipRequestCounts = {};

  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();

    if (!ipRequestCounts[ip]) {
      ipRequestCounts[ip] = [];
    }
    ipRequestCounts[ip] = ipRequestCounts[ip].filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

    if (ipRequestCounts[ip].length >= RATE_LIMIT_MAX_REQUESTS) {
      return res.status(429).json({
        error: 'Too many requests. Please try again in a moment.',
        retryAfter: 60,
      });
    }
    ipRequestCounts[ip].push(now);

    // Periodic cleanup of stale IP entries to prevent memory leak
    if (Object.keys(ipRequestCounts).length > RATE_LIMIT_CLEANUP_THRESHOLD) {
      const cutoff = now - RATE_LIMIT_WINDOW_MS * 2;
      Object.keys(ipRequestCounts).forEach((k) => {
        ipRequestCounts[k] = ipRequestCounts[k].filter((t) => t > cutoff);
        if (ipRequestCounts[k].length === 0) {
          delete ipRequestCounts[k];
        }
      });
    }
    return next();
  };
};

/**
 * JSON Syntax Error Handler.
 * Catches malformed JSON request bodies and returns a structured 400 error
 * instead of leaking stack traces to the client.
 * @param {Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const jsonErrorHandler = (err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Malformed JSON request body' });
  }
  return next(err);
};

/**
 * 404 Not Found Handler.
 * Catches all unmatched routes and returns a structured JSON error response.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const notFoundHandler = (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.originalUrl,
    method: req.method,
  });
};

/**
 * Global Error Handler.
 * Catches any unhandled errors thrown in route handlers via next(err).
 * Never leaks internal error details on 500 responses.
 * @param {Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
// eslint-disable-next-line no-unused-vars
const globalErrorHandler = (err, req, res, next) => {
  log('ERROR', 'SYSTEM', `Unhandled server error: ${err.message}`);
  const status = err.status || 500;
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : err.message,
  });
};

/**
 * Attaches all middleware to the given Express application in the correct order.
 * @param {import('express').Application} app - Express app instance
 * @param {string} baseDir - Application base directory for static file serving
 */
const attachMiddleware = (app, baseDir) => {
  app.use(securityHeaders);
  app.use(corsMiddleware);
  app.use(createRateLimiter());
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(jsonErrorHandler);
  app.use(express.static(path.join(baseDir, 'public')));
};

module.exports = {
  securityHeaders,
  corsMiddleware,
  createRateLimiter,
  jsonErrorHandler,
  notFoundHandler,
  globalErrorHandler,
  attachMiddleware,
};
