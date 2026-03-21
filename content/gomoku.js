// ─── Gomoku Content Script ───
// Supports Facebook Caro (including fbsbx.com iframe) and placeholder for other platforms

(function () {
  'use strict';

  console.log('[BM][gomoku] Content script loaded in frame:', location.href);

  // ─── Platform detection ───
  const hostname = location.hostname;
  let platform = '';

  if (hostname.includes('facebook.com') || hostname.includes('fbsbx.com')) {
    platform = 'facebook-caro';
  } else if (hostname.includes('gomokuonline.com')) {
    platform = 'gomokuonline.com';
  } else if (hostname.includes('playok.com')) {
    platform = 'playok.com';
  }

  // DOM-based fallback
  if (!platform) {
    if (document.querySelector('#playingBoard-main') || document.querySelector('[data-guide^="playing-board-cell"]')) {
      platform = 'facebook-caro';
    } else {
      const probe = new MutationObserver(() => {
        if (document.querySelector('#playingBoard-main') || document.querySelector('[data-guide^="playing-board-cell"]')) {
          probe.disconnect();
          platform = 'facebook-caro';
          initFacebookCaro();
        }
      });
      if (document.body) {
        probe.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => probe.disconnect(), 30000);
      }
      return;
    }
  }

  // Non-Facebook platforms placeholder
  if (platform !== 'facebook-caro') {
    function detectGame() {
      if (platform === 'gomokuonline.com') return !!document.querySelector('canvas, .board, #game-board');
      if (platform === 'playok.com') return !!document.querySelector('canvas, .board, #board');
      return false;
    }
    function notifyGameDetected() {
      chrome.runtime.sendMessage({ command: 'gameDetected', gameType: 'gomoku', platform });
    }
    const obs = new MutationObserver(() => { if (detectGame()) notifyGameDetected(); });
    obs.observe(document.body, { childList: true, subtree: true });
    if (detectGame()) notifyGameDetected();
    chrome.runtime.onMessage.addListener(() => {});
    return;
  }

  initFacebookCaro();

  // ═══════════════════════════════════════════════════════════════
  //  Facebook Caro
  // ═══════════════════════════════════════════════════════════════
  function initFacebookCaro() {
    console.log('[BM][gomoku] initFacebookCaro()');

    let boardEl = null;
    let boardRows = 0;
    let boardCols = 0;
    let prevSnapshotKey = '';   // stringified snapshot for change detection
    let autoMode = false;
    let autoTimerId = null;
    let hintsVisible = true;
    let suggestedMove = null;
    let highlightEl = null;
    let debounceTimer = null;
    let analysisInFlight = false;
    let boardObserver = null;
    let notifiedGameDetected = false;
    let contextValid = true;

    // Safe wrapper — detects "Extension context invalidated" and stops all activity
    function safeSendMessage(msg) {
      try {
        chrome.runtime.sendMessage(msg);
      } catch (e) {
        if (e.message?.includes('Extension context invalidated')) {
          console.log('[BM][gomoku] Context invalidated — cleaning up');
          contextValid = false;
          cleanup();
        }
      }
    }

    function cleanup() {
      if (boardObserver) { boardObserver.disconnect(); boardObserver = null; }
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      if (autoTimerId) { clearTimeout(autoTimerId); autoTimerId = null; }
      clearHighlight();
    }

    // ─── Board detection ───
    function findBoard() {
      const b = document.querySelector('#playingBoard-main');
      if (b) return b;
      const cell = document.querySelector('[data-guide^="playing-board-cell"]');
      if (cell) return cell.parentElement?.parentElement || null;
      return null;
    }

    // ─── Read a single cell ───
    // 0 = empty, 1 = X (black), 2 = O (white)
    function readCell(cellEl) {
      const guide = (cellEl.getAttribute('data-guide') || '').toLowerCase();
      if (guide.includes('empty')) return 0;

      const use = cellEl.querySelector('use');
      if (use) {
        const href = (use.getAttribute('xlink:href') || use.getAttribute('href') || '').toLowerCase();
        if (href.includes('black')) return 1;
        if (href.includes('white')) return 2;
      }

      if (guide.includes('moved') || guide.includes('filled')) return -1;
      return 0;
    }

    // ─── Snapshot board ───
    function snapshotBoard() {
      boardEl = findBoard();
      if (!boardEl) return null;

      const rowEls = Array.from(boardEl.children).filter(
        el => el.children.length > 0 && el.querySelector('[data-guide]')
      );
      if (rowEls.length === 0) return null;

      boardRows = rowEls.length;
      boardCols = rowEls[0].children.length;

      const snap = [];
      for (let r = 0; r < rowEls.length; r++) {
        const row = [];
        const cells = Array.from(rowEls[r].children);
        for (let c = 0; c < cells.length; c++) {
          row.push(readCell(cells[c]));
        }
        snap.push(row);
      }
      return snap;
    }

    // ─── Count stones ───
    function countStones(snap) {
      let x = 0, o = 0;
      for (const row of snap) {
        for (const cell of row) {
          if (cell === 1) x++;
          else if (cell === 2) o++;
        }
      }
      return { x, o };
    }

    // ─── Build moves list for API ───
    function buildMovesFromBoard(snap) {
      const xStones = [];
      const oStones = [];
      for (let r = 0; r < snap.length; r++) {
        for (let c = 0; c < snap[r].length; c++) {
          if (snap[r][c] === 1) xStones.push({ x: c, y: r, player: 1 });
          else if (snap[r][c] === 2) oStones.push({ x: c, y: r, player: 2 });
        }
      }
      const moves = [];
      const maxLen = Math.max(xStones.length, oStones.length);
      for (let i = 0; i < maxLen; i++) {
        if (i < xStones.length) moves.push(xStones[i]);
        if (i < oStones.length) moves.push(oStones[i]);
      }
      return moves;
    }

    // ─── Core: analyze current board ───
    function analyzeBoard() {
      if (!contextValid || analysisInFlight) return;

      const snap = snapshotBoard();
      if (!snap) return;

      const snapKey = JSON.stringify(snap);
      if (snapKey === prevSnapshotKey) return; // no change
      prevSnapshotKey = snapKey;

      const { x, o } = countStones(snap);
      const turn = (x === o) ? 'X' : 'O'; // X goes first
      const moves = buildMovesFromBoard(snap);
      const boardSize = Math.min(boardRows, boardCols);

      console.log('[BM][gomoku] Board changed — X:', x, 'O:', o,
        'turn:', turn, 'board:', boardCols + 'x' + boardRows, 'apiSize:', boardSize);

      // Clear old hint when board changes
      clearHighlight();
      suggestedMove = null;

      analysisInFlight = true;
      safeSendMessage({
        command: 'analyzeGomoku',
        boardSize: boardSize,
        moves: moves,
        turn: turn,
        platform: platform,
      });
    }

    // ─── Debounced board mutation handler ───
    function onBoardMutated() {
      if (!contextValid) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => analyzeBoard(), 300);
    }

    // ─── Highlight ───
    let currentTurn = 'X';

    function highlightCell(x, y) {
      clearHighlight();
      suggestedMove = { x, y };
      if (!hintsVisible) return;

      boardEl = findBoard();
      if (!boardEl) return;

      const rowEls = Array.from(boardEl.children).filter(
        el => el.children.length > 0 && el.querySelector('[data-guide]')
      );
      const rowEl = rowEls[y];
      if (!rowEl) return;

      const cell = rowEl.children[x];
      if (!cell) return;

      const pos = getComputedStyle(cell).position;
      if (pos === 'static') cell.style.position = 'relative';

      const isX = currentTurn === 'X';

      highlightEl = document.createElement('div');
      highlightEl.className = 'bm-gomoku-hint';

      if (isX) {
        // X → red "X" mark
        highlightEl.style.cssText = [
          'position:absolute', 'inset:2px',
          'display:flex', 'align-items:center', 'justify-content:center',
          'font-size:clamp(14px, 70%, 28px)', 'font-weight:900', 'color:#ef4444',
          'text-shadow:0 0 4px rgba(239,68,68,0.6)',
          'pointer-events:none', 'z-index:9999',
          'animation:bm-gomoku-pulse 1.2s ease-in-out infinite',
        ].join(';');
        highlightEl.textContent = 'X';
      } else {
        // O → blue circle
        highlightEl.style.cssText = [
          'position:absolute', 'inset:2px',
          'border:3px solid #3b82f6',
          'border-radius:50%',
          'background:rgba(59,130,246,0.3)',
          'pointer-events:none', 'z-index:9999',
          'animation:bm-gomoku-pulse 1.2s ease-in-out infinite',
        ].join(';');
      }

      // Disconnect observer to avoid self-trigger
      if (boardObserver) boardObserver.disconnect();
      cell.appendChild(highlightEl);
      reattachBoardObserver();
    }

    function clearHighlight() {
      if (highlightEl && highlightEl.parentElement) {
        if (boardObserver) boardObserver.disconnect();
        highlightEl.remove();
        reattachBoardObserver();
      }
      highlightEl = null;
    }

    // ─── Board observer management ───
    function reattachBoardObserver() {
      if (!boardObserver || !boardEl) return;
      boardObserver.observe(boardEl, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['data-guide', 'class', 'style'],
      });
    }

    function setupBoardObserver() {
      const board = findBoard();
      if (!board) return false;

      if (board === boardEl && boardObserver) return true; // already watching

      boardEl = board;
      if (boardObserver) boardObserver.disconnect();
      boardObserver = new MutationObserver(() => onBoardMutated());
      reattachBoardObserver();
      console.log('[BM][gomoku] Board observer attached');
      return true;
    }

    // ─── Auto-play ───
    function clickCell(x, y) {
      boardEl = findBoard();
      if (!boardEl) return;
      const rowEls = Array.from(boardEl.children).filter(
        el => el.children.length > 0 && el.querySelector('[data-guide]')
      );
      const cell = rowEls[y]?.children[x];
      if (!cell || readCell(cell) !== 0) return;

      cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      cell.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      console.log('[BM][gomoku] Auto-played at', x, y);
    }

    function scheduleAutoPlay(x, y) {
      if (autoTimerId) clearTimeout(autoTimerId);
      chrome.storage.local.get('boardMasterState', (result) => {
        const delay = result.boardMasterState?.gomokuSettings?.autoDelay || 1000;
        autoTimerId = setTimeout(() => { if (autoMode) clickCell(x, y); }, delay);
      });
    }

    // ─── CSS ───
    function injectStyles() {
      if (document.querySelector('#bm-gomoku-styles')) return;
      const style = document.createElement('style');
      style.id = 'bm-gomoku-styles';
      style.textContent = `
        @keyframes bm-gomoku-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.88); }
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    }

    // ─── Initialize ───
    function onBoardFound() {
      injectStyles();

      if (!notifiedGameDetected) {
        notifiedGameDetected = true;
        safeSendMessage({ command: 'gameDetected', gameType: 'gomoku', platform });
      }

      // Reset snapshot so new board gets analyzed fresh
      prevSnapshotKey = '';

      setupBoardObserver();
      analyzeBoard();
    }

    // Try to find board immediately
    if (findBoard()) {
      console.log('[BM][gomoku] Board found immediately');
      onBoardFound();
    }

    // Watch for board to appear/reappear
    let pageObserver = null;
    if (document.body) {
      pageObserver = new MutationObserver(() => {
        if (!contextValid) { pageObserver.disconnect(); return; }
        const board = findBoard();
        if (board && board !== boardEl) {
          console.log('[BM][gomoku] Board appeared/changed');
          onBoardFound();
        }
      });
      pageObserver.observe(document.body, { childList: true, subtree: true });
    }

    // Periodic fallback — catches anything observers miss
    const periodicId = setInterval(() => {
      if (!contextValid) { clearInterval(periodicId); return; }

      const board = findBoard();
      if (!board) return;

      if (board !== boardEl) {
        console.log('[BM][gomoku] [periodic] New board element detected');
        onBoardFound();
        return;
      }

      // Re-analyze if not in flight (catches missed mutations)
      if (!analysisInFlight) {
        analyzeBoard();
      }
    }, 3000);

    // ─── Message listener ───
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      // Only handle game messages in the frame that actually has the board
      if (msg.command !== 'ping' && !boardEl && !findBoard()) {
        return;
      }

      switch (msg.command) {
        case 'getFEN':
          analyzeBoard();
          sendResponse({ ok: true });
          break;

        case 'updateGomokuHints':
          analysisInFlight = false;
          if (msg.turn) currentTurn = msg.turn;
          console.log('[BM][gomoku] Hint received:', msg.move, 'turn:', currentTurn, 'engine:', msg.engineTime);
          if (msg.move && boardCols > 0 && boardRows > 0) {
            const mx = Math.min(msg.move.x, boardCols - 1);
            const my = Math.min(msg.move.y, boardRows - 1);
            highlightCell(mx, my);
            if (autoMode) scheduleAutoPlay(mx, my);
          }
          break;

        case 'analysisError':
          analysisInFlight = false;
          console.log('[BM][gomoku] Analysis error:', msg.error);
          break;

        case 'analysisStarted':
          break;

        case 'startAuto':
          autoMode = true;
          console.log('[BM][gomoku] Auto mode ON');
          analyzeBoard();
          break;

        case 'stopAuto':
          autoMode = false;
          if (autoTimerId) { clearTimeout(autoTimerId); autoTimerId = null; }
          break;

        case 'toggleHints':
          hintsVisible = msg.visible !== undefined ? msg.visible : !hintsVisible;
          if (!hintsVisible) clearHighlight();
          else if (suggestedMove) highlightCell(suggestedMove.x, suggestedMove.y);
          break;

        case 'ping':
          sendResponse({ ok: true });
          break;
      }
    });
  }
})();
