const elements = {
  form: document.querySelector('#record-form'),
  url: document.querySelector('#target-url'),
  record: document.querySelector('#record-button'),
  stop: document.querySelector('#stop-button'),
  play: document.querySelector('#play-button'),
  close: document.querySelector('#close-button'),
  clear: document.querySelector('#clear-button'),
  timeline: document.querySelector('#timeline'),
  actionCount: document.querySelector('#action-count'),
  timelineFooter: document.querySelector('#timeline-footer-text'),
  statusPill: document.querySelector('#status-pill'),
  sessionTitle: document.querySelector('#session-title'),
  sessionDetail: document.querySelector('#session-detail'),
  progress: document.querySelector('#readout-progress'),
  code: document.querySelector('#python-code'),
  copy: document.querySelector('#copy-button'),
  download: document.querySelector('#download-button'),
  toast: document.querySelector('#toast')
};

let lastState = null;
let toastTimer = null;
let isRefreshing = false;
let lastTimelineSignature = '';

const statusCopy = {
  idle: { pill: 'Ready', title: 'Ready to capture', detail: 'Choose a starting page to begin.' },
  recording: { pill: 'Live', title: 'Recording browser', detail: 'Interact with the opened browser window.' },
  recorded: { pill: 'Saved', title: 'Workflow captured', detail: 'Your sequence is ready for playback.' },
  playing: { pill: 'Running', title: 'Playing workflow', detail: 'Selenium is moving through the recorded steps.' },
  played: { pill: 'Complete', title: 'Playback complete', detail: 'The browser is still open for inspection.' },
  error: { pill: 'Error', title: 'Session needs attention', detail: 'Check the browser and try again.' }
};

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || 'The request could not be completed.');
  }
  return payload;
}

function selectedBrowser() {
  return document.querySelector('input[name="browser"]:checked').value;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    elements.toast.classList.remove('visible');
  }, 3200);
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.dataset.busy = busy ? 'true' : 'false';
}

function actionText(action) {
  if (action.type === 'navigate') {
    return { title: 'Navigate', detail: action.url || 'Page change' };
  }
  if (action.type === 'click') {
    return { title: action.label || 'Click target', detail: action.selector || 'CSS selector unavailable' };
  }
  if (action.type === 'input') {
    return { title: action.label || 'Enter text', detail: action.selector || 'CSS selector unavailable' };
  }
  if (action.type === 'change') {
    return { title: action.label || 'Change value', detail: action.selector || 'CSS selector unavailable' };
  }
  return { title: `Press ${action.key || 'key'}`, detail: action.selector || 'CSS selector unavailable' };
}

function createActionRow(action, index, state) {
  const row = document.createElement('div');
  row.className = 'action-row';
  if (state.status === 'playing' && index === state.activeIndex) {
    row.classList.add('is-active');
  }

  const number = document.createElement('span');
  number.className = 'action-number';
  number.textContent = String(index + 1).padStart(2, '0');

  const type = document.createElement('span');
  type.className = `action-type ${action.type}`;
  type.textContent = action.type === 'input' ? 'type' : action.type;

  const copy = document.createElement('div');
  copy.className = 'action-copy';
  const text = actionText(action);
  const title = document.createElement('strong');
  title.textContent = text.title;
  const detail = document.createElement('span');
  detail.textContent = text.detail;
  copy.append(title, detail);

  const value = document.createElement('span');
  value.className = 'action-value';
  value.textContent = action.value || action.key || '';

  row.append(number, type, copy, value);
  return row;
}

function renderTimeline(state) {
  const actions = Array.isArray(state.actions) ? state.actions : [];
  elements.actionCount.textContent = `${actions.length} action${actions.length === 1 ? '' : 's'}`;

  const timelineSignature = JSON.stringify({
    actions,
    isPlaying: state.status === 'playing',
    activeIndex: state.activeIndex
  });
  if (timelineSignature === lastTimelineSignature) {
    return;
  }
  lastTimelineSignature = timelineSignature;

  elements.timeline.replaceChildren();

  if (!actions.length) {
    const empty = document.createElement('div');
    empty.className = 'timeline-empty';
    const mark = document.createElement('span');
    mark.className = 'empty-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = '+';
    const title = document.createElement('strong');
    title.textContent = state.status === 'recording' ? 'Listening for browser actions' : 'Your workflow will appear here';
    const detail = document.createElement('span');
    detail.textContent = 'Clicks, text entry, navigation, and key actions.';
    empty.append(mark, title, detail);
    elements.timeline.append(empty);
  } else {
    const fragment = document.createDocumentFragment();
    actions.forEach((action, index) => fragment.append(createActionRow(action, index, state)));
    elements.timeline.append(fragment);
    elements.timeline.scrollTop = elements.timeline.scrollHeight;
  }
}

function renderState(state) {
  lastState = state;
  const copy = statusCopy[state.status] || statusCopy.idle;
  const isError = state.status === 'error';
  const isRecording = state.status === 'recording';
  const isPlaying = state.status === 'playing';
  const hasRecording = ['recorded', 'playing', 'played'].includes(state.status) || Boolean(state.script);

  elements.statusPill.textContent = isError ? 'Error' : copy.pill;
  elements.statusPill.classList.toggle('is-busy', isRecording || isPlaying);
  elements.statusPill.classList.toggle('is-error', isError);
  elements.sessionTitle.textContent = copy.title;
  elements.sessionDetail.textContent = isError && state.error ? state.error : copy.detail;
  elements.progress.style.width = isPlaying && state.actionCount
    ? `${Math.max(4, ((state.activeIndex + 1) / state.actionCount) * 100)}%`
    : isRecording ? '34%' : hasRecording ? '100%' : '4%';

  elements.record.disabled = isRecording || isPlaying;
  elements.stop.disabled = !isRecording;
  elements.play.disabled = !Boolean(state.script) || isRecording || isPlaying;
  elements.close.disabled = !isPlaying && !isError;
  elements.clear.disabled = state.status === 'idle';
  elements.copy.disabled = !Boolean(state.script);
  elements.download.disabled = !Boolean(state.script);
  elements.timelineFooter.textContent = isRecording
    ? 'Listening to the browser session'
    : isPlaying
      ? `Running step ${Math.min(state.activeIndex + 1, state.actionCount)} of ${state.actionCount}`
      : state.actionCount
        ? `${state.actionCount} captured action${state.actionCount === 1 ? '' : 's'}`
        : 'Waiting for a browser session';

  renderTimeline(state);
  elements.code.textContent = state.script || '# Record a workflow to generate Selenium code.';
}

async function refreshState() {
  if (isRefreshing) {
    return;
  }
  isRefreshing = true;
  try {
    renderState(await request('/api/state'));
  } catch (error) {
    elements.sessionDetail.textContent = error.message;
  } finally {
    isRefreshing = false;
  }
}

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setBusy(elements.record, true);
  try {
    const state = await request('/api/record/start', {
      method: 'POST',
      body: JSON.stringify({ url: elements.url.value, browser: selectedBrowser() })
    });
    renderState(state);
    showToast('Browser launched. Recording is live.');
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(elements.record, false);
    refreshState();
  }
});

elements.stop.addEventListener('click', async () => {
  setBusy(elements.stop, true);
  try {
    renderState(await request('/api/record/stop', { method: 'POST' }));
    showToast('Workflow saved and browser closed.');
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(elements.stop, false);
  }
});

elements.play.addEventListener('click', async () => {
  setBusy(elements.play, true);
  try {
    renderState(await request('/api/playback/start', { method: 'POST' }));
    showToast('Playback started in a fresh browser.');
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(elements.play, false);
  }
});

elements.close.addEventListener('click', async () => {
  setBusy(elements.close, true);
  try {
    renderState(await request('/api/browser/close', { method: 'POST' }));
    showToast('Browser closed.');
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(elements.close, false);
  }
});

elements.clear.addEventListener('click', async () => {
  setBusy(elements.clear, true);
  try {
    renderState(await request('/api/session/clear', { method: 'POST' }));
    showToast('Current session cleared.');
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.clear.disabled = !lastState || lastState.status === 'idle';
  }
});

elements.copy.addEventListener('click', async () => {
  if (!lastState?.script) {
    return;
  }
  try {
    await navigator.clipboard.writeText(lastState.script);
    showToast('Python Selenium script copied.');
  } catch {
    showToast('Clipboard access was unavailable.');
  }
});

elements.download.addEventListener('click', () => {
  if (!lastState?.script) {
    return;
  }
  const blob = new Blob([lastState.script], { type: 'text/x-python' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'workflow.py';
  link.click();
  URL.revokeObjectURL(link.href);
  showToast('workflow.py downloaded.');
});

renderState({
  status: 'idle',
  actions: [],
  actionCount: 0,
  activeIndex: -1,
  script: ''
});
refreshState();
window.setInterval(refreshState, 700);