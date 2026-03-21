# Board Master — Chrome Extension

Chess & board-game hint assistant with auto-play support.
Built with **Chrome Extension Manifest V3**.

---

## Quick Start

1. Clone or download this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top right corner)
4. Click **Load unpacked** and select the project folder
5. Navigate to a supported game site — the extension activates automatically
6. Click the extension icon on the toolbar to open the control popup

> **Tip:** Use **Alt+H** to toggle hints, **Alt+A** to toggle auto-play.

---

## Supported Platforms

| Platform | Game | Status | Features |
|----------|------|--------|----------|
| [chess.com](https://www.chess.com) | Chess | Active | Hints, arrow overlay, auto-play |
| [lichess.org](https://lichess.org) | Chess | Active | Hints, arrow overlay |
| [Facebook Caro](https://www.facebook.com/gaming/play/) | Gomoku | Active | Hints, full auto-play loop |
| [playok.com](https://www.playok.com) | Xiangqi / Gomoku | Planned | Game detection only |
| [xiangqi.com](https://www.xiangqi.com) | Xiangqi | Planned | Game detection only |
| [gomokuonline.com](https://gomokuonline.com) | Gomoku | Planned | Game detection only |

---

## Features

### Chess
- **Move suggestions** with evaluation scores (up to 3 lines via multiPV)
- **Arrow overlay** drawn directly on the board via SVG
- **Evaluation bar** showing win probability (sigmoid-based)
- **Auto-play** with configurable delay
- **Skill level** control (Elo 800 – 3200+)

### Gomoku (Facebook Caro)
- **Move hints** on the board — red **X** or blue **O** based on whose turn it is
- **Full auto-play loop** — queues games, plays moves, exits, and repeats
- **User side detection** — reads the footer DOM to determine if you're X (black) or O (white)
- **Rectangular board support** — handles non-square boards (e.g. 13x17):
  - Sends a padded square board to the engine (e.g. 17x17)
  - If the engine suggests outside the real board, retries with a **double-row wall pattern** that blocks unreachable cells while avoiding false threats (max 2 consecutive same-color stones in any direction)
- **Random delay** — configurable min/max range to vary auto-play timing
- **Double-click confirmation** — simulates the two-click move placement Facebook Caro requires
- **Cross-iframe injection** — content scripts run inside the `fbsbx.com` game iframe

---

## Installation

1. Clone or download this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the project folder
5. Navigate to a supported game site — the extension activates automatically

---

## Usage

- Click the extension icon to open the popup
- Hints appear automatically when a game is detected
- **Alt+H** — toggle hints on/off
- **Alt+A** — toggle auto-play mode

### Auto Mode (Gomoku)

When activated, the full auto loop runs continuously:

```
Lobby → click "Play Now"
  → Searching → wait for match
    → Playing → analyze board, place moves on your turn
      → Game Over → click "Exit"
        → back to Lobby
```

Auto mode can be started from any state (lobby, mid-game, game-over) and immediately performs the correct next action.

---

## Settings

Open via the gear icon in the popup.

### Chess

| Setting | Range | Default |
|---------|-------|---------|
| Skill Level | 0 – 20 | 20 |
| Search Depth | 1 – 15 | 12 |
| Suggestions (multiPV) | 1 / 2 / 3 | 3 |
| Auto Move Delay | 200 – 5000 ms | 1000 ms |
| Show Evaluation Bar | on / off | on |
| Show PV Lines | on / off | on |
| Show Ponder Move | on / off | on |
| Highlight Best Move | on / off | on |

### Gomoku

| Setting | Range | Default |
|---------|-------|---------|
| Board Size | 10 – 22 | 15 |
| Rule | Freestyle / Standard Renju / Free Renju | Freestyle |
| Search Depth | 1 – 15 | 10 |
| Auto Move Delay | 200 – 10000 ms | 1000 ms |
| Random Delay | on / off | off |
| Random Delay Min | 20 – 10000 ms | 200 ms |
| Random Delay Max | 20 – 10000 ms | 5000 ms |
| Highlight Best Move | on / off | on |

---

## Architecture

### Project Structure

```
chess-insight/
├── manifest.json                    # Extension manifest (MV3)
│
├── background/                      # Service worker (ES modules)
│   ├── background.js                # Entry point — commands, message routing
│   ├── api.js                       # HTTP client (Chess + Gomoku)
│   └── evaluation.js                # UCI → display conversion, eval formatting
│
├── content/                         # Content scripts (injected into game sites)
│   ├── chess/
│   │   ├── core.js                  # Shared logic: state, messaging, auto-play
│   │   ├── chesscom.js              # chess.com adapter
│   │   ├── chesscom-page.js         # chess.com page-world FEN reader (MAIN world)
│   │   ├── lichess.js               # lichess.org adapter
│   │   └── arrows.js                # SVG arrow overlay
│   ├── gomoku.js                    # Facebook Caro + gomoku platforms
│   └── xiangqi.js                   # Xiangqi (placeholder)
│
├── popup/                           # Extension popup UI
│   ├── popup.html                   # Single-page HTML with all views
│   ├── css/
│   │   ├── base.css                 # Variables, reset, layout
│   │   ├── components.css           # Buttons, toggles, dropdowns, eval bar
│   │   └── views.css                # Auto mode, settings, platforms
│   └── js/
│       ├── utils.js                 # DOM helpers, escapeHtml, capitalize
│       ├── state.js                 # DEFAULT_STATE, loadState/saveState
│       ├── navigation.js            # View router
│       ├── messaging.js             # Message listener, countdown timers
│       ├── init.js                  # Bootstrap, game detection, button wiring
│       └── views/
│           ├── main.js              # Hint display (chess & gomoku)
│           ├── auto.js              # Auto-play mode view
│           └── settings.js          # Settings form generator
│
└── icons/                           # 16/48/128 px (PNG + SVG)
```

### Data Flow

```
┌──────────────┐   FEN / board     ┌──────────────────┐   POST /api/…   ┌──────────┐
│ Content       │ ───────────────▶  │ Background        │ ─────────────▶  │ Engine   │
│ Script        │                   │ Service Worker    │                  │ API      │
│ (adapter)     │ ◀─────────────── │                   │ ◀───────────── │          │
└──────────────┘  updateHints msg  └──────────────────┘  JSON response  └──────────┘
       │                                    │
       │ gameDetected                       │ updateHints /
       │ analyzeFEN                         │ updateGomokuHints
       │ analyzeGomoku                      │
       ▼                                    ▼
                                 ┌──────────────────┐
                                 │ Popup UI          │
                                 │ (popup.html)      │
                                 └──────────────────┘
```

### Message Protocol

| Command | Direction | Payload |
|---------|-----------|---------|
| `gameDetected` | Content → BG → Popup | `{ gameType, platform }` |
| `analyzeFEN` | Content → BG | `{ fen, platform }` |
| `analyzeGomoku` | Content → BG | `{ boardSize, moves, turn, isRetry }` |
| `updateHints` | BG → Content/Popup | `{ hints[], ponder, evalScore, … }` |
| `updateGomokuHints` | BG → Content/Popup | `{ move, turn, engineTime, isRetry }` |
| `getFEN` | BG → Content | _(none)_ |
| `startAuto` / `stopAuto` | Popup → Content | _(none)_ |
| `toggleHints` | Hotkey/Popup ↔ Content | _(none)_ |

### Key Patterns

- **Adapter pattern** — `core.js` provides shared chess logic; platform adapters register via `ChessCore.register(name, { detectGame, requestFen, onGameDetected })`
- **World isolation bridge** — chess.com's board API lives in the page world; `chesscom-page.js` runs in `MAIN` world and communicates via `CustomEvent`
- **Wall retry** — for non-square gomoku boards, if the engine suggests out of bounds, retries with a double-row checkerboard wall:
  ```
  Row pattern (repeats every 4 rows):
    Row 0: ■ □ ■ □        ■ = player 1
    Row 1: □ ■ □ ■        □ = player 2
    Row 2: □ ■ □ ■        Max 2 consecutive same color
    Row 3: ■ □ ■ □        in any direction (H/V/diagonal)
  ```
- **Context invalidation guard** — gomoku content script wraps all `chrome.runtime` calls in try-catch; on context loss, cleans up observers and intervals

---

## API Reference

**Base URL:** `https://minhhoang.info`

### `POST /api/games/chess/move`

Analyze a chess position with Stockfish.

```json
{
  "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "depth": 12,
  "multiPV": 3,
  "skillLevel": 20
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fen` | string | Yes | Board position in FEN notation |
| `depth` | number | No | Search depth (1–15, default 12) |
| `multiPV` | number | No | Number of lines to return (1–3) |
| `skillLevel` | number | No | Engine skill level (0–20) |

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

### `POST /api/games/gomoku/move`

Analyze a gomoku position.

```json
{
  "boardSize": 17,
  "rule": 0,
  "moves": [
    { "x": 6, "y": 6, "player": 1 },
    { "x": 7, "y": 7, "player": 2 }
  ],
  "maxDepth": 10
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `boardSize` | number | Yes | Board dimension (square) |
| `rule` | number | No | 0 = freestyle, 1 = standard renju, 2 = free renju |
| `moves` | array | Yes | List of `{ x, y, player }` stones |
| `maxDepth` | number | No | Search depth (default 10) |

**Response:**

```json
{
  "success": true,
  "move": { "x": 8, "y": 6 },
  "engineTime": 62
}
```

---

## Adding a New Chess Platform

1. Create `content/chess/<platform>.js`:

```js
(function () {
  'use strict';

  function detectGame() {
    return !!document.querySelector('.board-component');
  }

  function requestFen() {
    return Promise.resolve(/* read FEN from DOM */);
  }

  function onGameDetected() {
    // Start polling, inject page scripts, etc.
    // Call ChessCore.handleFenChange(fen) when position changes.
  }

  ChessCore.register('platform.com', { detectGame, requestFen, onGameDetected });
})();
```

2. Add to `manifest.json` content_scripts and host_permissions.

---

## Popup UI Views

Single HTML page with 5 views toggled via `.active` class:

| View | Description | Trigger |
|------|-------------|---------|
| `view-not-detected` | "Navigate to a supported site" | No game found |
| `view-main` | Hint cards, eval bar, auto button | Game detected |
| `view-auto` | Auto-play countdown & stats | Auto mode active |
| `view-settings` | Sliders, toggles, rule dropdown | Settings clicked |
| `view-platforms` | Supported platform list | Platforms clicked |

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt + H` | Toggle Hints |
| `Alt + A` | Toggle Auto |

---
