/**
 * @fileoverview Nexus26 - Jest Unit Test Suite
 * @description Validates REST API routing, in-memory cached database operations,
 *   XSS sanitization security, input validation (400/404 responses), and
 *   the fallback AI agent chat integration.
 * @version 2.5.0
 */

'use strict';

const request = require('supertest');

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

const { app, server } = require('./server');

// ─── Lifecycle ────────────────────────────────────────────────────────────────
afterAll((done) => {
  if (server && server.listening) {
    server.close(done);
  } else {
    done();
  }
});

// ─── Test Suite ───────────────────────────────────────────────────────────────
describe('Nexus26 REST API — Core Operations', () => {
  // ── Sensors Endpoints ────────────────────────────────────────────────────────

  test('GET /api/sensors returns baseline gate data', async () => {
    const res = await request(app).get('/api/sensors');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('stadium_id');
    expect(res.body).toHaveProperty('gates');
    expect(Array.isArray(res.body.gates)).toBe(true);
    expect(res.body.gates.length).toBeGreaterThan(0);
  });

  test('POST /api/sensors/update successfully modifies gate congestion', async () => {
    const res = await request(app)
      .post('/api/sensors/update')
      .send({ gate_id: 'A1', congestion_level: 'high', current_count: 2400, avg_wait_min: 12 });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify in-memory cache reflects changes immediately
    const checkRes = await request(app).get('/api/sensors');
    const gateA1 = checkRes.body.gates.find((g) => g.gate_id === 'A1');
    expect(gateA1.congestion_level).toBe('high');
    expect(gateA1.current_count).toBe(2400);
  });

  test('POST /api/sensors/update returns 400 when gate_id is missing', async () => {
    const res = await request(app).post('/api/sensors/update').send({ congestion_level: 'high' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('POST /api/sensors/update returns 400 for invalid congestion_level', async () => {
    const res = await request(app).post('/api/sensors/update').send({ gate_id: 'A1', congestion_level: 'extreme' }); // not a valid value
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('congestion_level');
  });

  test('POST /api/sensors/update rejects invalid numeric sensor payloads', async () => {
    const res = await request(app)
      .post('/api/sensors/update')
      .send({ gate_id: 'A1', congestion_level: 'high', current_count: 'many', avg_wait_min: 12 });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('current_count');
  });

  test('POST /api/sensors/update returns 404 for non-existent gate', async () => {
    const res = await request(app).post('/api/sensors/update').send({ gate_id: 'Z99', congestion_level: 'low' });
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toContain('Z99');
  });

  // ── Transit Endpoints ─────────────────────────────────────────────────────────

  test('GET /api/transit returns transit schedule', async () => {
    const res = await request(app).get('/api/transit');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('lines');
    expect(Array.isArray(res.body.lines)).toBe(true);
  });

  test('POST /api/transit/update changes metro line delay', async () => {
    const res = await request(app)
      .post('/api/transit/update')
      .send({ line: 'K Line', status: 'delayed', delay_min: 30 });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('POST /api/transit/update returns 404 for unknown line', async () => {
    const res = await request(app).post('/api/transit/update').send({ line: 'Ghost Express', status: 'delayed' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toHaveProperty('error');
  });

  test('POST /api/transit/update rejects invalid status and delay values', async () => {
    const statusRes = await request(app)
      .post('/api/transit/update')
      .send({ line: 'K Line', status: 'teleporting', delay_min: 5 });
    expect(statusRes.statusCode).toBe(400);
    expect(statusRes.body.error).toContain('status');

    const delayRes = await request(app)
      .post('/api/transit/update')
      .send({ line: 'K Line', status: 'delayed', delay_min: -5 });
    expect(delayRes.statusCode).toBe(400);
    expect(delayRes.body.error).toContain('delay_min');
  });

  // ── Reports Endpoints ─────────────────────────────────────────────────────────

  test('GET /api/reports returns volunteer reports array', async () => {
    const res = await request(app).get('/api/reports');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('POST /api/reports creates new incident report', async () => {
    const res = await request(app)
      .post('/api/reports')
      .send({ zone: 'Gate B1', issue_type: 'overflowing_bin', text_raw: 'Bins are full' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('report_id');
    expect(res.body.report_id).toMatch(/^VR-/);
    expect(res.body.status).toBe('open');
  });

  // ── XSS Sanitization Security ─────────────────────────────────────────────────

  test('POST /api/reports sanitizes and escapes XSS injection in text_raw', async () => {
    const res = await request(app).post('/api/reports').send({
      zone: 'North Concourse',
      issue_type: 'overflowing_bin',
      text_raw: '<script>alert("XSS")</script>',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.text_raw).not.toContain('<script>');
    expect(res.body.text_raw).toContain('&lt;script&gt;');
  });

  test('POST /api/reports sanitizes XSS in zone field', async () => {
    const res = await request(app).post('/api/reports').send({
      zone: '<img src=x onerror=alert(1)>',
      issue_type: 'other',
      text_raw: 'Test',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.zone).not.toContain('<img');
    expect(res.body.zone).toContain('&lt;img');
  });

  // ── Dispatch Endpoints ────────────────────────────────────────────────────────

  test('POST /api/dispatch assigns a volunteer to a report', async () => {
    const reportRes = await request(app)
      .post('/api/reports')
      .send({ zone: 'Gate A2', issue_type: 'medical', text_raw: 'First aid needed' });

    const res = await request(app).post('/api/dispatch').send({ report_id: reportRes.body.report_id });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('dispatched');
    expect(res.body.data.assigned_volunteer).not.toBeNull();
  });

  test('POST /api/dispatch returns 404 for non-existent report_id', async () => {
    const res = await request(app).post('/api/dispatch').send({ report_id: 'VR-0000' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toHaveProperty('error');
  });

  // ── 404 Handler ───────────────────────────────────────────────────────────────

  test('Unknown endpoints return 404 with structured error', async () => {
    const res = await request(app).get('/api/nonexistent-endpoint');
    expect(res.statusCode).toBe(404);
    expect(res.body).toHaveProperty('error');
    expect(res.body).toHaveProperty('path');
  });

  // ── Chat Endpoints ────────────────────────────────────────────────────────────

  test('POST /api/chat/fan returns wayfinding route text in fallback mode', async () => {
    const res = await request(app)
      .post('/api/chat/fan')
      .send({
        message: 'Route to Section 102',
        history: [],
        current_location: [200, 420],
        accessibility_enabled: false,
      });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('text');
    expect(res.body.mode).toBe('fallback-agent');
  });

  test('POST /api/chat/command returns operational response in fallback mode', async () => {
    const res = await request(app).post('/api/chat/command').send({
      message: 'Which gates are backing up?',
      history: [],
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('text');
    expect(res.body.mode).toBe('fallback-agent');
  });

  test('POST /api/chat rejects unsupported personas and missing messages', async () => {
    const personaRes = await request(app).post('/api/chat/referee').send({ message: 'status?', history: [] });
    expect(personaRes.statusCode).toBe(404);
    expect(personaRes.body.error).toContain('not supported');

    const messageRes = await request(app).post('/api/chat/fan').send({ history: [] });
    expect(messageRes.statusCode).toBe(400);
    expect(messageRes.body.error).toContain('message');
  });

  test('POST /api/chat rejects malformed history arrays', async () => {
    const history = Array.from({ length: 13 }, () => ({ role: 'user', content: 'hello' }));
    const res = await request(app).post('/api/chat/fan').send({ message: 'Route to Section 102', history });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('history');
  });

  // ── Chat Persona: Fan Fallback Agent Details ───────────────────────────────

  test('POST /api/chat/fan processes wheelchair accessibility queries', async () => {
    const res = await request(app)
      .post('/api/chat/fan')
      .send({ message: 'I need wheelchair access to Gate A2', history: [], accessibility_enabled: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.text).toContain('Gate A2 features a wheelchair ramp');

    const resA1 = await request(app)
      .post('/api/chat/fan')
      .send({ message: 'I need wheelchair access to Gate A1', history: [], accessibility_enabled: true });
    expect(resA1.statusCode).toBe(200);
    expect(resA1.body.text).toContain('Gate A1 does not feature a wheelchair-compliant ramp');
  });

  test('POST /api/chat/fan processes Spanish language requests', async () => {
    const res = await request(app)
      .post('/api/chat/fan')
      .send({ message: '¿Cómo llego a la Sección 102?', history: [] });
    expect(res.statusCode).toBe(200);
    expect(res.body.text).toContain('Sección 102');
  });

  test('POST /api/chat/fan processes French language requests', async () => {
    const res = await request(app)
      .post('/api/chat/fan')
      .send({ message: 'Comment aller à la Section 102?', history: [] });
    expect(res.statusCode).toBe(200);
    expect(res.body.text).toContain('Section 102');
  });

  test('POST /api/chat/fan processes transit delay queries', async () => {
    const res = await request(app).post('/api/chat/fan').send({ message: 'Is the metro train delayed?', history: [] });
    expect(res.statusCode).toBe(200);
    expect(res.body.text).toContain('transit feed');
  });

  test('POST /api/chat/fan processes greeting requests', async () => {
    const res = await request(app).post('/api/chat/fan').send({ message: 'hello', history: [] });
    expect(res.statusCode).toBe(200);
    expect(res.body.text).toContain('Nexus26');
  });

  test('POST /api/chat/fan processes concessions queries', async () => {
    const res = await request(app).post('/api/chat/fan').send({ message: 'where is the food?', history: [] });
    expect(res.statusCode).toBe(200);
    expect(res.body.text).toContain('Concessions');
  });

  test('POST /api/chat/fan processes exits queries', async () => {
    const res = await request(app).post('/api/chat/fan').send({ message: 'how to exit the stadium?', history: [] });
    expect(res.statusCode).toBe(200);
    expect(res.body.text).toContain('Main stadium exits');
  });

  test('POST /api/chat/fan processes thank queries', async () => {
    const res = await request(app).post('/api/chat/fan').send({ message: 'thank you', history: [] });
    expect(res.statusCode).toBe(200);
    expect(res.body.text).toContain('welcome');
  });

  test('POST /api/chat/fan processes capabilities queries', async () => {
    const res = await request(app).post('/api/chat/fan').send({ message: 'what can you do?', history: [] });
    expect(res.statusCode).toBe(200);
    expect(res.body.text).toContain('Navigate to seat sections');
  });

  test('POST /api/chat/fan processes match details queries', async () => {
    const res = await request(app).post('/api/chat/fan').send({ message: 'who is playing today?', history: [] });
    expect(res.statusCode).toBe(200);
    expect(res.body.text).toContain('USA vs. Mexico');
  });

  // ── Chat Persona: Command Fallback Agent Details ───────────────────────────

  test('POST /api/chat/command processes waste reports query', async () => {
    const res = await request(app)
      .post('/api/chat/command')
      .send({ message: 'Which zones have overflowing waste bins?', history: [] });
    expect(res.statusCode).toBe(200);
    expect(res.body.text).toContain('bin');
  });

  test('POST /api/chat/command processes dispatch commands', async () => {
    const res = await request(app)
      .post('/api/chat/command')
      .send({ message: 'dispatch volunteer Carlos to VR-1042', history: [] });
    expect(res.statusCode).toBe(200);
    expect(res.body.text).toContain('DISPATCHED');
  });

  test('POST /api/chat/command handles non-existent report dispatches', async () => {
    const res = await request(app)
      .post('/api/chat/command')
      .send({ message: 'dispatch volunteer Carlos to VR-9999', history: [] });
    expect(res.statusCode).toBe(200);
    expect(res.body.text).toContain('failed');
  });

  test('POST /api/chat/command fallback message for general queries', async () => {
    const res = await request(app).post('/api/chat/command').send({ message: 'general question', history: [] });
    expect(res.statusCode).toBe(200);
    expect(res.body.text).toContain('COMMAND CORE');
  });

  // ── Reset & Broadcast Endpoints ─────────────────────────────────────────────

  test('POST /api/reset resets baseline data', async () => {
    const res = await request(app).post('/api/reset');
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('POST /api/broadcast successfully broadcasts a message', async () => {
    const res = await request(app).post('/api/broadcast').send({ message: 'Emergency alert!' });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('POST /api/broadcast returns 400 if message is missing', async () => {
    const res = await request(app).post('/api/broadcast').send({});
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('message is required');
  });

  test('POST /api/chat/fan processes compliance manual queries', async () => {
    const res = await request(app)
      .post('/api/chat/fan')
      .send({ message: 'What is the compliance manual policy?', history: [] });
    expect(res.statusCode).toBe(200);
    expect(res.body.text).toContain('COMPLIANCE POLICY');
  });

  test('POST /api/chat/command processes compliance manual queries', async () => {
    const res = await request(app)
      .post('/api/chat/command')
      .send({ message: 'show waste compliance threshold rules', history: [] });
    expect(res.statusCode).toBe(200);
    expect(res.body.text).toContain('COMPLIANCE SOP');
  });
});
