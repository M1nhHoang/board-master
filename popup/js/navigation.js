// ─── View Navigation ───

function showView(viewId) {
  $$('.view').forEach(v => v.classList.remove('active'));
  const el = $(`#view-${viewId}`);
  if (el) el.classList.add('active');
  state.view = viewId;
  saveState();
}

function navigateTo(view) {
  if (view === 'main' && state.autoMode) {
    updateAutoView();
    showView('auto');
  } else if (view === 'main') {
    updateMainView();
    showView('main');
  } else if (view === 'auto') {
    updateAutoView();
    showView('auto');
  } else if (view === 'settings') {
    renderSettings();
    showView('settings');
  } else if (view === 'platforms') {
    showView('platforms');
  } else {
    showView('not-detected');
  }
}
