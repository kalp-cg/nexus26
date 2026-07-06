/**
 * Nexus26 - Jest Unit Test Suite
 * Validates API routing, cached database operations, sanitization, and input security.
 */

const request = require('supertest');
const { app, server } = require('./server');

// Close server listener after all tests run to release ports
afterAll((done) => {
  if (server && server.listening) {
    server.close(done);
  } else {
    done();
  }
});

describe('Nexus26 - REST API Core Operations', () => {

  // Test 1: GET /api/sensors
  test('GET /api/sensors returns baseline gate statuses', async () => {
    const res = await request(app).get('/api/sensors');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('stadium_id');
    expect(res.body).toHaveProperty('gates');
    expect(Array.isArray(res.body.gates)).toBe(true);
  });

  // Test 2: POST /api/sensors/update
  test('POST /api/sensors/update modifies congestion details', async () => {
    const payload = {
      gate_id: 'A1',
      congestion_level: 'high',
      current_count: 2400,
      avg_wait_min: 12
    };
    const res = await request(app)
      .post('/api/sensors/update')
      .send(payload);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify cache reflects changes
    const checkRes = await request(app).get('/api/sensors');
    const gateA1 = checkRes.body.gates.find(g => g.gate_id === 'A1');
    expect(gateA1.congestion_level).toBe('high');
    expect(gateA1.current_count).toBe(2400);
  });

  // Test 3: GET /api/transit
  test('GET /api/transit returns transit status schedule', async () => {
    const res = await request(app).get('/api/transit');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('lines');
    expect(Array.isArray(res.body.lines)).toBe(true);
  });

  // Test 4: POST /api/transit/update
  test('POST /api/transit/update changes metro delays', async () => {
    const payload = {
      line: 'K Line',
      status: 'delayed',
      delay_min: 30
    };
    const res = await request(app)
      .post('/api/transit/update')
      .send(payload);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  // Test 5: Input Sanitization (XSS Vulnerability Blocking)
  test('POST /api/reports sanitizes and escapes malicious XSS code', async () => {
    const maliciousPayload = {
      zone: 'North Concourse',
      issue_type: 'overflowing_bin',
      text_raw: '<script>alert("XSS Vulnerability Test")</script>'
    };
    const res = await request(app)
      .post('/api/reports')
      .send(maliciousPayload);
    expect(res.statusCode).toBe(200);
    
    // Verify that HTML characters were escaped to entities
    expect(res.body.text_raw).not.toContain('<script>');
    expect(res.body.text_raw).toContain('&lt;script&gt;');
  });

  // Test 6: POST /api/dispatch
  test('POST /api/dispatch assigns volunteer to task', async () => {
    // File new report
    const newReport = await request(app)
      .post('/api/reports')
      .send({ zone: 'Gate B1', issue_type: 'medical', text_raw: 'First aid requested' });
    
    const reportId = newReport.body.report_id;

    // Dispatch
    const res = await request(app)
      .post('/api/dispatch')
      .send({ report_id: reportId });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('dispatched');
    expect(res.body.data.assigned_volunteer).not.toBeNull();
  });

  // Test 7: POST /api/chat/:persona
  test('POST /api/chat/fan processes offline wayfinding query', async () => {
    const chatPayload = {
      message: 'Direct me to Section 102',
      history: [],
      current_location: [200, 420],
      accessibility_enabled: false
    };
    const res = await request(app)
      .post('/api/chat/fan')
      .send(chatPayload);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('text');
    expect(res.body.mode).toBe('fallback-agent');
  });

});
