import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { GeminiProvider } from '../server/providers/gemini-provider.js';
import { getAvailableProviders, getProvider } from '../server/providers/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function createMockElement(tag = 'div') {
  const listeners = new Map();
  const classes = new Set();
  const attributes = new Map();
  let innerHtmlValue = '';

  const el = {
    tagName: tag.toUpperCase(),
    dataset: {},
    style: {},
    value: '',
    textContent: '',
    scrollHeight: 20,
    scrollTop: 0,
    children: [],
    className: '',
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      toggle: (name, force) => {
        if (force === undefined) {
          if (classes.has(name)) classes.delete(name);
          else classes.add(name);
        } else if (force) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
      },
      contains: (name) => classes.has(name)
    },
    setAttribute: (k, v) => attributes.set(k, String(v)),
    getAttribute: (k) => attributes.get(k) ?? null,
    addEventListener: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    dispatchEvent: async (eventObj) => {
      const fns = listeners.get(eventObj.type) || [];
      for (const fn of fns) {
        await fn(eventObj);
      }
    },
    focus: () => {},
    click: () => {},
    appendChild: (child) => {
      el.children.push(child);
      return child;
    },
    insertBefore: (child) => {
      el.children.unshift(child);
      return child;
    },
    closest: () => null,
    querySelector: (sel) => {
      if (!sel || !sel.startsWith('.')) return null;
      const cls = sel.slice(1);
      const queue = [...el.children];
      while (queue.length > 0) {
        const node = queue.shift();
        const nodeClasses = (node.className || '').split(/\s+/).filter(Boolean);
        if (nodeClasses.includes(cls) || node.classList?.contains(cls)) {
          return node;
        }
        if (Array.isArray(node.children)) {
          queue.push(...node.children);
        }
      }
      return null;
    },
    querySelectorAll: () => [],
    get innerHTML() {
      return innerHtmlValue;
    },
    set innerHTML(val) {
      innerHtmlValue = String(val);
    }
  };

  return el;
}

function loadRendererWithDom() {
  const rendererPath = path.join(repoRoot, 'renderer', 'renderer.js');
  const code = fs.readFileSync(rendererPath, 'utf8');

  const modelMenuHtmlByMenu = [];
  const modelMenus = [createMockElement('div'), createMockElement('div')];
  const modelLabels = [createMockElement('span'), createMockElement('span')];
  const providerLabels = [createMockElement('span'), createMockElement('span')];

  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k)
  };

  const sentRequests = [];
  const homeInput = createMockElement('textarea');
  const homeSendBtn = createMockElement('button');
  const messageInput = createMockElement('textarea');
  const chatSendBtn = createMockElement('button');
  const homeForm = createMockElement('form');
  const chatForm = createMockElement('form');
  const chatMessages = createMockElement('div');
  const homeView = createMockElement('div');
  const chatView = createMockElement('div');
  const chatTitle = createMockElement('span');

  const elementsById = new Map([
    ['homeView', homeView],
    ['chatView', chatView],
    ['homeForm', homeForm],
    ['homeInput', homeInput],
    ['homeSendBtn', homeSendBtn],
    ['chatForm', chatForm],
    ['messageInput', messageInput],
    ['chatSendBtn', chatSendBtn],
    ['chatMessages', chatMessages],
    ['chatTitle', chatTitle],
    ['sidebar', createMockElement('aside')],
    ['sidebarToggle', createMockElement('button')],
    ['rightSidebarExpand', createMockElement('button')],
    ['stepsList', createMockElement('div')],
    ['stepsCount', createMockElement('span')],
    ['toolCallsList', createMockElement('div')],
    ['emptySteps', createMockElement('div')],
    ['emptyTools', createMockElement('div')],
    ['chatHistoryList', createMockElement('div')],
    ['leftSidebar', createMockElement('aside')],
    ['leftSidebarToggle', createMockElement('button')],
    ['leftSidebarExpand', createMockElement('button')],
    ['homeAttachBtn', createMockElement('button')],
    ['chatAttachBtn', createMockElement('button')],
    ['homeFileInput', createMockElement('input')],
    ['chatFileInput', createMockElement('input')]
  ]);

  // Build model dropdowns with real click delegation support
  const modelDropdownListeners = new Map();
  const parsedModelItems = () => {
    const html = modelMenus[0].innerHTML;
    const itemRegex = /<div class="dropdown-item([^"]*)" data-value="([^"]+)">[\s\S]*?<span class="item-label">([^<]+)<\/span>([\s\S]*?)<span class="item-desc">([^<]*)<\/span>/g;
    const items = [];
    let match;
    while ((match = itemRegex.exec(html)) !== null) {
      const hasSelected = match[1].includes('selected');
      const value = match[2];
      const label = match[3];
      const hasCheckIcon = match[4].includes('check-icon');
      const itemEl = createMockElement('div');
      itemEl.dataset.value = value;
      if (hasSelected) itemEl.classList.add('selected');
      const checkEl = hasCheckIcon ? createMockElement('svg') : null;
      const labelEl = createMockElement('span');
      labelEl.textContent = label;
      itemEl.querySelector = (sel) => {
        if (sel === '.item-label') return labelEl;
        if (sel === '.check-icon') return checkEl;
        return null;
      };
      items.push(itemEl);
    }
    return items;
  };

  for (const menu of modelMenus) {
    const origDescriptor = Object.getOwnPropertyDescriptor(menu, 'innerHTML');
    Object.defineProperty(menu, 'innerHTML', {
      get: () => origDescriptor.get.call(menu),
      set: (val) => {
        origDescriptor.set.call(menu, val);
        modelMenuHtmlByMenu.push(String(val));
      }
    });
  }

  const homeModelDropdown = createMockElement('div');
  homeModelDropdown.querySelector = (sel) => {
    if (sel === '.model-selector') return createMockElement('button');
    if (sel === '.model-menu') {
      return {
        addEventListener: (ev, fn) => modelDropdownListeners.set(ev, fn)
      };
    }
    return null;
  };
  elementsById.set('homeModelDropdown', homeModelDropdown);

  const documentObj = {
    documentElement: createMockElement('html'),
    body: createMockElement('body'),
    getElementById: (id) => elementsById.get(id) || null,
    createElement: (tag) => createMockElement(tag),
    createElementNS: (_ns, tag) => createMockElement(tag),
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (selector === '.model-menu') return modelMenus;
      if (selector === '.model-selector .model-label') return modelLabels;
      if (selector === '.provider-selector .provider-label') return providerLabels;
      if (selector === '.model-menu .dropdown-item') return parsedModelItems();
      return [];
    }
  };

  const windowObj = {
    electronAPI: {
      sendMessage: async (message, chatId, provider, model) => {
        sentRequests.push({ message, chatId, provider, model });
        let readCount = 0;
        return {
          getReader: async () => ({
            read: async () => {
              if (readCount === 0) {
                readCount++;
                return { done: false, value: 'data: {"type":"done"}\n\n' };
              }
              return { done: true, value: undefined };
            }
          })
        };
      },
      getSkills: async () => ({ skills: [] }),
      getMcpStatus: async () => null
    },
    addEventListener: () => {},
    matchMedia: null
  };

  const context = vm.createContext({
    window: windowObj,
    document: documentObj,
    localStorage,
    console,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    Map,
    Set,
    Array,
    Promise,
    Error,
    marked: { setOptions: () => {}, parse: (x) => x }
  });

  // Expose top-level `let`/`const` bindings cleanly onto context via helper eval
  vm.runInContext(code, context, { filename: 'renderer/renderer.js' });
  vm.runInContext('setupDropdowns();', context);

  return {
    context,
    localStorage,
    modelMenus,
    modelLabels,
    sentRequests,
    homeInput,
    parsedModelItems,
    clickModelOption: (value) => {
      const clickHandler = modelDropdownListeners.get('click');
      assert.ok(clickHandler, 'model menu click listener should be registered');
      const items = parsedModelItems();
      const targetItem = items.find((i) => i.dataset.value === value);
      assert.ok(targetItem, `model dropdown item "${value}" should exist`);
      clickHandler({
        target: {
          closest: (sel) => (sel === '.dropdown-item' ? targetItem : null)
        }
      });
    }
  };
}

describe('Gemini model configuration and selection flow', () => {
  it('exposes gemini-4-argon in renderer providerModels while keeping gemini-3.8-flash as default', () => {
    const { context, modelMenus, modelLabels, parsedModelItems } = loadRendererWithDom();

    const geminiModels = vm.runInContext('providerModels.gemini', context);
    assert.ok(Array.isArray(geminiModels), 'providerModels.gemini must be an array');

    const values = geminiModels.map((m) => m.value);
    assert.ok(values.includes('gemini-3.8-flash'), 'gemini-3.8-flash must remain available');
    assert.ok(values.includes('gemini-4-argon'), 'gemini-4-argon must be available');
    assert.ok(values.includes('gemini-2.5-flash'), 'existing gemini-2.5-flash must remain available');
    assert.ok(values.includes('gemini-2.5-pro'), 'existing gemini-2.5-pro must remain available');

    const defaultModels = geminiModels.filter((m) => m.default);
    assert.equal(defaultModels.length, 1, 'exactly one Gemini model should be marked default');
    assert.equal(defaultModels[0].value, 'gemini-3.8-flash');

    // Switch dropdowns to Gemini provider and verify default selection & rendered items
    vm.runInContext("selectedProvider = 'gemini'; updateModelDropdowns('gemini');", context);

    assert.equal(vm.runInContext('selectedModel', context), 'gemini-3.8-flash');
    assert.equal(modelLabels[0].textContent, 'Gemini 3.8 Flash');

    const renderedValues = parsedModelItems().map((item) => item.dataset.value);
    assert.deepEqual(renderedValues, [
      'gemini-3.8-flash',
      'gemini-4-argon',
      'gemini-2.5-flash',
      'gemini-2.5-pro'
    ]);
    assert.ok(modelMenus[0].innerHTML.includes('data-value="gemini-4-argon"'));
  });

  it('propagates selected gemini-4-argon from UI selection to sendMessage payload', async () => {
    const { context, localStorage, modelLabels, sentRequests, homeInput, clickModelOption } = loadRendererWithDom();

    vm.runInContext("selectedProvider = 'gemini'; updateModelDropdowns('gemini');", context);
    assert.equal(vm.runInContext('selectedModel', context), 'gemini-3.8-flash');

    // Select gemini-4-argon from the rendered model dropdown
    clickModelOption('gemini-4-argon');

    assert.equal(vm.runInContext('selectedModel', context), 'gemini-4-argon');
    assert.equal(modelLabels[0].textContent, 'Gemini 4 Argon');
    assert.equal(localStorage.getItem('selectedModel'), 'gemini-4-argon');

    // Submit a prompt and verify selectedProvider + selectedModel are forwarded
    homeInput.value = 'Hola Gemini 4 Argon';
    await vm.runInContext('handleSendMessage({ preventDefault: () => {} })', context);

    assert.equal(sentRequests.length, 1);
    assert.equal(sentRequests[0].provider, 'gemini');
    assert.equal(sentRequests[0].model, 'gemini-4-argon');
    assert.equal(sentRequests[0].message, 'Hola Gemini 4 Argon');
    // Switch back to claude and back to gemini: default must remain gemini-3.8-flash
    vm.runInContext("selectedProvider = 'claude'; updateModelDropdowns('claude');", context);
    assert.equal(vm.runInContext('selectedModel', context), 'claude-sonnet-4-5-20250514');
    vm.runInContext("selectedProvider = 'gemini'; updateModelDropdowns('gemini');", context);
    assert.equal(vm.runInContext('selectedModel', context), 'gemini-3.8-flash');
    assert.equal(modelLabels[0].textContent, 'Gemini 3.8 Flash');

    // Selecting existing non-default Gemini models continues to work
    clickModelOption('gemini-2.5-flash');
    assert.equal(vm.runInContext('selectedModel', context), 'gemini-2.5-flash');
    clickModelOption('gemini-2.5-pro');
    assert.equal(vm.runInContext('selectedModel', context), 'gemini-2.5-pro');
  });

  it('registers gemini in provider registry with gemini-3.8-flash default and handles errors cleanly', async () => {
    const providers = getAvailableProviders();
    assert.ok(providers.includes('gemini'));
    const registryGemini = getProvider('gemini');
    assert.equal(registryGemini.defaultModel, 'gemini-3.8-flash');

    const originalEnvKey = process.env.GEMINI_API_KEY;
    const originalFetch = globalThis.fetch;
    try {
      process.env.GEMINI_API_KEY = 'your-gemini-api-key-here';
      const unconfigured = new GeminiProvider();
      await assert.rejects(
        async () => {
          for await (const _chunk of unconfigured.query({ prompt: 'Hi', chatId: 'err-key', model: 'gemini-4-argon' })) {
            // should throw before yield? Wait: session_init is yielded only after key check
          }
        },
        /GEMINI_API_KEY/
      );

      process.env.GEMINI_API_KEY = 'test-gemini-api-key';
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: { message: 'Model quota exceeded' } }), {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'Content-Type': 'application/json' }
        });

      const provider = new GeminiProvider();
      await assert.rejects(
        async () => {
          for await (const _chunk of provider.query({ prompt: 'Hi', chatId: 'err-http', model: 'gemini-4-argon' })) {
            // consume
          }
        },
        /\[Gemini API Error\] Model quota exceeded/
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalEnvKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalEnvKey;
    }
  });

  it('keeps Gemini provider option in renderer/index.html mentioning gemini-3.8-flash as default', () => {
    const indexHtml = fs.readFileSync(path.join(repoRoot, 'renderer', 'index.html'), 'utf8');
    const matches = indexHtml.match(/data-value="gemini"/g) || [];
    assert.equal(matches.length, 2, 'home and chat provider dropdowns must both expose Gemini');
    assert.match(indexHtml, /Google Gemini \(gemini-3\.8-flash\)/);
  });

  it('GeminiProvider defaults to gemini-3.8-flash and routes gemini-4-argon to the Gemini API endpoint', async () => {
    const originalFetch = globalThis.fetch;
    const originalEnvKey = process.env.GEMINI_API_KEY;
    const originalEnvModel = process.env.GEMINI_MODEL;

    delete process.env.GEMINI_MODEL;
    process.env.GEMINI_API_KEY = 'test-gemini-api-key';

    const fetchCalls = [];
    globalThis.fetch = async (url, options) => {
      fetchCalls.push({ url, options });
      const ssePayload = 'data: {"candidates":[{"content":{"parts":[{"text":"Respuesta de prueba"}]}}]}\n\ndata: [DONE]\n\n';
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(ssePayload));
          controller.close();
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    };

    try {
      const provider = new GeminiProvider();
      assert.equal(provider.name, 'gemini');
      assert.equal(provider.defaultModel, 'gemini-3.8-flash');

      // 1. Default model when model is omitted/null/empty
      const defaultChunks = [];
      for await (const chunk of provider.query({ prompt: 'Hola', chatId: 'chat-default', model: null })) {
        defaultChunks.push(chunk);
      }
      assert.equal(
        fetchCalls[0].url,
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse'
      );
      assert.ok(defaultChunks.some((c) => c.type === 'text' && c.content === 'Respuesta de prueba'));
      assert.ok(defaultChunks.some((c) => c.type === 'done'));

      const emptyModelChunks = [];
      for await (const chunk of provider.query({ prompt: 'Hola vacio', chatId: 'chat-empty', model: '' })) {
        emptyModelChunks.push(chunk);
      }
      assert.equal(
        fetchCalls[1].url,
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse'
      );

      // 2. Explicit gemini-4-argon model
      const argonChunks = [];
      for await (const chunk of provider.query({ prompt: 'Hola Argon', chatId: 'chat-argon', model: 'gemini-4-argon' })) {
        argonChunks.push(chunk);
      }
      assert.equal(
        fetchCalls[2].url,
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse'
      );
      assert.equal(fetchCalls[2].options.headers['x-goog-api-key'], 'test-gemini-api-key');
      assert.ok(argonChunks.some((c) => c.type === 'session_init' && c.provider === 'gemini'));
      assert.ok(argonChunks.some((c) => c.type === 'text' && c.content === 'Respuesta de prueba'));
      assert.ok(argonChunks.some((c) => c.type === 'done' && c.provider === 'gemini'));

      // 3. Prefixed models/gemini-4-argon normalizes cleanly
      for await (const _chunk of provider.query({ prompt: 'Hola prefijo', chatId: 'chat-prefix', model: 'models/gemini-4-argon' })) {
        // consume stream
      }
      assert.equal(
        fetchCalls[3].url,
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse'
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalEnvKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalEnvKey;
      if (originalEnvModel === undefined) delete process.env.GEMINI_MODEL;
      else process.env.GEMINI_MODEL = originalEnvModel;
    }
  });
});
