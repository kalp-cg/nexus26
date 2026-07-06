# Nexus26 — FIFA World Cup 2026 AI Operations Brain
### Hac2Skill Vibe Coding Submission | Built with Gemini API, WebSockets & Three.js

---

## One-Line Pitch
**Nexus26 is a bilingual pair of GenAI surfaces — a fan-facing multilingual navigation companion and a command-center intelligence dashboard — both powered by the same Gemini function-calling backbone, so a single live signal (a gate sensor spike, a delayed subway train) simultaneously reroutes fans and alerts staff in real time.**

---

## System Architecture

```mermaid
sequenceDiagram
    autonumber
    actor Fan as Fan Mobile Companion
    participant Spine as WebSocket Event Spine
    actor Staff as Command Center Dashboard
    participant Gemini as Gemini AI API / Mock Agent

    Staff->>Spine: Trigger Simulator Preset (e.g., Gate A1 Congestion Spike)
    Spine->>Spine: Save sensor state in JSON database
    Spine-->>Fan: Broadcast SENSOR_UPDATE warning
    Note over Fan: Map pulses Gate A1 red & slides warning banner
    Fan->>Gemini: Request wayfinding routing query
    Gemini->>Spine: Call tool "check_gate_congestion()"
    Spine-->>Gemini: Return state: Gate A1 is blocked, Gate A2 clear
    Gemini->>Fan: Return rerouted path coordinates & text instructions
    Note over Fan: Plot glowing 3D path via Gate A2
```

---

## Repository Hierarchy

<details>
<summary>Click to expand project folder structure</summary>

```
nexus26/
├── data/                            # Mock Database File Spine
│   ├── accessibility_routes.json    # Wheelchair ramp & rideshare locations
│   ├── fifa_compliance_manual.md    # Compliance regulations manual
│   ├── gate_sensors.json            # Dynamic gate queue wait times
│   ├── stadium_map_coords.json      # Coordinate systems for stadium sections
│   ├── transit_feeds.json           # Live transit delayed schedule updates
│   └── volunteer_reports.json       # Log of open/dispatched incident reports
├── public/                          # Frontend Static Assets
│   ├── css/
│   │   └── style.css                # Enterprise design system stylesheet
│   ├── js/
│   │   ├── command.js               # Staff dashboard handlers and simulator
│   │   ├── fan.js                   # Mobile wayfinding, voice & digital ticket
│   │   └── stadium3d.js             # Procedural 3D WebGL renderer (Three.js)
│   ├── command.html                 # Staff Command Dashboard
│   ├── fan.html                     # Mobile Fan Companion View
│   └── index.html                   # Submission Gateway Portal
├── .env.example                     # Environment variables template
├── package.json                     # Dependency manifests & startup scripts
├── server.js                        # Node/Express backend & WebSocket Spine
└── test_queries.js                  # Automated CLI query validation suite
```
</details>

---

## System Features

| Feature | Surface | Description | Technical Stack |
| :--- | :--- | :--- | :--- |
| **Interactive 3D WebGL Map** | Fan & Command | Procedurally rendered 3D stadium bowl with OrbitControls (drag to rotate, scroll to zoom, right-click to pan). Paths draw as glowing 3D tubes. | Three.js / WebGL / HTML Canvas |
| **Real-time Congestion Rerouting** | Fan Mobile | Triggering a gate congestion spike instantly alerts active fans with warning banners and redraws path lines. | WebSockets / SVG / Canvas |
| **Digital Ticket Integration** | Fan Mobile | Collapsible match ticket card. Click "Scan & Route" to automatically plot paths from transit hubs into stand sections. | HTML / Javascript |
| **Voice Translation Guide** | Fan Mobile | Speech recognition and translation guides. Speaks back wayfinding directions in Spanish, French, German, or English. | Web Speech Web API |
| **Operations KPI Stats Ribbon** | Command Center | Summary stats cards showing average gate queues, open incidents queue, and active ground volunteer counts. | HTML / CSS Grid / JS |
| **Quick Demo Presets** | Command Center | Simulator buttons to trigger Gate surges, Waste spills, or Transit delays in one click. | REST API / WebSockets |

---

## Installation & Local Startup

<details>
<summary>Click to expand local setup instructions</summary>

### Prerequisites
- Node.js (version 18 or above)
- npm (Node Package Manager)

### 1. Install Dependencies
Open a terminal in the root directory and run:
```bash
npm install
```

### 2. Configure Environment variables (Optional)
Copy `.env.example` to `.env` and add your Gemini API Key:
```bash
cp .env.example .env
```
Inside `.env`:
```env
PORT=3000
GEMINI_API_KEY=your_actual_gemini_api_key_here
```
*Note: If no key is configured, the application automatically runs in Fallback Mock-Agent Mode with full conversational wayfinding and query support.*

### 3. Run the Application
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
Open [http://localhost:3000](http://localhost:3000) to view the portal entry gateway!
</details>

---

## Live Demo Test Script

<details>
<summary>Click to expand step-by-step presentation steps</summary>

Arrange two browser windows side-by-side:
- **Window 1 (Mobile Fan)**: Open [http://localhost:3000/fan.html](http://localhost:3000/fan.html)
- **Window 2 (Dashboard)**: Open [http://localhost:3000/command.html](http://localhost:3000/command.html)

### Step 1: Render the 3D Stadium
1. In both views, click **3D Model** on the Navigation View selectors.
2. **Result**: The flat blueprint is replaced with a WebGL canvas rendering a 3D stadium bowl. Click and drag to spin the stadium. Scroll to zoom inside the bowl and see the grass pitch.

### Step 2: Auto-Route the Match Ticket
1. In the Fan view (Window 1), click **Digital Match Ticket** at the top -> **Scan & Route**.
2. **Result**: A glowing cyan 3D tube path is plotted. It starts at the Transit station ring, walks on the grass perimeter to Gate A1, and climbs up the stairs of the stands to Section 102!

### Step 3: Trigger a Gate Surge Alert
1. In the Command view (Window 2), go to **Quick Scenario Presets** and click **1. Gate Surge**.
2. **Result**: 
   - Gate A1 flashes red and pulses on both maps.
   - The Fan companion (Window 1) slides down a red warning banner.
   - The path line on the map **instantly redraws in red to navigate via Gate A2 instead**, updating the spoken instructions.

### Step 4: Toggle Map Layers & Dispatch Volunteers
1. In the Command view (Window 2), click **2. Trash Hazard** on the presets board.
2. **Result**: 
   - Stand circle **S118** highlights in amber on the heatmap.
   - The active map layer automatically swaps to **Waste** so staff can identify the location.
3. In the live alerts feed, click **Dispatch Volunteer** on the newly created ticket. The status changes to "En Route" and a dispatch notification is pushed to the Fan companion.
</details>

---

## Automated CLI Query Test
To instantly validate query routing, run this command in your terminal while the server is active:
```bash
node test_queries.js
```
It tests 7 typical scenarios (asking about bottlenecks, overflowing garbage bins, wheelchair ramps, transit schedules, and volunteer dispatch requests) and validates the structured output.
