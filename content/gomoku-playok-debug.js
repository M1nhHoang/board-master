// Injected into MAIN world so window.bmGomokuDebug is reachable from
// the page's DevTools console. Pure observation — no game interaction.
(function () {
  'use strict';
  const TAG = '[BM][gomoku][playok-debug]';
  console.log(TAG, 'Debug module armed at', location.href);

  let tapHandler = null;
  let watcher = null;

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
      'G', 'g', 'game', 'Game', 'board', 'Board', 'gomoku', 'Gomoku',
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

  function samplePixel(x, y, canvasIdx) {
    const all = Array.from(document.querySelectorAll('canvas'));
    const c = canvasIdx != null
      ? all[canvasIdx]
      : all.find(c => c.width >= 400 && c.height >= 400);
    if (!c) { console.warn(TAG, 'no canvas'); return null; }
    try {
      const ctx = c.getContext('2d');
      const data = ctx.getImageData(x, y, 1, 1).data;
      const hex = '#' + [data[0], data[1], data[2]]
        .map(n => n.toString(16).padStart(2, '0')).join('');
      const px = { r: data[0], g: data[1], b: data[2], a: data[3], hex };
      console.log(TAG, 'pixel', x, y, '→', px);
      return px;
    } catch (e) {
      console.warn(TAG, 'getImageData failed (likely tainted canvas):', e.message);
      return null;
    }
  }

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
          console.log(TAG, 'CLICK on canvas', {
            cssX: cssX.toFixed(1), cssY: cssY.toFixed(1),
            px: px.toFixed(1), py: py.toFixed(1),
            canvas: { w: c.width, h: c.height, idx: canvases.indexOf(c) },
          });
          samplePixel(Math.round(px), Math.round(py), canvases.indexOf(c));
          break;
        }
      }
    };
    document.addEventListener('click', tapHandler, true);
    console.log(TAG, 'tap enabled — click on the board to log coords');
  }

  // Known color signatures (sampled from a real playok game).
  // Tolerance ±25 per channel. Tweak after sampling more positions.
  const COLORS = {
    empty:    { r: 240, g: 176, b: 96  },  // #f0b060 wood
    gridLine: { r: 162, g: 108, b: 62  },  // #a46d3f wood grain line
    black:    { r: 40,  g: 40,  b: 40  },  // #282828
    white:    { r: 245, g: 245, b: 245 },  // guess — confirm by sampling a white stone
  };
  function colorMatch(px, ref, tol = 25) {
    return Math.abs(px[0] - ref.r) <= tol &&
           Math.abs(px[1] - ref.g) <= tol &&
           Math.abs(px[2] - ref.b) <= tol;
  }

  // Module-scoped grid (used by readBoard / drawOverlay). Filled by
  // detectGrid() but can be overridden by setGrid().
  let GRID = null;
  let GRID_DEBUG = null;

  // Print row/col gridline density profile so we can eyeball where the
  // detection threshold is failing. Each line: y/x → count + bar.
  function dumpCounts() {
    if (!GRID_DEBUG) { console.warn(TAG, 'run detectGrid() first'); return; }
    const { colCounts, rowCounts, colHitThresh, rowHitThresh } = GRID_DEBUG;
    const bar = (n, max) => '█'.repeat(Math.round((n / max) * 40));
    const colMax = Math.max(...colCounts), rowMax = Math.max(...rowCounts);
    console.log(TAG, 'colCounts (x → hits, threshold=' + colHitThresh.toFixed(1) + '):');
    for (let x = 0; x < colCounts.length; x++) {
      if (colCounts[x] >= colHitThresh * 0.5) {
        const mark = colCounts[x] >= colHitThresh ? '✓' : ' ';
        console.log(TAG, mark, 'x=' + x.toString().padStart(4), colCounts[x].toString().padStart(5), bar(colCounts[x], colMax));
      }
    }
    console.log(TAG, 'rowCounts (y → hits, threshold=' + rowHitThresh.toFixed(1) + '):');
    for (let y = 0; y < rowCounts.length; y++) {
      if (rowCounts[y] >= rowHitThresh * 0.5) {
        const mark = rowCounts[y] >= rowHitThresh ? '✓' : ' ';
        console.log(TAG, mark, 'y=' + y.toString().padStart(4), rowCounts[y].toString().padStart(5), bar(rowCounts[y], rowMax));
      }
    }
  }

  // detectGrid(): scans canvas[0] image data, finds horizontal & vertical
  // strips that are dominated by grid-line color, returns origin + step.
  // Extrapolates a uniform grid from the detected cell size so missing
  // edge lines (often hidden behind labels / coords) are filled in.
  function detectGrid(canvasIdx, opts) {
    opts = opts || {};
    const threshFactor = opts.threshFactor != null ? opts.threshFactor : 0.25;
    const colorTol = opts.tol != null ? opts.tol : 35;

    const all = Array.from(document.querySelectorAll('canvas'));
    const c = canvasIdx != null ? all[canvasIdx]
                                : all.find(c => c.width >= 400 && c.height >= 400);
    if (!c) { console.warn(TAG, 'no canvas'); return null; }

    let img;
    try { img = c.getContext('2d').getImageData(0, 0, c.width, c.height); }
    catch (e) { console.warn(TAG, 'getImageData failed:', e.message); return null; }
    const data = img.data, W = c.width, H = c.height;

    const rowCounts = new Array(H).fill(0);
    const colCounts = new Array(W).fill(0);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (colorMatch([data[i], data[i+1], data[i+2]], COLORS.gridLine, colorTol)) {
          rowCounts[y]++;
          colCounts[x]++;
        }
      }
    }

    const rowThresh = Math.max(...rowCounts) * threshFactor;
    const colThresh = Math.max(...colCounts) * threshFactor;
    const rowPeaks = pickPeaks(rowCounts, rowThresh);
    const colPeaks = pickPeaks(colCounts, colThresh);

    // Step from median diff between consecutive peaks (robust to outliers)
    const colStep = medianDiff(colPeaks);
    const rowStep = medianDiff(rowPeaks);
    const cellW = colStep || rowStep;
    const cellH = rowStep || colStep;

    // Threshold relative to the median strength of already-detected
    // peaks (not max — max can be inflated by modal text). At edge
    // lines the count is often weaker, so take 30% of the median.
    const peakCount = (counts, peaks) => peaks.map(p =>
      Math.max(counts[Math.max(0, p - 1)] || 0, counts[p] || 0,
               counts[Math.min(counts.length - 1, p + 1)] || 0)
    );
    const colPeakCounts = peakCount(colCounts, colPeaks).sort((a, b) => a - b);
    const rowPeakCounts = peakCount(rowCounts, rowPeaks).sort((a, b) => a - b);
    const colMedian = colPeakCounts[Math.floor(colPeakCounts.length / 2)] || 0;
    const rowMedian = rowPeakCounts[Math.floor(rowPeakCounts.length / 2)] || 0;
    const colHitThresh = Math.max(8, colMedian * 0.3);
    const rowHitThresh = Math.max(8, rowMedian * 0.3);
    function colOnBoard(x) {
      x = Math.round(x);
      let m = 0;
      for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < W && colCounts[xx] > m) m = colCounts[xx];
      }
      return m >= colHitThresh;
    }
    function rowOnBoard(y) {
      y = Math.round(y);
      let m = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = y + dy;
        if (yy >= 0 && yy < H && rowCounts[yy] > m) m = rowCounts[yy];
      }
      return m >= rowHitThresh;
    }
    console.log(TAG, 'thresholds:',
      { colMedian, rowMedian, colHitThresh, rowHitThresh });

    // Stash for dumpCounts
    GRID_DEBUG = { colCounts, rowCounts, colPeaks, rowPeaks,
                   colHitThresh, rowHitThresh, W, H };

    // Extrapolate from the median peak, but stop when we leave the wood.
    const colsExt = cellW ? extrapolateBounded(colPeaks, cellW, W, colOnBoard) : colPeaks.slice();
    const rowsExt = cellH ? extrapolateBounded(rowPeaks, cellH, H, rowOnBoard) : rowPeaks.slice();

    GRID = {
      x0: colsExt[0], y0: rowsExt[0],
      cellW, cellH,
      cols: colsExt.length, rows: rowsExt.length,
      colXs: colsExt, rowYs: rowsExt,
      raw: { colPeaks, rowPeaks },
      canvasIdx: all.indexOf(c),
    };
    console.log(TAG, 'grid detected (raw):',
      { cols: colPeaks.length, rows: rowPeaks.length, colPeaks, rowPeaks });
    console.log(TAG, 'grid extrapolated →',
      { cols: GRID.cols, rows: GRID.rows, x0: GRID.x0, y0: GRID.y0, cellW, cellH });
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
    const diffs = [];
    for (let i = 1; i < arr.length; i++) diffs.push(arr[i] - arr[i - 1]);
    diffs.sort((a, b) => a - b);
    return diffs[Math.floor(diffs.length / 2)];
  }

  // Extrapolate uniform positions from the median anchor outwards,
  // stopping when isOnBoardFn returns false (i.e. we left the wood).
  // Tolerates a single off-board sample to bridge label gaps.
  function extrapolateBounded(peaks, step, limit, isOnBoardFn) {
    if (peaks.length === 0) return [];
    const anchor = peaks[Math.floor(peaks.length / 2)];
    const left = [], right = [];

    let p = anchor - step, miss = 0;
    while (p >= 0 && miss < 2) {
      if (isOnBoardFn(p)) { left.unshift(Math.round(p)); miss = 0; }
      else miss++;
      p -= step;
    }
    p = anchor + step; miss = 0;
    while (p < limit && miss < 2) {
      if (isOnBoardFn(p)) { right.push(Math.round(p)); miss = 0; }
      else miss++;
      p += step;
    }
    return [...left, Math.round(anchor), ...right];
  }

  // Manually override the detected grid. Useful when detection picks up
  // partial board (e.g. settings overlay was visible during detect).
  function setGrid(params) {
    GRID = Object.assign({}, GRID || {}, params);
    if (params.cellW && params.x0 != null && params.cols) {
      GRID.colXs = Array.from({ length: params.cols },
        (_, i) => Math.round(params.x0 + i * params.cellW));
    }
    if (params.cellH && params.y0 != null && params.rows) {
      GRID.rowYs = Array.from({ length: params.rows },
        (_, i) => Math.round(params.y0 + i * params.cellH));
    }
    console.log(TAG, 'grid set:', GRID);
    drawOverlay();
    return GRID;
  }

  // Draw a positioned div on top of the canvas with a tiny dot at every
  // predicted intersection, plus a coordinate label at corners. This is
  // a sanity check — visually compare dots vs real grid intersections.
  let overlayEl = null;
  function drawOverlay(show = true) {
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    if (!show || !GRID || !GRID.colXs || !GRID.rowYs) return;
    const all = Array.from(document.querySelectorAll('canvas'));
    const c = all[GRID.canvasIdx ?? 0];
    if (!c) return;
    const rect = c.getBoundingClientRect();
    overlayEl = document.createElement('div');
    overlayEl.style.cssText =
      'position:fixed;pointer-events:none;z-index:99999;' +
      'left:' + rect.left + 'px;top:' + rect.top + 'px;' +
      'width:' + rect.width + 'px;height:' + rect.height + 'px;';
    const sx = rect.width / c.width, sy = rect.height / c.height;
    GRID.rowYs.forEach((py, ry) => {
      GRID.colXs.forEach((px, cx) => {
        const dot = document.createElement('div');
        const isCorner = (ry === 0 || ry === GRID.rows - 1) &&
                         (cx === 0 || cx === GRID.cols - 1);
        dot.style.cssText =
          'position:absolute;background:' + (isCorner ? '#ff0' : '#f0f') + ';' +
          'width:6px;height:6px;border-radius:50%;' +
          'left:' + (px * sx - 3) + 'px;top:' + (py * sy - 3) + 'px;' +
          'box-shadow:0 0 2px #000;';
        overlayEl.appendChild(dot);
      });
    });
    document.body.appendChild(overlayEl);
    console.log(TAG, 'overlay drawn —', GRID.cols, '×', GRID.rows,
      'intersections (yellow=corners, magenta=others). Call drawOverlay(false) to hide.');
  }

  // Dispatch a click at the given grid intersection. Sends pointer +
  // mouse events on the input overlay (.tsinbo.bsbb) which is where
  // playok actually listens — falls back to the board canvas if the
  // overlay isn't found. Use opts.confirm = true for the two-click
  // select-then-confirm pattern playok uses for stone placement.
  function clickAt(col, row, opts) {
    opts = opts || {};
    if (!GRID || !GRID.colXs || !GRID.rowYs) {
      console.warn(TAG, 'call setGrid()/detectGrid() first'); return;
    }
    if (col < 0 || col >= GRID.cols || row < 0 || row >= GRID.rows) {
      console.warn(TAG, 'col/row out of range'); return;
    }
    const all = Array.from(document.querySelectorAll('canvas'));
    const c = all[GRID.canvasIdx != null ? GRID.canvasIdx : 0];
    if (!c) { console.warn(TAG, 'no canvas'); return; }

    const rect = c.getBoundingClientRect();
    const sx = rect.width / c.width;
    const sy = rect.height / c.height;
    const intrinsicX = GRID.colXs[col];
    const intrinsicY = GRID.rowYs[row];
    const clientX = rect.left + intrinsicX * sx;
    const clientY = rect.top + intrinsicY * sy;

    const inputLayer = document.querySelector('.tsinbo.bsbb');
    const targetName = opts.target ||
                       (inputLayer ? '.tsinbo.bsbb' : 'canvas');
    const target = opts.target === 'canvas' ? c
                 : opts.target === 'document'
                   ? document.elementFromPoint(clientX, clientY)
                   : (inputLayer || c);

    const tsinboRect = inputLayer ? inputLayer.getBoundingClientRect() : null;
    const elemAtPoint = document.elementFromPoint(clientX, clientY);
    console.log(TAG, 'click col=' + col + ' row=' + row,
      '\n  intrinsic    =', intrinsicX, ',', intrinsicY,
      '\n  canvas rect  =', { left: rect.left, top: rect.top, w: rect.width, h: rect.height },
      '\n  tsinbo rect  =', tsinboRect && { left: tsinboRect.left, top: tsinboRect.top, w: tsinboRect.width, h: tsinboRect.height },
      '\n  scale (sx,sy)=', sx.toFixed(3), ',', sy.toFixed(3),
      '\n  client       =', clientX.toFixed(1), ',', clientY.toFixed(1),
      '\n  target       =', targetName,
      '\n  elementAt    =', elemAtPoint && (elemAtPoint.tagName + '.' + elemAtPoint.className));

    // Drop a tiny red marker at the click position for 2 seconds so the
    // user can visually verify against the real intersection.
    const marker = document.createElement('div');
    marker.style.cssText = 'position:fixed;z-index:99999;pointer-events:none;' +
      'left:' + (clientX - 5) + 'px;top:' + (clientY - 5) + 'px;' +
      'width:10px;height:10px;border-radius:50%;background:#ff0000;' +
      'box-shadow:0 0 6px #fff;';
    document.body.appendChild(marker);
    setTimeout(() => marker.remove(), 2000);

    function fire() {
      const init = {
        bubbles: true, cancelable: true, view: window, composed: true,
        clientX, clientY, screenX: clientX, screenY: clientY,
        button: 0, buttons: 1,
      };
      try {
        target.dispatchEvent(new PointerEvent('pointerdown',
          Object.assign({ pointerType: 'mouse', isPrimary: true }, init)));
      } catch (_) {}
      target.dispatchEvent(new MouseEvent('mousedown', init));
      try {
        target.dispatchEvent(new PointerEvent('pointerup',
          Object.assign({ pointerType: 'mouse', isPrimary: true,
                          buttons: 0 }, init, { buttons: 0 })));
      } catch (_) {}
      target.dispatchEvent(new MouseEvent('mouseup',
        Object.assign({}, init, { buttons: 0 })));
      target.dispatchEvent(new MouseEvent('click',
        Object.assign({}, init, { buttons: 0 })));
    }

    fire();
    if (opts.confirm) {
      setTimeout(() => { console.log(TAG, 'confirm click'); fire(); }, 300);
    }
  }

  // Read the current board into a 2D array of 0/1/2 (empty/black/white).
  // Samples a 9×9 patch (every 3px) around each intersection so a single
  // bad pixel (red last-move dot at the centre, AA on grid lines, board
  // border at corners) doesn't fool the classifier. Majority vote wins.
  function readBoard(canvasIdx) {
    if (!GRID) { console.warn(TAG, 'call detectGrid() or setGrid() first'); return null; }
    const all = Array.from(document.querySelectorAll('canvas'));
    const c = all[canvasIdx ?? GRID.canvasIdx ?? 0];
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const board = [];
    const RADIUS = 6;          // sample ±6px around centre
    const STEP   = 3;          // 9 samples per axis = 9×9 = 81 votes
    const unknownsByRC = [];

    for (let r = 0; r < GRID.rows; r++) {
      const row = [];
      for (let cIdx = 0; cIdx < GRID.cols; cIdx++) {
        const cx = GRID.colXs[cIdx], cy = GRID.rowYs[r];
        let nBlack = 0, nWhite = 0, nOther = 0;
        let sampleR = 0, sampleG = 0, sampleB = 0, sampleN = 0;
        for (let dy = -RADIUS; dy <= RADIUS; dy += STEP) {
          for (let dx = -RADIUS; dx <= RADIUS; dx += STEP) {
            const x = cx + dx, y = cy + dy;
            if (x < 0 || x >= c.width || y < 0 || y >= c.height) continue;
            const d = ctx.getImageData(x, y, 1, 1).data;
            const px = [d[0], d[1], d[2]];
            sampleR += d[0]; sampleG += d[1]; sampleB += d[2]; sampleN++;
            if      (colorMatch(px, COLORS.black, 35)) nBlack++;
            else if (colorMatch(px, COLORS.white, 25)) nWhite++;
            else nOther++;   // wood / grid line / red dot / border
          }
        }
        // A stone occupies most of the 13×13 area. Require a clear majority.
        let val = 0;
        if (nBlack >= sampleN * 0.35) val = 1;
        else if (nWhite >= sampleN * 0.35) val = 2;
        else val = 0;
        row.push(val);

        // Track ambiguous cells for diagnostics
        if (nBlack > 0 && nBlack < sampleN * 0.35 && nWhite > 0 && nWhite < sampleN * 0.35) {
          unknownsByRC.push({ r, c: cIdx, nBlack, nWhite, nOther,
            avg: [Math.round(sampleR/sampleN), Math.round(sampleG/sampleN), Math.round(sampleB/sampleN)] });
        }
      }
      board.push(row);
    }
    console.log(TAG, 'board:');
    console.log(board.map(r => r.map(v => v === 0 ? '·' : v === 1 ? 'X' : 'O').join(' ')).join('\n'));
    if (unknownsByRC.length) console.log(TAG, 'ambiguous cells:', unknownsByRC);
    return board;
  }

  // readSettings(): parse the create-game settings panel into a config
  // object suitable for sending to the engine.
  //
  // Earlier version mapped checkboxes/selects by DOM index — fragile,
  // and the mapping silently broke when playok rearranged the panel
  // (saw swap2 reported as true even when it wasn't ticked). Now we
  // identify each control by the label text of its parent div, which
  // is much more stable across UI tweaks.
  function readSettings() {
    const panel = document.querySelector('.bsbb.dsp1');
    if (!panel) { console.warn(TAG, 'settings panel not visible'); return null; }

    function labelTextOf(el) {
      // Wrapping div contains "<input> <label text> <maybe select>".
      // Strip the select's own value and the input's value so we get
      // just the human-readable label.
      const wrap = el.parentElement;
      let txt = (wrap && wrap.textContent) || '';
      const sel = wrap && wrap.querySelector('select');
      if (sel) txt = txt.replace(sel.value || '', '');
      return txt.toLowerCase().trim();
    }

    const findCheck = (...kws) => {
      const checks = panel.querySelectorAll('input[type=checkbox]');
      for (const cb of checks) {
        const lbl = labelTextOf(cb);
        if (kws.some(kw => lbl.includes(kw))) return !!cb.checked;
      }
      return false;
    };
    const findSelectByLabel = (...kws) => {
      const selects = panel.querySelectorAll('select');
      for (const sel of selects) {
        const lbl = labelTextOf(sel);
        if (kws.some(kw => lbl.includes(kw))) return sel.value;
      }
      return null;
    };
    // Room select has no explicit label — identify by option values
    let room = null;
    for (const sel of panel.querySelectorAll('select')) {
      const opts = Array.from(sel.options).map(o => o.value);
      if (opts.includes('public') || opts.includes('private')) {
        room = sel.value;
        break;
      }
    }

    const swap2     = findCheck('swap2', 'swap 2');
    const nonRated  = findCheck('non-rated', 'non rated', 'unrated');
    const noUndo    = findCheck('no undo');
    const sounds    = findCheck('sound');
    const gameTime  = findSelectByLabel('game time');
    const addedTime = findSelectByLabel('added time');

    const cfg = {
      room,
      gameTime:  gameTime  != null ? parseInt(gameTime,  10) : null,
      addedTime: addedTime != null ? parseInt(addedTime, 10) : null,
      noUndo, sounds, nonRated, swap2,
      // swap2 only changes opening protocol; engine rule (free / renju)
      // is orthogonal. Tag both for the API.
      rule: swap2 ? 'free-swap2' : 'free',
      boardSize: 15,
    };
    console.log(TAG, 'settings:', cfg);
    return cfg;
  }

  let lastCount = -1;
  watcher = setInterval(() => {
    const n = document.querySelectorAll('canvas').length;
    if (n !== lastCount) {
      lastCount = n;
      console.log(TAG, 'canvas count changed →', n);
      if (n > 0) dumpCanvases();
    }
  }, 1500);

  window.bmGomokuDebug = {
    dump: () => { dumpCanvases(); dumpDomAroundBoard(); dumpGlobals(); },
    canvases: dumpCanvases,
    dom: dumpDomAroundBoard,
    globals: dumpGlobals,
    pixel: samplePixel,
    tap,
    detectGrid,
    dumpCounts,
    setGrid,
    drawOverlay,
    readBoard,
    readSettings,
    click: clickAt,
    colors: COLORS,
    get grid() { return GRID; },
    stop: () => { if (watcher) clearInterval(watcher); tap(false); drawOverlay(false); console.log(TAG, 'stopped'); },
  };

  console.log(TAG, 'Ready. In DevTools console try:');
  console.log(TAG, '  bmGomokuDebug.detectGrid()  — auto-detect + extrapolate grid');
  console.log(TAG, '  bmGomokuDebug.drawOverlay() — show predicted intersections');
  console.log(TAG, '  bmGomokuDebug.readBoard()   — read current position as 2D array');
  console.log(TAG, '  bmGomokuDebug.setGrid({x0,y0,cellW,cellH,cols:15,rows:15}) — manual override');
  console.log(TAG, '  bmGomokuDebug.readSettings()');
  console.log(TAG, '  bmGomokuDebug.dump() / .pixel(x,y,0) / .tap() / .stop()');

  setTimeout(() => {
    try { dumpCanvases(); dumpDomAroundBoard(); dumpGlobals(); }
    catch (e) { console.warn(TAG, e); }
  }, 1500);
})();
