# Changelog

All notable changes to the **Nexus26 — FIFA World Cup 2026 AI Operations Brain** project will be documented in this file.

---

## [2.1.0] - 2026-07-07

### Added

- Complete German (`DE`) language fallback triggers and translations to `lib/ai.js`'s offline contingency mock agent.
- Integration tests in `lib.test.js` covering all German translation scenarios (greetings, exits, food kiosk queries, transit schedules, and wheelchair accessibility).
- Strict linter checks to `.eslintrc.json`: added rules `"prefer-const": "error"`, `"eqeqeq": "error"`, and `"no-var": "error"` to guarantee top-tier code quality.
- Accessible keyboard interactive triggers to custom elements in `public/fan.html` (e.g. digital ticket header) with `role="button"`, `tabindex="0"`, and custom `keydown` keyhandlers.

### Fixed

- Restored standard `parseBoundedNumber` logic in `server.js` to return primitives (`undefined` for missing and `null` for invalid) instead of helper objects, resolving schema integrity issues in dynamic data stores.
- Corrected `/api/sensors/update` and `/api/transit/update` validation logic to correctly handle optional attributes and avoid bad schema mutations in local databases.
- Synchronized README documentation headings to exactly match evaluated challenge rules (`Chosen Vertical`, `Approach & Logic`, `How it works`, `Assumptions Made`).

---

## [2.0.0] - 2026-07-07

### Added

- Production-grade WebSocket heartbeat implementation on the backend using a periodic ping/pong listener to automatically clean up dead connections.
- Heartbeat interval teardown logic triggered on `server.close()` inside tests to ensure a clean Jest exit and eliminate open handle warning notices.
- Comprehensive "Challenge Submission Overview" documentation section inside the `README.md` file.

### Fixed

- Switch-case indentation formatting issues in `.eslintrc.json` (`SwitchCase: 1`) to eliminate formatting rule conflicts between ESLint and Prettier.
- Format of all frontend and backend project files using Prettier to achieve zero warning compilation.

---

## [1.5.0] - 2026-07-06

### Refactored

- Monolithic `server.js` codebase modularized. Core functionalities split into independent modules:
  - `lib/logger.js`: Custom structured logging system.
  - `lib/sanitizer.js`: XSS inputs and path sanitization.
  - `lib/database.js`: Secure JSON read/write persistence.
  - `lib/operations.js`: Operations logic, congestion ranking, and routing path algorithms.
  - `lib/ai.js`: Gemini AI integration core and contingency agents.

---

## [1.4.0] - 2026-07-06

### Added

- Jest unit testing configuration (`jest.config.js`) enforcing high coverage thresholds.
- Prettier (`.prettierrc`, `.prettierignore`) and EditorConfig (`.editorconfig`) rules.
- Test suite expanded to 79 assertions covering operations routing, validation boundaries, and REST API controllers.

---

## [1.0.0] - 2026-07-05

### Added

- Initial commit of the World Cup Stadium Operations Brain.
- Real-time WebSocket event spine.
- 3D WebGL stadium map procedural engine with OrbitControls (Three.js).
- Mobile fan-facing navigation UI (`fan.html`) and Command staff dashboard (`command.html`).
