const path = require('node:path');
const express = require('express');
const { Builder, By, Key, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const edge = require('selenium-webdriver/edge');

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const recorderBindingName = '__seleniumStudioRecorderEvent';
const recorderScript = `
  (() => {
    if (window.__seleniumStudioRecorderInstalled
      || window.top !== window
      || typeof window.${recorderBindingName} !== 'function') {
      return;
    }

    const cssEscape = (value) => {
      if (window.CSS && typeof window.CSS.escape === 'function') {
        return window.CSS.escape(value);
      }
      return String(value).replace(/([\\\\.#:[\\],>+~*'" ])/g, '\\\\$1');
    };

    const selectorFor = (element) => {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) {
        return null;
      }

      if (element.id) {
        return '#' + cssEscape(element.id);
      }

      for (const attribute of ['data-testid', 'name', 'aria-label']) {
        const value = element.getAttribute(attribute);
        if (value) {
          return element.tagName.toLowerCase() + '[' + attribute + '="' + cssEscape(value) + '"]';
        }
      }

      const parts = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
        let part = current.tagName.toLowerCase();
        const siblings = current.parentElement
          ? Array.from(current.parentElement.children).filter((child) => child.tagName === current.tagName)
          : [];
        if (siblings.length > 1) {
          part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
        }
        parts.unshift(part);
        current = current.parentElement;
      }
      return parts.join(' > ');
    };

    const labelFor = (element) => {
      if (!element) {
        return '';
      }
      return element.getAttribute('aria-label')
        || element.getAttribute('name')
        || element.getAttribute('placeholder')
        || (element.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    };

    const emit = (event) => {
      window.${recorderBindingName}(JSON.stringify(event));
    };

    document.addEventListener('click', (event) => {
      const element = event.target.closest('button, a, input, textarea, select, [role="button"]');
      const selector = selectorFor(element);
      if (selector) {
        emit({ type: 'click', selector, label: labelFor(element), time: Date.now() });
      }
    }, true);

    document.addEventListener('input', (event) => {
      const element = event.target;
      const selector = selectorFor(element);
      if (selector && 'value' in element) {
        emit({ type: 'input', selector, value: element.value, label: labelFor(element), time: Date.now() });
      }
    }, true);

    document.addEventListener('change', (event) => {
      const element = event.target;
      const selector = selectorFor(element);
      if (selector && 'value' in element) {
        emit({ type: 'change', selector, value: element.value, label: labelFor(element), time: Date.now() });
      }
    }, true);

    document.addEventListener('keydown', (event) => {
      if (!['Enter', 'Tab', 'Escape'].includes(event.key)) {
        return;
      }
      const selector = selectorFor(event.target);
      if (selector) {
        emit({ type: 'key', selector, key: event.key, label: labelFor(event.target), time: Date.now() });
      }
    }, true);

    window.__seleniumStudioRecorderInstalled = true;
  })();
`;

let activeSession = null;
let savedRecording = null;

function safeUrl(value) {
  const parsed = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http:// and https:// URLs can be recorded.');
  }
  return parsed.href;
}

function browserName(value) {
  return value === 'edge' ? 'edge' : 'chrome';
}

const quietBrowserArguments = [
  '--disable-background-networking',
  '--disable-component-update',
  '--no-default-browser-check',
  '--no-first-run',
  '--log-level=3'
];

async function buildDriver(browser) {
  const selectedBrowser = browserName(browser);
  const builder = new Builder().forBrowser(selectedBrowser);

  if (selectedBrowser === 'edge') {
    const options = new edge.Options();
    options.addArguments('--start-maximized', ...quietBrowserArguments);
    builder.setEdgeOptions(options);
  } else {
    const options = new chrome.Options();
    options.addArguments('--start-maximized', ...quietBrowserArguments);
    builder.setChromeOptions(options);
  }

  return builder.build();
}

function sessionActions(session) {
  return session ? session.actions : (savedRecording ? savedRecording.actions : []);
}

function currentRecording() {
  if (activeSession && ['recording', 'playing'].includes(activeSession.mode)) {
    return {
      initialUrl: activeSession.initialUrl,
      browser: activeSession.browser,
      actions: activeSession.actions,
      createdAt: activeSession.startedAt
    };
  }
  return savedRecording;
}

function serializeState() {
  const recording = currentRecording();
  return {
    status: activeSession ? activeSession.mode : (savedRecording ? 'recorded' : 'idle'),
    browser: activeSession?.browser || savedRecording?.browser || 'chrome',
    currentUrl: activeSession?.currentUrl || savedRecording?.initialUrl || '',
    initialUrl: recording?.initialUrl || '',
    actions: sessionActions(activeSession),
    actionCount: sessionActions(activeSession).length,
    activeIndex: activeSession?.activeIndex ?? -1,
    error: activeSession?.error || '',
    script: recording ? generatePythonScript(recording) : ''
  };
}

function normalizeRecordedEvent(event) {
  return {
    type: event.type,
    selector: typeof event.selector === 'string' ? event.selector : '',
    value: typeof event.value === 'string' ? event.value : undefined,
    key: typeof event.key === 'string' ? event.key : undefined,
    label: typeof event.label === 'string' ? event.label : '',
    recordedAt: new Date(typeof event.time === 'number' ? event.time : Date.now()).toISOString()
  };
}

function appendRecordedEvent(session, event) {
  const action = normalizeRecordedEvent(event);
  const previous = session.actions[session.actions.length - 1];
  const actionTime = Date.parse(action.recordedAt);
  const previousTime = previous ? Date.parse(previous.recordedAt) : NaN;
  if (action.type === 'change' && previous && previous.type === 'input'
    && previous.selector === action.selector && previous.value === action.value) {
    return;
  }
  if (action.type === 'input' && previous && previous.type === 'input'
    && previous.selector === action.selector && actionTime - previousTime < 1200) {
    session.actions[session.actions.length - 1] = action;
    return;
  }
  session.actions.push(action);
}

function recordNavigation(session, url) {
  if (activeSession !== session || session.mode !== 'recording' || !url) {
    return;
  }

  if (!session.recordingReady) {
    session.currentUrl = url;
    return;
  }

  if (url === session.currentUrl) {
    return;
  }

  session.actions.push({ type: 'navigate', url, label: url });
  session.currentUrl = url;
}

function handleRecorderMessage(session, message) {
  let payload;
  try {
    payload = JSON.parse(message.toString());
  } catch {
    return;
  }

  if (payload.method === 'Runtime.bindingCalled'
    && payload.params?.name === recorderBindingName) {
    if (!session.recordingReady) {
      return;
    }
    try {
      appendRecordedEvent(session, JSON.parse(payload.params.payload));
    } catch (error) {
      session.error = error.message;
    }
    return;
  }

  if (payload.method === 'Page.frameNavigated') {
    const frame = payload.params?.frame;
    if (!frame || frame.parentId) {
      return;
    }
    session.mainFrameId ||= frame.id;
    if (frame.id === session.mainFrameId) {
      recordNavigation(session, frame.url);
    }
  } else if (payload.method === 'Page.navigatedWithinDocument') {
    const frameId = payload.params?.frameId;
    if (!session.mainFrameId) {
      session.mainFrameId = frameId;
    }
    if (frameId === session.mainFrameId) {
      recordNavigation(session, payload.params?.url);
    }
  }
}

async function sendCdpCommand(connection, method, params = {}) {
  const response = await connection.send(method, params);
  if (response.error) {
    throw new Error(response.error.message || `CDP command failed: ${method}`);
  }
  return response.result;
}

async function startEventRecorder(session) {
  const connection = await session.driver.createCDPConnection('page');
  const socket = connection._wsConnection;
  if (!socket || typeof socket.on !== 'function') {
    throw new Error('The browser did not expose a Chrome DevTools event connection.');
  }

  const messageListener = (message) => handleRecorderMessage(session, message);
  session.cdpConnection = connection;
  session.cdpSocket = socket;
  session.cdpMessageListener = messageListener;
  socket.on('message', messageListener);

  try {
    await sendCdpCommand(connection, 'Runtime.enable');
    await sendCdpCommand(connection, 'Page.enable');
    await sendCdpCommand(connection, 'Runtime.addBinding', { name: recorderBindingName });
    await sendCdpCommand(connection, 'Page.addScriptToEvaluateOnNewDocument', { source: recorderScript });
    await sendCdpCommand(connection, 'Runtime.evaluate', { expression: recorderScript });
  } catch (error) {
    stopEventRecorder(session);
    throw error;
  }
}

function stopEventRecorder(session) {
  session.recordingReady = false;
  if (session.cdpSocket && session.cdpMessageListener) {
    session.cdpSocket.removeListener('message', session.cdpMessageListener);
  }
  session.cdpConnection = null;
  session.cdpSocket = null;
  session.cdpMessageListener = null;
}

async function closeActiveBrowser() {
  const session = activeSession;
  if (!session) {
    return;
  }

  stopEventRecorder(session);
  activeSession = null;
  try {
    await session.driver.quit();
  } catch {
    // The browser may already have been closed by the user.
  }
}

function selectorTarget(selector) {
  return By.css(selector);
}

async function findTarget(driver, selector) {
  return driver.wait(until.elementLocated(selectorTarget(selector)), 10000);
}

function seleniumKey(key) {
  return { Enter: Key.ENTER, Tab: Key.TAB, Escape: Key.ESCAPE }[key] || key;
}

async function playAction(driver, action) {
  if (action.type === 'navigate') {
    await driver.get(safeUrl(action.url));
    return;
  }

  const element = await findTarget(driver, action.selector);
  if (action.type === 'click') {
    await driver.wait(until.elementIsVisible(element), 5000);
    await element.click();
  } else if (action.type === 'input') {
    await element.clear();
    await element.sendKeys(action.value || '');
  } else if (action.type === 'change') {
    await element.click();
    await element.sendKeys(action.value || '');
  } else if (action.type === 'key') {
    await element.sendKeys(seleniumKey(action.key));
  }
}

async function playRecording(session) {
  try {
    await session.driver.get(session.initialUrl);
    for (let index = 0; index < session.actions.length; index += 1) {
      if (activeSession !== session || session.mode !== 'playing') {
        return;
      }
      session.activeIndex = index;
      await playAction(session.driver, session.actions[index]);
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    session.activeIndex = session.actions.length;
    session.mode = 'played';
  } catch (error) {
    session.error = error.message;
    session.mode = 'error';
  }
}

function pythonString(value) {
  return JSON.stringify(String(value ?? ''));
}

function generatePythonScript(recording) {
  const browser = recording.browser === 'edge' ? 'webdriver.Edge()' : 'webdriver.Chrome()';
  const lines = [
    'from selenium import webdriver',
    'from selenium.webdriver.common.by import By',
    'from selenium.webdriver.common.keys import Keys',
    'from selenium.webdriver.support import expected_conditions as EC',
    'from selenium.webdriver.support.ui import WebDriverWait',
    '',
    `driver = ${browser}`,
    `driver.get(${pythonString(recording.initialUrl)})`,
    ''
  ];

  recording.actions.forEach((action) => {
    if (action.type === 'navigate') {
      lines.push(`driver.get(${pythonString(action.url)})`);
    } else if (action.type === 'click') {
      lines.push(`WebDriverWait(driver, 10).until(EC.element_to_be_clickable((By.CSS_SELECTOR, ${pythonString(action.selector)}))).click()`);
    } else if (action.type === 'input') {
      lines.push(`element = WebDriverWait(driver, 10).until(EC.visibility_of_element_located((By.CSS_SELECTOR, ${pythonString(action.selector)})))`);
      lines.push('element.clear()');
      lines.push(`element.send_keys(${pythonString(action.value || '')})`);
    } else if (action.type === 'change') {
      lines.push(`element = WebDriverWait(driver, 10).until(EC.visibility_of_element_located((By.CSS_SELECTOR, ${pythonString(action.selector)})))`);
      lines.push(`element.send_keys(${pythonString(action.value || '')})`);
    } else if (action.type === 'key') {
      const key = action.key === 'Enter' ? 'ENTER' : action.key === 'Tab' ? 'TAB' : 'ESCAPE';
      lines.push(`WebDriverWait(driver, 10).until(EC.presence_of_element_located((By.CSS_SELECTOR, ${pythonString(action.selector)}))).send_keys(Keys.${key})`);
    }
    lines.push('');
  });

  lines.push('driver.quit()');
  return lines.join('\n');
}

app.get('/api/state', (_request, response) => {
  response.json(serializeState());
});

app.post('/api/record/start', async (request, response) => {
  let driver = null;
  let session = null;
  try {
    const url = safeUrl(request.body?.url);
    const browser = browserName(request.body?.browser);
    await closeActiveBrowser();

    driver = await buildDriver(browser);
    session = {
      mode: 'recording',
      browser,
      driver,
      initialUrl: url,
      currentUrl: url,
      actions: [],
      startedAt: new Date().toISOString(),
      activeIndex: -1,
      error: '',
      recordingReady: false,
      mainFrameId: null,
      cdpConnection: null,
      cdpSocket: null,
      cdpMessageListener: null
    };
    activeSession = session;

    await startEventRecorder(session);
    await driver.get(url);
    session.currentUrl = await driver.getCurrentUrl();
    session.recordingReady = true;

    response.json(serializeState());
  } catch (error) {
    if (activeSession === session) {
      await closeActiveBrowser();
    } else if (driver) {
      try {
        await driver.quit();
      } catch {
        // The browser may already have been closed by the user.
      }
    }
    response.status(400).json({ error: error.message });
  }
});

app.post('/api/record/stop', async (_request, response) => {
  if (!activeSession || activeSession.mode !== 'recording') {
    response.status(409).json({ error: 'There is no active recording.' });
    return;
  }

  const session = activeSession;
  savedRecording = {
    initialUrl: session.initialUrl,
    browser: session.browser,
    actions: session.actions,
    createdAt: session.startedAt
  };
  await closeActiveBrowser();
  response.json(serializeState());
});

app.post('/api/playback/start', async (_request, response) => {
  if (!savedRecording) {
    response.status(409).json({ error: 'Record a workflow before playing it back.' });
    return;
  }

  try {
    await closeActiveBrowser();
    const driver = await buildDriver(savedRecording.browser);
    const session = {
      mode: 'playing',
      browser: savedRecording.browser,
      driver,
      initialUrl: savedRecording.initialUrl,
      currentUrl: savedRecording.initialUrl,
      actions: savedRecording.actions,
      startedAt: savedRecording.createdAt,
      activeIndex: -1,
      error: ''
    };
    activeSession = session;
    response.json(serializeState());
    playRecording(session);
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.post('/api/browser/close', async (_request, response) => {
  await closeActiveBrowser();
  response.json(serializeState());
});

app.post('/api/session/clear', async (_request, response) => {
  await closeActiveBrowser();
  savedRecording = null;
  response.json(serializeState());
});

const server = app.listen(port, () => {
  console.log(`Selenium Studio is running at http://localhost:${port}`);
});

let shutdownPromise = null;

async function shutdown(signal) {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    console.log(`Received ${signal}; closing Selenium Studio.`);
    await closeActiveBrowser();
    await new Promise((resolve) => server.close(resolve));
  })();

  return shutdownPromise;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    shutdown(signal)
      .then(() => process.exit(0))
      .catch((error) => {
        console.error('Selenium Studio shutdown failed:', error);
        process.exit(1);
      });
  });
}
