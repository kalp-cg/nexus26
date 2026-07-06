# Nexus26 — FIFA World Cup 2026 AI Operations Brain
### Hac2Skill Vibe Coding Submission | Built with Gemini API & Google Antigravity

Nexus26 is a real-time stadium operations platform featuring two primary user surfaces powered by a single backend spine:
1. **The Global Fan Companion**: A mobile-first translation and navigation surface featuring dynamic pathfinding, digital match tickets, voice guides, accessibility-first routing, and an interactive 3D WebGL stadium map.
2. **The Venue Command Center**: An enterprise-grade staff dashboard featuring real-time KPI summary blocks, visual map layers, a simulator presets board, a live volunteer alert feed, and a natural language command console.

Both interfaces are synchronized in real-time via a WebSocket event spine, illustrating the loop of crowd sensor updates dynamically rerouting fans and updating staff simultaneously.

---

## 📁 Repository Folder Structure

The project follows a clean, professional Node.js structure:

```
nexus26/
├── data/                            # Mock Database Layer (JSON & MD)
│   ├── accessibility_routes.json    # Wheelchair ramp & rideshare coordinates
│   ├── fifa_compliance_manual.md    # FIFA venue compliance guidelines manual
│   ├── gate_sensors.json            # Live gate counts and wait times
│   ├── stadium_map_coords.json      # Coordinate systems for isometric nodes
│   ├── transit_feeds.json           # Live transit departures and delay feeds
│   └── volunteer_reports.json       # Log of open/dispatched incident reports
├── public/                          # Frontend Static Assets
│   ├── css/
│   │   └── style.css                # Unified enterprise design system stylesheet
│   ├── js/
│   │   ├── command.js               # Command dashboard interaction, KPIs, and simulator
│   │   ├── fan.js                   # Fan wayfinding, voice recognition, and digital ticket
│   │   └── stadium3d.js             # Procedural 3D WebGL stadium renderer (Three.js)
│   ├── command.html                 # Staff Command Dashboard View
│   ├── fan.html                     # Mobile Fan Companion View
│   └── index.html                   # Submission Gateway / Entrance Portal
├── .env.example                     # Environment variables template
├── package.json                     # Dependency manifests & startup scripts
├── server.js                        # Node/Express backend & WebSocket Spine
└── test_queries.js                  # Automated CLI query validation suite
```

---

## ⚙️ Key Technical Features

- **Interactive 3D WebGL Stadium (Three.js)**: Users can toggle from the flat `2D Blueprint` to a fully interactive `3D Model` (using OrbitControls). Zoom inside the stands, click-and-drag to rotate the arena, and watch walking paths draw as glowing 3D tubes climbing up into the seating tiers in real-time.
- **Operations KPI Summary Cards**: Real-time stats panels at the top of the command center track Average wait times, Active incident counts, Volunteer forces, and Transit health.
- **Quick Demo Scenario Presets**: One-click preset triggers in the command dashboard allow simulating complex matchday scenarios:
  - *Gate Surge*: Spikes Gate A1 to critical, logs a surge report, and triggers fan rerouting alerts.
  - *Trash Hazard*: Logs an overflowing recycling bin and toggles the heatmap to the Waste Alerts layer to highlight stands Section 118 in amber.
  - *Metro Delay*: Delays the subway departures, logs an incident, and broadcasts travel notices.
- **Unified API Key Configuration Drawer**: Built into the header of all pages. Judges can paste their Google AI Studio API key directly into the UI to save it to local storage and activate live Gemini features.
- **Fail-safe Mock Agent**: If no Gemini API Key is configured, a rule-based fallback agent processes conversational queries (greetings, exits, food location, match details) and executes local tool functions automatically.
- **Bilingual Speech Integration**: Uses browser-native Web Speech APIs to recognize spoken wayfinding requests in English/Spanish and speak back directions using localized synthesis.
- **Automated CLI Query Test Suite**: A validation script (`node test_queries.js`) that verifies typical user queries against local endpoints, ensuring correct function call routing.

---

## 🛠️ Installation & Setup

### Prerequisites
- Node.js (version 18 or above)
- npm (Node Package Manager)

### Step 1: Install Dependencies
Open a terminal in the root directory and run:
```bash
npm install
```

### Step 2: Run the Application
Start the server:
```bash
npm start
```
The console will log:
```
=======================================================
 Nexus26 - World Cup Operations Spine Server
 Running on: http://localhost:3000
 WebSocket Spine: ws://localhost:3000
=======================================================
```
Open [http://localhost:3000](http://localhost:3000) to view the entry portal gateway!

---

## 🧪 Demonstration & Testing

### 1. Automated CLI Query Test
To instantly validate query routing, run this command in your terminal while the server is active:
```bash
node test_queries.js
```
It tests 7 typical scenarios (asking about bottlenecks, overflowing garbage bins, wheelchair ramps, transit schedules, and volunteer dispatch requests) and validates the structured output.

### 2. Live Demo Script (Arranged Side-by-Side)
Arrange two browser windows side-by-side:
- **Window 1 (Mobile Fan)**: Open [http://localhost:3000/fan.html](http://localhost:3000/fan.html)
- **Window 2 (Dashboard)**: Open [http://localhost:3000/command.html](http://localhost:3000/command.html)

#### Scenario A: Match Ticket Auto-Routing
1. In the Fan view (Window 1), click **Digital Match Ticket** at the top -> **Scan & Route**.
2. **Observation**: A path is immediately plotted from the Transit station, through Gate A1, climbing up to Section 102 stands on the map (try toggling to **3D Model** to see it climb!).

#### Scenario B: Live Congestion Rerouting
1. In the Command view (Window 2), go to **Quick Scenario Presets** and click **1. Gate Surge**.
2. **Observation**: 
   - Gate A1 flashes red and pulses on both maps.
   - The Fan companion (Window 1) slides down a red warning banner.
   - The path line on the map **instantly redraws in red to navigate via Gate A2 instead**, updating the spoken and written instructions.

#### Scenario C: Visual Map Layer Toggles
1. In the Command view (Window 2), click **2. Trash Hazard** on the presets board.
2. **Observation**: 
   - Stand circle **S118** immediately highlights in amber on the heatmap.
   - The active map layer automatically swaps to **Waste** so staff can identify the location of the report. Toggle back to **Crowd** to restore gate indicators.
