// ─── Arrow Overlay for Chess Board ───
// Draws move-suggestion arrows on the chess board.
// Loaded BEFORE core.js; used via the global `ChessArrows` object.

// eslint-disable-next-line no-var
var ChessArrows = (function () {
  'use strict';

  let svg = null;
  let visible = true;
  let cached = [];
  let observer = null;

  // Arrow styles by rank (best → worst)
  const STYLES = [
    { color: 'rgba(255, 170, 0, 0.85)', w: 22 },  // #1 bold
    { color: 'rgba(255, 170, 0, 0.55)', w: 17 },  // #2 medium
    { color: 'rgba(255, 170, 0, 0.35)', w: 14 },  // #3 subtle
  ];

  /* ── board helpers ── */

  function getBoard() {
    return document.querySelector('wc-chess-board, cg-board');
  }

  function isFlipped() {
    const b = getBoard();
    if (!b) return false;
    // Page script sets this attribute (chess.com)
    if (b.dataset.bmFlipped === '1') return true;
    if (b.dataset.bmFlipped === '0') return false;
    // Fallback: check class
    if (b.tagName === 'WC-CHESS-BOARD') return b.classList.contains('flipped');
    // Lichess chessground
    const wrap = b.closest('.cg-wrap');
    return wrap ? wrap.classList.contains('orientation-black') : false;
  }

  /** Square name ("e4") → viewBox center coordinates */
  function sqXY(sq, flip) {
    const f = sq.charCodeAt(0) - 97;        // a=0 … h=7
    const r = parseInt(sq[1], 10) - 1;      // 1→0 … 8→7
    return flip
      ? { x: (7 - f) * 100 + 50, y: r * 100 + 50 }
      : { x: f * 100 + 50, y: (7 - r) * 100 + 50 };
  }

  /* ── SVG container ── */

  function ensureSVG() {
    const b = getBoard();
    if (!b) return null;

    if (svg && document.body.contains(svg)) {
      syncPosition(b);
      return svg;
    }

    // Remove stale overlay
    const old = document.getElementById('bm-arrows');
    if (old) old.remove();

    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'bm-arrows';
    svg.setAttribute('viewBox', '0 0 800 800');
    svg.style.cssText =
      'position:absolute;pointer-events:none;z-index:9999;';

    document.body.appendChild(svg);
    syncPosition(b);

    // Keep overlay aligned with the board
    if (!observer) {
      observer = new ResizeObserver(() => { if (svg) syncPosition(b); });
    }
    observer.observe(b);
    window.addEventListener('scroll', () => syncPosition(b), { passive: true });

    return svg;
  }

  function syncPosition(b) {
    if (!svg || !b) return;
    const r = b.getBoundingClientRect();
    svg.style.left   = (r.left + window.scrollX) + 'px';
    svg.style.top    = (r.top  + window.scrollY) + 'px';
    svg.style.width  = r.width  + 'px';
    svg.style.height = r.height + 'px';
  }

  /* ── arrow geometry ── */

  /** Build a thick arrow <path> (body rectangle + triangle head) */
  function arrowPathD(from, to, w) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return '';

    const ux = dx / len, uy = dy / len;   // unit direction
    const px = -uy, py = ux;               // perpendicular

    const headLen = w * 2;
    const headHW  = w * 1.3;               // head half-width
    const hw      = w / 2;                 // body half-width
    const startOff = 15;                   // offset from square center

    const sx = from.x + ux * startOff;
    const sy = from.y + uy * startOff;

    const bodyLen = len - startOff - headLen;
    const tipX = to.x - ux * 10;
    const tipY = to.y - uy * 10;

    if (bodyLen < 5) {
      // Very short move — just a triangle
      return [
        'M', sx + px * headHW, sy + py * headHW,
        'L', tipX, tipY,
        'L', sx - px * headHW, sy - py * headHW, 'Z',
      ].join(' ');
    }

    const bx = sx + ux * bodyLen;
    const by = sy + uy * bodyLen;

    return [
      'M', sx + px * hw,     sy + py * hw,
      'L', bx + px * hw,     by + py * hw,
      'L', bx + px * headHW, by + py * headHW,
      'L', tipX,              tipY,
      'L', bx - px * headHW, by - py * headHW,
      'L', bx - px * hw,     by - py * hw,
      'L', sx - px * hw,     sy - py * hw,
      'Z',
    ].join(' ');
  }

  /* ── public API ── */

  function draw(hints) {
    cached = hints || [];
    console.log('[BM][arrows] draw() called with', cached.length, 'hints:', JSON.stringify(cached.map(h => h.move)));

    const board = getBoard();
    console.log('[BM][arrows] board element:', board ? board.tagName : 'NOT FOUND');

    const s = ensureSVG();
    if (!s) { console.log('[BM][arrows] ensureSVG() returned null — aborting'); return; }

    console.log('[BM][arrows] SVG overlay:', s.id, 'style:', s.style.cssText);

    // Clear previous arrows
    s.querySelectorAll('.bm-arrow').forEach(n => n.remove());
    if (!visible || cached.length === 0) { console.log('[BM][arrows] visible:', visible, 'hints:', cached.length, '— skipping'); return; }

    const flip = isFlipped();
    console.log('[BM][arrows] flipped:', flip);

    // Draw back-to-front so best move renders on top
    let drawn = 0;
    for (let i = cached.length - 1; i >= 0; i--) {
      const parts = cached[i].move.split('→');
      if (parts.length !== 2) { console.log('[BM][arrows] skip hint', i, '— bad format:', cached[i].move); continue; }

      const fromSq = parts[0].trim();
      const toSq   = parts[1].trim();
      const from   = sqXY(fromSq, flip);
      const to     = sqXY(toSq,   flip);
      const st     = STYLES[Math.min(i, STYLES.length - 1)];
      const d      = arrowPathD(from, to, st.w);
      if (!d) { console.log('[BM][arrows] skip hint', i, '— empty path, from:', fromSq, 'to:', toSq); continue; }

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.classList.add('bm-arrow');
      path.setAttribute('d', d);
      path.setAttribute('fill', st.color);
      s.appendChild(path);
      drawn++;
    }

    console.log('[BM][arrows] Drew', drawn, 'arrow(s) on board');
  }

  function clear() {
    cached = [];
    if (svg) svg.querySelectorAll('.bm-arrow').forEach(n => n.remove());
  }

  function toggle() {
    visible = !visible;
    if (svg) svg.style.display = visible ? '' : 'none';
    return visible;
  }

  function setVisible(v) {
    visible = v;
    if (svg) svg.style.display = v ? '' : 'none';
  }

  return { draw, clear, toggle, setVisible };
})();
