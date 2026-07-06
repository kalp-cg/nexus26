/**
 * @fileoverview Nexus26 — Gemini AI Integration & Offline Mock Agent Module
 * @description Manages prompts injection, function declarations mapping, calling loops,
 *   and bilingual offline contingency agent responses.
 * @module lib/ai
 * @version 1.0.0
 */

'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { readJSON } = require('./database');
const { log } = require('./logger');
const {
  local_check_gate_congestion,
  local_get_transit_status,
  local_get_accessible_route,
  local_log_volunteer_report,
  local_query_open_reports,
  local_dispatch_volunteer,
  local_generate_reroute
} = require('./operations');

// ─── Gemini AI System Prompts ────────────────────────────────────────────────
const FAN_SYSTEM_PROMPT = `You are Nexus26, the official FIFA World Cup 2026 fan navigation assistant.

You help fans in their native language with: finding their seat/section, 
avoiding crowded gates, catching the right transit connection, and finding 
wheelchair-accessible or rideshare paths.

Rules:
1. Always call check_gate_congestion before recommending a route — never guess 
   congestion levels from memory.
2. If a fan's stated destination has a gate at "high" or "critical" congestion, 
   call generate_reroute with avoid_congestion_above set accordingly, and 
   explain the alternate path in one short, friendly sentence plus walking 
   time.
3. If a fan asks about transit, call get_transit_status before answering 
   with departure times.
4. If a fan mentions a wheelchair, stroller, or mobility need, call 
   get_accessible_route automatically without being asked twice.
5. Respond in the same language the fan used to speak or type to you. Keep 
   spoken responses under 3 sentences — they will be converted to audio.
6. Never invent gate numbers, wait times, or transit times that didn't come 
   from a tool call.
7. If systems are down or data is missing, say so plainly and suggest asking 
   a nearby staff member — do not fabricate reassurance.`;

const COMMAND_SYSTEM_PROMPT = `You are the Nexus26 Command Center Intelligence Agent, supporting venue 
operations staff during FIFA World Cup 2026 matches.

Your job is to turn natural-language staff questions into the correct tool 
calls and return concise, actionable answers — never vague summaries.

Rules:
1. For congestion questions ("which gates are backing up?"), call 
   check_gate_congestion across all gates and rank by severity.
2. For resource/waste/report questions ("which zones have overflowing bins?"), 
   call query_open_reports filtered appropriately.
3. If a staff member asks you to send help, call dispatch_volunteer with the 
   relevant report_id — confirm the assignment back to them in one sentence.
4. Always state your answer as: [severity/count] → [specific zone/gate] → 
   [recommended action]. Staff are triaging under time pressure; do not 
   editorialize or pad the response.
5. If a query spans both crowd and sustainability domains (e.g. "give me a 
   full status of the North Concourse"), call both check_gate_congestion and 
   query_open_reports and merge into one short brief.
6. Flag anything classified as "medical" or "crowd_surge" at the top of any 
   response, regardless of what was asked — safety signals are never buried.`;

/**
 * Run Gemini Chat Agent with Function Calling Loop
 */
async function runGeminiAgent(persona, message, history, apiKey, currentLocation, accessibilityEnabled) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const complianceManual = readJSON('fifa_compliance_manual.md') || '';
  const sysPrompt = (persona === 'fan'
    ? FAN_SYSTEM_PROMPT + (accessibilityEnabled ? '\nNote: Fan has accessibility needs. Prioritize get_accessible_route.' : '')
    : COMMAND_SYSTEM_PROMPT) + `\n\nOfficial Venue Regulations & Compliance SOPs:\n${complianceManual}`;

  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    systemInstruction: sysPrompt,
  });

  const tools = [{
    functionDeclarations: [
      {
        name: 'check_gate_congestion',
        description: 'Returns live congestion level, wait time, and capacity for one or all gates at SoFi Stadium.',
        parameters: {
          type: 'OBJECT',
          properties: {
            stadium_id: { type: 'STRING' },
            gate_id: { type: 'STRING', description: 'Optional. Omit to get all gates.' }
          },
          required: ['stadium_id']
        }
      },
      {
        name: 'get_transit_status',
        description: 'Returns live delay/status for transit lines serving a given stadium/city.',
        parameters: {
          type: 'OBJECT',
          properties: {
            city: { type: 'STRING' }
          },
          required: ['city']
        }
      },
      {
        name: 'generate_reroute',
        description: 'Given a destination section and current location, returns walking coordinates and routing directions that avoid gates above a congestion threshold.',
        parameters: {
          type: 'OBJECT',
          properties: {
            stadium_id: { type: 'STRING' },
            destination_section: { type: 'STRING' },
            current_location_coords: {
              type: 'ARRAY',
              items: { type: 'NUMBER' },
              description: 'Array of two numbers [x, y]. Coordinates on stadium grid.'
            },
            avoid_congestion_above: { type: 'STRING', enum: ['high', 'critical'] }
          },
          required: ['stadium_id', 'destination_section', 'current_location_coords']
        }
      },
      {
        name: 'get_accessible_route',
        description: 'Returns wheelchair-accessible ramp and rideshare pickup coordinates nearest to a gate.',
        parameters: {
          type: 'OBJECT',
          properties: {
            gate_id: { type: 'STRING' }
          },
          required: ['gate_id']
        }
      },
      {
        name: 'log_volunteer_report',
        description: "Files a structured issue report from a volunteer's free-text input, classified by issue type and zone.",
        parameters: {
          type: 'OBJECT',
          properties: {
            zone: { type: 'STRING' },
            issue_type: {
              type: 'STRING',
              enum: ['overflowing_bin', 'crowd_surge', 'medical', 'accessibility_blocked', 'other']
            },
            text_raw: { type: 'STRING' }
          },
          required: ['zone', 'issue_type', 'text_raw']
        }
      },
      {
        name: 'query_open_reports',
        description: 'Lets Command Center staff ask questions about open reports, filtered by zone or issue type.',
        parameters: {
          type: 'OBJECT',
          properties: {
            issue_type: { type: 'STRING' },
            zone: { type: 'STRING' },
            status: { type: 'STRING', enum: ['open', 'resolved', 'all'] }
          }
        }
      },
      {
        name: 'dispatch_volunteer',
        description: 'Assigns the nearest available volunteer to an open report.',
        parameters: {
          type: 'OBJECT',
          properties: {
            report_id: { type: 'STRING' },
            zone: { type: 'STRING' }
          },
          required: ['report_id']
        }
      }
    ]
  }];

  // Filter history to ensure it starts with a 'user' message as required by Gemini
  const formattedHistory = [];
  let userSeen = false;
  for (const h of (history || [])) {
    if (h.role === 'user') userSeen = true;
    if (userSeen) {
      formattedHistory.push({
        role: h.role === 'assistant' ? 'model' : h.role,
        parts: [{ text: h.content || '' }]
      });
    }
  }

  const chat = model.startChat({
    history: formattedHistory,
    generationConfig: { temperature: 0.1 },
    tools: tools
  });

  let result = await chat.sendMessage(message);
  let functionCalls = result.response.getFunctionCalls();
  let loops = 0;

  while (functionCalls && functionCalls.length > 0 && loops < 5) {
    loops++;
    const functionResponses = [];

    for (const call of functionCalls) {
      const name = call.name;
      const args = call.args;
      let toolResult;

      log('INFO', 'AI', `Gemini Tool Executing: ${name}`);

      try {
        if (name === 'check_gate_congestion') {
          toolResult = await local_check_gate_congestion(args.stadium_id, args.gate_id);
        } else if (name === 'get_transit_status') {
          toolResult = await local_get_transit_status(args.city);
        } else if (name === 'generate_reroute') {
          const coords = args.current_location_coords || currentLocation || [200, 420];
          toolResult = await local_generate_reroute(args.stadium_id, args.destination_section, coords, args.avoid_congestion_above);
        } else if (name === 'get_accessible_route') {
          toolResult = await local_get_accessible_route(args.gate_id);
        } else if (name === 'log_volunteer_report') {
          toolResult = await local_log_volunteer_report(args.zone, args.issue_type, args.text_raw);
        } else if (name === 'query_open_reports') {
          toolResult = await local_query_open_reports(args.issue_type, args.zone, args.status);
        } else if (name === 'dispatch_volunteer') {
          toolResult = await local_dispatch_volunteer(args.report_id, args.zone);
        } else {
          toolResult = { error: 'Unknown function' };
        }
      } catch (err) {
        log('ERROR', 'AI', `Tool execution error: ${name} - ${err.message}`);
        toolResult = { error: err.message };
      }

      functionResponses.push({
        functionResponse: {
          name: name,
          response: { content: toolResult }
        }
      });
    }

    result = await chat.sendMessage(functionResponses);
    functionCalls = result.response.getFunctionCalls();
  }

  return result.response.text();
}

// Local Fallback Mock Agent with Rules Matching the Persona System Prompts
async function runFallbackMockAgent(persona, message, currentLocation, accessibilityEnabled) {
  const msgLower = message.toLowerCase();
  const location = currentLocation || [200, 420];

  if (persona === 'fan') {
    const isSpanish = (msgLower.includes('como') || msgLower.includes('cómo') || msgLower.includes('puerta') || msgLower.includes('seccion') || msgLower.includes('sección') || msgLower.includes('estadio') || msgLower.includes('congestion') || msgLower.includes('congestión') || msgLower.includes('ayuda'));
    const isFrench = (msgLower.includes('comment') || msgLower.includes('porte') || msgLower.includes('section') || msgLower.includes('retard') || (msgLower.includes('metro') && !msgLower.includes('train')) || msgLower.includes('métro'));

    // Check for Wheelchair/Stroller Access
    if (accessibilityEnabled || msgLower.includes('wheelchair') || msgLower.includes('silla') || msgLower.includes('stroller') || msgLower.includes('ramp') || msgLower.includes('rampe')) {
      const dataA2 = await local_get_accessible_route('A2');
      if (isSpanish) {
        return `He verificado las rutas de accesibilidad. La Puerta A2 está equipada con una rampa accesible en las coordenadas [${dataA2.nearest_ramp_coords.join(', ')}] y la zona de transporte compartido está en las coordenadas [${dataA2.rideshare_zone_coords.join(', ')}].`;
      } else if (isFrench) {
        return `J'ai vérifié les voies d'accès. La Porte A2 est équipée d'une rampe accessible aux coordonnées [${dataA2.nearest_ramp_coords.join(', ')}] et la zone de covoiturage se trouve à [${dataA2.rideshare_zone_coords.join(', ')}].`;
      } else {
        return `Accessibility route verified. Gate A2 features a wheelchair ramp at coordinates [${dataA2.nearest_ramp_coords.join(', ')}] and the rideshare pick-up point is situated at [${dataA2.rideshare_zone_coords.join(', ')}].`;
      }
    }

    // Check for Transit
    if (msgLower.includes('transit') || msgLower.includes('train') || msgLower.includes('metro') || msgLower.includes('bus') || msgLower.includes('shuttle') || msgLower.includes('transporte')) {
      const status = await local_get_transit_status('Inglewood');
      const linesText = status.lines.map(l => `${l.line}: ${l.status === 'delayed' ? `Delayed by ${l.delay_min} mins` : 'On Time'} (Next: ${l.next_departure})`).join(', ');
      if (isSpanish) {
        return `Estado de tránsito en tiempo real para Inglewood: ${linesText.replace('Delayed', 'Retrasado').replace('On Time', 'A tiempo')}.`;
      } else if (isFrench) {
        return `État des transports en temps réel à Inglewood: ${linesText.replace('Delayed', 'Retardé').replace('On Time', 'À l\'heure')}.`;
      } else {
        return `Real-time transit feed for Inglewood: ${linesText}.`;
      }
    }

    // Check for Section Routing
    const sectionMatch = msgLower.match(/(?:section|sección|seccion)\s*(\d+)/);
    if (sectionMatch) {
      const section = sectionMatch[1];
      const routeInfo = await local_generate_reroute('sofi_stadium', section, location, 'high');

      if (isSpanish) {
        return `${routeInfo.instructions.replace('Rerouted via', 'Redirigido por').replace('to avoid', 'para evitar').replace('congestion at', 'congestión en').replace('Walking time is approx.', 'El tiempo de caminata es aprox.')} (Sección ${section})`;
      } else if (isFrench) {
        return `${routeInfo.instructions.replace('Rerouted via', 'Redirigé via').replace('to avoid', 'pour éviter').replace('congestion at', 'encombrement à').replace('Walking time is approx.', 'Le temps de marche est d\'environ')} (Section ${section})`;
      } else {
        return `${routeInfo.instructions}`;
      }
    }

    // Conversational Intents for Fallback Agent
    if (msgLower.includes('hello') || msgLower.includes('hi') || msgLower.includes('hey') || msgLower.includes('hola') || msgLower.includes('bonjour')) {
      if (isSpanish) {
        return '¡Hola! Soy tu asistente de estadio Nexus26. ¿A qué sección vas hoy o qué información de transporte necesitas?';
      } else if (isFrench) {
        return 'Bonjour! Je suis Nexus26, votre compagnon de stade. Quelle section ou porte cherchez-vous?';
      } else {
        return 'Hello! I am Nexus26, your stadium operations companion. Which seat section or gate are you looking for?';
      }
    }

    if (msgLower.includes('food') || msgLower.includes('drink') || msgLower.includes('concession') || msgLower.includes('hungry') || msgLower.includes('restroom') || msgLower.includes('baño') || msgLower.includes('comida')) {
      if (isSpanish) {
        return 'Las concesiones de comida y los baños están disponibles en todos los niveles principales. El punto de comida más cercano está cerca de la Sección 102 (cerca de la entrada de la Puerta A1).';
      } else if (isFrench) {
        return 'Des concessions alimentaires et des toilettes sont situées à tous les niveaux. Le stand de nourriture le plus proche se trouve à côté de la Section 102.';
      } else {
        return 'Concessions, snacks, and restrooms are situated on all main stadium levels. The nearest beverage station is adjacent to Section 102.';
      }
    }

    if (msgLower.includes('exit') || msgLower.includes('leave') || msgLower.includes('salida') || msgLower.includes('salir') || msgLower.includes('sortir')) {
      if (isSpanish) {
        return 'Las salidas principales del estadio están ubicadas en las Puertas A1, A2 y B1. Consulta la ruta en el mapa para dirigirte a la salida más conveniente.';
      } else if (isFrench) {
        return 'Les sorties principales du stade sont situées aux Portes A1, A2 et B1. Veuillez consulter la carte pour l\'itinéraire de sortie le plus proche.';
      } else {
        return 'Main stadium exits are located at Gate A1, Gate A2, and Gate B1. Check your map coordinates for the closest exit route from your section.';
      }
    }

    if (msgLower.includes('thank') || msgLower.includes('gracias') || msgLower.includes('merci') || msgLower.includes('danke')) {
      if (isSpanish) {
        return '¡De nada! Disfruta del partido y avísame si necesitas algo más.';
      } else if (isFrench) {
        return 'De rien! Bon match et n\'hésitez pas si vous avez d\'autres questions!';
      } else {
        return 'You are very welcome! Have a safe match day and let me know if you need anything else!';
      }
    }

    // Check for capabilities query
    if (msgLower.includes('what') && (msgLower.includes('do') || msgLower.includes('can') || msgLower.includes('help') || msgLower.includes('feature') || msgLower.includes('service') || msgLower.includes('capability'))) {
      if (isSpanish) {
        return 'Puedo ayudarte a: 1. Navegar a cualquier sección (ej. \'Ir a la Sección 102\') | 2. Ver retrasos de metro (ej. \'¿El metro está retrasado?\') | 3. Encontrar rampas accesibles (ej. \'Rampa de silla de ruedas\') | 4. Ubicar puestos de comida.';
      } else {
        return 'I can help you: 1. Navigate to seat sections (e.g. \'Route to Section 102\') | 2. Check live transit schedules (\'Is the subway delayed?\') | 3. Find accessibility ramps (\'Wheelchair ramp\') | 4. Locate concessions and exits.';
      }
    }

    // Check for match details
    if (msgLower.includes('match') || msgLower.includes('game') || msgLower.includes('who') || msgLower.includes('play') || msgLower.includes('stadium') || msgLower.includes('partido') || msgLower.includes('juego') || msgLower.includes('equipo')) {
      if (isSpanish) {
        return 'El partido de hoy es USA contra México en el Estadio SoFi. El inicio es a las 20:00.';
      } else {
        return 'Today\'s match is USA vs. Mexico here at SoFi Stadium. Kickoff is scheduled for 20:00 local time.';
      }
    }

    // Check for compliance policy manual
    if (msgLower.includes('policy') || msgLower.includes('manual') || msgLower.includes('sop') || msgLower.includes('compliance') || msgLower.includes('threshold') || msgLower.includes('rule')) {
      if (isSpanish) {
        return 'POLÍTICA DE CUMPLIMIENTO → 1. Vaciar contenedores dentro de 15 min. 2. Puerta crítica: espera > 20 min (desviar). 3. Asistente de movilidad para sillas de ruedas.';
      } else {
        return 'COMPLIANCE POLICY → 1. Empty waste bins within 15 mins. 2. Critical gate wait time is > 20 mins. 3. Assist wheelchair requests at non-ramp gates by guiding to Gate A2/B1.';
      }
    }

    if (isSpanish) {
      return 'Modo de contingencia Nexus26. Intenta escribir una de estas opciones: \n1. \'Ir a la Sección 102\' (Navegación)\n2. \'Estado del metro\' (Transporte)\n3. \'Rampa de silla de ruedas\' (Accesibilidad)\n4. \'¿Dónde hay comida?\' (Servicios)';
    } else {
      return 'Nexus26 Offline Contingency Mode. Try typing one of these exact queries to test features:\n1. \'Route to Section 102\' (Plotted maps)\n2. \'Is the subway delayed?\' (Transit logs)\n3. \'Wheelchair access ramp\' (Accessibility path)\n4. \'Where is the food?\' (Concession guidelines)';
    }
  }

  // COMMAND CENTER PERSONA MOCK AGENT
  if (persona === 'command') {
    // Compliance SOP / Policy manual queries
    if (msgLower.includes('policy') || msgLower.includes('manual') || msgLower.includes('sop') || msgLower.includes('compliance') || msgLower.includes('threshold') || msgLower.includes('rule')) {
      return 'COMPLIANCE SOP → 1. Bins must be emptied within 15 mins of alert. 2. Critical gate wait time is > 20 mins. 3. Gate design capacity is 4,000/hr. 4. Low: <1500, Medium: 1500-2500, High: 2500-3500, Critical: >3500 count/hr.';
    }

    // 1. Congestion Questions
    if (msgLower.includes('congestion') || msgLower.includes('gate') || msgLower.includes('back') || msgLower.includes('crowd')) {
      const gates = await local_check_gate_congestion('sofi_stadium');
      const criticalGates = gates.filter(g => g.congestion_level === 'critical');
      const highGates = gates.filter(g => g.congestion_level === 'high');

      if (criticalGates.length > 0) {
        return `CRITICAL → Gate ${criticalGates[0].gate_id} is reporting ${criticalGates[0].current_count} count (${criticalGates[0].avg_wait_min}m wait) → Recommended Action: Immediately trigger fan rerouting to Gate A2 and hold subway bus departures.`;
      } else if (highGates.length > 0) {
        return `HIGH → Gate ${highGates[0].gate_id} shows ${highGates[0].current_count} count (${highGates[0].avg_wait_min}m wait) → Recommended Action: Monitor gate queue closely; prepare to direct volunteers to assist crowd flow.`;
      } else {
        return 'NORMAL → All gates showing low congestion (average wait < 4 mins) → Recommended Action: Maintain current staffing configurations.';
      }
    }

    // 2. Resource/Bin Reports
    if (msgLower.includes('bin') || msgLower.includes('trash') || msgLower.includes('overflow') || msgLower.includes('waste') || msgLower.includes('report') || msgLower.includes('alert')) {
      const reports = await local_query_open_reports(null, null, 'open');
      const binReports = reports.filter(r => r.issue_type === 'overflowing_bin');
      const surgeReports = reports.filter(r => r.issue_type === 'crowd_surge');

      if (surgeReports.length > 0) {
        return `CRITICAL → Crowd surge reported in ${surgeReports[0].zone} (${surgeReports[0].text_raw}) → Recommended Action: Dispatch security team and nearest supervisor immediately.`;
      } else if (binReports.length > 0) {
        return `ATTENTION → ${binReports.length} overflowing bin reports in ${binReports[0].zone} → Recommended Action: Dispatch sanitation crew using ID ${binReports[0].report_id} to clean the area.`;
      } else if (reports.length > 0) {
        return `WARNING → ${reports.length} pending operations reports in ${reports[0].zone} → Recommended Action: Review report ${reports[0].report_id} and dispatch volunteer.`;
      } else {
        return 'STABLE → 0 open operation reports on the logs → Recommended Action: No dispatch actions required.';
      }
    }

    // 3. Dispatch Volunteer
    const hasDispatchWord = msgLower.includes('dispatch') || msgLower.includes('send') || msgLower.includes('assign');
    const idMatch = msgLower.match(/(vr-\d+)/i);
    if (hasDispatchWord && idMatch) {
      const repId = idMatch[1].toUpperCase();
      const dispatchResult = await local_dispatch_volunteer(repId, 'General Zone');
      if (dispatchResult.error) {
        return `ERROR → Dispatch failed → Action: Report ID ${repId} not found in database.`;
      }
      return `DISPATCHED → Report ${repId} assigned to ${dispatchResult.assigned_volunteer} → Action: Volunteer en route; tracking status.`;
    }

    return 'COMMAND CORE → Nexus26 Active. Provide query:\n- Ask: "Which gates are backing up?"\n- Ask: "Which zones have overflowing bins?"\n- Command: "Dispatch volunteer to VR-1042"';
  }

  return `System active. Configured for ${persona}.`;
}

module.exports = {
  runGeminiAgent,
  runFallbackMockAgent
};
