/**
 * Jest configuration for Nexus26.
 * Enforces meaningful coverage gates on the backend modules and API tests
 * that power the operational demo and AI chat integration.
 */
'use strict';

module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/*.test.js'],
  collectCoverageFrom: ['server.js', 'lib/**/*.js', '!coverage/**', '!node_modules/**'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  coverageThreshold: {
    global: {
      statements: 85,
      branches: 75,
      functions: 85,
      lines: 85,
    },
  },
};
