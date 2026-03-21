// ─── Chess.com Page-World Script ───
// Runs in the MAIN world (page context) via manifest "world": "MAIN".
// Has access to wc-chess-board.game which is invisible to content scripts.

(function () {
  'use strict';

  function getFEN() {
    var board = document.querySelector('wc-chess-board');
    if (board && board.game && typeof board.game.getFEN === 'function') {
      return board.game.getFEN();
    }
    if (board) {
      var fen = board.getAttribute('fen');
      if (fen) return fen;
    }
    return null;
  }

  // On-demand request from content script
  window.addEventListener('bm-request-fen', function () {
    var fen = getFEN();
    console.log('[BM][page] FEN requested →', fen);
    window.dispatchEvent(new CustomEvent('bm-fen-response', { detail: { fen: fen } }));
  });

  // Auto-push on move change (poll every 500ms)
  var lastKnownFen = '';
  setInterval(function () {
    var board = document.querySelector('wc-chess-board');
    if (!board) return;

    // Expose board orientation for the content-script arrow overlay
    try {
      var flipped = !!(board.game && board.game.getPlayingAs && board.game.getPlayingAs() === 2);
      board.setAttribute('data-bm-flipped', flipped ? '1' : '0');
    } catch (_) {}

    var fen = getFEN();
    if (fen && fen !== lastKnownFen) {
      lastKnownFen = fen;
      console.log('[BM][page] FEN changed →', fen);
      window.dispatchEvent(new CustomEvent('bm-fen-changed', { detail: { fen: fen } }));
    }
  }, 500);

  console.log('[BM][page] chesscom-page.js loaded in MAIN world');

  // ─── Auto-play: simulate click on board squares ───
  window.addEventListener('bm-auto-move', function (e) {
    var from = e.detail?.from; // e.g. "e2"
    var to   = e.detail?.to;   // e.g. "e4"
    if (!from || !to) { console.log('[BM][page] autoMove — missing from/to'); return; }

    var board = document.querySelector('wc-chess-board');
    if (!board) { console.log('[BM][page] autoMove — no board'); return; }

    console.log('[BM][page] autoMove:', from, '→', to);

    // Determine if board is flipped
    var flipped = false;
    try { flipped = !!(board.game && board.game.getPlayingAs && board.game.getPlayingAs() === 2); } catch (_) {}

    var rect = board.getBoundingClientRect();
    var sqW = rect.width / 8;
    var sqH = rect.height / 8;

    function sqCenter(sq) {
      var file = sq.charCodeAt(0) - 97; // a=0..h=7
      var rank = parseInt(sq[1], 10) - 1; // 1→0..8→7
      var x, y;
      if (flipped) {
        x = rect.left + (7 - file) * sqW + sqW / 2;
        y = rect.top  + rank * sqH + sqH / 2;
      } else {
        x = rect.left + file * sqW + sqW / 2;
        y = rect.top  + (7 - rank) * sqH + sqH / 2;
      }
      return { x: x, y: y };
    }

    var fromPt = sqCenter(from);
    var toPt   = sqCenter(to);

    function firePointer(type, pt, el) {
      var ev = new PointerEvent(type, {
        bubbles: true, cancelable: true,
        clientX: pt.x, clientY: pt.y,
        pointerId: 1, pointerType: 'mouse',
        button: 0, buttons: type === 'pointerup' ? 0 : 1,
      });
      (el || document.elementFromPoint(pt.x, pt.y) || board).dispatchEvent(ev);
    }

    function fireMouse(type, pt, el) {
      var ev = new MouseEvent(type, {
        bubbles: true, cancelable: true,
        clientX: pt.x, clientY: pt.y,
        button: 0, buttons: type === 'mouseup' ? 0 : 1,
      });
      (el || document.elementFromPoint(pt.x, pt.y) || board).dispatchEvent(ev);
    }

    // Click source square
    var srcEl = document.elementFromPoint(fromPt.x, fromPt.y) || board;
    firePointer('pointerdown', fromPt, srcEl);
    fireMouse('mousedown', fromPt, srcEl);

    // Small delay then click destination
    setTimeout(function () {
      var dstEl = document.elementFromPoint(toPt.x, toPt.y) || board;
      firePointer('pointerup', toPt, dstEl);
      fireMouse('mouseup', toPt, dstEl);
      fireMouse('click', toPt, dstEl);
      console.log('[BM][page] autoMove dispatched:', from, '→', to);

      // Report success back
      window.dispatchEvent(new CustomEvent('bm-auto-move-done', { detail: { from: from, to: to } }));
    }, 150);
  });
})();
