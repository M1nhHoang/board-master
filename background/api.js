// ─── Chess API Client ───

export const API_BASE = 'https://minhhoang.info';

export async function analyzePosition(fen, settings) {
  const body = { fen };
  if (settings.searchDepth) body.depth = settings.searchDepth;
  if (settings.multiPV) body.multiPV = settings.multiPV;
  if (settings.skillLevel !== undefined) body.skillLevel = settings.skillLevel;

  const resp = await fetch(`${API_BASE}/api/games/chess/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

async function readErrorBody(resp) {
  try {
    const text = await resp.text();
    try {
      const j = JSON.parse(text);
      return j.error || j.message || text;
    } catch { return text; }
  } catch { return ''; }
}

export async function analyzeGomokuPosition(boardSize, rule, moves, maxDepth) {
  const body = { boardSize, rule, moves };
  if (maxDepth) body.maxDepth = maxDepth;

  const resp = await fetch(`${API_BASE}/api/games/gomoku/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await readErrorBody(resp);
    console.error('[BM][api] /move', resp.status, '— request:', JSON.stringify(body),
      '— response:', detail);
    throw new Error(`Gomoku API ${resp.status}: ${detail || 'no body'}`);
  }
  return resp.json();
}

// Drive the swap2 opening protocol. Send 0, 3, or 5 stones; engine
// returns one of: { action: 'opening', moves: [3] } when proposer,
// 'swap' / 'move' / 'put_two' when chooser. See swap2.md.
export async function analyzeGomokuSwap2(boardSize, moves, maxDepth) {
  const body = { boardSize, moves };
  if (maxDepth) body.maxDepth = maxDepth;

  const resp = await fetch(`${API_BASE}/api/games/gomoku/swap2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await readErrorBody(resp);
    console.error('[BM][api] /swap2', resp.status, '— request:', JSON.stringify(body),
      '— response:', detail);
    throw new Error(`Gomoku swap2 API ${resp.status}: ${detail || 'no body'}`);
  }
  return resp.json();
}
