/**
 * Nexus26 - Operations Query Validation Script
 * This script submits typical questions to the Fan and Command Center API endpoints
 * to verify the response formatting and function routing.
 */

const http = require('http');

const queries = [
  // 1. Command Center Staff Queries
  {
    persona: 'command',
    message: 'Which gates are backing up right now?',
    description: 'Staff asking about gate bottlenecks',
  },
  {
    persona: 'command',
    message: 'Which zones have overflowing garbage bins?',
    description: 'Staff checking sustainability issues',
  },
  {
    persona: 'command',
    message: 'dispatch volunteer Carlos to VR-1042',
    description: 'Staff dispatching a volunteer',
  },
  // 2. Fan Companion Queries
  {
    persona: 'fan',
    message: 'I want to go to Section 102, how do I get there?',
    description: 'Fan requesting navigation to a congested sector',
  },
  {
    persona: 'fan',
    message: '¿Cómo llego a la Sección 102?',
    description: 'Fan requesting navigation in Spanish',
  },
  {
    persona: 'fan',
    message: 'I am in a wheelchair, where is the nearest ramp for Gate A2?',
    description: 'Fan requesting accessibility routing',
  },
  {
    persona: 'fan',
    message: 'Is the subway train delayed?',
    description: 'Fan checking transit departures',
  },
];

function sendQuery(q) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      message: q.message,
      history: [],
      current_location: [200, 420],
      accessibility_enabled: q.message.toLowerCase().includes('wheelchair'),
    });

    const options = {
      hostname: 'localhost',
      port: 3000,
      path: `/api/chat/${q.persona}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve({
            success: true,
            description: q.description,
            persona: q.persona,
            query: q.message,
            response: parsed.text,
            mode: parsed.mode,
          });
        } catch (err) {
          resolve({
            success: false,
            description: q.description,
            error: 'Failed to parse JSON response',
          });
        }
      });
    });

    req.on('error', (err) => {
      resolve({
        success: false,
        description: q.description,
        error: err.message,
      });
    });

    req.write(postData);
    req.end();
  });
}

async function runTests() {
  console.log('=======================================================');
  console.log(' Starting Operations Query Validation Tests...');
  console.log(' Testing against: http://localhost:3000');
  console.log('=======================================================\n');

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    console.log(`[Test ${i + 1}/${queries.length}] ${q.description}`);
    console.log(`> Persona: ${q.persona.toUpperCase()}`);
    console.log(`> Question: "${q.message}"`);

    const result = await sendQuery(q);

    if (result.success) {
      console.log(`\n> Response Mode: ${result.mode.toUpperCase()}`);
      console.log('> Answer:\n-------------------------------------------------------');
      console.log(result.response);
      console.log('-------------------------------------------------------\n');
    } else {
      console.log(`> ERROR: ${result.error}\n`);
    }
  }

  console.log('=======================================================');
  console.log(' Operations Query Validation Tests Complete.');
  console.log('=======================================================');
}

runTests();
