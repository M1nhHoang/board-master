// ─── Chess / Gomoku API Client ───

export const API_BASE = 'https://minhhoang.info';

// Friendly, user-facing copy for the API's documented status codes.
// 5xx bodies are intentionally generic (engine details are logged
// server-side only), and 429 now covers several causes (per-IP rate
// limit of 120/min, 5 pending requests for this IP, or the global queue
// being full). For 4xx we prefer the server's specific message and fall
// back to this copy; for 5xx (or an empty body) we always use this copy.
const STATUS_MESSAGE = {
  400: 'Invalid request — check the board state or settings',
  408: 'Engine timed out (server busy) — please retry',
  413: 'Request too large (over 32 KB)',
  429: 'Too many requests — slow down and retry shortly',
  500: 'Engine temporarily unavailable — please retry',
};

async function readErrorBody(resp) {
  try {
    const text = await resp.text();
    try {
      const j = JSON.parse(text);
      return j.error || j.message || text;
    } catch { return text; }
  } catch { return ''; }
}

// Shared POST helper: one place to issue the request, surface the new
// status codes (413 / richer 429 / generic 5xx), and log failures.
async function postJson(path, body, label) {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (resp.ok) return resp.json();

  const detail = await readErrorBody(resp);
  console.error(`[BM][api] ${label}`, resp.status, '— request:', JSON.stringify(body),
    '— response:', detail);
  // 4xx bodies carry a specific, safe message — prefer it. 5xx bodies are
  // intentionally generic, so fall back to our own copy (also used when
  // the body is empty).
  const friendly = STATUS_MESSAGE[resp.status] || `API error ${resp.status}`;
  const message = (resp.status < 500 && detail) ? detail : friendly;
  throw new Error(`${message} (${resp.status})`);
}

export async function analyzePosition(fen, settings) {
  const body = { fen };
  if (settings.searchDepth) body.depth = settings.searchDepth;
  if (settings.multiPV) body.multiPV = settings.multiPV;
  if (settings.skillLevel !== undefined) body.skillLevel = settings.skillLevel;
  return postJson('/api/games/chess/move', body, 'chess /move');
}

export async function analyzeGomokuPosition(boardSize, rule, moves, maxDepth) {
  const body = { boardSize, rule, moves };
  if (maxDepth) body.maxDepth = maxDepth;
  return postJson('/api/games/gomoku/move', body, 'gomoku /move');
}

// Drive the swap2 opening protocol. Send 0, 3, or 5 stones; engine
// returns one of: { action: 'opening', moves: [3] } when proposer,
// 'swap' / 'move' / 'put_two' when chooser. See swap2.md.
export async function analyzeGomokuSwap2(boardSize, moves, maxDepth) {
  const body = { boardSize, moves };
  if (maxDepth) body.maxDepth = maxDepth;
  return postJson('/api/games/gomoku/swap2', body, 'gomoku /swap2');
}
