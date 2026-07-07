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
    }),
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
                        args: { stadium_id: 'sofi_stadium', gate_id: 'A1' },
                      },
                    ],
                  },
                });
              } else {
                // Return final text on subsequent calls
                return Promise.resolve({
                  response: {
                    text: () => 'Final Gemini response with gate details.',
                    getFunctionCalls: () => [],
                  },
                });
              }
            }),
          }),
        }),
      };
    }),
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
  local_generate_reroute,
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
  test('ALLOWED_FILES whitelist contains expected data files', () => {
    expect(ALLOWED_FILES).toContain('gate_sensors.json');
    expect(ALLOWED_FILES).toContain('volunteer_reports.json');
    expect(ALLOWED_FILES).toContain('transit_feeds.json');
    expect(ALLOWED_FILES).toContain('accessibility_routes.json');
    expect(ALLOWED_FILES).toContain('stadium_map_coords.json');
    expect(ALLOWED_FILES).toContain('fifa_compliance_manual.md');
    expect(ALLOWED_FILES).not.toContain('unauthorized_file.json');
  });

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
  test('local_get_transit_status returns transit feed data', async () => {
    const result = await local_get_transit_status('Inglewood');
    expect(result).toHaveProperty('lines');
    expect(Array.isArray(result.lines)).toBe(true);
    expect(result.lines.length).toBeGreaterThan(0);
  });

  test('local_query_open_reports filters by issue_type, zone, and status', async () => {
    // Seed a medical report
    await local_log_volunteer_report('Gate A1', 'medical', 'Test medical report');

    // Filter by issue_type
    const medicalReports = await local_query_open_reports('medical', null, null);
    expect(medicalReports.length).toBeGreaterThan(0);
    expect(medicalReports.every((r) => r.issue_type === 'medical')).toBe(true);

    // Filter by zone
    const zoneReports = await local_query_open_reports(null, 'Gate A1', null);
    expect(zoneReports.length).toBeGreaterThan(0);

    // Filter by status
    const openReports = await local_query_open_reports(null, null, 'open');
    expect(openReports.every((r) => r.status === 'open')).toBe(true);

    // Status 'all' returns everything
    const allReports = await local_query_open_reports(null, null, 'all');
    expect(allReports.length).toBeGreaterThanOrEqual(openReports.length);
  });

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
    const gateA1 = sensorData.gates.find((g) => g.gate_id === 'A1');
    const prevLevel = gateA1.congestion_level;
    gateA1.congestion_level = 'critical';

    const result = await local_generate_reroute('sofi_stadium', '102', [200, 420], 'critical');
    expect(result.rerouted).toBe(true);

    // Restore
    gateA1.congestion_level = prevLevel;
  });

  test('local_generate_reroute handles all gate-to-section mappings', async () => {
    // Section mapped to A2
    const routeA2 = await local_generate_reroute('sofi_stadium', '103', [200, 420], 'high');
    expect(routeA2).toHaveProperty('gate_used');
    expect(routeA2.original_gate).toBe('A2');

    // Section mapped to B1
    const routeB1 = await local_generate_reroute('sofi_stadium', '115', [200, 420], 'high');
    expect(routeB1).toHaveProperty('gate_used');
    expect(routeB1.original_gate).toBe('B1');

    // All gates congested — reroute stays on original
    const sensorData = readJSON('gate_sensors.json');
    sensorData.gates.forEach((g) => {
      g.congestion_level = 'high';
    });
    const routeNoAlt = await local_generate_reroute('sofi_stadium', '102', [200, 420], 'high');
    expect(routeNoAlt).toHaveProperty('instructions');
    // Restore
    sensorData.gates.forEach((g) => {
      g.congestion_level = 'low';
    });
  });

  test('local_check_gate_congestion returns all gates when no gate_id given', async () => {
    const result = await local_check_gate_congestion('sofi_stadium');
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  // ── AI Module Tests ──────────────────────────────────────────────────────────
  test('runGeminiAgent processes function calls and loops successfully', async () => {
    const response = await runGeminiAgent(
      'fan',
      'Is Gate A1 congested?',
      [{ role: 'user', content: 'hello' }],
      'fake_api_key',
      [200, 420],
      false
    );
    expect(response).toBe('Final Gemini response with gate details.');
  });

  test('runFallbackMockAgent responds correctly in Spanish and French', async () => {
    // Fan - Spanish Spanish query for wheelchair
    const esRamp = await runFallbackMockAgent('fan', 'Necesito ayuda con silla de ruedas', [200, 420], true);
    expect(esRamp).toContain('rampa accesible');

    // Fan - Spanish Spanish query for wheelchair at A1
    const esRampA1 = await runFallbackMockAgent(
      'fan',
      'Necesito ayuda con silla de ruedas en puerta A1',
      [200, 420],
      true
    );
    expect(esRampA1).toContain('Puerta A1 no tiene rampa accesible');

    // Fan - French query for wheelchair
    const frRamp = await runFallbackMockAgent('fan', 'comment obtenir une rampe de fauteuil', [200, 420], true);
    expect(frRamp).toContain('rampe accessible');

    // Fan - French query for wheelchair at A1
    const frRampA1 = await runFallbackMockAgent('fan', 'comment rampe porte A1', [200, 420], true);
    expect(frRampA1).toContain('Porte A1');

    // Fan - English query for wheelchair at A1
    const enRampA1 = await runFallbackMockAgent('fan', 'wheelchair at gate a1', [200, 420], true);
    expect(enRampA1).toContain('Gate A1 does not feature a wheelchair-compliant ramp');

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
    sensorData.gates.forEach((g) => {
      g.congestion_level = 'low';
      g.avg_wait_min = 2;
    });

    const result = await runFallbackMockAgent('command', 'Show gate status', null, false);
    expect(result).toContain('NORMAL');

    // Restore gates
    sensorData.gates = prevGates;
  });

  test('runFallbackMockAgent command persona handles high congestion', async () => {
    const sensorData = readJSON('gate_sensors.json');
    const gateA1 = sensorData.gates.find((g) => g.gate_id === 'A1');
    const prevLevel = gateA1.congestion_level;
    gateA1.congestion_level = 'high';

    const result = await runFallbackMockAgent('command', 'Which gates are congested?', null, false);
    expect(result).toContain('HIGH');

    // Test critical gate
    gateA1.congestion_level = 'critical';
    const resultCritical = await runFallbackMockAgent('command', 'crowd congestion gate', null, false);
    expect(resultCritical).toContain('CRITICAL');

    // Restore
    gateA1.congestion_level = prevLevel;
  });

  test('runFallbackMockAgent fan persona handles all intents and German fallback', async () => {
    const greetFr = await runFallbackMockAgent('fan', 'bonjour comment', [200, 420], false);
    expect(greetFr).toContain('stade');

    const greetEs = await runFallbackMockAgent('fan', 'hola amigo', [200, 420], false);
    expect(greetEs).toContain('Nexus26');

    const foodFr = await runFallbackMockAgent('fan', 'comment trouver la section des concessions?', [200, 420], false);
    expect(foodFr).toContain('concessions');

    const foodEs = await runFallbackMockAgent('fan', 'donde comida estadio', [200, 420], false);
    expect(foodEs).toContain('concesiones');

    const exitEs = await runFallbackMockAgent('fan', 'como salir del estadio', [200, 420], false);
    expect(exitEs).toContain('salida');

    const exitFr = await runFallbackMockAgent('fan', 'comment sortir porte', [200, 420], false);
    expect(exitFr).toContain('Porte');

    const thankEs = await runFallbackMockAgent('fan', 'gracias estadio', [200, 420], false);
    expect(thankEs).toContain('partido');

    const thankFr = await runFallbackMockAgent('fan', 'merci beaucoup', [200, 420], false);
    expect(thankFr).toContain('match');

    const matchEs = await runFallbackMockAgent('fan', 'quien juega estadio hoy partido equipo', [200, 420], false);
    expect(matchEs).toContain('USA contra');

    const policyEs = await runFallbackMockAgent('fan', 'politica cumplimiento estadio rule', [200, 420], false);
    expect(policyEs).toContain('POL');

    // German/unknown fallback
    const deFallback = await runFallbackMockAgent('fan', 'danke schon sehr', [200, 420], false);
    expect(deFallback).toContain('geschehen');

    const deGreet = await runFallbackMockAgent('fan', 'hallo wie geht es dir', [200, 420], false);
    expect(deGreet).toContain('Stadionbegleiter');

    const deFood = await runFallbackMockAgent('fan', 'wo gibt es essen und trinken', [200, 420], false);
    expect(deFood).toContain('Speisen');

    const deExit = await runFallbackMockAgent('fan', 'wo ist der ausgang', [200, 420], false);
    expect(deExit).toContain('Hauptausgänge');

    const deTransit = await runFallbackMockAgent('fan', 'ist die u-bahn verspätet', [200, 420], false);
    expect(deTransit).toContain('Echtzeit-Verkehrsdaten');

    const deAccess = await runFallbackMockAgent('fan', 'rollstuhlrampe für a2', [200, 420], false);
    expect(deAccess).toContain('Barrierefreie Route');

    const deAccessA1 = await runFallbackMockAgent('fan', 'rollstuhlrampe für a1', [200, 420], false);
    expect(deAccessA1).toContain('Tor A1 verfügt über keine rollstuhlgerechte Rampe');

    const deRoute = await runFallbackMockAgent('fan', 'route zu sektion 102', [200, 420], false);
    expect(deRoute).toContain('Sektion 102');

    const dePolicy = await runFallbackMockAgent('fan', 'richtlinien compliance rule', [200, 420], false);
    expect(dePolicy).toContain('RICHTLINIEN');

    const deMatch = await runFallbackMockAgent('fan', 'wer spielt heute spiel', [200, 420], false);
    expect(deMatch).toContain('USA gegen Mexiko');

    const deCap = await runFallbackMockAgent('fan', 'what can you do hilfe', [200, 420], false);
    expect(deCap).toContain('Ich kann Ihnen helfen');

    const deDefault = await runFallbackMockAgent('fan', 'unbekanntes wort', [200, 420], false);
    expect(deDefault).toContain('Offline-Modus');

    // Default system fallback
    const result = await runFallbackMockAgent('unknown_persona', 'anything', null, false);
    expect(result).toContain('System active');
  });

  test('runFallbackMockAgent command handles missing reports dispatch', async () => {
    // VR-9999 must match the VR-\d+ pattern AND include a dispatch word
    const result = await runFallbackMockAgent('command', 'dispatch volunteer to VR-9999', null, false);
    expect(result).toContain('ERROR');
  });

  test('runFallbackMockAgent command handles surge reports', async () => {
    const reports = readJSON('volunteer_reports.json');
    const prevReports = JSON.parse(JSON.stringify(reports));

    const surgeReport = {
      report_id: 'VR-5555',
      volunteer_id: 'V-200',
      zone: 'Gate B1',
      issue_type: 'crowd_surge',
      text_raw: 'Crowd surge occurring',
      timestamp: new Date().toISOString(),
      status: 'open',
      assigned_volunteer: null,
    };
    reports.unshift(surgeReport);

    const result = await runFallbackMockAgent('command', 'show overflow alerts', null, false);
    expect(result).toContain('CRITICAL');

    // Restore
    writeJSON('volunteer_reports.json', prevReports, path.join(__dirname));
  });

  test('runFallbackMockAgent command handles stable reports state', async () => {
    const reports = readJSON('volunteer_reports.json');
    const prevReports = JSON.parse(JSON.stringify(reports));
    writeJSON('volunteer_reports.json', [], path.join(__dirname));

    const result = await runFallbackMockAgent('command', 'show overflow trash report', null, false);
    expect(result).toContain('STABLE');

    writeJSON('volunteer_reports.json', prevReports, path.join(__dirname));
  });

  test('runFallbackMockAgent command handles compliance queries', async () => {
    const result = await runFallbackMockAgent('command', 'show compliance policy sop', null, false);
    expect(result).toContain('COMPLIANCE SOP');
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
      assigned_volunteer: null,
    };
    reports.unshift(newReport);

    const result = await runFallbackMockAgent('command', 'Show open waste bins', null, false);
    expect(result).toContain('CRITICAL');

    // Restore reports
    writeJSON('volunteer_reports.json', prevReports, path.join(__dirname));
  });
});
