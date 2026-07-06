/**
 * @fileoverview Nexus26 - Command Center Dashboard Controller
 * @description Manages the staff operations dashboard including WebSocket event
 *   consumption, KPI stat counters, scenario simulation presets, live alert feeds,
 *   volunteer dispatch workflows, and the natural-language operations console.
 * @version 1.0.0
 */

/* eslint-disable no-unused-vars */

'use strict';

// State and connection
let socket = null;
let chatHistory = [];
let activeReports = [];
let activeMapLayer = 'crowd';
const savedApiKey = localStorage.getItem('gemini_api_key') || '';
let stadium3d = null;
let currentMapView = '2d';

// Node elements
const wsStatusDot = document.getElementById('ws-status');
const wsStatusText = document.getElementById('ws-text');
const consoleMessages = document.getElementById('console-messages');
const consoleInput = document.getElementById('console-input');
const alertsList = document.getElementById('alerts-list');
const activeAlertCount = document.getElementById('active-alert-count');
const agentModeLabel = document.getElementById('agent-mode');

// Init
document.addEventListener('DOMContentLoaded', () => {
  connectWebSocket();
  fetchInitialData();
  configureAgentModeLabel();
  // Pre-load drawer input if key exists
  const input = document.getElementById('drawer-api-key');
  if (input) input.value = savedApiKey;
});

// Configure Agent Mode UI
function configureAgentModeLabel() {
  if (savedApiKey) {
    agentModeLabel.textContent = 'GEMINI ACTIVE';
    agentModeLabel.className = 'key-status-label status-configured';
  } else {
    agentModeLabel.textContent = 'FALLBACK AGENT ACTIVE';
    agentModeLabel.className = 'key-status-label status-idle';
  }
}

// WebSocket Connection
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    wsStatusDot.className = 'status-dot connected';
    wsStatusText.textContent = 'Spine Connected';
    console.log('[WS] Connected to operations spine');
  };

  socket.onclose = () => {
    wsStatusDot.className = 'status-dot';
    wsStatusText.textContent = 'Disconnected';
    console.log('[WS] Disconnected, retrying in 3s...');
    setTimeout(connectWebSocket, 3000);
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      console.log('[WS] Received message:', msg);

      switch (msg.type) {
        case 'SENSOR_UPDATE':
          updateHeatmapVisuals(msg.data.gates);
          updateTestBenchCounters(msg.data.gates);
          // Check if any gates just crossed into critical and push an operational alert
          msg.data.gates.forEach((gate) => {
            if (gate.congestion_level === 'critical') {
              pushSystemAlert(
                `Gate ${gate.gate_id} count surge (${gate.current_count}/hr). Wait time: ${gate.avg_wait_min}m.`
              );
            }
          });
          updateKpiStats();
          break;
        case 'NEW_REPORT':
          activeReports.unshift(msg.data);
          prependAlertToFeed(msg.data);
          updateAlertCounter();
          refreshMapLayerHighlights();
          updateKpiStats();
          break;
        case 'DISPATCH_VOLUNTEER': {
          const rep = activeReports.find((x) => x.report_id === msg.data.report_id);
          if (rep) {
            rep.status = msg.data.status;
            rep.assigned_volunteer = msg.data.assigned_volunteer;
          }
          updateAlertDispatchStatus(msg.data);
          updateAlertCounter();
          refreshMapLayerHighlights();
          updateKpiStats();
          break;
        }
        case 'EMERGENCY_BROADCAST':
          appendConsoleBubble('assistant', `EMERGENCY ALERT BROADCASTED: "${msg.data.message}"`);
          break;
        case 'TRANSIT_UPDATE':
          updateKpiStats();
          break;
        case 'RESET_SYSTEM':
          activeReports = msg.data.reports || [];
          updateHeatmapVisuals(msg.data.sensors.gates);
          updateTestBenchCounters(msg.data.sensors.gates);
          loadReportsList(activeReports);
          updateAlertCounter();
          refreshMapLayerHighlights();
          updateKpiStats();
          appendConsoleBubble('assistant', 'SYSTEM DATA RESET: Baseline operating metrics loaded. Sensors normalized.');
          break;
      }
    } catch (err) {
      console.error('[WS] Error processing message:', err);
    }
  };
}

// Fetch baseline data
async function fetchInitialData() {
  try {
    // Fetch sensors
    const sensorRes = await fetch('/api/sensors');
    const sensorData = await sensorRes.json();
    if (sensorData && sensorData.gates) {
      updateHeatmapVisuals(sensorData.gates);
      updateTestBenchCounters(sensorData.gates);
    }

    // Fetch reports
    const reportRes = await fetch('/api/reports');
    const reportData = await reportRes.json();
    if (reportData) {
      loadReportsList(reportData);
    }

    updateKpiStats();
  } catch (err) {
    console.error('Error fetching initial data:', err);
  }
}

// Update Heatmap colors based on live signals
function updateHeatmapVisuals(gates) {
  gates.forEach((gate) => {
    const circle = document.getElementById(`hcircle-gate-${gate.gate_id}`);
    if (circle) {
      if (gate.congestion_level === 'critical') {
        circle.setAttribute('fill', 'var(--status-red)');
        circle.setAttribute('stroke', '#fff');
        // Add a pulsing effect to critical gates
        circle.innerHTML = '<animate attributeName="opacity" values="1;0.4;1" dur="1s" repeatCount="indefinite" />';
      } else if (gate.congestion_level === 'high') {
        circle.setAttribute('fill', '#ff7a00');
        circle.removeAttribute('stroke');
        circle.innerHTML = '';
      } else {
        circle.setAttribute('fill', 'var(--status-green)');
        circle.removeAttribute('stroke');
        circle.innerHTML = '';
      }
    }
  });

  // Sync with 3D model gate markers if initialized
  if (stadium3d) {
    gates.forEach((gate) => {
      stadium3d.setGateCongestion(gate.gate_id, gate.congestion_level);
    });
  }
}

// Update simulator counters and buttons active state
function updateTestBenchCounters(gates) {
  gates.forEach((gate) => {
    const countLbl = document.getElementById(`lbl-count-${gate.gate_id}`);
    const waitLbl = document.getElementById(`lbl-wait-${gate.gate_id}`);
    if (countLbl) countLbl.textContent = gate.current_count;
    if (waitLbl) waitLbl.textContent = gate.avg_wait_min;

    // Toggle active state classes of buttons
    const row = document.getElementById(`bench-gate-${gate.gate_id}`);
    if (row) {
      const btns = row.querySelectorAll('.ctrl-btn');
      btns.forEach((btn) => {
        btn.classList.remove('active-low', 'active-high', 'active-critical');
        const text = btn.textContent.toLowerCase();
        if (text === 'low' && gate.congestion_level === 'low') btn.classList.add('active-low');
        if (text === 'high' && gate.congestion_level === 'high') btn.classList.add('active-high');
        if (text === 'spike' && gate.congestion_level === 'critical') btn.classList.add('active-critical');
      });
    }
  });
}

// Trigger sensor update (Test Bench)
async function simulateSensor(gateId, level, count, wait) {
  try {
    const res = await fetch('/api/sensors/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gate_id: gateId,
        congestion_level: level,
        current_count: count,
        avg_wait_min: wait,
      }),
    });
    const result = await res.json();
    console.log('[Simulator Sensor Update Result]', result);
    updateKpiStats();
  } catch (err) {
    console.error('Error simulating sensor:', err);
  }
}

// Load volunteer reports list
function loadReportsList(reports) {
  activeReports = reports || [];
  alertsList.innerHTML = '';
  activeReports.forEach((report) => {
    prependAlertToFeed(report);
  });
  updateAlertCounter();
  refreshMapLayerHighlights();
}

// Helper to update alerts count header
function updateAlertCounter() {
  const openCount = alertsList.querySelectorAll('.alert-item:not(.severity-dispatched)').length;
  if (openCount === 0) {
    activeAlertCount.textContent = '0 Alerts';
    activeAlertCount.className = 'key-status-label status-configured';
  } else {
    activeAlertCount.textContent = `${openCount} Active Alert${openCount > 1 ? 's' : ''}`;
    activeAlertCount.className = 'key-status-label status-idle';
  }
}

// Append volunteer or system alert cards to queue
function prependAlertToFeed(report) {
  const item = document.createElement('div');
  item.id = `alert-${report.report_id}`;

  const date = new Date(report.timestamp);
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const isDispatched = report.status === 'dispatched';
  const severityClass = isDispatched ? 'severity-dispatched' : `severity-${report.status}`;

  let labelPrefix = 'INFO';
  let badgeText = 'report';
  let badgeClass = 'info';

  if (report.issue_type === 'overflowing_bin') {
    labelPrefix = 'WASTE';
    badgeText = 'sustainability';
    badgeClass = 'warning';
  } else if (report.issue_type === 'crowd_surge') {
    labelPrefix = 'SURGE';
    badgeText = 'crowd surge';
    badgeClass = 'danger';
  } else if (report.issue_type === 'medical') {
    labelPrefix = 'MEDICAL';
    badgeText = 'medical alert';
    badgeClass = 'danger';
  } else if (report.issue_type === 'accessibility_blocked') {
    labelPrefix = 'ACCESS';
    badgeText = 'accessibility';
    badgeClass = 'warning';
  }

  item.className = `alert-item ${severityClass}`;
  item.innerHTML = `
    <div class="alert-meta">
      <span>ID: <strong>${report.report_id}</strong> (${report.volunteer_id})</span>
      <span>${timeStr}</span>
    </div>
    <div class="alert-text">
      <strong>[${labelPrefix}] ${report.zone}</strong>: ${report.text_raw}
    </div>
    <div class="alert-meta" style="margin-top: 0.25rem;">
      <span class="alert-badge ${badgeClass}">${badgeText}</span>
      <span id="assignee-${report.report_id}" style="font-style: italic;">
        ${isDispatched ? `Assigned: ${report.assigned_volunteer}` : 'Status: Open'}
      </span>
    </div>
    <div class="alert-action-row">
      <button class="alert-dispatch-btn" id="btn-dispatch-${report.report_id}" 
        onclick="dispatchVolunteer('${report.report_id}')" ${isDispatched ? 'disabled' : ''}>
        ${isDispatched ? 'En Route' : 'Dispatch Volunteer'}
      </button>
    </div>
  `;

  alertsList.prepend(item);
}

// Push system sensor warning to alerts queue
function pushSystemAlert(message) {
  const existingAlert = Array.from(alertsList.querySelectorAll('.alert-text')).some((el) =>
    el.textContent.includes(message.substring(0, 30))
  );
  if (existingAlert) return;

  const item = document.createElement('div');
  item.className = 'alert-item severity-critical';

  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  item.innerHTML = `
    <div class="alert-meta">
      <span>ID: SYSTEM ALERT</span>
      <span>${timeStr}</span>
    </div>
    <div class="alert-text">
      <strong>[SENSOR ALERT]</strong>: ${message}
    </div>
    <div class="alert-meta" style="margin-top: 0.25rem;">
      <span class="alert-badge danger">CROWD WARNING</span>
      <span>Status: Unresolved</span>
    </div>
  `;
  alertsList.prepend(item);
  updateAlertCounter();
}

// Update report card once volunteer is assigned
function updateAlertDispatchStatus(report) {
  const card = document.getElementById(`alert-${report.report_id}`);
  if (card) {
    card.className = 'alert-item severity-dispatched';
    const btn = document.getElementById(`btn-dispatch-${report.report_id}`);
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'En Route';
    }
    const assignee = document.getElementById(`assignee-${report.report_id}`);
    if (assignee) {
      assignee.textContent = `Assigned: ${report.assigned_volunteer}`;
    }
  }
}

// Dispatch Volunteer Action
async function dispatchVolunteer(reportId) {
  try {
    const res = await fetch('/api/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report_id: reportId }),
    });
    const result = await res.json();
    console.log('[Dispatch Result]', result);
    updateKpiStats();
  } catch (err) {
    console.error('Error dispatching volunteer:', err);
  }
}

// On-ground Volunteer filing custom report (Form Action)
async function submitVolunteerReport() {
  const zone = document.getElementById('report-zone').value;
  const issue_type = document.getElementById('report-type').value;
  const text_raw = document.getElementById('report-text').value.trim();

  if (!text_raw) {
    alert('Please enter issue details.');
    return;
  }

  document.getElementById('report-text').value = '';

  try {
    const res = await fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zone, issue_type, text_raw }),
    });
    const result = await res.json();
    console.log('[Volunteer Report Submit Result]', result);
    updateKpiStats();
  } catch (err) {
    console.error('Error submitting report:', err);
  }
}

// Chat input operations query console
function handleConsoleKey(event) {
  if (event.key === 'Enter') {
    sendConsoleCommand();
  }
}

async function sendConsoleCommand() {
  const query = consoleInput.value.trim();
  if (!query) return;
  consoleInput.value = '';

  appendConsoleBubble('user', query);
  appendConsoleBubble('assistant', 'PROCESSING OPERATION QUERY...');

  try {
    const res = await fetch('/api/chat/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: query,
        history: chatHistory,
        userApiKey: savedApiKey,
      }),
    });
    const result = await res.json();

    const messages = consoleMessages.querySelectorAll('.console-bubble.assistant');
    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.textContent.includes('PROCESSING')) {
        lastMsg.remove();
      }
    }

    appendConsoleBubble('assistant', result.text);
  } catch (err) {
    console.error('Error sending query:', err);
    // Remove loader
    const messages = consoleMessages.querySelectorAll('.console-bubble.assistant');
    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.textContent.includes('PROCESSING')) lastMsg.remove();
    }
    appendConsoleBubble('assistant', 'Command console communication timeout.');
  }
}

// Append message bubbles to Console panel
function appendConsoleBubble(role, text) {
  const bubble = document.createElement('div');
  bubble.className = `console-bubble ${role}`;
  bubble.innerHTML = `<pre>${text}</pre>`;
  consoleMessages.appendChild(bubble);
  consoleMessages.scrollTop = consoleMessages.scrollHeight;

  // Track history
  if (role === 'user' || role === 'assistant') {
    chatHistory.push({ role, content: text });
    if (chatHistory.length > 10) chatHistory.shift();
  }
}

// Reset System State
async function resetSystemState() {
  if (confirm('Are you sure you want to reset all sensors, volunteer alerts, and paths to baseline defaults?')) {
    try {
      const res = await fetch('/api/reset', { method: 'POST' });
      const result = await res.json();
      console.log('[System Reset Result]', result);
      updateKpiStats();
    } catch (err) {
      console.error('Error resetting system state:', err);
    }
  }
}

// Visual Map Layer Controls (Version 2)
function setMapLayer(layerName) {
  activeMapLayer = layerName;

  document.getElementById('layer-btn-crowd').classList.remove('active-low');
  document.getElementById('layer-btn-waste').classList.remove('active-low');
  document.getElementById('layer-btn-security').classList.remove('active-low');
  document.getElementById('layer-btn-crowd').setAttribute('aria-pressed', 'false');
  document.getElementById('layer-btn-waste').setAttribute('aria-pressed', 'false');
  document.getElementById('layer-btn-security').setAttribute('aria-pressed', 'false');

  const activeBtn = document.getElementById(`layer-btn-${layerName}`);
  if (activeBtn) {
    activeBtn.classList.add('active-low');
    activeBtn.setAttribute('aria-pressed', 'true');
  }

  refreshMapLayerHighlights();
}

function refreshMapLayerHighlights() {
  // Clear existing highlights on section circles
  document.querySelectorAll('.section-label circle').forEach((circle) => {
    circle.classList.remove('section-highlight-active', 'section-highlight-warning');
  });

  if (activeMapLayer === 'crowd') return; // Rely on gate circles

  activeReports.forEach((report) => {
    if (report.status === 'dispatched') return; // Skip resolved/assigned logs for mapping clutter

    const zoneText = report.zone.toLowerCase();
    const detailText = report.text_raw.toLowerCase();

    let sectionMatched = null;
    const match = (zoneText + ' ' + detailText).match(/(?:sec-|section|s|sección|seccion)\s*(\d+)/i);
    if (match) {
      sectionMatched = match[1];
    } else if (zoneText.includes('concourse')) {
      if (zoneText.includes('north')) sectionMatched = '118';
      else if (zoneText.includes('south')) sectionMatched = '102';
    }

    if (sectionMatched) {
      const secCircleG = document.getElementById(`sec-${sectionMatched}`);
      if (secCircleG) {
        const circle = secCircleG.querySelector('circle');
        if (circle) {
          if (activeMapLayer === 'waste' && report.issue_type === 'overflowing_bin') {
            circle.classList.add('section-highlight-warning');
          } else if (
            activeMapLayer === 'security' &&
            (report.issue_type === 'crowd_surge' ||
              report.issue_type === 'medical' ||
              report.issue_type === 'accessibility_blocked')
          ) {
            circle.classList.add('section-highlight-active');
          }
        }
      }
    }
  });
}

// Emergency Broadcast triggers
async function sendEmergencyBroadcast() {
  const input = document.getElementById('broadcast-msg-input');
  const message = input.value.trim();
  if (!message) {
    alert('Please enter a broadcast message.');
    return;
  }

  input.value = '';

  try {
    const res = await fetch('/api/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const result = await res.json();
    if (!result.success) {
      alert('Failed to transmit broadcast alert.');
    }
  } catch (err) {
    console.error('Error broadcasting message:', err);
    alert('Failed to transmit broadcast alert.');
  }
}

// ==========================================
// KPI & Simulator Scenario Additions (V2.1)
// ==========================================

async function updateKpiStats() {
  const waitEl = document.getElementById('kpi-wait-avg');
  const incidentsEl = document.getElementById('kpi-incidents-count');
  const volunteersEl = document.getElementById('kpi-volunteers-count');
  const transitEl = document.getElementById('kpi-transit-status');

  if (!waitEl) return;

  // 1. Avg Wait Time KPI
  try {
    const res = await fetch('/api/sensors');
    const data = await res.json();
    if (data && data.gates) {
      let totalWait = 0;
      data.gates.forEach((g) => (totalWait += g.avg_wait_min));
      const avg = (totalWait / data.gates.length).toFixed(1);
      waitEl.textContent = `${avg}m avg`;

      waitEl.className = 'kpi-value';
      if (parseFloat(avg) > 15) waitEl.classList.add('critical');
      else if (parseFloat(avg) > 8) waitEl.classList.add('warning');
      else waitEl.classList.add('stable');
    }
  } catch (e) {
    console.error(e);
  }

  // 2. Open Incidents KPI
  const openCount = activeReports.filter((r) => r.status !== 'dispatched').length;
  incidentsEl.textContent = `${openCount} Open`;
  incidentsEl.className = 'kpi-value';
  if (openCount > 2) incidentsEl.classList.add('critical');
  else if (openCount > 0) incidentsEl.classList.add('warning');
  else incidentsEl.classList.add('stable');

  // 3. Volunteer headcounts
  const dispatchedCount = activeReports.filter((r) => r.status === 'dispatched').length;
  const available = Math.max(0, 4 - dispatchedCount);
  volunteersEl.textContent = `${available} Available`;
  volunteersEl.className = 'kpi-value';
  if (available === 0) volunteersEl.classList.add('warning');
  else volunteersEl.classList.add('stable');

  // 4. Transit spine delay warnings
  try {
    const res = await fetch('/api/transit');
    const data = await res.json();
    if (data && data.lines) {
      const hasDelay = data.lines.some((l) => l.status === 'delayed');
      if (hasDelay) {
        transitEl.textContent = 'Transit Delayed';
        transitEl.className = 'kpi-value warning';
      } else {
        transitEl.textContent = '100% Stable';
        transitEl.className = 'kpi-value stable';
      }
    }
  } catch (e) {
    console.error(e);
  }
}

// Trigger Simulator Demo Presets
async function triggerScenario(type) {
  appendConsoleBubble('assistant', `SIMULATING OPERATION PRESET: "${type.toUpperCase()}"`);

  if (type === 'surge') {
    // 1. Critical bottleneck at Gate A1
    await simulateSensor('A1', 'critical', 3820, 22);
    // 2. File surge report
    try {
      await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          zone: 'Gate A1 Entrance',
          issue_type: 'crowd_surge',
          text_raw: 'Critical crowd congestion buildup. Dynamic turnstiles experiencing slow read rates.',
        }),
      });
    } catch (e) {
      console.error(e);
    }
    // 3. Broadcast safety warning
    try {
      await fetch('/api/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Gate A1 is CLOSED due to heavy congestion. All ticket holders redirect to Gate A2.',
        }),
      });
    } catch (e) {
      console.error(e);
    }

    appendConsoleBubble(
      'assistant',
      'Surge Preset executed. Gate A1 red heatmap pulsed, staff logged report, and fan companions rerouted.'
    );
  } else if (type === 'waste') {
    // 1. File overflowing bin report at Section 118
    try {
      await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          zone: 'North Concourse (S118)',
          issue_type: 'overflowing_bin',
          text_raw: 'Overflowing recycle bins next to concession stand 4; waste spilling onto concourse corridor.',
        }),
      });
    } catch (e) {
      console.error(e);
    }

    // 2. Switch map layer to show waste alerts
    setMapLayer('waste');

    appendConsoleBubble(
      'assistant',
      'Waste Preset executed. Incident ticket queued and map layer auto-switched to highlight Section 118.'
    );
  } else if (type === 'transit') {
    // 1. Delay subway line K
    try {
      await fetch('/api/transit/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line: 'K Line', status: 'delayed', delay_min: 25 }),
      });
    } catch (e) {
      console.error(e);
    }
    // 2. File transit report
    try {
      await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          zone: 'Transit Hub',
          issue_type: 'other',
          text_raw: 'Inglewood subway Line K delayed 25m. Transit staff coordinating additional bus shuttles.',
        }),
      });
    } catch (e) {
      console.error(e);
    }
    // 3. Broadcast travel notice
    try {
      await fetch('/api/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Subway Line K delayed 25m. Please proceed to shuttle bus gates for route connections.',
        }),
      });
    } catch (e) {
      console.error(e);
    }

    appendConsoleBubble(
      'assistant',
      'Transit Preset executed. Live schedule delay posted, incident ticket logged, and fans notified.'
    );
  }
}

// Unified header key configuration drawer
function toggleApiDrawer() {
  const drawer = document.getElementById('api-key-drawer');
  const input = document.getElementById('drawer-api-key');
  const isHidden = drawer.classList.toggle('hidden');
  if (!isHidden) {
    input.value = localStorage.getItem('gemini_api_key') || '';
    input.focus();
  }
}

function saveDrawerKey() {
  const input = document.getElementById('drawer-api-key');
  const key = input.value.trim();
  if (key) {
    localStorage.setItem('gemini_api_key', key);
    appendConsoleBubble('assistant', 'Gemini API Key configured via header drawer. Reloading panels...');
    toggleApiDrawer();
    setTimeout(() => window.location.reload(), 800);
  } else {
    alert('Please enter a valid API key.');
  }
}

function clearDrawerKey() {
  localStorage.removeItem('gemini_api_key');
  const input = document.getElementById('drawer-api-key');
  if (input) input.value = '';
  appendConsoleBubble('assistant', 'Gemini API Key cleared. Reloading panels...');
  toggleApiDrawer();
  setTimeout(() => window.location.reload(), 800);
}

// Map 2D / 3D View Toggler (Version 2.2)
function toggleMapView(view) {
  currentMapView = view;

  const btn2D = document.getElementById('btn-view-2d');
  const btn3D = document.getElementById('btn-view-3d');
  const svgMap = document.getElementById('stadium-heatmap');
  const threeContainer = document.getElementById('three-container');

  btn2D.classList.remove('active-low');
  btn3D.classList.remove('active-low');
  btn2D.setAttribute('aria-pressed', 'false');
  btn3D.setAttribute('aria-pressed', 'false');

  if (view === '2d') {
    btn2D.classList.add('active-low');
    btn2D.setAttribute('aria-pressed', 'true');
    svgMap.classList.remove('hidden');
    threeContainer.classList.add('hidden');
  } else {
    btn3D.classList.add('active-low');
    btn3D.setAttribute('aria-pressed', 'true');
    svgMap.classList.add('hidden');
    threeContainer.classList.remove('hidden');

    // Initialize 3D on-demand
    if (!stadium3d) {
      stadium3d = new Stadium3D('three-container');
      fetchInitialData(); // sync gate colors
    }
  }
}
