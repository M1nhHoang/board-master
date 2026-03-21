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
    let userSide = '';  // 'X' or 'O' — detected from footer DOM

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
      if (fullAutoInterval) { clearInterval(fullAutoInterval); fullAutoInterval = null; }
      clearHighlight();
    }

    // ─── User side detection ───
    // Footer (bottom) always shows the current user
    // .playerInfo__color img alt="b"/src="black.svg" → X, alt="w"/src="white.svg" → O
    function detectUserSide() {
      const footer = document.querySelector('.match-board__footer');
      if (!footer) return '';
      const colorImg = footer.querySelector('.playerInfo__color img');
      if (!colorImg) return '';
      const alt = (colorImg.getAttribute('alt') || '').toLowerCase();
      const src = (colorImg.getAttribute('src') || '').toLowerCase();
      if (alt === 'b' || src.includes('black')) return 'X';
      if (alt === 'w' || src.includes('white')) return 'O';
      return '';
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

    // ─── Wall pattern for out-of-bounds columns/rows ───
    // Double-row checkerboard: max 2 consecutive same color in any direction
    // Formula: rows 0,3,4,7,8,11… → ■□■□ ; rows 1,2,5,6,9,10… → □■□■
    function buildWallMoves(cols, rows, apiSize) {
      const xWalls = [];
      const oWalls = [];
      for (let y = 0; y < apiSize; y++) {
        for (let x = 0; x < apiSize; x++) {
          if (x < cols && y < rows) continue; // real board area — skip
          const flip = (y % 4 === 1 || y % 4 === 2) ? 1 : 0;
          const player = ((x + flip) % 2 === 0) ? 1 : 2;
          if (player === 1) xWalls.push({ x, y, player: 1 });
          else oWalls.push({ x, y, player: 2 });
        }
      }
      // Interleave X/O
      const walls = [];
      const maxLen = Math.max(xWalls.length, oWalls.length);
      for (let i = 0; i < maxLen; i++) {
        if (i < xWalls.length) walls.push(xWalls[i]);
        if (i < oWalls.length) walls.push(oWalls[i]);
      }
      return walls;
    }

    // ─── Core: analyze current board ───
    let lastSnap = null; // stored for wall-retry

    function analyzeBoard() {
      if (!contextValid || analysisInFlight) return;

      const snap = snapshotBoard();
      if (!snap) return;

      const snapKey = JSON.stringify(snap);
      if (snapKey === prevSnapshotKey) return; // no change
      prevSnapshotKey = snapKey;

      sendAnalysis(snap, false);
    }

    function sendAnalysis(snap, withWalls) {
      lastSnap = snap;

      const { x, o } = countStones(snap);
      const turn = (x === o) ? 'X' : 'O'; // X goes first
      const apiSize = Math.max(boardRows, boardCols);
      let moves = buildMovesFromBoard(snap);

      if (withWalls) {
        moves = [...moves, ...buildWallMoves(boardCols, boardRows, apiSize)];
      }

      console.log('[BM][gomoku] Board changed — X:', x, 'O:', o,
        'turn:', turn, 'board:', boardCols + 'x' + boardRows, 'apiSize:', apiSize,
        withWalls ? '(with walls)' : '');

      // Clear old hint when board changes
      clearHighlight();
      suggestedMove = null;

      analysisInFlight = true;
      safeSendMessage({
        command: 'analyzeGomoku',
        boardSize: apiSize,
        moves: moves,
        turn: turn,
        platform: platform,
        isRetry: withWalls,
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

    // ─── Full Auto Loop ───
    let fullAutoInterval = null;

    function startFullAuto() {
      if (fullAutoInterval) return;
      autoMode = true;
      console.log('[BM][gomoku] Full auto started');
      safeSendMessage({ command: 'autoStatus', status: 'running' });
      fullAutoTick(); // run immediately
      fullAutoInterval = setInterval(fullAutoTick, 2000);
    }

    function stopFullAuto() {
      autoMode = false;
      if (fullAutoInterval) { clearInterval(fullAutoInterval); fullAutoInterval = null; }
      if (autoTimerId) { clearTimeout(autoTimerId); autoTimerId = null; }
      console.log('[BM][gomoku] Full auto stopped');
      safeSendMessage({ command: 'autoStatus', status: 'stopped' });
    }

    function detectPageState() {
      const mainMenu = document.querySelector('.main-menu');
      const gameEndFooter = document.querySelector('.footer .actions');
      const board = findBoard();

      if (gameEndFooter && gameEndFooter.querySelectorAll('.action').length > 0) {
        return 'game-over';
      }
      if (board) {
        return 'playing';
      }
      if (mainMenu) {
        return 'lobby';
      }
      return 'searching';
    }

    function fullAutoTick() {
      if (!contextValid) { stopFullAuto(); return; }

      const pageState = detectPageState();

      switch (pageState) {
        case 'lobby': {
          console.log('[BM][gomoku][auto] In lobby — clicking Play Now');
          userSide = ''; // reset — new match may assign different side
          safeSendMessage({ command: 'autoStatus', status: 'lobby' });
          const playBtn = document.querySelector('.main-menu .button.big');
          if (playBtn) playBtn.click();
          break;
        }

        case 'searching':
          console.log('[BM][gomoku][auto] Searching for match…');
          safeSendMessage({ command: 'autoStatus', status: 'searching' });
          break;

        case 'playing':
          // Retry user side detection if not yet known
          if (!userSide) {
            const detected = detectUserSide();
            if (detected) {
              userSide = detected;
              console.log('[BM][gomoku][auto] User plays:', userSide);
            }
          }
          // Auto-play is handled by analyzeBoard + scheduleAutoPlay
          safeSendMessage({ command: 'autoStatus', status: 'playing' });
          break;

        case 'game-over': {
          console.log('[BM][gomoku][auto] Game over — clicking Exit');
          safeSendMessage({ command: 'autoStatus', status: 'game-over' });
          const actions = document.querySelectorAll('.footer .actions .action');
          // Exit = last .action (no .highlight, no .re-match)
          const exitBtn = actions[actions.length - 1];
          if (exitBtn) exitBtn.click();
          break;
        }
      }
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

      // First click: select the cell
      cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      cell.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      console.log('[BM][gomoku] Auto-play select at', x, y);

      // Second click after short delay: confirm the move
      setTimeout(() => {
        cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        cell.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        console.log('[BM][gomoku] Auto-play confirm at', x, y);
      }, 300);
    }

    function scheduleAutoPlay(x, y) {
      if (autoTimerId) clearTimeout(autoTimerId);

      // Only auto-play on user's turn
      if (userSide && currentTurn !== userSide) {
        console.log('[BM][gomoku] Not user turn (' + currentTurn + ' vs ' + userSide + ') — skip auto-play');
        return;
      }

      chrome.storage.local.get('boardMasterState', (result) => {
        const gs = result.boardMasterState?.gomokuSettings || {};
        let delay;
        if (gs.randomDelay) {
          const min = gs.randomDelayMin || 200;
          const max = gs.randomDelayMax || 5000;
          delay = Math.floor(Math.random() * (max - min + 1)) + min;
        } else {
          delay = gs.autoDelay || 1000;
        }
        console.log('[BM][gomoku] Auto-play in', delay + 'ms', gs.randomDelay ? '(random)' : '');
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

      // Delay before first analysis — let the board render fully
      setTimeout(() => {
        // Detect which side user plays (footer may take time to render)
        const detected = detectUserSide();
        if (detected) {
          userSide = detected;
          console.log('[BM][gomoku] User plays:', userSide);
        }
        analyzeBoard();
      }, 2000);
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
    const alwaysAllowed = new Set(['ping', 'startAuto', 'stopAuto', 'toggleHints']);
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      // Only handle game messages in the frame that actually has the board
      // But always allow control commands (auto, hints, ping) through
      if (!alwaysAllowed.has(msg.command) && !boardEl && !findBoard()) {
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
          console.log('[BM][gomoku] Hint received:', msg.move, 'turn:', currentTurn, 'engine:', msg.engineTime,
            msg.isRetry ? '(wall retry)' : '');

          if (msg.move && boardCols > 0 && boardRows > 0) {
            // Check if hint is outside the real board
            if (!msg.isRetry && (msg.move.x >= boardCols || msg.move.y >= boardRows)) {
              console.log('[BM][gomoku] Hint outside board (' + msg.move.x + ',' + msg.move.y +
                ') — retrying with walls');
              if (lastSnap) sendAnalysis(lastSnap, true);
              break;
            }

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
          startFullAuto();
          // If already have a hint, play it immediately
          if (suggestedMove && findBoard()) {
            scheduleAutoPlay(suggestedMove.x, suggestedMove.y);
          }
          // Force re-analyze even if board hasn't changed
          prevSnapshotKey = '';
          analyzeBoard();
          break;

        case 'stopAuto':
          stopFullAuto();
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
