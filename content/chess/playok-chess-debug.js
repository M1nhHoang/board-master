// Injected into MAIN world so window.bmChessDebug is reachable from
// the page's DevTools console. Pure observation — no game interaction.
// Mirrors content/gomoku-playok-debug.js, but tuned for chess: alternating
// light/dark squares (no grid lines), 8x8 board, side panel for turn.
(function () {
  'use strict';
  const TAG = '[BM][chess][playok-debug]';
  console.log(TAG, 'armed at', location.href);

  let tapHandler = null;
  let watcher = null;

  // ─── Canvas discovery ───
  function dumpCanvases() {
    const all = Array.from(document.querySelectorAll('canvas'));
    console.log(TAG, 'Found', all.length, 'canvas element(s)');
    all.forEach((c, i) => {
      const rect = c.getBoundingClientRect();
      const cs = getComputedStyle(c);
      console.log(TAG, 'canvas[' + i + ']', {
        el: c,
        intrinsic: c.width + 'x' + c.height,
        css: rect.width.toFixed(1) + 'x' + rect.height.toFixed(1),
        pos: rect.left.toFixed(1) + ',' + rect.top.toFixed(1),
        zIndex: cs.zIndex,
        position: cs.position,
        className: c.className,
        parent: (c.parentElement?.tagName || '') +
                (c.parentElement?.id ? '#' + c.parentElement.id : '') +
                (c.parentElement?.className
                  ? '.' + String(c.parentElement.className).replace(/\s+/g, '.')
                  : ''),
      });
    });
    return all;
  }

  function dumpDomAroundBoard() {
    const canvases = Array.from(document.querySelectorAll('canvas'));
    const board = canvases.find(c => c.width >= 400 && c.height >= 400) || canvases[0];
    if (!board) { console.warn(TAG, 'no canvas found yet'); return; }

    let node = board.parentElement;
    let depth = 0;
    while (node && depth < 5) {
      console.log(TAG, 'parent[' + depth + ']', {
        tag: node.tagName, id: node.id, cls: node.className,
        children: node.children.length,
        rect: node.getBoundingClientRect(),
      });
      node = node.parentElement;
      depth++;
    }

    const container = board.parentElement;
    if (container) {
      console.log(TAG, 'container children:');
      Array.from(container.children).forEach((el, i) => {
        console.log(TAG, '  [' + i + ']', el.tagName, el.id || '', el.className || '',
          '— rect:', el.getBoundingClientRect());
      });
    }
  }

  function dumpGlobals() {
    const interesting = [
      'G', 'g', 'game', 'Game', 'board', 'Board', 'chess', 'Chess',
      'players', 'player', 'mySide', 'side', 'turn', 'state',
      'ws', 'socket', 'sock', 'conn', 'pko', 'PKO',
    ];
    const found = {};
    for (const k of interesting) {
      try { if (window[k] !== undefined) found[k] = window[k]; } catch (_) {}
    }
    console.log(TAG, 'globals (whitelist):', found);

    const skip = new Set(Object.getOwnPropertyNames(Object.getPrototypeOf(window)));
    const keys = Object.keys(window).filter(k =>
      !skip.has(k) && k.length <= 12 && /^[A-Za-z_]/.test(k)
    );
    console.log(TAG, 'window own keys (' + keys.length + '):', keys);
    return { found, keys };
  }

  // ─── Pixel sampling (uses our own canvas; playok's getContext lacks willReadFrequently) ───
  let offCanvas = null, offCtx = null;
  function readPixels(c) {
    if (!offCanvas || offCanvas.width !== c.width || offCanvas.height !== c.height) {
      offCanvas = document.createElement('canvas');
      offCanvas.width  = c.width;
      offCanvas.height = c.height;
      offCtx = offCanvas.getContext('2d', { willReadFrequently: true });
    }
    offCtx.clearRect(0, 0, offCanvas.width, offCanvas.height);
    offCtx.drawImage(c, 0, 0);
    return offCtx.getImageData(0, 0, c.width, c.height);
  }

  function samplePixel(x, y, canvasIdx) {
    const all = Array.from(document.querySelectorAll('canvas'));
    const c = canvasIdx != null
      ? all[canvasIdx]
      : all.find(c => c.width >= 400 && c.height >= 400);
    if (!c) { console.warn(TAG, 'no canvas'); return null; }
    try {
      const img = readPixels(c);
      const i = (Math.round(y) * c.width + Math.round(x)) * 4;
      const px = {
        r: img.data[i], g: img.data[i+1], b: img.data[i+2], a: img.data[i+3],
        hex: '#' + [img.data[i], img.data[i+1], img.data[i+2]]
          .map(n => n.toString(16).padStart(2, '0')).join(''),
      };
      console.log(TAG, 'pixel', x, y, '→', px);
      return px;
    } catch (e) {
      console.warn(TAG, 'getImageData failed (likely tainted canvas):', e.message);
      return null;
    }
  }

  // ─── Click logger: clicks anywhere on the canvas, prints intrinsic pixel coords ───
  function tap(enable) {
    if (enable === undefined) enable = true;
    if (tapHandler) {
      document.removeEventListener('click', tapHandler, true);
      tapHandler = null;
    }
    if (!enable) { console.log(TAG, 'tap disabled'); return; }

    tapHandler = (ev) => {
      const canvases = Array.from(document.querySelectorAll('canvas'));
      for (const c of canvases) {
        const rect = c.getBoundingClientRect();
        if (ev.clientX >= rect.left && ev.clientX <= rect.right &&
            ev.clientY >= rect.top  && ev.clientY <= rect.bottom) {
          const cssX = ev.clientX - rect.left;
          const cssY = ev.clientY - rect.top;
          const px = cssX * (c.width / rect.width);
          const py = cssY * (c.height / rect.height);
          const info = {
            cssX: cssX.toFixed(1), cssY: cssY.toFixed(1),
            px: px.toFixed(1), py: py.toFixed(1),
            canvas: { w: c.width, h: c.height, idx: canvases.indexOf(c) },
          };
          if (GRID) {
            // Show where the click lands in grid coords
            const col = Math.floor((px - GRID.x0) / GRID.cellSize);
            const row = Math.floor((py - GRID.y0) / GRID.cellSize);
            const file = String.fromCharCode(97 + (GRID.flipped ? 7 - col : col));
            const rank = (GRID.flipped ? row + 1 : 8 - row);
            info.square = (col >= 0 && col < 8 && row >= 0 && row < 8)
              ? (file + rank + ' (col=' + col + ', row=' + row + ')')
              : 'outside-grid';
          }
          console.log(TAG, 'CLICK on canvas', info);
          samplePixel(Math.round(px), Math.round(py), canvases.indexOf(c));
          break;
        }
      }
    };
    document.addEventListener('click', tapHandler, true);
    console.log(TAG, 'tap enabled — click on the board to log intrinsic px coords + colors');
  }

  // ─── Grid state ───
  // Chess: 8x8 board, alternating light/dark squares, no grid lines.
  // x0,y0 = intrinsic-px coord of the TOP-LEFT corner of the board.
  // cellSize = intrinsic px per square.
  // flipped = true if board is rotated (we're playing black at bottom).
  let GRID = null;

  function findBoardCanvas() {
    return Array.from(document.querySelectorAll('canvas'))
      .find(c => c.width >= 400 && c.height >= 400) || null;
  }

  // Auto-detect grid by scanning horizontal & vertical strips for the
  // alternating light/dark square pattern.
  //
  // Strategy (best-effort, can be wrong — user can override via setGrid):
  //   1. Take a horizontal strip 1px tall at canvas mid-height.
  //   2. Walk left → right, find sharp luminance transitions
  //      (light→dark or dark→light). These are square edges.
  //   3. Median spacing between transitions ≈ cell size.
  //   4. Same vertically.
  //   5. Pick the largest run of ~7 evenly-spaced transitions on each
  //      axis as the inner board borders → 8 squares.
  function detectGrid(opts) {
    opts = opts || {};
    const canvasIdx = opts.canvasIdx;
    const all = Array.from(document.querySelectorAll('canvas'));
    const c = canvasIdx != null ? all[canvasIdx] : findBoardCanvas();
    if (!c) { console.warn(TAG, 'no canvas ≥400x400'); return null; }
    const all_idx = all.indexOf(c);

    let img;
    try { img = readPixels(c); }
    catch (e) { console.warn(TAG, 'getImageData failed:', e.message); return null; }
    const data = img.data, W = c.width, H = c.height;

    // Luminance at a point (cheap Rec-601 grey).
    const lum = (i) => (data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114) | 0;

    // Find transitions in a 1D strip of luminance values.
    // A transition = |L(i) - L(i-1)| > threshold.
    function findTransitions(lumArr, thresh) {
      const xs = [];
      for (let i = 1; i < lumArr.length; i++) {
        if (Math.abs(lumArr[i] - lumArr[i-1]) > thresh) xs.push(i);
      }
      return xs;
    }

    // Cluster adjacent transitions so an edge isn't counted twice.
    function clusterTransitions(xs, gap) {
      if (!xs.length) return [];
      const out = [xs[0]];
      for (let i = 1; i < xs.length; i++) {
        if (xs[i] - out[out.length - 1] >= gap) out.push(xs[i]);
      }
      return out;
    }

    // Median spacing.
    function medianDiff(xs) {
      if (xs.length < 2) return 0;
      const d = [];
      for (let i = 1; i < xs.length; i++) d.push(xs[i] - xs[i-1]);
      d.sort((a, b) => a - b);
      return d[Math.floor(d.length / 2)];
    }

    // Find longest run of transitions whose spacing matches the median
    // (within ±25%). Returns {start, step, count}.
    function longestRun(xs) {
      const med = medianDiff(xs);
      if (!med) return null;
      const tol = med * 0.25;
      let best = { start: xs[0], step: med, count: 1, startIdx: 0 };
      let runStart = 0;
      for (let i = 1; i < xs.length; i++) {
        const d = xs[i] - xs[i-1];
        if (Math.abs(d - med) > tol) {
          runStart = i;
        }
        const count = i - runStart + 1;
        if (count > best.count) {
          best = { start: xs[runStart], step: med, count, startIdx: runStart };
        }
      }
      return best;
    }

    // Build a luminance row from canvas mid-height (and a few neighbours
    // averaged to suppress noise).
    function lumRow(y, halfband) {
      const arr = new Array(W).fill(0);
      const yBand = halfband || 0;
      for (let x = 0; x < W; x++) {
        let s = 0, n = 0;
        for (let dy = -yBand; dy <= yBand; dy++) {
          const yy = y + dy;
          if (yy >= 0 && yy < H) { s += lum(((yy * W) + x) * 4); n++; }
        }
        arr[x] = (s / n) | 0;
      }
      return arr;
    }
    function lumCol(x, halfband) {
      const arr = new Array(H).fill(0);
      const xBand = halfband || 0;
      for (let y = 0; y < H; y++) {
        let s = 0, n = 0;
        for (let dx = -xBand; dx <= xBand; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < W) { s += lum(((y * W) + xx) * 4); n++; }
        }
        arr[y] = (s / n) | 0;
      }
      return arr;
    }

    // 3 horizontal samples (1/3, 1/2, 2/3 of height) merge for robustness.
    const ySamples = [Math.round(H * 0.33), Math.round(H * 0.50), Math.round(H * 0.66)];
    const xSamples = [Math.round(W * 0.33), Math.round(W * 0.50), Math.round(W * 0.66)];

    const TRANS_THRESH = 18;   // luminance jump to call an edge
    const MIN_GAP      = 12;   // px — squares are at least this wide

    let xTransAll = [];
    for (const y of ySamples) {
      const arr = lumRow(y, 2);
      const t = findTransitions(arr, TRANS_THRESH);
      xTransAll = xTransAll.concat(t);
    }
    let yTransAll = [];
    for (const x of xSamples) {
      const arr = lumCol(x, 2);
      const t = findTransitions(arr, TRANS_THRESH);
      yTransAll = yTransAll.concat(t);
    }

    xTransAll.sort((a, b) => a - b);
    yTransAll.sort((a, b) => a - b);
    const xT = clusterTransitions(xTransAll, MIN_GAP);
    const yT = clusterTransitions(yTransAll, MIN_GAP);
    console.log(TAG, 'detectGrid: xTransitions=', xT.length, 'yTransitions=', yT.length);
    console.log(TAG, 'xT:', xT);
    console.log(TAG, 'yT:', yT);

    const xRun = longestRun(xT);
    const yRun = longestRun(yT);
    console.log(TAG, 'detectGrid runs:', { x: xRun, y: yRun });

    if (!xRun || !yRun) {
      console.warn(TAG, 'detectGrid: no transition runs — try setGrid({...}) manually');
      return null;
    }

    // Cell size = step. Origin = start of run (minus one step? — depends
    // on whether the run starts at the FIRST inner edge or the outer
    // board border). Average step from both axes for stability.
    const step = Math.round((xRun.step + yRun.step) / 2);
    const x0 = xRun.start;
    const y0 = yRun.start;
    GRID = {
      x0, y0,
      cellSize: step,
      flipped: false,
      canvasIdx: all_idx,
      canvasW: W, canvasH: H,
      autoDetected: true,
      xRun, yRun,
    };
    console.log(TAG, 'GRID detected:', GRID);
    console.log(TAG, 'NOTE: detection is best-effort. If overlay dots don\'t hit square centers,');
    console.log(TAG, '      use: bmChessDebug.setGrid({x0, y0, cellSize, flipped})');
    return GRID;
  }

  // Manual override. Provide any subset of {x0, y0, cellSize, flipped}.
  function setGrid(params) {
    const c = findBoardCanvas();
    if (!c) { console.warn(TAG, 'no canvas — cannot set grid'); return null; }
    GRID = Object.assign({
      canvasIdx: Array.from(document.querySelectorAll('canvas')).indexOf(c),
      canvasW: c.width, canvasH: c.height,
      flipped: false,
    }, GRID || {}, params || {});
    console.log(TAG, 'GRID set:', GRID);
    drawOverlay(true);
    return GRID;
  }

  // Draw a dot at the predicted center of every square + label
  // a-h / 1-8. Yellow = a1 (orientation check).
  let overlayEl = null;
  function drawOverlay(show) {
    if (show === undefined) show = true;
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    if (!show || !GRID) return;
    const all = Array.from(document.querySelectorAll('canvas'));
    const c = all[GRID.canvasIdx] || findBoardCanvas();
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const sx = rect.width / c.width, sy = rect.height / c.height;
    overlayEl = document.createElement('div');
    overlayEl.style.cssText =
      'position:fixed;pointer-events:none;z-index:99999;' +
      'left:' + rect.left + 'px;top:' + rect.top + 'px;' +
      'width:' + rect.width + 'px;height:' + rect.height + 'px;';

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const cx = GRID.x0 + (col + 0.5) * GRID.cellSize;
        const cy = GRID.y0 + (row + 0.5) * GRID.cellSize;
        const file = String.fromCharCode(97 + (GRID.flipped ? 7 - col : col));
        const rank = (GRID.flipped ? row + 1 : 8 - row);
        const sq = file + rank;
        const isA1 = (sq === 'a1');

        const dot = document.createElement('div');
        dot.style.cssText =
          'position:absolute;' +
          'background:' + (isA1 ? '#ff0' : '#f0f') + ';' +
          'width:6px;height:6px;border-radius:50%;' +
          'left:' + (cx * sx - 3) + 'px;top:' + (cy * sy - 3) + 'px;' +
          'box-shadow:0 0 2px #000;';
        overlayEl.appendChild(dot);

        const label = document.createElement('div');
        label.textContent = sq;
        label.style.cssText =
          'position:absolute;color:#fff;font:9px/1 monospace;' +
          'text-shadow:0 0 2px #000;' +
          'left:' + (cx * sx + 4) + 'px;top:' + (cy * sy - 6) + 'px;';
        overlayEl.appendChild(label);
      }
    }
    document.body.appendChild(overlayEl);
    console.log(TAG, 'overlay drawn — yellow=a1; flipped=' + GRID.flipped);
  }

  // For each of the 64 squares, sample center pixel + 4 offsets, log
  // the dominant color and luminance. Use to discover piece signatures
  // (template-match later).
  function readSquareSignatures(opts) {
    opts = opts || {};
    if (!GRID) { console.warn(TAG, 'call detectGrid() or setGrid() first'); return null; }
    const c = Array.from(document.querySelectorAll('canvas'))[GRID.canvasIdx] || findBoardCanvas();
    if (!c) return null;
    let img;
    try { img = readPixels(c); } catch (e) { console.warn(TAG, e.message); return null; }
    const data = img.data, W = c.width;

    const R = Math.floor(GRID.cellSize * 0.25);  // sample radius in px
    const STEP = Math.max(2, Math.floor(R / 4));
    const sigs = [];
    for (let row = 0; row < 8; row++) {
      const out = [];
      for (let col = 0; col < 8; col++) {
        const cx = Math.round(GRID.x0 + (col + 0.5) * GRID.cellSize);
        const cy = Math.round(GRID.y0 + (row + 0.5) * GRID.cellSize);
        let sR = 0, sG = 0, sB = 0, n = 0;
        let minL = 255, maxL = 0;
        for (let dy = -R; dy <= R; dy += STEP) {
          for (let dx = -R; dx <= R; dx += STEP) {
            const x = cx + dx, y = cy + dy;
            if (x < 0 || x >= c.width || y < 0 || y >= c.height) continue;
            const i = (y * W + x) * 4;
            sR += data[i]; sG += data[i+1]; sB += data[i+2]; n++;
            const L = (data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114) | 0;
            if (L < minL) minL = L; if (L > maxL) maxL = L;
          }
        }
        const r = (sR / n) | 0, g = (sG / n) | 0, b = (sB / n) | 0;
        const avgL = (r * 0.299 + g * 0.587 + b * 0.114) | 0;
        const file = String.fromCharCode(97 + (GRID.flipped ? 7 - col : col));
        const rank = (GRID.flipped ? row + 1 : 8 - row);
        out.push({
          sq: file + rank,
          rgb: [r, g, b],
          hex: '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join(''),
          avgL, range: maxL - minL,  // range > ~40 likely indicates a piece on top of square color
        });
      }
      sigs.push(out);
    }
    // Pretty-print: rank 8 (row 0) at top.
    console.log(TAG, 'square signatures (avg RGB + luminance range):');
    sigs.forEach((row, i) => {
      const r8 = GRID.flipped ? i + 1 : 8 - i;
      console.log(TAG, 'rank ' + r8 + ':',
        row.map(s => s.sq + ' L=' + s.avgL + ' Δ=' + s.range + ' ' + s.hex).join(' | '));
    });
    return sigs;
  }

  // Snapshot the entire intrinsic canvas as a data URL — open in a new
  // tab to compare what we're seeing vs what's on screen.
  function snapshotCanvas() {
    const c = findBoardCanvas();
    if (!c) { console.warn(TAG, 'no canvas'); return null; }
    if (!offCanvas || offCanvas.width !== c.width || offCanvas.height !== c.height) {
      offCanvas = document.createElement('canvas');
      offCanvas.width = c.width; offCanvas.height = c.height;
      offCtx = offCanvas.getContext('2d', { willReadFrequently: true });
    }
    offCtx.clearRect(0, 0, c.width, c.height);
    offCtx.drawImage(c, 0, 0);
    const url = offCanvas.toDataURL('image/png');
    console.log(TAG, 'snapshot data URL (length=' + url.length + ')');
    console.log(TAG, 'open in new tab:', url.slice(0, 100) + '…');
    return url;
  }

  // ─── PIECE DETECTION (BREAKTHROUGH) ─────────────────────────────
  // PlayOK chess pieces are NOT drawn on the canvas — they're DOM <img>
  // elements positioned absolutely over the board canvas. The canvas only
  // renders the green/cream square grid. This means we can skip pixel
  // classification entirely and read pieces directly from the DOM.
  //
  // Pieces live as <img> children of the canvas's parent (.bcont). Each
  // image is ~68x68 px and positioned via inline style or `left`/`top`.
  // We need to discover playok's URL/class convention for piece type +
  // colour — that's what dumpPieces() is for.

  // Find the chess board container — the canvas's parent.
  function findBoardContainer() {
    const c = findBoardCanvas();
    return c ? c.parentElement : null;
  }

  // Get all piece IMG elements (skip images with zero size — placeholders).
  function pieceImgs() {
    const cont = findBoardContainer();
    if (!cont) return [];
    return Array.from(cont.querySelectorAll('img')).filter(img => {
      const r = img.getBoundingClientRect();
      return r.width > 10 && r.height > 10;
    });
  }

  // Translate a piece IMG to its (file, rank) square. Returns null if no
  // grid has been detected yet or the IMG is outside the 8x8 area.
  function imgToSquare(img) {
    if (!GRID) return null;
    const cRect = (Array.from(document.querySelectorAll('canvas'))[GRID.canvasIdx]
                   || findBoardCanvas()).getBoundingClientRect();
    const iRect = img.getBoundingClientRect();
    const cssToIntrinsicX = GRID.canvasW / cRect.width;
    const cssToIntrinsicY = GRID.canvasH / cRect.height;
    // Use IMG's top-left in canvas-intrinsic coords
    const ix = (iRect.left - cRect.left) * cssToIntrinsicX;
    const iy = (iRect.top  - cRect.top ) * cssToIntrinsicY;
    // Snap to nearest cell center
    const colF = (ix + GRID.cellSize / 2 - GRID.x0) / GRID.cellSize;
    const rowF = (iy + GRID.cellSize / 2 - GRID.y0) / GRID.cellSize;
    const col  = Math.floor(colF);
    const row  = Math.floor(rowF);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    const file = String.fromCharCode(97 + (GRID.flipped ? 7 - col : col));
    const rank = (GRID.flipped ? row + 1 : 8 - row);
    return { col, row, file, rank, sq: file + rank, ix, iy };
  }

  // Dump every piece IMG with its derived square and full attribute set,
  // so the user can share output and we can map src/alt/class → piece code.
  function dumpPieces() {
    if (!GRID) {
      console.warn(TAG, 'no GRID — calling detectGrid() first');
      detectGrid();
      if (!GRID) return null;
    }
    const imgs = pieceImgs();
    console.log(TAG, 'dumpPieces — found', imgs.length, 'piece IMGs');
    const summary = [];
    imgs.forEach((img, i) => {
      const sq = imgToSquare(img);
      const r = img.getBoundingClientRect();
      const style = img.getAttribute('style') || '';
      const row = {
        idx: i,
        square: sq ? sq.sq : '(outside)',
        col: sq?.col, row: sq?.row,
        src:        img.src || img.getAttribute('src') || '',
        srcset:     img.getAttribute('srcset') || '',
        alt:        img.getAttribute('alt') || '',
        title:      img.getAttribute('title') || '',
        className:  img.className || '',
        id:         img.id || '',
        style,
        natural:    img.naturalWidth + 'x' + img.naturalHeight,
        rect:       r.width.toFixed(0) + 'x' + r.height.toFixed(0) +
                    ' @ (' + r.left.toFixed(0) + ',' + r.top.toFixed(0) + ')',
        // Look for inline left/top in style (playok uses px positioning)
        styleLeft:  (style.match(/left\s*:\s*([^;]+)/) || [])[1] || '',
        styleTop:   (style.match(/top\s*:\s*([^;]+)/) || [])[1] || '',
        styleBg:    (style.match(/background[^:]*:\s*([^;]+)/) || [])[1] || '',
        // Dataset (data-* attributes)
        dataset:    Object.assign({}, img.dataset),
      };
      summary.push(row);
    });
    console.table(summary);
    // Also log a deduped list of distinct src/srcset/className values so
    // we can quickly see playok's piece naming convention.
    const distinctSrcs   = Array.from(new Set(summary.map(s => s.src).filter(Boolean)));
    const distinctClass  = Array.from(new Set(summary.map(s => s.className).filter(Boolean)));
    const distinctAlt    = Array.from(new Set(summary.map(s => s.alt).filter(Boolean)));
    console.log(TAG, 'distinct src URLs (' + distinctSrcs.length + '):');
    distinctSrcs.forEach(s => console.log(TAG, '  ', s));
    console.log(TAG, 'distinct className values (' + distinctClass.length + '):', distinctClass);
    console.log(TAG, 'distinct alt values   (' + distinctAlt.length + '):',  distinctAlt);
    // Render a board grid of squares→piece for quick visual confirmation.
    const grid = Array.from({ length: 8 }, () => Array(8).fill('.'));
    summary.forEach(s => {
      if (s.col != null && s.row != null) {
        // Use last URL path segment (e.g. "wp.png" → "wp") as label,
        // or first 4 chars of className if no src.
        const label = (s.src.split('/').pop() || '').replace(/\.\w+$/, '') ||
                      s.className.slice(0, 4) || '?';
        grid[s.row][s.col] = label;
      }
    });
    console.log(TAG, 'board grid (row 0 = top of canvas, col 0 = left):');
    grid.forEach((r, i) => console.log(TAG, 'row ' + i + ':', r.map(x => x.padEnd(4)).join('')));
    return summary;
  }

  // Refine grid from IMG positions. Pieces are positioned more reliably
  // than pixel-edge detection (e.g. our auto-detect was off by 3px on x0).
  // If at least 2 pieces are visible, derive cellSize + origin from them.
  function detectGridFromPieces() {
    const imgs = pieceImgs();
    if (imgs.length < 2) {
      console.warn(TAG, 'not enough piece IMGs for grid inference');
      return null;
    }
    const c = findBoardCanvas();
    if (!c) return null;
    const cRect = c.getBoundingClientRect();
    const sx = c.width / cRect.width;
    const sy = c.height / cRect.height;

    const ixs = [], iys = [], sizes = [];
    imgs.forEach((img) => {
      const r = img.getBoundingClientRect();
      ixs.push((r.left - cRect.left) * sx);
      iys.push((r.top  - cRect.top ) * sy);
      sizes.push(r.width * sx);
    });

    // Cell size ≈ median IMG width (pieces fill a square).
    sizes.sort((a, b) => a - b);
    const cellSize = Math.round(sizes[Math.floor(sizes.length / 2)]);
    // Origin = smallest IMG left/top, snapped down to a multiple of cellSize.
    const minX = Math.round(Math.min(...ixs));
    const minY = Math.round(Math.min(...iys));
    // The smallest piece might not be at column 0 — but if it's at col k,
    // origin = minX - k*cellSize. Estimate k by mod: minX mod cellSize.
    // Or just trust minX is at file a / h depending on flip and snap to grid.
    // Simplest robust strategy: bin all xs into cells of size cellSize,
    // find the smallest bin that's still on the board.
    const x0Candidates = ixs.map(x => x - Math.round((x - minX) / cellSize) * cellSize);
    const y0Candidates = iys.map(y => y - Math.round((y - minY) / cellSize) * cellSize);
    x0Candidates.sort((a, b) => a - b);
    y0Candidates.sort((a, b) => a - b);
    const x0 = Math.round(x0Candidates[Math.floor(x0Candidates.length / 2)]);
    const y0 = Math.round(y0Candidates[Math.floor(y0Candidates.length / 2)]);

    GRID = Object.assign(GRID || {}, {
      x0, y0, cellSize,
      flipped: GRID?.flipped || false,
      canvasIdx: Array.from(document.querySelectorAll('canvas')).indexOf(c),
      canvasW: c.width, canvasH: c.height,
      derivedFromPieces: true,
    });
    console.log(TAG, 'GRID (from pieces):', GRID);
    drawOverlay(true);
    return GRID;
  }

  // Dump player panel — assume same .tplcont structure as Gomoku PlayOK.
  function detectPlayers() {
    const cont = document.querySelector('.tplcont');
    if (!cont) { console.warn(TAG, 'no .tplcont yet'); return null; }
    const panels = cont.querySelectorAll(':scope > div');
    const candidates = [];
    panels.forEach((sec) => {
      const nameEl   = sec.querySelector('.nowrel');
      const colorBox = sec.querySelector('.f12 > div');
      const arrowEl  = sec.querySelector('.tplext div[style*="border-bottom"]');
      const name = nameEl ? nameEl.textContent.trim() : '';
      const isActive = !!(arrowEl && arrowEl.style.visibility === 'inherit');
      let colorRgb = null;
      if (colorBox) {
        const bg = (colorBox.style.background || colorBox.style.backgroundColor || '').toLowerCase();
        const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) colorRgb = [+m[1], +m[2], +m[3]];
      }
      // For chess, dark colour box ≈ black, light ≈ white.
      let side = '?';
      if (colorRgb) {
        const L = colorRgb[0] * 0.299 + colorRgb[1] * 0.587 + colorRgb[2] * 0.114;
        side = L < 128 ? 'black' : 'white';
      }
      candidates.push({ name, side, isActive, colorRgb });
    });
    console.log(TAG, 'players:', candidates);
    return candidates;
  }

  // Watcher — print canvas count every time it changes.
  let lastCount = -1;
  watcher = setInterval(() => {
    const n = document.querySelectorAll('canvas').length;
    if (n !== lastCount) {
      lastCount = n;
      console.log(TAG, 'canvas count changed →', n);
      if (n > 0) dumpCanvases();
    }
  }, 1500);

  window.bmChessDebug = {
    dump: () => { dumpCanvases(); dumpDomAroundBoard(); dumpGlobals(); },
    canvases: dumpCanvases,
    dom: dumpDomAroundBoard,
    globals: dumpGlobals,
    pixel: samplePixel,
    tap,
    detectGrid,
    detectGridFromPieces,
    setGrid,
    drawOverlay,
    readSquareSignatures,
    snapshotCanvas,
    detectPlayers,
    dumpPieces,
    pieceImgs,
    imgToSquare,
    get grid() { return GRID; },
    stop: () => {
      if (watcher) clearInterval(watcher);
      tap(false); drawOverlay(false);
      console.log(TAG, 'stopped');
    },
  };

  console.log(TAG, 'Ready. PlayOK chess pieces are DOM <img> overlays, not canvas-drawn.');
  console.log(TAG, 'In DevTools console try:');
  console.log(TAG, '  bmChessDebug.detectGridFromPieces() — derive grid from IMG positions (BEST)');
  console.log(TAG, '  bmChessDebug.dumpPieces()           — list every piece IMG + src/alt/class');
  console.log(TAG, '  bmChessDebug.detectGrid()           — fallback: pixel-based grid detect');
  console.log(TAG, '  bmChessDebug.setGrid({x0,y0,cellSize,flipped})');
  console.log(TAG, '  bmChessDebug.drawOverlay()          — visualise grid (yellow=a1)');
  console.log(TAG, '  bmChessDebug.detectPlayers()        — read player panel (.tplcont)');
  console.log(TAG, '  bmChessDebug.tap()                  — click logger');
  console.log(TAG, '  bmChessDebug.stop()');

  setTimeout(() => {
    try { dumpCanvases(); dumpDomAroundBoard(); dumpGlobals(); detectPlayers(); }
    catch (e) { console.warn(TAG, e); }
  }, 1500);
})();
