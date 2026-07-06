/**
 * @fileoverview Jest Configuration — Nexus26 Test Suite
 * Enforces minimum coverage thresholds to maintain code quality gates.
 */
module.exports = {
  testEnvironment: 'node',
  verbose: true,
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'clover'],
  coverageThreshold: {
    global: {
      statements: 70,
      branches: 60,
      functions: 80,
      lines: 70,
    },
  },
  testMatch: ['**/*.test.js'],
  moduleFileExtensions: ['js', 'json'],
};
