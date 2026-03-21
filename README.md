# Board Master — Chrome Extension

Chess & board-game hint assistant with auto-play support.  
Built with **Chrome Extension Manifest V3**.

---

## Project Structure

```
chess-insight/
├── manifest.json                    # Extension manifest (MV3)
│
├── background/                      # Service worker (ES modules)
│   ├── background.js                # Entry point — commands, message routing
│   ├── api.js                       # HTTP client for the Stockfish API
│   └── evaluation.js                # UCI → display conversion, eval formatting
│
├── content/                         # Content scripts (injected into game sites)
│   ├── chess/                       # ♚ Chess — one file per platform
│   │   ├── core.js                  # Shared logic: state, messaging, auto-play, observer
│   │   ├── chesscom.js              # chess.com adapter
│   │   └── lichess.js               # lichess.org adapter
│   ├── xiangqi.js                   # ♜ Xiangqi (placeholder — coming soon)
│   └── gomoku.js                    # ⊕ Gomoku  (placeholder — coming soon)
│
├── popup/                           # Extension popup UI
│   ├── popup.html                   # Single-page HTML with all views
│   ├── css/
│   │   ├── base.css                 # Variables, reset, layout
│   │   ├── components.css           # Buttons, toggles, dropdowns, hints, eval bar
│   │   └── views.css                # Auto mode, settings, platforms styles
│   └── js/
│       ├── utils.js                 # DOM helpers ($, $$), escapeHtml, capitalize
│       ├── state.js                 # DEFAULT_STATE, loadState/saveState (chrome.storage)
│       ├── navigation.js            # View router (showView, navigateTo)
│       ├── messaging.js             # chrome.runtime message listener
│       ├── init.js                  # Bootstrap, button wiring, proactive detection
│       └── views/
│           ├── main.js              # Hint display (chess & gomoku)
│           ├── auto.js              # Auto-play mode view
│           └── settings.js          # Settings form (sliders, toggles, multiPV)
│
└── icons/                           # Extension icons (16/48/128 px, PNG + SVG)
```

---

## Architecture Overview

### Data flow

```
┌─────────────┐   FEN changed    ┌────────────────┐   POST /api/…   ┌───────────┐
│ Content      │ ──────────────▶  │ Background      │ ─────────────▶  │ Stockfish │
│ Script       │                  │ Service Worker  │                 │ API       │
│ (adapter)    │ ◀────────────── │                 │ ◀───────────── │           │
└─────────────┘  updateHints msg └────────────────┘  JSON response  └───────────┘
       │                                 │
       │ gameDetected /                  │ updateHints
       │ analyzeFEN                      │
       ▼                                 ▼
                              ┌────────────────┐
                              │ Popup UI        │
                              │ (popup.html)    │
                              └────────────────┘
```

### Message protocol

| Command           | Direction                  | Payload                                       |
| ----------------- | -------------------------- | --------------------------------------------- |
| `gameDetected`    | Content → Background → Popup | `{ gameType, platform }`                      |
| `analyzeFEN`      | Content → Background       | `{ fen, platform }`                           |
| `updateHints`     | Background → Popup/Content | `{ hints[], ponder, engineTime, evalScore, …}` |
| `getFEN`          | Background → Content       | _(none)_                                      |
| `requestAnalysis` | Popup → Background         | _(none)_                                      |
| `startAuto`       | Popup → Content            | _(none)_                                      |
| `stopAuto`        | Popup → Content            | _(none)_                                      |
| `toggleHints`     | Hotkey / Popup ↔ Content   | _(none)_                                      |
| `toggleAuto`      | Hotkey / Popup ↔ Content   | _(none)_                                      |

---

## API Reference

**Base URL:** `https://minhhoang.info`

### `POST /api/games/chess/move`

Analyze a chess position with Stockfish.

**Request body:**

```json
{
  "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "depth": 12,
  "multiPV": 3,
  "skillLevel": 20
}
```

| Field        | Type   | Required | Description                        |
| ------------ | ------ | -------- | ---------------------------------- |
| `fen`        | string | Yes      | Board position in FEN notation     |
| `depth`      | number | No       | Search depth (1–15, default: 12)   |
| `multiPV`    | number | No       | Number of lines to return (1–3)    |
| `skillLevel` | number | No       | Engine skill level (0–20)          |

**Response:**

```json
{
  "success": true,
  "bestmove": "g1f3",
  "ponder": "b8c6",
  "evaluation": { "type": "cp", "value": 35 },
  "lines": [
    { "rank": 1, "move": "g1f3", "score": 35, "pv": ["g1f3", "b8c6", "f1b5"] }
  ],
  "engineTime": 850
}
```

| Field                 | Type   | Description                                             |
| --------------------- | ------ | ------------------------------------------------------- |
| `bestmove`            | string | Best move in UCI notation (e.g. `g1f3`)                 |
| `ponder`              | string | Expected opponent reply in UCI notation                 |
| `evaluation.type`     | string | `"cp"` (centipawns) or `"mate"` (mate in N)            |
| `evaluation.value`    | number | Centipawn score, or number of moves to mate             |
| `lines[].rank`        | number | Line rank (1 = best)                                   |
| `lines[].move`        | string | First move of this line (UCI)                           |
| `lines[].score`       | number | Centipawn score for this line                           |
| `lines[].pv`          | array  | Principal variation — array of UCI moves                |
| `engineTime`          | number | Analysis time in milliseconds                           |

### `GET /api/games/chess/info`

Returns engine status and version info.

---

## Content Script — Platform Adapter Pattern

Each chess platform has different DOM structures. The adapter pattern keeps
platform-specific code isolated while sharing all common logic.

### How it works

1. **`core.js`** loads first and creates the global `ChessCore` object with:
   - State management (`lastFen`, `gameDetected`, `autoMode`)
   - `MutationObserver` for board detection
   - Message listener (handles `getFEN`, `startAuto`, `stopAuto`, etc.)
   - `handleFenChange(fen)` — deduplicates & sends `analyzeFEN` to background

2. **Platform adapter** (e.g. `chesscom.js`) loads second and calls:
   ```js
   ChessCore.register('chess.com', {
     detectGame,      // () => boolean — is a game board present?
     requestFen,      // () => Promise<string|null> — get current FEN
     onGameDetected,  // () => void — called once when board first appears
   });
   ```

3. **Manifest** pairs the files per platform:
   ```json
   { "matches": ["https://www.chess.com/*"], "js": ["content/chess/core.js", "content/chess/chesscom.js"] }
   { "matches": ["https://lichess.org/*"],   "js": ["content/chess/core.js", "content/chess/lichess.js"] }
   ```

### Adding a new chess platform

1. Create `content/chess/<platform>.js`
2. Implement the three adapter functions:

```js
// content/chess/chess24.js
(function () {
  'use strict';

  function detectGame() {
    // Return true if a game board element exists in the DOM
    return !!document.querySelector('.board-component');
  }

  function requestFen() {
    // Return a Promise that resolves to the current FEN string (or null)
    // May need page-script injection if the FEN is only on page-world objects
    return Promise.resolve(/* read FEN from DOM or page context */);
  }

  function onGameDetected() {
    // Called once when the board is first detected.
    // Use this to inject page scripts, start FEN polling, etc.
    // Call  ChessCore.handleFenChange(fen)  whenever the position changes.
  }

  ChessCore.register('chess24.com', { detectGame, requestFen, onGameDetected });
})();
```

3. Add to `manifest.json`:
```json
{
  "matches": ["https://chess24.com/*"],
  "js": ["content/chess/core.js", "content/chess/chess24.js"]
}
```

4. Add the host to `host_permissions`:
```json
"host_permissions": [
  "https://chess24.com/*",
  ...
]
```

---

## Popup UI Views

The popup uses a single HTML page with 5 view containers, toggled via CSS class `.active`:

| View ID              | Description                                  | State trigger               |
| -------------------- | -------------------------------------------- | --------------------------- |
| `view-not-detected`  | No game found — shows "Navigate to…" prompt  | Default / no chess site     |
| `view-main`          | Hint cards, eval bar, auto start button      | Game detected               |
| `view-auto`          | Auto-play mode with countdown & stats        | Auto mode enabled           |
| `view-settings`      | Sliders, toggles, multiPV selector           | Settings button clicked     |
| `view-platforms`     | Supported platform list                      | Platforms button clicked    |

### Script load order (popup.html)

Scripts are loaded as plain `<script>` tags (not ES modules) in dependency order:

1. `js/utils.js` — DOM helpers, utility functions
2. `js/state.js` — `DEFAULT_STATE`, `state` object, `loadState()`, `saveState()`
3. `js/views/main.js` — `updateMainView()`, `renderChessHints()`
4. `js/views/auto.js` — `updateAutoView()`
5. `js/views/settings.js` — `renderSettings()`, HTML helpers
6. `js/navigation.js` — `showView()`, `navigateTo()`
7. `js/messaging.js` — `sendToActiveTab()`, message listener
8. `js/init.js` — `init()`, button wiring, proactive game detection

### State persistence

All state is persisted to `chrome.storage.local` under key `boardMasterState`.
The popup loads state on open and saves after every change.

---

## Keyboard Shortcuts

| Shortcut  | Action        |
| --------- | ------------- |
| `Alt + H` | Toggle Hints  |
| `Alt + A` | Toggle Auto   |

---

## TODO / Future Work

- [ ] **Board arrow overlay** — Draw arrows from source to target square on the actual game board (content script side)
- [ ] **Auto-play move execution** — Actually click/drag pieces on the board (requires per-platform DOM interaction)
- [ ] **Xiangqi support** — Implement `content/xiangqi/` with the same adapter pattern
- [ ] **Gomoku support** — Implement `content/gomoku/` with the same adapter pattern
- [ ] **More chess platforms** — chess24.com, playchess.com, etc.
- [ ] **Error handling in popup** — Show API errors, connection issues in the UI
- [ ] **Rate limiting** — Debounce rapid FEN changes to avoid spamming the API
- [ ] **Options page** — Full-page settings as alternative to popup settings
- [ ] **Build pipeline** — Bundler (esbuild/vite), linting, zip for Web Store submission
