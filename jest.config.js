/**
 * Jest configuration for Nexus26.
 * Keeps the submission honest by enforcing meaningful coverage gates on the
 * backend modules and API tests that power the demo.
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
      statements: 70,
      branches: 60,
      functions: 70,
      lines: 70,
    },
  },
};
