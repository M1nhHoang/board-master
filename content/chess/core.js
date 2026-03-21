// ─── Chess Content Script — Shared Core ───
// Platform-agnostic logic: state, messaging, auto-play, observer.
// Loaded BEFORE the platform adapter (chesscom.js / lichess.js / ...).
// Each adapter must call  ChessCore.register({ ... })  to plug in.

// eslint-disable-next-line no-var
var ChessCore = (function () {
  'use strict';

  let platform = '';
  let lastFen = '';
  let lastBestUci = '';
  let gameDetected = false;
  let autoMode = false;
  let autoTimerId = null;

  // Platform adapter — filled by register()
  let adapter = {
    detectGame: () => false,
    requestFen: () => Promise.resolve(null),
    onGameDetected: () => {},
    performMove: () => Promise.resolve(false),
  };

  // ─── Called by a platform adapter ───
  function register(name, impl) {
    platform = name;
    adapter = Object.assign(adapter, impl);
    console.log(`[BM] register("${name}") — checking for board...`);

    // Start detection
    if (adapter.detectGame()) {
      console.log(`[BM] Board found immediately on ${name}`);
      onDetected();
    } else {
      console.log(`[BM] Board NOT found yet, starting MutationObserver...`);
    }

    // MutationObserver for late-loading boards
    const observer = new MutationObserver(() => {
      if (!gameDetected && adapter.detectGame()) {
        console.log(`[BM] Board detected via MutationObserver on ${name}`);
        onDetected();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─── Internals ───
  function onDetected() {
    gameDetected = true;
    console.log(`[BM] ✅ Game detected! platform=${platform}`);
    chrome.runtime.sendMessage({
      command: 'gameDetected',
      gameType: 'chess',
      platform: platform,
    });
    adapter.onGameDetected();
  }

  function handleFenChange(fen) {
    if (!fen || fen === lastFen) return;
    lastFen = fen;
    console.log(`[BM] 📋 FEN changed: ${fen}`);
    // Clear stale arrows from previous position immediately
    if (typeof ChessArrows !== 'undefined') ChessArrows.clear();
    chrome.runtime.sendMessage({
      command: 'analyzeFEN',
      fen: fen,
      platform: platform,
    });
    if (autoMode) scheduleAutoMove();
  }

  function scheduleAutoMove() {
    if (autoTimerId) clearTimeout(autoTimerId);

    chrome.storage.local.get('boardMasterState', (result) => {
      const st = result.boardMasterState || {};
      const delay = st.chessSettings?.autoDelay || 1000;

      autoTimerId = setTimeout(() => {
        if (lastFen) {
          console.log('[BM] Auto-mode: requesting analysis for auto-move');
          chrome.runtime.sendMessage({
            command: 'analyzeFEN',
            fen: lastFen,
            platform: platform,
            autoPlay: true,
          });
        }
      }, delay);
    });
  }

  function executeAutoMove(uciMove) {
    if (!uciMove || uciMove.length < 4) return;
    const from = uciMove.slice(0, 2);
    const to   = uciMove.slice(2, 4);
    console.log('[BM] Executing auto-move:', from, '→', to);
    adapter.performMove(from, to).then((ok) => {
      if (ok) {
        chrome.runtime.sendMessage({ command: 'autoMovePlayed', move: from + to });
      } else {
        console.log('[BM] Auto-move failed');
      }
    });
  }

  // ─── Message listener ───
  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.command) {
      case 'getFEN':
        console.log(`[BM] Received getFEN request, asking adapter...`);
        adapter.requestFen().then((fen) => {
          console.log(`[BM] Adapter returned FEN:`, fen);
          if (fen) {
            lastFen = fen;
            chrome.runtime.sendMessage({
              command: 'analyzeFEN',
              fen: fen,
              platform: platform,
            });
          }
        });
        break;

      case 'startAuto':
        autoMode = true;
        console.log('[BM] Auto-mode ON — triggering immediate analysis');
        // Immediately analyze current position for auto-play
        if (lastFen) {
          chrome.runtime.sendMessage({
            command: 'analyzeFEN',
            fen: lastFen,
            platform: platform,
          });
        } else {
          // No FEN yet, request one
          adapter.requestFen().then((fen) => {
            if (fen) {
              lastFen = fen;
              chrome.runtime.sendMessage({
                command: 'analyzeFEN',
                fen: fen,
                platform: platform,
              });
            }
          });
        }
        break;

      case 'stopAuto':
        autoMode = false;
        if (autoTimerId) {
          clearTimeout(autoTimerId);
          autoTimerId = null;
        }
        break;

      case 'toggleHints':
        if (typeof ChessArrows !== 'undefined') {
          if (msg.visible !== undefined) ChessArrows.setVisible(msg.visible);
          else ChessArrows.toggle();
        }
        break;

      case 'updateHints':
        console.log('[BM] updateHints received in content script, hints:', msg.hints?.length, 'bestUci:', msg.bestUci, 'autoMode:', autoMode);
        if (typeof ChessArrows !== 'undefined') ChessArrows.draw(msg.hints);
        // Store last best move for auto-play
        if (msg.bestUci) lastBestUci = msg.bestUci;
        // Auto-play: if in auto mode and we have a best move, execute it
        if (autoMode && msg.bestUci) {
          executeAutoMove(msg.bestUci);
        }
        break;

      case 'ping':
        // Background uses this to check if content scripts are loaded
        break;
    }
  });

  // Public API (used by adapters)
  return { register, handleFenChange };
})();
