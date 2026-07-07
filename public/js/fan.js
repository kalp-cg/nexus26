/**
 * @fileoverview Nexus26 - Fan Companion Client Controller
 * @description Manages WebSocket connectivity, chat UI, SVG/3D map toggling,
 *   voice recognition (Web Speech API), bilingual translation, accessibility
 *   routing, and real-time sensor update rendering for the mobile fan surface.
 * @version 1.0.0
 */

'use strict';

// Web Socket and State management
let socket = null;
let currentLanguage = 'en';
let accessibilityEnabled = false;
const chatHistory = [];
let activePathData = null;
let stadium3d = null;

// Node elements
const wsStatusDot = document.getElementById('ws-status');
const wsStatusText = document.getElementById('ws-text');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const voiceBtn = document.getElementById('voice-btn');
const accessToggle = document.getElementById('access-toggle');

const routePanel = document.getElementById('route-panel');
const routeHeading = document.getElementById('route-heading');
const routeBadge = document.getElementById('route-badge');
const routeTime = document.getElementById('route-time');
const routeDistance = document.getElementById('route-distance');
const routeInstructions = document.getElementById('route-instructions');
const fanPath = document.getElementById('fan-path');
const userPin = document.getElementById('user-pin');

// Speech API references
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let isSpeaking = false;

// Initialize connection and recognition
document.addEventListener('DOMContentLoaded', () => {
  connectWebSocket();
  initSpeechRecognition();
  loadSavedApiKey();
  fetchSensorBaseline();
});

// Load API Key indicator
function loadSavedApiKey() {
  const key = localStorage.getItem('gemini_api_key');
  if (key) {
    appendChatBubble('assistant', 'Gemini API Key configured. Live AI wayfinding & tools active.');
  } else {
    appendChatBubble(
      'assistant',
      'Fallback Mock-Agent active. Entering Section numbers (e.g. "Section 102") will trigger simulated routes.'
    );
  }
}

// Fetch initial gate sensor statuses to render correct colors
async function fetchSensorBaseline() {
  try {
    const res = await fetch('/api/sensors');
    const data = await res.json();
    if (data && data.gates) {
      updateGateVisuals(data.gates);
    }
  } catch (err) {
    console.error('Error fetching baseline sensors:', err);
  }
}

// WebSocket connection
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
          updateGateVisuals(msg.data.gates);

          // Auto-retrigger route check if active route is blocked by gate critical spike
          if (activePathData) {
            const activeGate = msg.data.gates.find((g) => g.gate_id === activePathData.gate_used);
            if (activeGate && activeGate.congestion_level === 'critical') {
              showSystemAlertBanner(
                `Active Route Warning: Gate ${activePathData.gate_used} has spiked to critical congestion. Rerouting path automatically.`,
                'critical'
              );
              recalculateActiveRoute();
            }
          }

          // Bind functions called from HTML attributes
          window.setLanguage = setLanguage;
          window.toggleAccessibility = toggleAccessibility;
          window.scanTicket = scanTicket;
          window.handleInputKey = handleInputKey;
          window.startVoiceAssistant = startVoiceAssistant;
          window.saveDrawerKey = saveDrawerKey;
          window.clearDrawerKey = clearDrawerKey;
          window.toggleMapView = toggleMapView;
          break;
        case 'REROUTE_FAN':
          drawReroute(msg.data);
          break;
        case 'EMERGENCY_BROADCAST':
          showSystemAlertBanner(`Emergency Broadcast: ${msg.data.message}`, 'critical');
          appendChatBubble('assistant', `Emergency Notice: ${msg.data.message}`);
          speakResponse(`Attention, safety broadcast: ${msg.data.message}`);
          break;
        case 'RESET_SYSTEM':
          updateGateVisuals(msg.data.sensors.gates);
          clearRoute();
          dismissAlertBanner();
          appendChatBubble('tool-notification', 'System metrics reset to baseline. Active paths cleared.');
          break;
        case 'DISPATCH_VOLUNTEER':
          if (activePathData && activePathData.gate_used === msg.data.zone) {
            appendChatBubble(
              'assistant',
              `Operational Alert: A service volunteer (${msg.data.assigned_volunteer}) has been dispatched to your area to assist with crowd operations.`
            );
          }
          break;
      }
    } catch (err) {
      console.error('[WS] Error processing message:', err);
    }
  };
}

// Update SVG Gate Colors
function updateGateVisuals(gates) {
  gates.forEach((gate) => {
    const circle = document.getElementById(`circle-gate-${gate.gate_id}`);
    if (circle) {
      if (gate.congestion_level === 'critical') {
        circle.setAttribute('fill', 'var(--status-red)');
        circle.setAttribute('stroke', '#fff');
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

  // Update 3D model gate markers if initialized
  if (stadium3d) {
    gates.forEach((gate) => {
      stadium3d.setGateCongestion(gate.gate_id, gate.congestion_level);
    });
  }
}

// Toggle language
function setLanguage(lang) {
  currentLanguage = lang;
  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.classList.remove('active');
    btn.setAttribute('aria-pressed', 'false');
    if (btn.textContent.toLowerCase() === lang) {
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
    }
  });

  const greetings = {
    en: 'Language set to English. How can I help you find your seat?',
    es: 'Idioma cambiado a Español. ¿Cómo puedo ayudarte a encontrar tu sección?',
    fr: 'Langue configurée en Français. Comment puis-je vous aider à trouver votre place ?',
    de: 'Sprache auf Deutsch eingestellt. Wie kann ich Ihnen helfen, Ihren Sitzplatz zu finden?',
  };

  appendChatBubble('assistant', greetings[lang]);
}

// Toggle accessibility wheelchair route
function toggleAccessibility() {
  accessibilityEnabled = !accessibilityEnabled;
  accessToggle.classList.toggle('active', accessibilityEnabled);
  accessToggle.setAttribute('aria-pressed', String(accessibilityEnabled));

  if (accessibilityEnabled) {
    accessToggle.textContent = 'Route: Accessible';
    appendChatBubble('tool-notification', 'Accessibility routing active (wheelchair ramps preferred).');
  } else {
    accessToggle.textContent = 'Route: Standard';
    appendChatBubble('tool-notification', 'Standard routing active.');
  }

  if (activePathData) {
    recalculateActiveRoute();
  }
}

// Ticket scan & collapsible controls
function toggleTicketDetails() {
  const box = document.getElementById('ticket-details-box');
  const text = document.getElementById('ticket-toggle-text');
  const isHidden = box.classList.toggle('hidden');
  text.textContent = isHidden ? '[Show]' : '[Hide]';
}

function scanTicket() {
  toggleTicketDetails();
  appendChatBubble('user', 'Accessing match ticket for seat routing.');
  queryAssistant('Direct me to Section 102');
  appendChatBubble('tool-notification', 'Ticket verified. Plotting automated route to Section 102.');
}

// System Alert Banner controls
function showSystemAlertBanner(message, type = 'critical') {
  const banner = document.getElementById('system-alert-banner');
  const title = document.getElementById('alert-banner-title');
  const msg = document.getElementById('alert-banner-msg');

  title.textContent = type === 'critical' ? 'CRITICAL SYSTEM WARNING' : 'OPERATIONAL NOTICE';
  msg.textContent = message;
  banner.classList.remove('hidden');

  if (type === 'critical') {
    banner.style.background = 'var(--status-red)';
    banner.style.color = '#fff';
  } else {
    banner.style.background = 'var(--accent-cyan)';
    banner.style.color = '#0f172a';
  }
}

function dismissAlertBanner() {
  const banner = document.getElementById('system-alert-banner');
  banner.classList.add('hidden');
}

// Chat input logic
function handleInputKey(event) {
  if (event.key === 'Enter') {
    sendTextMessage();
  }
}

async function sendTextMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';

  appendChatBubble('user', text);
  await queryAssistant(text);
}

// Append Chat Bubble Helper
function appendChatBubble(role, text) {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${role}`;
  bubble.textContent = text;
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  if (role === 'user' || role === 'assistant') {
    chatHistory.push({ role, content: text });
    if (chatHistory.length > 8) chatHistory.shift();
  }
}

// Speech recognition initial setup
function initSpeechRecognition() {
  if (!SpeechRecognition) {
    console.warn('SpeechRecognition API not supported in this browser.');
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = false;

  recognition.onstart = () => {
    voiceBtn.classList.add('listening');
    voiceBtn.textContent = 'LISTENING...';
    console.log('[Speech] Recognition started');
  };

  recognition.onend = () => {
    voiceBtn.classList.remove('listening');
    voiceBtn.textContent = 'TAP TO SPEAK';
    console.log('[Speech] Recognition stopped');
  };

  recognition.onresult = async (event) => {
    const text = event.results[0][0].transcript;
    console.log('[Speech] Transcribed result:', text);
    appendChatBubble('user', text);
    await queryAssistant(text);
  };

  recognition.onerror = (err) => {
    console.error('[Speech] Error:', err);
    voiceBtn.classList.remove('listening');
    voiceBtn.textContent = 'TAP TO SPEAK';
  };
}

function startVoiceAssistant() {
  if (isSpeaking) {
    window.speechSynthesis.cancel();
    isSpeaking = false;
    return;
  }

  if (!recognition) {
    alert('Speech recognition is not supported in this browser. Please type your request.');
    return;
  }

  const locales = { en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE' };
  recognition.lang = locales[currentLanguage] || 'en-US';

  try {
    recognition.start();
  } catch (err) {
    recognition.stop();
  }
}

// Speak response helper
function speakResponse(text) {
  if (!window.speechSynthesis) return;

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);

  const locales = { en: 'en', es: 'es', fr: 'fr', de: 'de' };
  const targetLocale = locales[currentLanguage] || 'en';

  const voices = window.speechSynthesis.getVoices();
  const matchedVoice = voices.find((v) => v.lang.startsWith(targetLocale));
  if (matchedVoice) {
    utterance.voice = matchedVoice;
  }

  utterance.onstart = () => {
    isSpeaking = true;
  };
  utterance.onend = () => {
    isSpeaking = false;
  };
  utterance.onerror = () => {
    isSpeaking = false;
  };

  window.speechSynthesis.speak(utterance);
}

// Send request to Gemini Backend
async function queryAssistant(messageText) {
  appendChatBubble('tool-notification', 'Querying Nexus26 Brain...');

  const apiKey = localStorage.getItem('gemini_api_key') || '';
  const currentPinCoords = activePathData ? activePathData.path[0] : [200, 420];

  try {
    const response = await fetch('/api/chat/fan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: messageText,
        history: chatHistory.filter((h) => h.role !== 'tool-notification'),
        userApiKey: apiKey,
        current_location: currentPinCoords,
        accessibility_enabled: accessibilityEnabled,
      }),
    });

    const result = await response.json();

    // Remove the querying loader bubble
    const notifications = document.querySelectorAll('.chat-bubble.tool-notification');
    if (notifications.length > 0) {
      notifications[notifications.length - 1].remove();
    }

    appendChatBubble('assistant', result.text);
    speakResponse(result.text);
  } catch (err) {
    console.error('Error querying assistant:', err);
    appendChatBubble('assistant', 'Communication error. Please check your network or try again.');
  }
}

// Force a route recalculation
async function recalculateActiveRoute() {
  if (!activePathData) return;
  const section = activePathData.destination_section;

  appendChatBubble('tool-notification', `Recalculating path for Section ${section}...`);

  const apiKey = localStorage.getItem('gemini_api_key') || '';
  try {
    const response = await fetch('/api/chat/fan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Direct me to Section ${section}`,
        history: [],
        userApiKey: apiKey,
        current_location: activePathData.path[0],
        accessibility_enabled: accessibilityEnabled,
      }),
    });
    const result = await response.json();
    console.log('[Recalculated Route Response]', result);
  } catch (err) {
    console.error('Recalculate route failure:', err);
  }
}

// Render dynamic path on SVG
function drawReroute(route) {
  activePathData = route;

  const coords = route.path;
  if (!coords || coords.length < 2) return;

  let dAttr = `M ${coords[0][0]} ${coords[0][1]}`;
  for (let i = 1; i < coords.length; i++) {
    dAttr += ` L ${coords[i][0]} ${coords[i][1]}`;
  }

  fanPath.setAttribute('d', dAttr);

  if (route.rerouted) {
    fanPath.setAttribute('stroke', 'var(--status-red)');
    routeBadge.textContent = 'Congestion Reroute';
    routeBadge.className = 'route-badge rerouted';
  } else {
    fanPath.setAttribute('stroke', 'var(--accent-cyan)');
    routeBadge.textContent = 'Direct Route';
    routeBadge.className = 'route-badge direct';
  }

  userPin.setAttribute('transform', `translate(${coords[0][0]}, ${coords[0][1]})`);

  // Update details card
  routeHeading.textContent = `Route to Section ${route.destination_section}`;
  routeTime.textContent = route.duration_minutes;
  routeDistance.textContent = route.distance_meters;
  routeInstructions.textContent = route.instructions;
  routePanel.classList.remove('hidden');

  appendChatBubble('tool-notification', `Path visualizer updated. Route plotted through ${route.gate_used}.`);

  // Sync with 3D model if active
  if (stadium3d) {
    stadium3d.drawPath3D(route.path, route.rerouted);
  }
}

function clearRoute() {
  activePathData = null;
  fanPath.setAttribute('d', '');
  routePanel.classList.add('hidden');
  userPin.setAttribute('transform', 'translate(200, 420)');

  if (stadium3d) {
    stadium3d.clearPath3D();
  }
}

// Header API Key Drawer (Version 2.1)
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
    appendChatBubble('tool-notification', 'Gemini API Key configured. Refreshing connection...');
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
  appendChatBubble('tool-notification', 'Gemini API Key cleared. Refreshing connection...');
  toggleApiDrawer();
  setTimeout(() => window.location.reload(), 800);
}

// Map 2D / 3D View Toggler (Version 2.2)
function toggleMapView(view) {
  const btn2D = document.getElementById('btn-view-2d');
  const btn3D = document.getElementById('btn-view-3d');
  const svgMap = document.getElementById('stadium-map');
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
      fetchSensorBaseline(); // sync gate colors in 3D
    }

    // If a path is already drawn, render it immediately in 3D
    if (activePathData) {
      stadium3d.drawPath3D(activePathData.path, activePathData.rerouted);
    }
  }
}
