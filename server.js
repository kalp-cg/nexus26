/**
 * @fileoverview Nexus26 — FIFA World Cup 2026 AI Operations Spine Server
 * @description Application entry point that orchestrates the Express server,
 *   WebSocket event bus, middleware pipeline, and modular route handlers.
 *   All business logic is delegated to dedicated modules in `/lib`.
 * @version 1.2.0
 * @author Nexus26 Team
 */

'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const dotenv = require('dotenv');

dotenv.config();

// Import modular subsystems
const { log } = require('./lib/logger');
const { initDatabase } = require('./lib/database');
const { initOperations } = require('./lib/operations');
const { attachMiddleware, notFoundHandler, globalErrorHandler } = require('./lib/middleware');
const { router, initRoutes } = require('./lib/routes');
const { PORT, WS_HEARTBEAT_INTERVAL_MS } = require('./lib/constants');

// ─── Environment Validation ─────────────────────────────────────────────────

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

// ─── Express & WebSocket Setup ──────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

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

// ─── Initialize Subsystems ──────────────────────────────────────────────────

initDatabase(__dirname);
initOperations(broadcast, __dirname);
initRoutes(broadcast, __dirname);

// ─── Middleware & Routes ────────────────────────────────────────────────────

attachMiddleware(app, __dirname);
app.use(router);
app.use(notFoundHandler);
app.use(globalErrorHandler);

// ─── WebSocket Connection Handler ───────────────────────────────────────────

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
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, WS_HEARTBEAT_INTERVAL_MS);

server.on('close', () => {
  clearInterval(heartbeatInterval);
  wss.close();
});

// ─── Start Server ───────────────────────────────────────────────────────────

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
