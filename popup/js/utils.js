// ─── DOM helpers ───
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── Utility functions ───
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function capitalize(s) {
  return s.replace(/(?:^|[-_ ])(\w)/g, (_, c) => ' ' + c.toUpperCase()).trim();
}

function skillDesc(level) {
  if (level <= 3) return '~800 Elo (Beginner)';
  if (level <= 6) return '~1200 Elo (Casual)';
  if (level <= 10) return '~1800 Elo (Intermediate)';
  if (level <= 15) return '~2400 Elo (Advanced)';
  if (level <= 19) return '~3000 Elo (Expert)';
  return '~3200+ Elo (Maximum)';
}
