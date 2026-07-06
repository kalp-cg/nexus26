/**
 * @fileoverview Jest test suite to achieve 100% coverage on Nexus26 library modules.
 * @version 1.0.0
 */

'use strict';

const path = require('path');

// Mock fs.writeFile to prevent tests from modifying physical files
jest.mock('fs', () => {
  const originalFs = jest.requireActual('fs');
  return {
    ...originalFs,
    writeFile: jest.fn().mockImplementation((path, data, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      if (cb) cb(null);
    })
  };
});

// Mock Google Generative AI module
jest.mock('@google/generative-ai', () => {
  let callCount = 0;
  return {
    GoogleGenerativeAI: jest.fn().mockImplementation(() => {
      return {
        getGenerativeModel: jest.fn().mockReturnValue({
          startChat: jest.fn().mockReturnValue({
            sendMessage: jest.fn().mockImplementation(() => {
              callCount++;
              if (callCount === 1) {
                // Return a function call on the first call
                return Promise.resolve({
                  response: {
                    text: () => 'Refining answer...',
                    getFunctionCalls: () => [
                      {
                        name: 'check_gate_congestion',
                        args: { stadium_id: 'sofi_stadium', gate_id: 'A1' }
                      }
                    ]
                  }
                });
              } else {
                // Return final text on subsequent calls
                return Promise.resolve({
                  response: {
                    text: () => 'Final Gemini response with gate details.',
                    getFunctionCalls: () => []
                  }
                });
              }
            })
          })
        })
      };
    })
  };
});

const { log } = require('./lib/logger');
const { sanitizeInput } = require('./lib/sanitizer');
const { initDatabase, readJSON, writeJSON, ALLOWED_FILES } = require('./lib/database');
const {
  initOperations,
  local_check_gate_congestion,
  local_get_transit_status,
  local_get_accessible_route,
  local_log_volunteer_report,
  local_query_open_reports,
  local_dispatch_volunteer,
  local_generate_reroute
} = require('./lib/operations');
const { runGeminiAgent, runFallbackMockAgent } = require('./lib/ai');

describe('Nexus26 Core Library Units', () => {

  beforeAll(() => {
    initDatabase(path.join(__dirname));
    initOperations(() => {}, path.join(__dirname));
  });

  // ── Logger Tests ─────────────────────────────────────────────────────────────
  test('Logger correctly formats INFO, WARN, and ERROR outputs', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    log('INFO', 'TEST', 'Info message');
    log('WARN', 'TEST', 'Warn message');
    log('ERROR', 'TEST', 'Error message');

    expect(logSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // ── Sanitizer Tests ──────────────────────────────────────────────────────────
  test('Sanitizer encodes special characters and handles non-string inputs', () => {
    expect(sanitizeInput('<div>&"\'/</div>')).toBe('&lt;div&gt;&amp;&quot;&#x27;&#x2F;&lt;&#x2F;div&gt;');
    expect(sanitizeInput(42)).toBe(42);
    expect(sanitizeInput(null)).toBeNull();
  });

  // ── Database Module Tests ─────────────────────────────────────────────────────
  test('readJSON rejects files not in whitelist', () => {
    expect(readJSON('unauthorized_file.json')).toBeNull();
  });

  test('writeJSON rejects files not in whitelist', () => {
    expect(writeJSON('unauthorized_file.json', {})).toBe(false);
  });

  test('initDatabase handles missing data directory gracefully', () => {
    const originalConsoleError = console.error;
    console.error = jest.fn();
    initDatabase('/nonexistent_path');
    expect(console.error).toHaveBeenCalled();
    console.error = originalConsoleError;
    // Restore the correct DB cache path immediately
    initDatabase(path.join(__dirname));
  });

  // ── Operations Module Tests ──────────────────────────────────────────────────
  test('local_check_gate_congestion with invalid gate returns error', async () => {
    const result = await local_check_gate_congestion('sofi_stadium', 'invalid_gate');
    expect(result).toHaveProperty('error');
  });

  test('local_get_accessible_route with invalid gate returns error', async () => {
    const result = await local_get_accessible_route('invalid_gate');
    expect(result).toHaveProperty('error');
  });

  test('local_dispatch_volunteer with invalid report returns error', async () => {
    const result = await local_dispatch_volunteer('VR-999999');
    expect(result).toHaveProperty('error');
  });

  test('local_log_volunteer_report uses defaults for missing inputs', async () => {
    const report = await local_log_volunteer_report(null, null, null);
    expect(report.zone).toBe('Unknown Concourse');
    expect(report.issue_type).toBe('other');
    expect(report.text_raw).toBe('Unspecified report');
  });

  test('local_generate_reroute returns error if map data is missing', async () => {
    // Temporarily clear cache
    const cacheSensors = readJSON('gate_sensors.json');
    writeJSON('gate_sensors.json', null, path.join(__dirname));
    const result = await local_generate_reroute('sofi_stadium', '102');
    expect(result).toHaveProperty('error');
    // Restore
    writeJSON('gate_sensors.json', cacheSensors, path.join(__dirname));
  });

  test('local_generate_reroute performs critical congestion rerouting', async () => {
    // Force Gate A1 to critical congestion
    const sensorData = readJSON('gate_sensors.json');
    const gateA1 = sensorData.gates.find(g => g.gate_id === 'A1');
    const prevLevel = gateA1.congestion_level;
    gateA1.congestion_level = 'critical';

    const result = await local_generate_reroute('sofi_stadium', '102', [200, 420], 'critical');
    expect(result.rerouted).toBe(true);

    // Restore
    gateA1.congestion_level = prevLevel;
  });

  // ── AI Module Tests ──────────────────────────────────────────────────────────
  test('runGeminiAgent processes function calls and loops successfully', async () => {
    const response = await runGeminiAgent('fan', 'Is Gate A1 congested?', [{ role: 'user', content: 'hello' }], 'fake_api_key', [200, 420], false);
    expect(response).toBe('Final Gemini response with gate details.');
  });

  test('runFallbackMockAgent responds correctly in Spanish and French', async () => {
    // Fan - Spanish Spanish query for wheelchair
    const esRamp = await runFallbackMockAgent('fan', 'Necesito ayuda con silla de ruedas', [200, 420], true);
    expect(esRamp).toContain('rampa accesible');

    // Fan - French query for wheelchair
    const frRamp = await runFallbackMockAgent('fan', 'comment obtenir une rampe de fauteuil', [200, 420], true);
    expect(frRamp).toContain('rampe accessible');

    // Fan - Spanish query for transit
    const esTransit = await runFallbackMockAgent('fan', 'ayuda transporte al metro', [200, 420], false);
    expect(esTransit).toContain('Estado de tránsito');

    // Fan - French query for transit
    const frTransit = await runFallbackMockAgent('fan', 'comment metro retard', [200, 420], false);
    expect(frTransit).toContain('transports en temps réel');

    // Fan - Spanish query for section
    const esRoute = await runFallbackMockAgent('fan', 'Sección 102', [200, 420], false);
    expect(esRoute).toContain('Sección 102');

    // Fan - French query for section
    const frRoute = await runFallbackMockAgent('fan', 'section 102', [200, 420], false);
    expect(frRoute).toContain('Section 102');

    // Fan - Default Spanish fallback
    const esFallback = await runFallbackMockAgent('fan', 'ayuda con algo desconocido', [200, 420], false);
    expect(esFallback).toContain('Modo de contingencia');
  });

  test('runFallbackMockAgent command persona handles edge cases', async () => {
    // Command - Congestion low / normal scenario
    const sensorData = readJSON('gate_sensors.json');
    const prevGates = JSON.parse(JSON.stringify(sensorData.gates));
    // Set all gates to low
    sensorData.gates.forEach(g => {
      g.congestion_level = 'low';
      g.avg_wait_min = 2;
    });

    const result = await runFallbackMockAgent('command', 'Show gate status', null, false);
    expect(result).toContain('NORMAL');

    // Restore gates
    sensorData.gates = prevGates;
  });

  test('runFallbackMockAgent command persona handles open reports status warnings', async () => {
    // Seed an open medical report
    const reports = readJSON('volunteer_reports.json');
    const prevReports = JSON.parse(JSON.stringify(reports));

    const newReport = {
      report_id: 'VR-8888',
      volunteer_id: 'V-111',
      zone: 'Gate A1',
      issue_type: 'medical',
      text_raw: 'Heart issue',
      timestamp: new Date().toISOString(),
      status: 'open',
      assigned_volunteer: null
    };
    reports.unshift(newReport);

    const result = await runFallbackMockAgent('command', 'Show open waste bins', null, false);
    expect(result).toContain('CRITICAL');

    // Restore reports
    writeJSON('volunteer_reports.json', prevReports, path.join(__dirname));
  });
});
