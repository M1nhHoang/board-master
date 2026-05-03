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
    // playok serves multiple games — only attach on /gomoku/ path
    if (!/\/gomoku(\/|$)/i.test(location.pathname)) return;
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

  // Non-Facebook platforms
  if (platform !== 'facebook-caro') {
    if (platform === 'playok.com') {
      initPlayokGomoku();
      initPlayokDebug();   // also expose window.bmGomokuDebug for diagnostics
      return;
    }
    // gomokuonline placeholder — detection only
    function detectGame() {
      return !!document.querySelector('canvas, .board, #game-board');
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
  //  Playok Gomoku — canvas-based reader, hint mode (no auto-play yet:
  //  user-side detection on playok still TBD).
  //
  //  Pipeline (mirrors initFacebookCaro but for canvas):
  //    detectGrid() once → poll snapshotBoard() every 500ms → send
  //    diff to engine → render hint as DOM overlay over canvas.
  //  Grid is re-detected automatically when canvas dimensions change
  //  (playok rewrites canvas.width on viewport resize).
  // ═══════════════════════════════════════════════════════════════
  function initPlayokGomoku() {
    const TAG = '[BM][gomoku][playok]';
    console.log(TAG, 'init [v6-offscreen-readback]');

    const COLORS = {
      empty:    { r: 240, g: 176, b: 96  },
      gridLine: { r: 162, g: 108, b: 62  },
      black:    { r: 40,  g: 40,  b: 40  },
      white:    { r: 245, g: 245, b: 245 },
    };
    const colorMatch = (px, ref, tol) =>
      Math.abs(px[0] - ref.r) <= tol &&
      Math.abs(px[1] - ref.g) <= tol &&
      Math.abs(px[2] - ref.b) <= tol;

    let boardCanvas      = null;
    let GRID             = null;
    let prevSnapshotKey  = '';
    let suggestedMove    = null;
    let hintsVisible     = true;
    let highlightEl      = null;
    let analysisInFlight = false;
    let pollIntervalId   = null;
    let resizeObserver   = null;
    let contextValid     = true;
    let currentTurn      = 'X';
    let userSide         = '';   // 'X' / 'O' — from .tplcont DOM
    // Debounce userSide updates: Playok flickers panel colour-box
    // and arrow state during game transitions (game over → new game),
    // making detectPlayers().user.side flip X↔O every poll for a
    // second or two. We require the new side to hold for 2 consecutive
    // detections before committing — otherwise transient flickers can
    // fire /swap2 with the wrong perspective.
    let userSideCandidate     = '';
    let userSideCandidateHits = 0;
    const USERSIDE_STABLE_HITS = 2;
    let autoMode         = false;
    let autoTimerId      = null;
    let notifiedGameDetected = false;

    // Swap2 protocol state
    let swap2Mode             = false; // mirror of gomokuSettings.swap2
    let pendingMoves          = [];    // queued from /swap2 (opening = 3, put_two = 2)
    let pendingTimerId        = null;
    // True once the swap2 opening protocol has been resolved (engine
    // returned a final 'move'/'swap' decision OR opp swapped colours
    // mid-opening, both of which mean we should switch from /swap2 to
    // regular /move for the rest of the game). Reset when the board
    // returns to 0 stones (a new game).
    let swap2OpeningResolved  = false;

    function safeSendMessage(msg) {
      try { chrome.runtime.sendMessage(msg); }
      catch (e) {
        if (e.message && e.message.includes('Extension context invalidated')) {
          console.log(TAG, 'context invalidated — cleaning up');
          contextValid = false;
          cleanup();
        }
      }
    }

    function cleanup() {
      if (pollIntervalId)  { clearInterval(pollIntervalId); pollIntervalId = null; }
      if (resizeObserver)  { resizeObserver.disconnect(); resizeObserver = null; }
      if (autoTimerId)     { clearTimeout(autoTimerId); autoTimerId = null; }
      if (pendingTimerId)  { clearTimeout(pendingTimerId); pendingTimerId = null; }
      pendingMoves = [];
      clearHighlight();
    }

    // Detect swap2 from playok's table-info banner. Direct selector
    // (provided by the user) — second child of .ttlcont reads e.g.
    // "5m, sw" when swap2 is the active rule, just "5m" otherwise.
    const SWAP2_BANNER_SEL =
      '#precont > div.gview.sbfixed > div.bsbb.tsb.sbclrd > div > div.ttlcont > div:nth-child(2)';
    let swap2DetectCalls = 0;
    let swap2DetectFirstHit = false;
    function detectSwap2FromDOM() {
      swap2DetectCalls++;
      const el = document.querySelector(SWAP2_BANNER_SEL);
      const text = el ? (el.textContent || '').trim() : '';

      if (swap2DetectCalls <= 5) {
        console.log(TAG, '[swap2-detect] call#' + swap2DetectCalls,
          'el=' + (el ? 'yes' : 'no'),
          'text=' + JSON.stringify(text));
      }

      if (!el) return null;            // banner not in DOM yet
      const result = /\bsw\b/i.test(text);
      if (!swap2DetectFirstHit) {
        swap2DetectFirstHit = true;
        console.log(TAG, '[swap2-detect] first hit on call#' + swap2DetectCalls,
          'text:', JSON.stringify(text), '→ swap2=' + result);
      }
      return result;
    }
    function refreshSwap2Flag() {
      const prev = swap2Mode;
      const dom = detectSwap2FromDOM();
      if (dom === null) return;     // banner not in DOM yet — keep prev
      swap2Mode = dom;
      if (swap2Mode !== prev) {
        console.log(TAG, 'swap2Mode →', swap2Mode);
        // Force re-analysis so the next analyzeBoard pick the right
        // endpoint (/swap2 vs /move) for the current stone count.
        prevSnapshotKey = '';
      }
    }

    function findBoardCanvas() {
      return Array.from(document.querySelectorAll('canvas'))
        .find(c => c.width >= 400 && c.height >= 400) || null;
    }

    function findInputLayer() {
      return document.querySelector('.tsinbo.bsbb');
    }

    // ─── Player panel parsing (.tplcont) ───
    // Each player section contains:
    //   • a color box (rgb(102,102,102) = black, rgb(255,255,255) = white)
    //   • .nowrel — player name
    //   • a triangle div with border-bottom — visibility:inherit when it's
    //     that player's turn, hidden otherwise
    //
    // To identify the local user, read their logged-in name from the
    // page header and match against panel names — the panels themselves
    // contain no "this is you" marker. The header lives in different
    // selectors across Playok versions, so try several. Final fallback
    // is gomokuSettings.playokUsername which the user can configure
    // manually when auto-detection fails.
    let cachedManualName = null;
    function refreshManualNameFromStorage() {
      try {
        chrome.storage.local.get('boardMasterState', (result) => {
          const gs = result?.boardMasterState?.gomokuSettings || {};
          const n = (gs.playokUsername || '').trim();
          if (n !== cachedManualName) {
            cachedManualName = n;
            console.log(TAG, 'playokUsername (settings):', n || '(unset)');
          }
        });
      } catch (_) {}
    }
    refreshManualNameFromStorage();

    const HEADER_NAME_SELECTORS = [
      '#appcont .nav0.usno.tama .msub',
      '#appcont .usno .msub',
      '#appcont .msub',
      '.nav0 .msub',
      '[class*="usno"] .msub',
      '#hdcont .msub',
      '.msub',
    ];
    let headerSelectorWarned = false;
    function getLoggedInName() {
      // 1) Manual override always wins.
      if (cachedManualName) return cachedManualName;
      // 2) Try several header selectors — Playok's class names shift.
      for (const sel of HEADER_NAME_SELECTORS) {
        const el = document.querySelector(sel);
        const t = el && el.textContent && el.textContent.trim();
        if (t && t.length <= 40 && /^[A-Za-z0-9_-]+$/.test(t)) {
          return t;
        }
      }
      if (!headerSelectorWarned) {
        headerSelectorWarned = true;
        console.warn(TAG, 'could not locate logged-in name in header — set ' +
          'gomokuSettings.playokUsername to override (chrome.storage.local)');
      }
      return '';
    }

    function detectPlayers() {
      const cont = document.querySelector('.tplcont');
      if (!cont) return null;
      const myName = getLoggedInName();
      let turn = null;
      const candidates = [];
      // .tplcont's direct children ARE the two player sections.
      // (Earlier code used ':scope > div > div' which matched grandchildren
      //  — those are .f12 / .tplext / etc. and never satisfied the
      //  name+colorBox+arrow gate, so nothing was ever detected.)
      const panels = cont.querySelectorAll(':scope > div');
      panels.forEach((sec) => {
        const nameEl   = sec.querySelector('.nowrel');
        const colorBox = sec.querySelector('.f12 > div');
        const arrowEl  = sec.querySelector('.tplext div[style*="border-bottom"]');
        if (!nameEl || !colorBox) return;

        const bg = (colorBox.style.background || colorBox.style.backgroundColor || '').toLowerCase();
        const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!m) return;
        const r = +m[1], g = +m[2], b = +m[3];
        const side = (r < 200 && g < 200 && b < 200) ? 'X' : 'O';

        const name = nameEl.textContent.trim();
        const isActive = !!(arrowEl && arrowEl.style.visibility === 'inherit');
        if (isActive) turn = side;

        const nameColor = (nameEl.style.color || '').toLowerCase();
        candidates.push({ side, name, isActive, nameColor });
      });

      // Identify the local user. Strict ordering — if we can't tell
      // confidently, return user=null so analyzeBoard refuses to
      // operate (better than guessing the wrong perspective and
      // calling /swap2 with inverted player codes).
      //
      // Header text often contains username + rating concatenated
      // (e.g. ".msub" → "gmw343g1200" while the panel just shows
      // "gmw343g"). Try exact match first, then prefix in either
      // direction so "gmw343g1200" maps to panel "gmw343g".
      //
      // We DO NOT fall back to .nowrel `color: inherit`: that
      // attribute tracks "is this player currently waiting" (Playok
      // flips it between panels every move), not "is this you".
      // Using it caused userSide to bounce X↔O each turn and the
      // hint to flicker (force-re-analyze on every false flip).
      let user = null;
      let userSource = null;
      if (myName) {
        user = candidates.find(c => c.name === myName) || null;
        if (user) userSource = 'header-name';
        if (!user) {
          // Tolerate trailing rating / suffix on either side. Pick
          // the longest matching candidate name to avoid partial
          // collisions ("ab" vs "abcd" both prefixing "abcdef").
          const prefixMatches = candidates.filter(c =>
            c.name && (myName.startsWith(c.name) || c.name.startsWith(myName)));
          if (prefixMatches.length === 1) {
            user = prefixMatches[0];
            userSource = 'header-prefix';
          } else if (prefixMatches.length > 1) {
            user = prefixMatches.sort((a, b) => b.name.length - a.name.length)[0];
            userSource = 'header-prefix-longest';
          }
        }
      }
      // No reliable signal — DO NOT guess. Caller checks user==null.
      const opponent = user ? (candidates.find(c => c !== user) || null) : null;
      return { user, opponent, turn, myName, userSource, candidates };
    }

    // ─── Pixel readback ───
    // Playok already created its 2D context without willReadFrequently,
    // so passing the flag to a later getContext() call has no effect —
    // browsers warn about slow readback. Workaround: blit the playok
    // canvas onto our own offscreen canvas (created WITH the flag) and
    // read pixels from there.
    let offCanvas = null;
    let offCtx    = null;
    function readCanvasPixels(c) {
      try {
        if (!offCanvas || offCanvas.width !== c.width || offCanvas.height !== c.height) {
          offCanvas = document.createElement('canvas');
          offCanvas.width  = c.width;
          offCanvas.height = c.height;
          offCtx = offCanvas.getContext('2d', { willReadFrequently: true });
        }
        offCtx.clearRect(0, 0, offCanvas.width, offCanvas.height);
        offCtx.drawImage(c, 0, 0);
        return offCtx.getImageData(0, 0, c.width, c.height);
      } catch (e) {
        console.warn(TAG, 'pixel readback failed:', e.message);
        return null;
      }
    }

    // ─── Grid detection (auto-extrapolated) ───
    function detectGrid() {
      const c = findBoardCanvas();
      if (!c) return null;

      const img = readCanvasPixels(c);
      if (!img) return null;
      const data = img.data, W = c.width, H = c.height;

      const rowCounts = new Array(H).fill(0);
      const colCounts = new Array(W).fill(0);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          if (colorMatch([data[i], data[i+1], data[i+2]], COLORS.gridLine, 35)) {
            rowCounts[y]++;
            colCounts[x]++;
          }
        }
      }

      const rowPeaks = pickPeaks(rowCounts, Math.max(...rowCounts) * 0.25);
      const colPeaks = pickPeaks(colCounts, Math.max(...colCounts) * 0.25);
      if (rowPeaks.length < 5 || colPeaks.length < 5) {
        console.warn(TAG, 'too few grid peaks',
          { cols: colPeaks.length, rows: rowPeaks.length });
        return null;
      }

      const cellW = medianDiff(colPeaks);
      const cellH = medianDiff(rowPeaks);

      const peakCounts = (counts, peaks) => peaks.map(p =>
        Math.max(counts[Math.max(0, p-1)] || 0, counts[p] || 0,
                 counts[Math.min(counts.length-1, p+1)] || 0));
      const colHit = Math.max(8, median(peakCounts(colCounts, colPeaks)) * 0.3);
      const rowHit = Math.max(8, median(peakCounts(rowCounts, rowPeaks)) * 0.3);
      const colHasLine = (x) => {
        x = Math.round(x); let m = 0;
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < W && colCounts[xx] > m) m = colCounts[xx];
        }
        return m >= colHit;
      };
      const rowHasLine = (y) => {
        y = Math.round(y); let m = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const yy = y + dy;
          if (yy >= 0 && yy < H && rowCounts[yy] > m) m = rowCounts[yy];
        }
        return m >= rowHit;
      };

      const colXs = extrapolateBounded(colPeaks, cellW, W, colHasLine);
      const rowYs = extrapolateBounded(rowPeaks, cellH, H, rowHasLine);

      GRID = {
        x0: colXs[0], y0: rowYs[0], cellW, cellH,
        cols: colXs.length, rows: rowYs.length,
        colXs, rowYs,
        canvasW: W, canvasH: H,
      };
      console.log(TAG, 'grid:', GRID.cols + 'x' + GRID.rows,
        'origin=' + GRID.x0 + ',' + GRID.y0,
        'cell=' + cellW + 'x' + cellH);
      // If a hint was previously shown but the grid invalidated (e.g. on
      // resize / canvas re-render), re-render the highlight at the new
      // pixel coords now that we have a fresh grid.
      if (suggestedMove && hintsVisible && !highlightEl) {
        highlightCell(suggestedMove.x, suggestedMove.y);
      }
      return GRID;
    }

    function pickPeaks(counts, thresh) {
      const peaks = [];
      let inPeak = false, peakStart = 0;
      for (let i = 0; i < counts.length; i++) {
        if (counts[i] >= thresh) {
          if (!inPeak) { inPeak = true; peakStart = i; }
        } else if (inPeak) {
          peaks.push(Math.round((peakStart + i - 1) / 2));
          inPeak = false;
        }
      }
      if (inPeak) peaks.push(Math.round((peakStart + counts.length - 1) / 2));
      return peaks;
    }
    function medianDiff(arr) {
      if (arr.length < 2) return null;
      const d = [];
      for (let i = 1; i < arr.length; i++) d.push(arr[i] - arr[i-1]);
      d.sort((a, b) => a - b);
      return d[Math.floor(d.length / 2)];
    }
    function median(arr) {
      arr = arr.slice().sort((a, b) => a - b);
      return arr[Math.floor(arr.length / 2)] || 0;
    }
    function extrapolateBounded(peaks, step, limit, isOnFn) {
      if (peaks.length === 0) return [];
      const anchor = peaks[Math.floor(peaks.length / 2)];
      const left = [], right = [];
      let p = anchor - step, miss = 0;
      while (p >= 0 && miss < 2) {
        if (isOnFn(p)) { left.unshift(Math.round(p)); miss = 0; }
        else miss++;
        p -= step;
      }
      p = anchor + step; miss = 0;
      while (p < limit && miss < 2) {
        if (isOnFn(p)) { right.push(Math.round(p)); miss = 0; }
        else miss++;
        p += step;
      }
      return [...left, Math.round(anchor), ...right];
    }

    // ─── Snapshot ───
    function snapshotBoard() {
      if (!GRID) return null;
      const c = findBoardCanvas();
      if (!c) return null;
      // Canvas was rebuilt under us → re-detect
      if (c.width !== GRID.canvasW || c.height !== GRID.canvasH) {
        console.log(TAG, 'canvas size changed — re-detecting');
        GRID = null; prevSnapshotKey = ''; clearHighlight();
        return null;
      }
      const img = readCanvasPixels(c);
      if (!img) return null;
      const data = img.data, W = c.width, H = c.height;
      const RADIUS = 6, STEP = 3;

      const board = [];
      for (let r = 0; r < GRID.rows; r++) {
        const row = [];
        for (let cIdx = 0; cIdx < GRID.cols; cIdx++) {
          const cx = GRID.colXs[cIdx], cy = GRID.rowYs[r];
          let nB = 0, nW = 0, nT = 0;
          for (let dy = -RADIUS; dy <= RADIUS; dy += STEP) {
            for (let dx = -RADIUS; dx <= RADIUS; dx += STEP) {
              const x = cx + dx, y = cy + dy;
              if (x < 0 || x >= W || y < 0 || y >= H) continue;
              const i = (y * W + x) * 4;
              const px = [data[i], data[i+1], data[i+2]];
              if      (colorMatch(px, COLORS.black, 35)) nB++;
              else if (colorMatch(px, COLORS.white, 25)) nW++;
              nT++;
            }
          }
          let val = 0;
          if      (nB >= nT * 0.35) val = 1;
          else if (nW >= nT * 0.35) val = 2;
          row.push(val);
        }
        board.push(row);
      }
      return board;
    }

    // ─── Build engine payload ───
    function countStones(snap) {
      let x = 0, o = 0;
      for (const row of snap) for (const cell of row) {
        if (cell === 1) x++; else if (cell === 2) o++;
      }
      return { x, o };
    }
    // Build moves payload for the engine API.
    // Player codes per spec: 1 = OWN (engine plays this side = user),
    //                        2 = OPPONENT.
    // We map the user's stone colour to "OWN" so the engine returns
    // moves for the user's side. Default to user-as-black if userSide
    // hasn't been detected yet.
    function buildMovesFromBoard(snap) {
      const userIsWhite = (userSide === 'O');
      const blackPlayer = userIsWhite ? 2 : 1;
      const whitePlayer = userIsWhite ? 1 : 2;
      const xs = [], os = [];
      for (let r = 0; r < snap.length; r++) {
        for (let c = 0; c < snap[r].length; c++) {
          if (snap[r][c] === 1) xs.push({ x: c, y: r, player: blackPlayer });
          else if (snap[r][c] === 2) os.push({ x: c, y: r, player: whitePlayer });
        }
      }
      // Per Gomocup convention the chronologically first stone is Black —
      // interleave Black then White so the order matches.
      const moves = [];
      const n = Math.max(xs.length, os.length);
      for (let i = 0; i < n; i++) {
        if (i < xs.length) moves.push(xs[i]);
        if (i < os.length) moves.push(os[i]);
      }
      return moves;
    }

    // NOTE: swap2 opening detection is currently disabled — the text
    // regex was firing false positives (e.g. lobby/settings strings
    // bleeding into .bcont). Engine doesn't truly support swap2 yet
    // either, so for now we just analyse every position. Revisit when
    // we wire a swap2-capable engine (Rapfi/Yixin) and find a robust
    // DOM signal for the opening phase.

    function analyzeBoard() {
      if (!contextValid) return;
      if (analysisInFlight) {
        // Heartbeat: warn every ~3s if analysisInFlight is stuck so we
        // know an API call timed out without a response.
        const _h = Date.now();
        if (!analyzeBoard._stuckSince) analyzeBoard._stuckSince = _h;
        else if (_h - analyzeBoard._stuckSince > 3000 &&
                 (!analyzeBoard._lastStuckLog || _h - analyzeBoard._lastStuckLog > 3000)) {
          analyzeBoard._lastStuckLog = _h;
          console.warn(TAG, 'analysisInFlight stuck — waiting for engine response');
        }
        return;
      }
      analyzeBoard._stuckSince = 0;
      // (swap2 detection now runs from the poll tick — independent of
      //  analysisInFlight gating — so it always fires regardless of
      //  whether an in-flight analysis is stuck.)
      const playersForId = detectPlayers();
      // Diagnostic: surface what detectPlayers is seeing, throttled to
      // once every ~5s so the console isn't flooded but the user can
      // tell at a glance whether we even see the player panels.
      const _now = Date.now();
      if (!analyzeBoard._lastDiagLog || _now - analyzeBoard._lastDiagLog > 5000) {
        analyzeBoard._lastDiagLog = _now;
        if (!playersForId) {
          console.log(TAG, 'detectPlayers: .tplcont not in DOM yet');
        } else {
          console.log(TAG, 'detectPlayers:',
            'user=' + (playersForId.user ? playersForId.user.name + '/' + playersForId.user.side : 'null'),
            'src=' + (playersForId.userSource || '-'),
            'turn=' + (playersForId.turn || '-'),
            'myName=' + JSON.stringify(playersForId.myName || ''),
            'candidates=' + JSON.stringify(playersForId.candidates.map(c =>
              ({ name: c.name, side: c.side, active: c.isActive, nc: c.nameColor }))));
        }
      }
      // If detectPlayers can't confidently identify the user (e.g. the
      // page header isn't where we expect AND the panel name colours
      // don't disambiguate) refuse to operate. Calling the engine with
      // a guessed perspective causes "engine plays for the opponent"
      // bugs that are hard to recover from. Warn loudly so the user
      // can copy a name into gomokuSettings.playokUsername.
      if (playersForId && !playersForId.user && playersForId.candidates?.length >= 2) {
        if (!analyzeBoard._lastUnidWarn || _now - analyzeBoard._lastUnidWarn > 5000) {
          analyzeBoard._lastUnidWarn = _now;
          const names = playersForId.candidates.map(c => c.name).join(' / ');
          console.warn(TAG, 'cannot identify which panel is you. Players on board:',
            names, '\nFix: paste this in the page console (replace YOUR_NAME):\n' +
            "chrome.storage.local.get('boardMasterState',r=>{const s=r.boardMasterState||{};s.gomokuSettings={...(s.gomokuSettings||{}),playokUsername:'YOUR_NAME'};chrome.storage.local.set({boardMasterState:s})})");
        }
        return;
      }
      // Update userSide via debounce — swap2 'swap' actions flip
      // colours mid-game without adding a stone, so a once-and-done
      // cache goes stale and the engine receives moves with inverted
      // OWN/OPPONENT codes. But raw frame-by-frame detection is
      // also unreliable: during Playok's game-transition animations
      // (game over → new game) the colour-box and arrow flicker
      // X↔O every poll, which would otherwise fire spurious /swap2
      // calls. Require N consecutive same-side detections before we
      // commit a change.
      const detectedSide = playersForId?.user?.side;
      let sideChanged = false;
      if (detectedSide && detectedSide !== userSide) {
        if (userSideCandidate === detectedSide) {
          userSideCandidateHits++;
        } else {
          userSideCandidate = detectedSide;
          userSideCandidateHits = 1;
        }
        if (userSideCandidateHits >= USERSIDE_STABLE_HITS) {
          if (!userSide) {
            console.log(TAG, 'user side:', detectedSide,
              '(' + playersForId.user.name + ' vs ' + (playersForId.opponent?.name || '?') + ')',
              playersForId.myName ? '— matched header name' : '— fallback');
          } else {
            console.log(TAG, 'user side flipped (stable):', userSide, '→', detectedSide);
            sideChanged = true;
          }
          userSide = detectedSide;
          userSideCandidate = '';
          userSideCandidateHits = 0;
        }
      } else if (userSideCandidate) {
        // Detected side reverted to the committed value before stabilising
        // — pure flicker, drop the candidate.
        userSideCandidate = '';
        userSideCandidateHits = 0;
      }


      if (!GRID) detectGrid();
      if (!GRID) return;

      const snap = snapshotBoard();
      if (!snap) return;

      // Include turn in the key so a silent turn-flip (e.g. swap2
      // 'swap' action: colours change but no stone is added) still
      // bumps the key and triggers a fresh analysis. Otherwise the
      // canvas pixels are identical and analyzeBoard would return
      // early forever after the swap.
      const turnKey = playersForId?.turn || '';
      const snapKey = JSON.stringify(snap) + '|t=' + turnKey + '|u=' + userSide;
      if (!sideChanged && snapKey === prevSnapshotKey) return;
      prevSnapshotKey = snapKey;

      // Refresh once more (cheap) so the next-block check sees the latest
      const players = detectPlayers();

      const { x, o } = countStones(snap);
      const total = x + o;
      // Prefer DOM-reported turn (from arrow indicator); fall back to parity.
      const turn = players?.turn || ((x === o) ? 'X' : 'O');
      const moves = buildMovesFromBoard(snap);

      // Reset swap2 protocol state on a fresh board (new game).
      if (total === 0 && (swap2OpeningResolved || pendingMoves.length > 0)) {
        console.log(TAG, 'swap2 protocol state reset (new game) — clearing',
          pendingMoves.length, 'pending moves');
        swap2OpeningResolved = false;
        pendingMoves = [];
      }
      // A userSide flip is the signature of opp's swap2 'swap' action.
      // Whatever stones we had queued were planned under the old colour
      // assignment; they're no longer valid. Clear them and mark the
      // protocol resolved so we use /move from now on (calling /swap2
      // again post-swap would re-evaluate a decision opp already made).
      if (sideChanged) {
        if (pendingMoves.length > 0) {
          console.log(TAG, 'side flip — discarding', pendingMoves.length,
            'stale pending moves');
          pendingMoves = [];
        }
        if (total > 0 && !swap2OpeningResolved) {
          console.log(TAG, 'swap2 protocol resolved (mid-opening side flip)');
          swap2OpeningResolved = true;
        }
      }

      clearHighlight();
      suggestedMove = null;

      // If we have queued moves from a prior /swap2 result (opening = 3
      // stones, put_two = 2 stones) and the user just placed one of
      // them manually, advance to the next pending stone instead of
      // re-querying the engine with /move (which can't see the
      // opening intent and would suggest a different next stone).
      if (pendingMoves.length > 0) {
        pendingMoves = pendingMoves.filter(m =>
          !snap[m.y] || snap[m.y][m.x] === 0);
        if (pendingMoves.length > 0) {
          const next = pendingMoves[0];
          console.log(TAG, 'pending swap2 queue:', pendingMoves.length, 'left → hint',
            next.x + ',' + next.y);
          highlightCell(next.x, next.y);
          return;
        }
      }

      // Swap2 protocol: only the /swap2 endpoint understands the
      // proposer / chooser decisions. The panel turn-arrow is the
      // single source of truth for who acts at any moment — that
      // already encodes "is it my turn to be the proposer/chooser?":
      //   • 0 stones, arrow on me → I'm proposer (places opening 3).
      //   • 3 stones, arrow on me → I'm chooser (deciding swap/play/put_two).
      //   • 5 stones, arrow on me → I'm proposer (deciding swap/play after put_two).
      //
      // (Earlier code tried to derive "decider" from stone-colour
      // counts, but at 3 stones the BWB opening always has 2 black +
      // 1 white regardless of who placed them — the chooser's userStones
      // is 1, not 0, so that heuristic blocked /swap2 incorrectly.)
      const isUserTurn = !!(players?.user?.isActive);
      const atDecisionPoint = [0, 3, 5].includes(total);
      // While userSide is still being debounced (Playok mid-transition),
      // refuse to fire /swap2 — the side reading isn't trustworthy yet
      // and the wrong perspective would have the engine propose moves
      // for the opposite player.
      const sideStable = !userSideCandidate;
      const useSwap2 = swap2Mode && atDecisionPoint && isUserTurn &&
                       pendingMoves.length === 0 && !swap2OpeningResolved &&
                       sideStable;

      if (useSwap2) {
        console.log(TAG, 'swap2 decision point — stones:', total,
          'turn:', turn, 'userSide:', userSide || '(unknown)');
        analysisInFlight = true;
        safeSendMessage({
          command: 'analyzeGomokuSwap2',
          boardSize: GRID.cols,
          moves,
          platform: 'playok.com',
        });
        return;
      }

      // In swap2 mode during the opening phase (total < 6, before
      // the protocol settles into regular play), if it's not our
      // turn there's nothing useful to compute — opponent is acting,
      // wait. Calling /move with rule=6 + 0/3/5 stones is also the
      // wrong endpoint (Rapfi expects /swap2 there) and at 1/2/4
      // stones during opening the position is in flux and the engine
      // can't yet give a meaningful hint.
      if (swap2Mode && total < 6 && !isUserTurn && !swap2OpeningResolved) {
        console.log(TAG, 'swap2 wait — total:', total,
          'userSide:', userSide || '(?)', '(opponent acting)');
        return;
      }

      console.log(TAG, 'board change — X:', x, 'O:', o, 'turn:', turn,
        swap2Mode ? '(swap2 mode)' : '');

      analysisInFlight = true;
      safeSendMessage({
        command: 'analyzeGomoku',
        boardSize: GRID.cols,
        moves, turn,
        // /move only accepts rule ∈ {0,1,2}; rule=6 (free-swap2) is
        // /swap2-only. During a swap2 game's regular play (counts
        // 1,2,4,≥6) we use rule=0 (freestyle) — same effective
        // ruleset (no renju constraints), just the legal value /move
        // accepts.
        rulePreference: swap2Mode ? 'freestyle' : null,
        platform: 'playok.com',
        isRetry: false,
      });
    }

    // Sequentially play queued moves with the user's configured delay.
    // Used for /swap2 actions that return multiple stones at once
    // (action='opening' = 3 stones, action='put_two' = 2 stones).
    function playPendingMoves() {
      if (pendingTimerId) { clearTimeout(pendingTimerId); pendingTimerId = null; }
      if (!autoMode || !contextValid) return;
      if (!pendingMoves.length) return;

      // Drop moves that are already on the board (defensive — in case
      // user manually placed one before we got here).
      const snap = snapshotBoard();
      if (snap) {
        pendingMoves = pendingMoves.filter(m =>
          !snap[m.y] || !snap[m.y][m.x]);
      }
      if (!pendingMoves.length) return;

      chrome.storage.local.get('boardMasterState', (result) => {
        const gs = result?.boardMasterState?.gomokuSettings || {};
        const delay = gs.randomDelay
          ? Math.floor(Math.random() *
              ((gs.randomDelayMax || 5000) - (gs.randomDelayMin || 200) + 1)) +
            (gs.randomDelayMin || 200)
          : (gs.autoDelay || 1000);
        pendingTimerId = setTimeout(() => {
          if (!autoMode || !pendingMoves.length) return;
          const m = pendingMoves.shift();
          console.log(TAG, 'swap2 auto-play (' + (pendingMoves.length) +
            ' more queued):', m);
          clickCell(m.x, m.y);
          if (pendingMoves.length) playPendingMoves();
        }, delay);
      });
    }

    // Find the playok swap button — appears for the chooser when the
    // engine wants to take black. Selector is a best-effort guess; if
    // it doesn't fire, log it and let the user click manually.
    function clickSwapButton() {
      // Likely candidates: a button or link near .tsinbo / .bcont
      // labelled "swap" or with a swap icon. Without a confirmed DOM
      // sample we just scan for clickable elements containing the text.
      const candidates = Array.from(document.querySelectorAll(
        '#appcont button, #appcont a, .bcont button, .bcont a, ' +
        '.bcont [class*="butsys"], .bcont [class*="butsit"]'));
      const swapBtn = candidates.find(el => {
        const t = (el.textContent || '').trim().toLowerCase();
        return t === 'swap' || t === 'swap colors' || t === 'switch';
      });
      if (swapBtn) {
        console.log(TAG, 'clicking swap button:', swapBtn);
        swapBtn.click();
        return true;
      }
      console.warn(TAG, 'swap button not found — please click "swap" '
        + 'manually. (Paste the button DOM so I can wire it.)');
      return false;
    }

    // ─── Auto-play scheduling ───
    function scheduleAutoPlay(col, row) {
      if (autoTimerId) { clearTimeout(autoTimerId); autoTimerId = null; }
      if (!autoMode) return;
      if (userSide && currentTurn !== userSide) {
        console.log(TAG, 'not user turn (' + currentTurn + ' vs ' + userSide + ') — skip auto-play');
        return;
      }
      chrome.storage.local.get('boardMasterState', (result) => {
        const gs = result?.boardMasterState?.gomokuSettings || {};
        let delay;
        if (gs.randomDelay) {
          const min = gs.randomDelayMin || 200;
          const max = gs.randomDelayMax || 5000;
          delay = Math.floor(Math.random() * (max - min + 1)) + min;
        } else {
          delay = gs.autoDelay || 1000;
        }
        console.log(TAG, 'auto-play in', delay + 'ms', gs.randomDelay ? '(random)' : '');
        autoTimerId = setTimeout(() => { if (autoMode) clickCell(col, row); }, delay);
      });
    }

    // ─── Highlight ───
    // X = black stone, O = white. Border matches the stone colour and
    // we add a contrasting box-shadow ring so the hint stays visible
    // against the brown wood background.
    function highlightCell(col, row) {
      clearHighlight();
      suggestedMove = { x: col, y: row };
      if (!hintsVisible || !GRID) return;
      const c = findBoardCanvas();
      if (!c) return;
      const rect = c.getBoundingClientRect();
      const sx = rect.width / c.width, sy = rect.height / c.height;
      const cx = (GRID.x0 + col * GRID.cellW) * sx;
      const cy = (GRID.y0 + row * GRID.cellH) * sy;
      const size = Math.max(20, GRID.cellW * sx * 0.85);
      const isX = currentTurn === 'X';

      const border  = isX ? '#000' : '#fff';
      const fill    = isX ? 'rgba(0,0,0,0.32)' : 'rgba(255,255,255,0.45)';
      const contrast= isX ? '#fff' : '#000';

      highlightEl = document.createElement('div');
      highlightEl.style.cssText = [
        'position:fixed', 'pointer-events:none', 'z-index:99999',
        'left:'   + (rect.left + cx - size / 2) + 'px',
        'top:'    + (rect.top  + cy - size / 2) + 'px',
        'width:'  + size + 'px',
        'height:' + size + 'px',
        'border-radius:50%',
        'border:3px solid ' + border,
        'background:' + fill,
        'box-shadow:0 0 0 2px ' + contrast + ', 0 0 6px rgba(0,0,0,0.35)',
        'animation:bm-gomoku-pulse 1.2s ease-in-out infinite',
      ].join(';');
      document.body.appendChild(highlightEl);
    }
    function clearHighlight() {
      if (highlightEl) { highlightEl.remove(); highlightEl = null; }
    }

    // ─── Click (used later by auto-play once user-side detection lands) ───
    function clickCell(col, row) {
      if (!GRID) return;
      const c = findBoardCanvas();
      if (!c) return;
      const rect = c.getBoundingClientRect();
      const sx = rect.width / c.width, sy = rect.height / c.height;
      const clientX = rect.left + GRID.colXs[col] * sx;
      const clientY = rect.top  + GRID.rowYs[row] * sy;
      const target = findInputLayer() || c;
      const init = {
        bubbles: true, cancelable: true, view: window, composed: true,
        clientX, clientY, screenX: clientX, screenY: clientY,
        button: 0, buttons: 1,
      };
      try { target.dispatchEvent(new PointerEvent('pointerdown',
        Object.assign({ pointerType: 'mouse', isPrimary: true }, init))); } catch (_) {}
      target.dispatchEvent(new MouseEvent('mousedown', init));
      const upInit = Object.assign({}, init, { buttons: 0 });
      try { target.dispatchEvent(new PointerEvent('pointerup',
        Object.assign({ pointerType: 'mouse', isPrimary: true }, upInit))); } catch (_) {}
      target.dispatchEvent(new MouseEvent('mouseup', upInit));
      target.dispatchEvent(new MouseEvent('click', upInit));
    }

    // ─── CSS for hint pulse ───
    function injectStyles() {
      if (document.querySelector('#bm-gomoku-styles')) return;
      const style = document.createElement('style');
      style.id = 'bm-gomoku-styles';
      style.textContent =
        '@keyframes bm-gomoku-pulse {' +
        '  0%,100% { opacity: 1; transform: scale(1); }' +
        '  50%     { opacity: .55; transform: scale(.88); }' +
        '}';
      (document.head || document.documentElement).appendChild(style);
    }

    // Refresh manual playokUsername when settings change (user types
    // their username in extension options without reload).
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.boardMasterState) {
          refreshManualNameFromStorage();
          // Force re-identification of user/side on next tick.
          userSide = '';
          userSideCandidate = '';
          userSideCandidateHits = 0;
          analyzeBoard._unidentifiedWarned = false;
          headerSelectorWarned = false;
          prevSnapshotKey = '';
        }
      });
    } catch (_) {}

    // ─── Init flow ───
    function tryInit() {
      const c = findBoardCanvas();
      if (!c) return false;
      if (c === boardCanvas) return true;

      boardCanvas = c;
      injectStyles();

      if (!notifiedGameDetected) {
        notifiedGameDetected = true;
        safeSendMessage({ command: 'gameDetected', gameType: 'gomoku', platform: 'playok.com' });
      }

      if (resizeObserver) resizeObserver.disconnect();
      resizeObserver = new ResizeObserver(() => {
        if (!contextValid) return;
        if (!boardCanvas) return;
        // Only invalidate when the intrinsic canvas dimensions actually
        // changed — getBoundingClientRect jitter from ancestor reflows
        // must NOT clobber a valid grid.
        if (boardCanvas.width !== GRID?.canvasW || boardCanvas.height !== GRID?.canvasH) {
          console.log(TAG, 'resize → invalidate grid');
          GRID = null; prevSnapshotKey = '';
          // Clear stale-coord highlight; detectGrid() will re-render at
          // the new coords on its next run because we kept suggestedMove.
          clearHighlight();
          // Re-detect promptly (don't wait for the next 500ms poll if
          // we're mid-analysis with analysisInFlight=true).
          setTimeout(() => { if (!GRID) detectGrid(); }, 100);
        }
      });
      resizeObserver.observe(c);

      // First detect after canvas finishes drawing
      setTimeout(() => { detectGrid(); analyzeBoard(); }, 1500);
      return true;
    }

    if (!tryInit() && document.body) {
      const obs = new MutationObserver(() => {
        if (!contextValid) { obs.disconnect(); return; }
        if (tryInit()) {
          // keep observer running — board can be rebuilt across matches
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }

    // Polling — canvas mutations don't fire DOM events so we tick.
    // Swap2 detection runs FIRST (and unconditionally) so we can see
    // banner state changes even while an analysis is in flight or while
    // the board canvas is still loading.
    pollIntervalId = setInterval(() => {
      if (!contextValid) { clearInterval(pollIntervalId); return; }
      refreshSwap2Flag();
      if (!boardCanvas || !document.contains(boardCanvas)) {
        boardCanvas = null; GRID = null; prevSnapshotKey = '';
        tryInit();
        return;
      }
      analyzeBoard();
    }, 500);

    // Message listener
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      switch (msg.command) {
        case 'getFEN':
          prevSnapshotKey = '';
          analyzeBoard();
          sendResponse({ ok: true });
          break;

        case 'updateGomokuHints':
          analysisInFlight = false;
          if (msg.turn) currentTurn = msg.turn;
          console.log(TAG, 'hint:', msg.move, 'turn:', currentTurn);
          if (msg.move && GRID &&
              msg.move.x < GRID.cols && msg.move.y < GRID.rows) {
            highlightCell(msg.move.x, msg.move.y);
            if (autoMode) scheduleAutoPlay(msg.move.x, msg.move.y);
          }
          break;

        case 'updateGomokuSwap2':
          analysisInFlight = false;
          console.log(TAG, 'swap2 →', msg.action,
            'engine:', msg.engineTime, msg);
          pendingMoves = [];
          if (pendingTimerId) { clearTimeout(pendingTimerId); pendingTimerId = null; }
          switch (msg.action) {
            case 'opening': {  // 3 stones (proposer)
              const list = (msg.moves || []).filter(m =>
                GRID && m.x < GRID.cols && m.y < GRID.rows);
              if (!list.length) break;
              pendingMoves = list.slice();
              highlightCell(list[0].x, list[0].y);
              console.log(TAG, 'swap2 opening — place these 3 stones:',
                list, '(highlighting first; queue will advance on each click)');
              if (autoMode) playPendingMoves();
              break;
            }
            case 'put_two': {  // 2 balancing stones (chooser)
              const list = (msg.moves || []).filter(m =>
                GRID && m.x < GRID.cols && m.y < GRID.rows);
              if (!list.length) break;
              pendingMoves = list.slice();
              highlightCell(list[0].x, list[0].y);
              console.log(TAG, 'swap2 put_two — place 2 balancing stones:',
                list);
              if (autoMode) playPendingMoves();
              break;
            }
            case 'move': {     // engine keeps colour and plays one stone
              // Engine returned a single concrete move = swap2 protocol
              // is settled from here; switch to /move next time.
              swap2OpeningResolved = true;
              if (msg.move && GRID &&
                  msg.move.x < GRID.cols && msg.move.y < GRID.rows) {
                highlightCell(msg.move.x, msg.move.y);
                console.log(TAG, 'swap2 move — keep colour, play:',
                  msg.move.x + ',' + msg.move.y);
                if (autoMode) scheduleAutoPlay(msg.move.x, msg.move.y);
              }
              break;
            }
            case 'swap': {     // engine wants to take the other colour
              // Engine wants the swap. Once the user clicks the swap
              // button (or autoMode does), the panel colours flip and
              // analyzeBoard's sideChanged path will mark the protocol
              // resolved. Either way we're done with /swap2.
              swap2OpeningResolved = true;
              console.log(TAG, 'swap2 SWAP — engine recommends taking the ' +
                'opposite colour. Click the "swap" button on Playok' +
                (autoMode ? ' (auto)' : ''));
              if (autoMode) clickSwapButton();
              break;
            }
            default:
              console.warn(TAG, 'unknown swap2 action:', msg.action);
          }
          break;

        case 'analysisError':
          analysisInFlight = false;
          console.log(TAG, 'analysis error:', msg.error);
          break;

        case 'analysisStarted': break;

        case 'startAuto':
          autoMode = true;
          console.log(TAG, 'auto-play ON — userSide:', userSide || '(detect on next move)');
          safeSendMessage({ command: 'autoStatus', status: 'running' });
          if (suggestedMove) scheduleAutoPlay(suggestedMove.x, suggestedMove.y);
          prevSnapshotKey = '';   // force re-analyze
          analyzeBoard();
          break;

        case 'stopAuto':
          autoMode = false;
          if (autoTimerId) { clearTimeout(autoTimerId); autoTimerId = null; }
          console.log(TAG, 'auto-play OFF');
          safeSendMessage({ command: 'autoStatus', status: 'stopped' });
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

  // ═══════════════════════════════════════════════════════════════
  //  Playok Gomoku — Debug / Reverse-engineering helpers
  //
  //  Board on playok is a <canvas>, not a DOM grid. Before we can
  //  read the position we need to figure out:
  //    • which canvas holds the board (there are multiple layers)
  //    • the grid origin + cell size in pixel space
  //    • where stones live (separate canvas? same canvas?)
  //    • whether playok exposes any game state on window.*
  //
  //  Implementation: inject content/gomoku-playok-debug.js into the
  //  page's MAIN world via a <script src> tag so window.bmGomokuDebug
  //  is reachable from the page console (content scripts live in an
  //  isolated world, so anything they put on window won't be visible
  //  to the user typing into the regular console context).
  // ═══════════════════════════════════════════════════════════════
  function initPlayokDebug() {
    const url = chrome.runtime.getURL('content/gomoku-playok-debug.js');
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => s.remove();
    s.onerror = (e) => console.warn('[BM][gomoku][playok-debug] inject failed', e);
    (document.head || document.documentElement).appendChild(s);
    console.log('[BM][gomoku][playok-debug] injected', url);
  }

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
