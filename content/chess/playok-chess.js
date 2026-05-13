// ─── PlayOK Chess Content Script (Phase 2) ───
// PlayOK renders chess pieces as DOM <img> overlays on a canvas board
// (canvas only paints the squares grid; pieces are absolute-positioned
// IMGs as children of .bcont). The image src is an inline data: URL —
// 12 unique URLs across the 6 piece types × 2 colours.
//
// Strategy:
//   1. Detect grid origin + cell size from IMG positions (more accurate
//      than canvas pixel scanning).
//   2. Auto-calibrate piece map from the starting position: when 32 IMGs
//      sit on rows 0/1/6/7 with the canonical R-N-B-Q-K-B-N-R + 8 pawns
//      pattern, derive src → piece-code mapping by square.
//   3. Persist piece map in chrome.storage (re-use across page loads).
//   4. On every poll, snapshot the board, build a FEN, ship it to
//      analyzeFEN, render the engine's bestmove as an SVG arrow.
(function () {
  'use strict';
  if (!/\/chess(\/|$|\?|#)/i.test(location.pathname)) return;

  const TAG = '[BM][chess][playok]';
  console.log(TAG, 'content script loaded (Phase 2) at', location.href);

  // ─── State ───
  let contextValid = true;
  let notifiedGameDetected = false;
  let boardCanvas = null;
  let bcont = null;
  let pollIntervalId = null;
  let resizeObserver = null;
  let debugInjected = false;

  // Grid: {x0, y0, cellSize, flipped, canvasW, canvasH}
  let GRID = null;

  // Piece map: hash(src) → FEN piece code (P/N/B/R/Q/K/p/n/b/r/q/k).
  let pieceMap = {};
  let pieceMapCalibrated = false;
  const PIECE_MAP_STORAGE_KEY = 'playokChessPieceMap';

  // Track last raw board layout (Map<canvasIdx, src>) so we only build a
  // new FEN when something visibly changed.
  let lastBoardKey = '';
  let lastFen = '';
  let lastBestUci = '';
  let analyzing = false;
  let analyzingSince = 0;
  let hintsVisible = true;
  let autoMode = false;
  let autoTimerId = null;
  // Track which UCI we last auto-played so the same hint never fires
  // twice within one turn (e.g. on a stray re-analysis).
  let lastAutoPlayedUci = '';

  // Player panel state (refreshed on every tick).
  let userSide = '';    // 'w' / 'b' / ''
  let sideTurn = null;  // { userSide, turn }

  // SVG arrow overlay
  let arrowSvg = null;

  // Calibration log throttling
  let calibrateLogTick = 0;

  // Once-per-turn analysis gate. After PlayOK applies the user's move,
  // the piece IMGs update a few ms BEFORE the .tplcont turn-arrow flips
  // to the opponent. Without this gate the very next 500ms tick would
  // see (board changed, still our turn) and ship a phantom FEN. We
  // require an explicit turn TRANSITION before analyzing again.
  let prevMyTurn = false;
  let analyzedThisTurn = false;

  // ─── Boilerplate ───
  function safeSendMessage(msg) {
    if (!contextValid) return;
    try { chrome.runtime.sendMessage(msg); }
    catch (e) {
      if (e.message && e.message.includes('Extension context invalidated')) {
        console.log(TAG, 'context invalidated — cleanup');
        contextValid = false;
        cleanup();
      }
    }
  }

  function cleanup() {
    if (pollIntervalId) { clearInterval(pollIntervalId); pollIntervalId = null; }
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    if (autoTimerId)    { clearTimeout(autoTimerId); autoTimerId = null; }
    if (arrowSvg) { arrowSvg.remove(); arrowSvg = null; }
  }

  function findBoardCanvas() {
    return Array.from(document.querySelectorAll('canvas'))
      .find(c => c.width >= 400 && c.height >= 400) || null;
  }

  function injectDebug() {
    if (debugInjected) return;
    debugInjected = true;
    const url = chrome.runtime.getURL('content/chess/playok-chess-debug.js');
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => s.remove();
    s.onerror = (e) => console.warn(TAG, 'debug inject failed', e);
    (document.head || document.documentElement).appendChild(s);
  }

  // ─── IMG pixel-based colour classification ───
  // The ONLY source of truth for "is this piece white or black" that
  // doesn't depend on PlayOK's DOM panel detection (which can be wrong)
  // or our own pieceMap (which can be inverted if calibration was off).
  // Draw the IMG into a tiny offscreen canvas and count near-white vs
  // near-black opaque pixels. Cached per src signature — IMG content
  // doesn't change between ticks.
  let srcColorCache = {};
  let colorClsfWorkCanvas = null;
  let colorClsfWorkCtx = null;
  function classifyImgColor(img) {
    if (!img || !img.complete || img.naturalWidth === 0) return null;
    if (!img.src) return null;
    const sig = '__c_' + img.src.length + '_' + img.src.slice(-32);
    if (srcColorCache[sig] !== undefined) return srcColorCache[sig];
    try {
      if (!colorClsfWorkCanvas) {
        colorClsfWorkCanvas = document.createElement('canvas');
        colorClsfWorkCanvas.width = 32;
        colorClsfWorkCanvas.height = 32;
        colorClsfWorkCtx = colorClsfWorkCanvas.getContext('2d', { willReadFrequently: true });
      }
      colorClsfWorkCtx.clearRect(0, 0, 32, 32);
      colorClsfWorkCtx.drawImage(img, 0, 0, 32, 32);
      const data = colorClsfWorkCtx.getImageData(0, 0, 32, 32).data;
      let nW = 0, nB = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue; // transparent
        const L = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        if (L > 200) nW++;
        else if (L < 60) nB++;
      }
      if (nW + nB < 10) return null;
      const result = nW > nB ? 'w' : 'b';
      srcColorCache[sig] = result;
      return result;
    } catch (e) {
      return null;
    }
  }

  // ─── Hash function (djb2) ───
  // Used to compress 5KB data URLs down to 8-char base36 sigs for the
  // piece map — direct URL comparison would also work but blows up
  // chrome.storage size and is awkward to log.
  function djb2(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  // ─── Persistence ───
  function loadPieceMap() {
    try {
      chrome.storage.local.get('boardMasterState', (r) => {
        const st = r?.boardMasterState || {};
        const stored = st[PIECE_MAP_STORAGE_KEY];
        if (stored && typeof stored === 'object') {
          pieceMap = stored;
          const distinct = new Set(Object.values(pieceMap));
          pieceMapCalibrated = distinct.size === 12;
          console.log(TAG, 'loaded pieceMap (' + Object.keys(pieceMap).length +
            ' entries, ' + distinct.size + ' distinct pieces, calibrated=' +
            pieceMapCalibrated + ')');
        } else {
          console.log(TAG, 'no saved pieceMap — will calibrate at next starting position');
        }
      });
    } catch (_) {}
  }

  function savePieceMap() {
    try {
      chrome.storage.local.get('boardMasterState', (r) => {
        const st = r?.boardMasterState || {};
        st[PIECE_MAP_STORAGE_KEY] = pieceMap;
        chrome.storage.local.set({ boardMasterState: st });
        console.log(TAG, 'pieceMap saved to chrome.storage');
      });
    } catch (_) {}
  }

  // ─── Player panel: detect user side + turn ───
  // Same .tplcont structure as Gomoku PlayOK. Light/dark colour-box
  // identifies black vs white; the active-arrow indicates whose move.
  // To identify the local user, match the page-header username against
  // panel names — assuming "p[1] = user" (bottom panel) is FRAGILE on
  // PlayOK because panel ordering depends on board orientation and may
  // shift between games.
  const HEADER_NAME_SELECTORS = [
    '#appcont .nav0.usno.tama .msub',
    '#appcont .usno .msub',
    '#appcont .msub',
    '.nav0 .msub',
    '[class*="usno"] .msub',
    '#hdcont .msub',
    '.msub',
  ];
  let cachedManualName = null;
  let headerSelectorWarned = false;
  function refreshManualNameFromStorage() {
    try {
      chrome.storage.local.get('boardMasterState', (result) => {
        const cs = result?.boardMasterState?.chessSettings || {};
        const n = (cs.playokUsername || '').trim();
        if (n !== cachedManualName) {
          cachedManualName = n;
          if (n) console.log(TAG, 'manual playokUsername:', n);
        }
      });
    } catch (_) {}
  }
  refreshManualNameFromStorage();

  function getLoggedInName() {
    if (cachedManualName) return cachedManualName;
    for (const sel of HEADER_NAME_SELECTORS) {
      const el = document.querySelector(sel);
      const t = el && el.textContent && el.textContent.trim();
      if (t && t.length <= 40 && /^[A-Za-z0-9_-]+$/.test(t)) return t;
    }
    if (!headerSelectorWarned) {
      headerSelectorWarned = true;
      console.warn(TAG, 'could not locate logged-in name in header — set ' +
        'chessSettings.playokUsername to override (chrome.storage.local).' +
        '\nQuick fix from page console:\n' +
        "chrome.storage.local.get('boardMasterState',r=>{const s=r.boardMasterState||{};s.chessSettings={...(s.chessSettings||{}),playokUsername:'YOUR_NAME'};chrome.storage.local.set({boardMasterState:s})})");
    }
    return '';
  }

  function detectPlayers() {
    const cont = document.querySelector('.tplcont');
    if (!cont) return null;
    const panels = cont.querySelectorAll(':scope > div');
    const candidates = [];
    panels.forEach((sec) => {
      const nameEl   = sec.querySelector('.nowrel');
      const colorBox = sec.querySelector('.f12 > div');
      const arrowEl  = sec.querySelector('.tplext div[style*="border-bottom"]');
      if (!nameEl || !colorBox) return;
      const name = nameEl.textContent.trim();
      const isActive = !!(arrowEl && arrowEl.style.visibility === 'inherit');
      let side = '';
      const bg = (colorBox.style.background || colorBox.style.backgroundColor || '').toLowerCase();
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) {
        const L = (+m[1]) * 0.299 + (+m[2]) * 0.587 + (+m[3]) * 0.114;
        side = L < 128 ? 'b' : 'w';
      }
      candidates.push({ name, side, isActive });
    });
    return candidates;
  }

  // Identify which candidate panel is the local user by matching the
  // page header username against panel names. PlayOK's header sometimes
  // concatenates name + rating (e.g. "gmw343g1200" while panel just
  // says "gmw343g") — so accept exact match OR prefix match either way.
  let unidentifiedWarnedAt = 0;
  function getSideAndTurn() {
    const p = detectPlayers();
    if (!p || p.length < 2) return null;
    const myName = getLoggedInName();
    let user = null;
    if (myName) {
      user = p.find(c => c.name === myName) || null;
      if (!user) {
        const prefixMatches = p.filter(c =>
          c.name && (myName.startsWith(c.name) || c.name.startsWith(myName)));
        if (prefixMatches.length === 1) user = prefixMatches[0];
        else if (prefixMatches.length > 1) {
          user = prefixMatches.sort((a, b) => b.name.length - a.name.length)[0];
        }
      }
    }
    // No reliable signal — refuse to guess; calling code logs and waits.
    if (!user) {
      const now = Date.now();
      if (now - unidentifiedWarnedAt > 5000) {
        unidentifiedWarnedAt = now;
        const names = p.map(c => c.name + '/' + (c.side || '?')).join(' vs ');
        console.warn(TAG, 'cannot identify user. panels:', names,
          '| myName=' + JSON.stringify(myName));
      }
      return null;
    }
    const active = p.find(c => c.isActive);
    return {
      userSide: user.side || '',
      turn: active?.side || '',
      userName: user.name,
    };
  }

  // ─── Piece IMG helpers ───
  function pieceImgs() {
    if (!bcont) return [];
    return Array.from(bcont.querySelectorAll('img')).filter(img => {
      const r = img.getBoundingClientRect();
      return r.width > 10 && r.height > 10 && img.src;
    });
  }

  function imgToColRow(img) {
    if (!GRID || !boardCanvas) return null;
    const cRect = boardCanvas.getBoundingClientRect();
    const iRect = img.getBoundingClientRect();
    const sx = GRID.canvasW / cRect.width;
    const sy = GRID.canvasH / cRect.height;
    const ix = (iRect.left - cRect.left) * sx;
    const iy = (iRect.top  - cRect.top ) * sy;
    const col = Math.round((ix - GRID.x0) / GRID.cellSize);
    const row = Math.round((iy - GRID.y0) / GRID.cellSize);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    return { col, row };
  }

  // (col, row) → algebraic square. col 0 is canvas-left; row 0 is canvas-top.
  // flipped=true means board is rotated 180° (user is black, white at top).
  function colRowToSquare(col, row, flipped) {
    const file = String.fromCharCode(97 + (flipped ? 7 - col : col));
    const rank = (flipped ? row + 1 : 8 - row);
    return file + rank;
  }

  // ─── Grid detection from IMG positions ───
  // Pieces are 67.99×67.99 px squares in canvas-intrinsic coords. Derive
  // origin + cell size by collecting all IMG top-lefts and finding the
  // common grid they snap to. More reliable than pixel-edge detection
  // (which was off by ~3px in earlier testing).
  function detectGridFromPieces() {
    const imgs = pieceImgs();
    if (imgs.length < 2 || !boardCanvas) return null;
    const cRect = boardCanvas.getBoundingClientRect();
    const sx = boardCanvas.width / cRect.width;
    const sy = boardCanvas.height / cRect.height;

    const ixs = [], iys = [], sizes = [];
    imgs.forEach((img) => {
      const r = img.getBoundingClientRect();
      ixs.push((r.left - cRect.left) * sx);
      iys.push((r.top  - cRect.top ) * sy);
      sizes.push(r.width * sx);
    });
    sizes.sort((a, b) => a - b);
    const cellSize = Math.round(sizes[Math.floor(sizes.length / 2)]);
    const minX = Math.min.apply(null, ixs);
    const minY = Math.min.apply(null, iys);
    const x0c = ixs.map(x => x - Math.round((x - minX) / cellSize) * cellSize);
    const y0c = iys.map(y => y - Math.round((y - minY) / cellSize) * cellSize);
    x0c.sort((a, b) => a - b);
    y0c.sort((a, b) => a - b);
    const x0 = Math.round(x0c[Math.floor(x0c.length / 2)]);
    const y0 = Math.round(y0c[Math.floor(y0c.length / 2)]);

    const next = {
      x0, y0, cellSize,
      flipped: GRID?.flipped || false,
      canvasW: boardCanvas.width,
      canvasH: boardCanvas.height,
    };
    if (!GRID || GRID.x0 !== x0 || GRID.y0 !== y0 || GRID.cellSize !== cellSize) {
      console.log(TAG, 'GRID:', next);
    }
    GRID = next;
    return GRID;
  }

  // ─── Calibrate piece map from starting position ───
  // Starting position has:
  //   - 32 pieces total
  //   - 8 pawns each on rows 1 and 6 (single distinct src per row)
  //   - Major rows on 0 and 7: R N B Q K B N R (3 piece types appearing
  //     2x each — R/N/B — plus Q & K once each)
  // Once these constraints hold we can confidently bind each src to a
  // piece code by column position.
  function tryCalibrate(imgs) {
    if (imgs.length !== 32) return false;

    const byRow = { 0: [], 1: [], 6: [], 7: [] };
    let outside = 0;
    for (const img of imgs) {
      const cr = imgToColRow(img);
      if (!cr) { outside++; continue; }
      if (cr.row === 0 || cr.row === 1 || cr.row === 6 || cr.row === 7) {
        byRow[cr.row].push({ col: cr.col, src: img.src });
      } else {
        outside++;
      }
    }
    if (outside > 0) return false;
    if (byRow[0].length !== 8 || byRow[1].length !== 8 ||
        byRow[6].length !== 8 || byRow[7].length !== 8) return false;

    // Pawn rows must be homogeneous and different from each other.
    const pawnSrc1 = byRow[1][0].src;
    if (!byRow[1].every(p => p.src === pawnSrc1)) return false;
    const pawnSrc6 = byRow[6][0].src;
    if (!byRow[6].every(p => p.src === pawnSrc6)) return false;
    if (pawnSrc1 === pawnSrc6) return false;

    // Major rows: cols 0/7 same (rooks), 1/6 same (knights),
    // 2/5 same (bishops), 3/4 different (Q vs K).
    function majorRowOK(row) {
      const arr = row.slice().sort((a, b) => a.col - b.col);
      if (arr[0].src !== arr[7].src) return null;
      if (arr[1].src !== arr[6].src) return null;
      if (arr[2].src !== arr[5].src) return null;
      if (arr[3].src === arr[4].src) return null;
      return arr;
    }
    const wMajor = majorRowOK(byRow[7]);
    const bMajor = majorRowOK(byRow[0]);
    if (!wMajor || !bMajor) return false;

    // Determine flipped from PIXEL CLASSIFICATION of bottom-row pieces.
    // Bottom row visually white → standard orientation (user is white).
    // Bottom row visually black → board is flipped (user is black).
    // We do NOT rely on .tplcont panel info here — the panel colour-box
    // detection has proved unreliable for chess (vs. gomoku), causing
    // inverted pieceMaps that persist via storage cache.
    let bottomW = 0, bottomB = 0;
    for (const p of byRow[7]) {
      const img = imgs.find(i => i.src === p.src && classifyImgColor(i) !== null);
      const c = img ? classifyImgColor(img) : null;
      if (c === 'w') bottomW++;
      else if (c === 'b') bottomB++;
    }
    if (bottomW + bottomB < 4) {
      if (calibrateLogTick++ % 10 === 0) {
        console.log(TAG, 'calibration: waiting for piece images to load ' +
          '(bottomW=' + bottomW + ' bottomB=' + bottomB + ')');
      }
      return false;
    }
    const userIsWhite = bottomW > bottomB;
    // userIsWhite → not flipped: row 7 = rank 1 (white major), row 0 = rank 8 (black)
    // userIsBlack → flipped:     row 7 = rank 8 (black major), row 0 = rank 1 (white)
    const flipped = !userIsWhite;
    const whiteMajor = userIsWhite ? wMajor : bMajor;
    const blackMajor = userIsWhite ? bMajor : wMajor;
    const whitePawnSrc = userIsWhite ? pawnSrc6 : pawnSrc1;
    const blackPawnSrc = userIsWhite ? pawnSrc1 : pawnSrc6;

    // Major piece pattern by column order, depending on flip:
    //   Not flipped: col 0..7 → files a..h → R N B Q K B N R
    //   Flipped:     col 0..7 → files h..a → R N B K Q B N R
    const majorByCol = flipped
      ? ['R', 'N', 'B', 'K', 'Q', 'B', 'N', 'R']
      : ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];

    const newMap = {};
    newMap[djb2(whitePawnSrc)] = 'P';
    newMap[djb2(blackPawnSrc)] = 'p';
    for (let i = 0; i < 8; i++) {
      newMap[djb2(whiteMajor[i].src)] = majorByCol[i];
      newMap[djb2(blackMajor[i].src)] = majorByCol[i].toLowerCase();
    }

    const distinct = new Set(Object.values(newMap));
    if (distinct.size !== 12) {
      console.warn(TAG, 'calibration produced', distinct.size, 'distinct codes (expected 12) — abort');
      return false;
    }

    pieceMap = newMap;
    pieceMapCalibrated = true;
    GRID.flipped = flipped;
    console.log(TAG, '✅ piece map CALIBRATED');
    console.log(TAG, '   userIsWhite=' + userIsWhite + ' flipped=' + flipped +
      ' (bottomW=' + bottomW + ' bottomB=' + bottomB + ')');
    console.log(TAG, '   mapping:', pieceMap);
    savePieceMap();
    return true;
  }

  // ─── Re-detect board orientation from pixel-level piece colours ───
  // Uses classifyImgColor (pixel sampling) — INDEPENDENT of pieceMap and
  // panel detection, so it can correct both a stale flip flag AND an
  // inverted pieceMap.
  function redetectFlipped(imgs) {
    if (!GRID) return;
    let bottomW = 0, bottomB = 0, topW = 0, topB = 0;
    for (const img of imgs) {
      const cr = imgToColRow(img);
      if (!cr) continue;
      const c = classifyImgColor(img);
      if (!c) continue;
      if (cr.row >= 6) { c === 'w' ? bottomW++ : bottomB++; }
      else if (cr.row <= 1) { c === 'w' ? topW++ : topB++; }
    }
    if (bottomW + bottomB < 4 && topW + topB < 4) return;

    // Bottom rows are most reliable (user sits there). If only top has
    // pieces, infer the inverse.
    let detected;
    if (bottomW + bottomB >= 4) detected = bottomB > bottomW;
    else detected = topW > topB;

    if (detected !== GRID.flipped) {
      console.log(TAG, '🔄 flip redetected (pixel-based):', GRID.flipped, '→', detected,
        '(bottom w=' + bottomW + ' b=' + bottomB +
        ' | top w=' + topW + ' b=' + topB + ')');
      GRID.flipped = detected;
      lastBoardKey = '';
      lastFen = '';
      clearArrow();
      lastBestUci = '';
    }
  }

  // ─── pieceMap sanity check ───
  // If pieceMap was previously calibrated with an inverted user-side,
  // every src is mapped to the opposite colour code (whiteRook src →
  // 'r' lowercase, blackRook src → 'R' uppercase). Detect this by
  // comparing pieceMap's reported colour against pixel classification
  // for ≥4 IMGs. If majority disagree, nuke pieceMap + force recalibration.
  function validatePieceMap(imgs) {
    if (!pieceMapCalibrated) return true;
    let agree = 0, disagree = 0;
    for (const img of imgs) {
      const piece = pieceMap[djb2(img.src)];
      if (!piece) continue;
      const c = classifyImgColor(img);
      if (!c) continue;
      const pieceIsWhite = piece >= 'A' && piece <= 'Z';
      if ((pieceIsWhite && c === 'w') || (!pieceIsWhite && c === 'b')) agree++;
      else disagree++;
    }
    if (disagree >= 4 && disagree > agree) {
      console.warn(TAG, '⚠️  pieceMap is COLOUR-INVERTED (agree=' + agree +
        ' disagree=' + disagree + ') — clearing for re-calibration');
      pieceMap = {};
      pieceMapCalibrated = false;
      srcColorCache = {};
      try {
        chrome.storage.local.get('boardMasterState', (r) => {
          const st = r?.boardMasterState || {};
          delete st[PIECE_MAP_STORAGE_KEY];
          chrome.storage.local.set({ boardMasterState: st });
        });
      } catch (_) {}
      return false;
    }
    return true;
  }

  // ─── Snapshot board ───
  function snapshotBoard(imgs) {
    if (!pieceMapCalibrated || !GRID) return null;
    const board = {};
    const unknownSrcs = [];
    for (const img of imgs) {
      const cr = imgToColRow(img);
      if (!cr) continue;
      const sig = djb2(img.src);
      const piece = pieceMap[sig];
      if (!piece) { unknownSrcs.push(img.src); continue; }
      const sq = colRowToSquare(cr.col, cr.row, GRID.flipped);
      board[sq] = piece;
    }
    if (unknownSrcs.length > 0) {
      // Log once per distinct unknown src — could happen if playok
      // updates assets, in which case the user needs to manually clear
      // pieceMap via the debug helper.
      snapshotBoard._loggedUnknowns = snapshotBoard._loggedUnknowns || new Set();
      for (const src of unknownSrcs) {
        const sig = djb2(src);
        if (!snapshotBoard._loggedUnknowns.has(sig)) {
          snapshotBoard._loggedUnknowns.add(sig);
          console.warn(TAG, 'unknown piece sig:', sig,
            'src head:', src.slice(0, 60) + '…',
            'tail:', src.slice(-32));
          console.warn(TAG, '→ assets may have changed; reset via debug ' +
            'console or wait for a starting-position to recalibrate.');
        }
      }
      return null;
    }
    return board;
  }

  // ─── FEN builder ───
  function boardToFen(board, sideToMove) {
    const ranks = [];
    for (let rank = 8; rank >= 1; rank--) {
      let row = '';
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const sq = String.fromCharCode(97 + f) + rank;
        const p = board[sq];
        if (p) {
          if (empty > 0) { row += empty; empty = 0; }
          row += p;
        } else empty++;
      }
      if (empty > 0) row += empty;
      ranks.push(row);
    }

    // Castling — heuristic: allow if king at home AND rook at home.
    // We don't track move history, so this can over-grant rights (e.g.
    // king moved to e1 then back stays "K"). Acceptable trade-off.
    let castling = '';
    if (board.e1 === 'K') {
      if (board.h1 === 'R') castling += 'K';
      if (board.a1 === 'R') castling += 'Q';
    }
    if (board.e8 === 'k') {
      if (board.h8 === 'r') castling += 'k';
      if (board.a8 === 'r') castling += 'q';
    }
    if (!castling) castling = '-';

    return [ranks.join('/'), sideToMove, castling, '-', '0', '1'].join(' ');
  }

  // ─── SVG arrow overlay ───
  // Floats above the canvas with viewport-fixed positioning. Re-rendered
  // on every analysis response and on window scroll/resize.
  function ensureArrowSvg() {
    if (arrowSvg && document.body.contains(arrowSvg)) return arrowSvg;
    arrowSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrowSvg.id = 'bm-playok-chess-arrows';
    arrowSvg.style.cssText =
      'position:fixed;left:0;top:0;pointer-events:none;z-index:99999;';
    document.body.appendChild(arrowSvg);
    return arrowSvg;
  }

  function clearArrow() {
    if (arrowSvg) while (arrowSvg.firstChild) arrowSvg.removeChild(arrowSvg.firstChild);
  }

  function squareViewportCenter(sq) {
    const f = sq.charCodeAt(0) - 97;
    const r = parseInt(sq[1], 10) - 1;
    const col = GRID.flipped ? 7 - f : f;
    const row = GRID.flipped ? r : 7 - r;
    const cx = GRID.x0 + (col + 0.5) * GRID.cellSize;
    const cy = GRID.y0 + (row + 0.5) * GRID.cellSize;
    const cRect = boardCanvas.getBoundingClientRect();
    const sx = cRect.width / boardCanvas.width;
    const sy = cRect.height / boardCanvas.height;
    return { x: cRect.left + cx * sx, y: cRect.top + cy * sy };
  }

  function renderArrow(fromSq, toSq) {
    clearArrow();
    if (!hintsVisible || !GRID || !boardCanvas) return;
    if (!fromSq || !toSq) return;

    const svg = ensureArrowSvg();
    svg.style.width  = window.innerWidth + 'px';
    svg.style.height = window.innerHeight + 'px';
    svg.setAttribute('viewBox', '0 0 ' + window.innerWidth + ' ' + window.innerHeight);

    const from = squareViewportCenter(fromSq);
    const to   = squareViewportCenter(toSq);
    // Diagnostic: log the exact viewport coords used + canvas/GRID state
    // so we can match the arrow against the actual on-screen squares.
    const cRect = boardCanvas.getBoundingClientRect();
    console.log(TAG, '[arrow]',
      fromSq + '→' + toSq,
      '| from(viewport)=' + from.x.toFixed(1) + ',' + from.y.toFixed(1),
      'to(viewport)=' + to.x.toFixed(1) + ',' + to.y.toFixed(1),
      '| canvas rect=' + cRect.left.toFixed(1) + ',' + cRect.top.toFixed(1) +
      ' (' + cRect.width.toFixed(1) + 'x' + cRect.height.toFixed(1) + ')',
      '| GRID x0=' + GRID.x0 + ' y0=' + GRID.y0 +
      ' cell=' + GRID.cellSize + ' flipped=' + GRID.flipped);
    // Drop visible debug dots at the computed from/to centres. Cleared
    // on next clearArrow(). Lets us visually confirm whether the math
    // matches the actual square — if the dot is off, the rendering is
    // wrong; if it aligns with the wrong square the bug is in
    // squareViewportCenter / GRID.
    const dot = (pt, color) => {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', pt.x); c.setAttribute('cy', pt.y);
      c.setAttribute('r', '4');   c.setAttribute('fill', color);
      c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', '1');
      svg.appendChild(c);
    };
    dot(from, '#ff0000');
    dot(to,   '#00cc00');
    const dx = to.x - from.x, dy = to.y - from.y;
    const L = Math.hypot(dx, dy);
    if (L < 1) return;
    const ux = dx / L, uy = dy / L;
    const px = -uy, py = ux;

    // Sizes scale with cell size so the arrow looks proportionate.
    const cellPx = (boardCanvas.getBoundingClientRect().width / boardCanvas.width) * GRID.cellSize;
    const w        = cellPx * 0.18;
    const headLen  = cellPx * 0.42;
    const headHw   = cellPx * 0.34;
    const offset   = cellPx * 0.25;
    const tipBack  = cellPx * 0.12;

    const sx0 = from.x + ux * offset, sy0 = from.y + uy * offset;
    const tipX = to.x - ux * tipBack, tipY = to.y - uy * tipBack;
    const bodyLen = L - offset - headLen;

    let d;
    if (bodyLen < 5) {
      d = ['M', sx0 + px * headHw, sy0 + py * headHw,
           'L', tipX, tipY,
           'L', sx0 - px * headHw, sy0 - py * headHw, 'Z'].join(' ');
    } else {
      const bx = sx0 + ux * bodyLen;
      const by = sy0 + uy * bodyLen;
      d = ['M', sx0 + px * w,      sy0 + py * w,
           'L', bx + px * w,       by + py * w,
           'L', bx + px * headHw,  by + py * headHw,
           'L', tipX, tipY,
           'L', bx - px * headHw,  by - py * headHw,
           'L', bx - px * w,       by - py * w,
           'L', sx0 - px * w,      sy0 - py * w,
           'Z'].join(' ');
    }
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'rgba(255,170,0,0.85)');
    path.setAttribute('stroke', 'rgba(120,60,0,0.6)');
    path.setAttribute('stroke-width', '1');
    svg.appendChild(path);
  }

  function rerenderArrow() {
    if (lastBestUci && lastBestUci.length >= 4) {
      renderArrow(lastBestUci.slice(0, 2), lastBestUci.slice(2, 4));
    }
  }

  // ─── Auto-play ───
  // Click-click pattern: click from-square, ~150ms delay, click to-square.
  // PlayOK's input layer is .tsinbo.bsbb — sits over the canvas and
  // captures pointer events. We dispatch pointer + mouse events to it
  // (matches the Gomoku PlayOK implementation that's been tested in
  // production).
  function findInputLayer() {
    return document.querySelector('.tsinbo.bsbb') || boardCanvas;
  }

  function squareToViewportXY(uciSq) {
    if (!GRID || !boardCanvas) return null;
    const f = uciSq.charCodeAt(0) - 97;
    const r = parseInt(uciSq[1], 10) - 1;
    const col = GRID.flipped ? 7 - f : f;
    const row = GRID.flipped ? r : 7 - r;
    const cRect = boardCanvas.getBoundingClientRect();
    const sx = cRect.width / boardCanvas.width;
    const sy = cRect.height / boardCanvas.height;
    const cx = GRID.x0 + (col + 0.5) * GRID.cellSize;
    const cy = GRID.y0 + (row + 0.5) * GRID.cellSize;
    return { x: cRect.left + cx * sx, y: cRect.top + cy * sy };
  }

  function dispatchClickAt(x, y, label) {
    // Use whatever element is actually under the cursor at this point
    // — for a FROM square with a piece this is the IMG, for an empty
    // TO square it's the canvas or input layer. Dispatching to the
    // real hit-target lets PlayOK's piece-level handlers see the event
    // with the right `event.target`; events still bubble up to
    // .tsinbo.bsbb / document for any delegated listeners.
    const elAtPt = document.elementFromPoint(x, y);
    const inputLayer = findInputLayer();
    const target = elAtPt || inputLayer || boardCanvas;
    if (!target) {
      console.warn(TAG, '[click] no target', label || '');
      return;
    }
    const desc = (el) => el ? el.tagName +
      (el.className ? '.' + String(el.className).trim().replace(/\s+/g, '.') : '') : '(none)';
    console.log(TAG, '[click]', label || '', 'at', x.toFixed(0) + ',' + y.toFixed(0),
      '→ target=' + desc(target));

    const init = {
      bubbles: true, cancelable: true, view: window, composed: true,
      clientX: x, clientY: y, screenX: x, screenY: y,
      button: 0, buttons: 1,
    };
    try {
      target.dispatchEvent(new PointerEvent('pointerdown',
        Object.assign({ pointerType: 'mouse', isPrimary: true }, init)));
    } catch (_) {}
    target.dispatchEvent(new MouseEvent('mousedown', init));
    const upInit = Object.assign({}, init, { buttons: 0 });
    try {
      target.dispatchEvent(new PointerEvent('pointerup',
        Object.assign({ pointerType: 'mouse', isPrimary: true }, upInit)));
    } catch (_) {}
    target.dispatchEvent(new MouseEvent('mouseup', upInit));
    target.dispatchEvent(new MouseEvent('click', upInit));
  }

  function playMove(uci) {
    if (!uci || uci.length < 4 || !GRID || !boardCanvas) {
      console.warn(TAG, '[auto] playMove abort — uci=' + uci +
        ' GRID=' + !!GRID + ' canvas=' + !!boardCanvas);
      return false;
    }
    const from = uci.slice(0, 2);
    const to   = uci.slice(2, 4);
    const promo = uci.length >= 5 ? uci[4] : '';
    const fromPt = squareToViewportXY(from);
    const toPt   = squareToViewportXY(to);
    if (!fromPt || !toPt) {
      console.warn(TAG, '[auto] playMove abort — coord calc failed');
      return false;
    }
    console.log(TAG, '🤖 auto-play', from, '→', to,
      promo ? '(promotion=' + promo + ')' : '',
      '| from=' + fromPt.x.toFixed(0) + ',' + fromPt.y.toFixed(0),
      'to=' + toPt.x.toFixed(0) + ',' + toPt.y.toFixed(0));
    dispatchClickAt(fromPt.x, fromPt.y, 'FROM ' + from);
    setTimeout(() => {
      dispatchClickAt(toPt.x, toPt.y, 'TO ' + to);
      if (promo) {
        console.warn(TAG, 'promotion picker handling not implemented — ' +
          'click the desired piece manually');
      }
      safeSendMessage({ command: 'autoMovePlayed', move: uci });
    }, 200);
    return true;
  }

  function scheduleAutoPlay(uci) {
    if (autoTimerId) { clearTimeout(autoTimerId); autoTimerId = null; }
    if (!autoMode) {
      console.log(TAG, '[auto] scheduleAutoPlay called but autoMode=false');
      return;
    }
    if (!uci || uci.length < 4) {
      console.log(TAG, '[auto] scheduleAutoPlay no valid uci:', uci);
      return;
    }
    if (uci === lastAutoPlayedUci) {
      console.log(TAG, '[auto] uci already played this turn, skip:', uci);
      return;
    }
    const ourSide = GRID?.flipped ? 'b' : 'w';
    const turnNow = sideTurn?.turn || '';
    if (turnNow !== ourSide) {
      console.log(TAG, '[auto] skip: turn=' + turnNow + ' vs ourSide=' + ourSide);
      return;
    }
    try {
      chrome.storage.local.get('boardMasterState', (result) => {
        const cs = result?.boardMasterState?.chessSettings || {};
        const delay = Math.max(50, cs.autoDelay || 1000);
        console.log(TAG, '[auto] scheduled in', delay + 'ms for', uci,
          '(ourSide=' + ourSide + ' turn=' + turnNow + ')');
        autoTimerId = setTimeout(() => {
          autoTimerId = null;
          if (!autoMode) {
            console.log(TAG, '[auto] timer fired but autoMode=false, skip');
            return;
          }
          // Re-verify turn at fire time — opp might've blitzed.
          const players = detectPlayers();
          const active = players && players.find(c => c.isActive);
          const turnAtFire = active?.side || sideTurn?.turn || '';
          if (turnAtFire !== ourSide) {
            console.log(TAG, '[auto] abort at fire — turn=' + turnAtFire);
            return;
          }
          console.log(TAG, '[auto] timer fired, calling playMove(' + uci + ')');
          if (playMove(uci)) lastAutoPlayedUci = uci;
        }, delay);
      });
    } catch (e) {
      console.warn(TAG, '[auto] schedule error:', e);
    }
  }

  // ─── Main tick ───
  let tickCount = 0;
  function tick() {
    if (!contextValid) { clearInterval(pollIntervalId); return; }
    tickCount++;

    // Re-discover canvas if it's been rebuilt.
    if (!boardCanvas || !document.contains(boardCanvas)) {
      boardCanvas = findBoardCanvas();
      bcont = boardCanvas ? boardCanvas.parentElement : null;
      if (boardCanvas && !notifiedGameDetected) {
        notifiedGameDetected = true;
        safeSendMessage({ command: 'gameDetected', gameType: 'chess', platform: 'playok.com' });
        console.log(TAG, 'gameDetected sent — canvas',
          boardCanvas.width + 'x' + boardCanvas.height);
      }
      if (boardCanvas) {
        if (resizeObserver) resizeObserver.disconnect();
        resizeObserver = new ResizeObserver(() => {
          if (!boardCanvas || !contextValid) return;
          if (GRID && (boardCanvas.width !== GRID.canvasW || boardCanvas.height !== GRID.canvasH)) {
            console.log(TAG, 'canvas dims changed → invalidate grid');
            GRID = null;
            lastBoardKey = '';
          }
          rerenderArrow();
        });
        resizeObserver.observe(boardCanvas);
      }
    }
    if (!boardCanvas || !bcont) return;

    if (!GRID) detectGridFromPieces();
    if (!GRID) return;

    const imgs = pieceImgs();
    if (imgs.length === 0) return;

    // Update player panel (cheap). Returns null if user can't be
    // identified by name — that's OK now, we don't depend on it for
    // userSide (use pixel detection); only for turn (active panel).
    const stp = getSideAndTurn();
    if (stp) sideTurn = stp;

    if (!pieceMapCalibrated) {
      if (tryCalibrate(imgs)) {
        // Calibrated — fall through to first board read.
      } else {
        if (tickCount % 20 === 0) {
          console.log(TAG, 'awaiting starting position to calibrate piece map ' +
            '(' + imgs.length + ' pieces on board)');
        }
        return;
      }
    }

    // Self-heal: if cached pieceMap is colour-inverted, clear it.
    if (!validatePieceMap(imgs)) return;

    // pieceMap is calibrated (either freshly or loaded from storage).
    // Always recheck orientation — user may have switched colour vs the
    // previous saved session, in which case GRID.flipped is stale.
    redetectFlipped(imgs);

    // Once flip is known, derive userSide independently of panel
    // detection: !flipped → user is white (white at bottom of canvas).
    const derivedUserSide = GRID.flipped ? 'b' : 'w';
    if (!sideTurn || sideTurn.userSide !== derivedUserSide) {
      sideTurn = { ...(sideTurn || {}), userSide: derivedUserSide,
                   turn: sideTurn?.turn || '' };
    }
    // Turn fallback: if panel can't tell, infer from active panel's
    // side regardless of user identification. detectPlayers gives us
    // that directly.
    if (!sideTurn.turn) {
      const players = detectPlayers();
      const active = players && players.find(c => c.isActive);
      if (active && active.side) sideTurn.turn = active.side;
    }

    // Build a cheap board key (sig + col + row) before doing full FEN
    // build — most ticks the board is unchanged.
    let keyArr = [];
    let unknownCount = 0;
    for (const img of imgs) {
      const cr = imgToColRow(img);
      if (!cr) continue;
      const sig = djb2(img.src);
      if (!pieceMap[sig]) { unknownCount++; }
      keyArr.push(cr.col + ',' + cr.row + ':' + sig);
    }
    keyArr.sort();
    const turn = sideTurn?.turn || '';
    const boardKey = keyArr.join('|') + '|t=' + turn;
    if (boardKey === lastBoardKey) {
      // No change — but if analyze got stuck, recover after 8s.
      if (analyzing && Date.now() - analyzingSince > 8000) {
        console.warn(TAG, 'analyzing flag stuck >8s — clearing');
        analyzing = false;
      }
      return;
    }
    lastBoardKey = boardKey;

    if (unknownCount > 0) {
      // logged inside snapshotBoard
    }

    const board = snapshotBoard(imgs);
    if (!board) return;

    if (!turn) {
      if (tickCount % 20 === 0) {
        console.log(TAG, 'no active turn from panel — skip FEN build');
      }
      return;
    }

    // Only analyze on the user's own turn — when it's the opponent's
    // move, hints for their best move are useless (we can't play them)
    // and just clutter the board. Clear any stale arrow and wait.
    const myTurn = !!(sideTurn?.userSide && turn === sideTurn.userSide);
    // Track turn transitions to gate "one analysis per my-turn":
    //   - Entering my turn (opp→me): allow a fresh analysis.
    //   - Mid-my-turn board change (I just moved, panel lagging): skip.
    if (myTurn && !prevMyTurn) {
      analyzedThisTurn = false;
      lastAutoPlayedUci = '';   // fresh turn — allow auto-play again
    }
    prevMyTurn = myTurn;
    if (!myTurn) {
      if (lastBestUci || arrowSvg?.firstChild) {
        clearArrow();
        lastBestUci = '';
      }
      if (tickCount % 20 === 0) {
        console.log(TAG, 'opp turn (' + turn + ', we are ' +
          (sideTurn?.userSide || '?') + ') — waiting');
      }
      return;
    }

    // Already analyzed this turn — don't re-fire when our own move
    // changes the board before PlayOK's turn arrow has flipped to opp.
    if (analyzedThisTurn) {
      if (tickCount % 20 === 0) {
        console.log(TAG, 'already analyzed this turn — waiting for opp');
      }
      return;
    }

    const fen = boardToFen(board, turn);
    if (fen === lastFen) return;

    lastFen = fen;
    console.log(TAG, '📋 FEN (our turn):', fen);
    clearArrow();
    lastBestUci = '';

    if (analyzing && Date.now() - analyzingSince > 8000) {
      analyzing = false;
    }
    if (!analyzing) {
      analyzing = true;
      analyzingSince = Date.now();
      analyzedThisTurn = true;
      safeSendMessage({
        command: 'analyzeFEN',
        fen,
        platform: 'playok.com',
      });
    }
  }

  // ─── Message handling ───
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.command) {
      case 'getFEN':
        if (lastFen) {
          safeSendMessage({ command: 'analyzeFEN', fen: lastFen, platform: 'playok.com' });
        } else {
          // Force re-read on next tick.
          lastBoardKey = '';
          lastFen = '';
        }
        if (sendResponse) sendResponse({ ok: true });
        break;

      case 'updateHints':
        analyzing = false;
        if (msg.bestUci && msg.bestUci.length >= 4) {
          lastBestUci = msg.bestUci;
          console.log(TAG, '🎯 best:', msg.bestUci,
            'eval:', msg.evalScore, 'depth:', msg.evalDepth);
          renderArrow(msg.bestUci.slice(0, 2), msg.bestUci.slice(2, 4));
          if (autoMode) scheduleAutoPlay(msg.bestUci);
        }
        break;

      case 'analysisStarted':
        break;

      case 'analysisError':
        analyzing = false;
        console.warn(TAG, 'analysis error:', msg.error);
        break;

      case 'toggleHints':
        hintsVisible = msg.visible !== undefined ? msg.visible : !hintsVisible;
        if (!hintsVisible) clearArrow();
        else rerenderArrow();
        break;

      case 'startAuto':
        autoMode = true;
        console.log(TAG, '🤖 auto-mode ON');
        safeSendMessage({ command: 'autoStatus', status: 'running' });
        // If we already have a fresh hint and it's our turn, schedule it.
        if (lastBestUci) scheduleAutoPlay(lastBestUci);
        break;

      case 'stopAuto':
        autoMode = false;
        if (autoTimerId) { clearTimeout(autoTimerId); autoTimerId = null; }
        console.log(TAG, '🤖 auto-mode OFF');
        safeSendMessage({ command: 'autoStatus', status: 'stopped' });
        break;

      case 'ping':
        if (sendResponse) sendResponse({ ok: true });
        break;
    }
  });

  // ─── Boot ───
  injectDebug();
  loadPieceMap();

  pollIntervalId = setInterval(tick, 500);

  // Re-render arrow on scroll/resize so it stays glued to the board.
  window.addEventListener('scroll', rerenderArrow, { passive: true });
  window.addEventListener('resize', rerenderArrow);
})();
