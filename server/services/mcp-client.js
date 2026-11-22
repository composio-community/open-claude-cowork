import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { enforceClickUpScope } from './clickup-scope.js';

const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Sanitize a JSON Schema object into a Gemini-compatible function parameter schema.
 * Strips unsupported JSON Schema keywords and normalizes nullable union types.
 *
 * @param {Object} schema
 * @returns {Object|undefined}
 */
export function sanitizeSchemaForGemini(schema) {
  if (!schema || typeof schema !== 'object') {
    return undefined;
  }

  const out = {};

  if (Array.isArray(schema.type)) {
    const nonNullTypes = schema.type.filter((t) => t !== 'null');
    out.type = (nonNullTypes[0] || 'string').toUpperCase();
    if (schema.type.includes('null')) {
      out.nullable = true;
    }
  } else if (typeof schema.type === 'string') {
    out.type = schema.type.toUpperCase();
  }

  if (typeof schema.description === 'string' && schema.description.trim()) {
    out.description = schema.description.trim();
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    out.enum = schema.enum.filter((v) => v !== null && v !== undefined).map(String);
  }

  if (schema.properties && typeof schema.properties === 'object') {
    const props = {};
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      const sanitizedProp = sanitizeSchemaForGemini(propSchema);
      if (sanitizedProp) {
        props[key] = sanitizedProp;
      }
    }
    if (Object.keys(props).length > 0) {
      out.properties = props;
    }
  }

  if (Array.isArray(schema.required) && schema.required.length > 0 && out.properties) {
    const validRequired = schema.required.filter((req) => Object.prototype.hasOwnProperty.call(out.properties, req));
    if (validRequired.length > 0) {
      out.required = validRequired;
    }
  }

  if (schema.items && typeof schema.items === 'object') {
    const sanitizedItems = sanitizeSchemaForGemini(schema.items);
    if (sanitizedItems) {
      out.items = sanitizedItems;
    }
  }

  if (!out.type) {
    if (out.properties) out.type = 'OBJECT';
    else if (out.items) out.type = 'ARRAY';
    else out.type = 'STRING';
  }

  // Gemini rejects OBJECT schemas with no properties
  if (out.type === 'OBJECT' && (!out.properties || Object.keys(out.properties).length === 0)) {
    return undefined;
  }

  return out;
}

/**
 * Parse an HTTP MCP response which may be application/json or text/event-stream (SSE).
 *
 * @param {Response} response
 * @param {number|string} expectedId
 * @returns {Promise<Object>}
 */
async function parseMcpHttpResponse(response, expectedId) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();

  if (contentType.includes('text/event-stream')) {
    const text = await response.text();
    const messages = [];
    let currentData = [];

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (line.startsWith('data:')) {
        currentData.push(line.slice(5).trim());
      } else if (line === '' && currentData.length > 0) {
        const joined = currentData.join('\n').trim();
        currentData = [];
        if (joined && joined !== '[DONE]') {
          try {
            messages.push(JSON.parse(joined));
          } catch {
            // Ignore malformed SSE chunk
          }
        }
      }
    }

    if (currentData.length > 0) {
      const joined = currentData.join('\n').trim();
      if (joined && joined !== '[DONE]') {
        try {
          messages.push(JSON.parse(joined));
        } catch {
          // Ignore malformed trailing SSE chunk
        }
      }
    }

    const matching = messages.find((m) => m && m.id === expectedId);
    return matching || messages[messages.length - 1] || {};
  }

  const rawText = await response.text();
  if (!rawText.trim()) {
    return {};
  }
  return JSON.parse(rawText);
}

/**
 * Lightweight client for a single HTTP (Streamable HTTP) MCP server.
 */
class HttpMcpConnection {
  constructor(name, config) {
    this.name = name;
    this.url = config.url;
    this.headers = config.headers || {};
    this.sessionId = null;
    this.initialized = false;
    this.nextId = 1;
  }

  async rpc(method, params = {}, signal = undefined, isNotification = false) {
    const id = isNotification ? undefined : this.nextId++;
    const payload = {
      jsonrpc: '2.0',
      ...(id !== undefined ? { id } : {}),
      method,
      params
    };

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...this.headers
    };

    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }

    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), DEFAULT_TIMEOUT_MS);
    const onExternalAbort = () => timeoutController.abort();
    if (signal) {
      if (signal.aborted) timeoutController.abort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: timeoutController.signal
      });

      const returnedSessionId = response.headers.get('mcp-session-id');
      if (returnedSessionId) {
        this.sessionId = returnedSessionId;
      }

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} ${response.statusText}${errBody ? `: ${errBody.slice(0, 200)}` : ''}`);
      }

      if (isNotification) {
        return null;
      }

      const data = await parseMcpHttpResponse(response, id);
      if (data.error) {
        throw new Error(data.error.message || JSON.stringify(data.error));
      }
      return data.result ?? data;
    } finally {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  async ensureInitialized(signal) {
    if (this.initialized) return;

    await this.rpc(
      'initialize',
      {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'open-claude-cowork', version: '1.0.0' }
      },
      signal
    );

    // Best-effort initialized notification (some servers return 202/204)
    await this.rpc('notifications/initialized', {}, signal, true).catch(() => {});
    this.initialized = true;
  }

  async listTools(signal) {
    await this.ensureInitialized(signal);
    const tools = [];
    let cursor = undefined;

    do {
      const result = await this.rpc('tools/list', cursor ? { cursor } : {}, signal);
      if (Array.isArray(result?.tools)) {
        tools.push(...result.tools);
      }
      cursor = result?.nextCursor;
    } while (cursor);

    return tools;
  }

  async callTool(toolName, args = {}, signal) {
    await this.ensureInitialized(signal);
    return this.rpc('tools/call', { name: toolName, arguments: args }, signal);
  }
}

/**
 * Execute a single JSON-RPC call sequence against a local stdio MCP server.
 */
async function callStdioMcp(serverConfig, method, params = {}, signal = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn(serverConfig.command, serverConfig.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(serverConfig.env || {}) },
      ...(serverConfig.shell ? { shell: true } : {})
    });

    const rl = readline.createInterface({ input: child.stdout, terminal: false });
    let settled = false;
    let step = 'init';

    const cleanup = () => {
      rl.close();
      if (!child.killed) {
        child.kill();
      }
    };

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`Stdio MCP timeout executing ${method}`));
      }
    }, DEFAULT_TIMEOUT_MS);

    const onAbort = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(new Error('Stdio MCP aborted'));
      }
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        cleanup();
        reject(err);
      }
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }

      if (step === 'init' && msg.id === 1) {
        if (msg.error) {
          settled = true;
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
          cleanup();
          reject(new Error(msg.error.message || 'Stdio MCP initialize failed'));
          return;
        }
        step = 'call';
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }) + '\n');
      } else if (step === 'call' && msg.id === 2) {
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        cleanup();
        if (msg.error) {
          reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          resolve(msg.result ?? msg);
        }
      }
    });

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'open-claude-cowork', version: '1.0.0' }
      }
    }) + '\n');
  });
}

/**
 * Build a safe Gemini function declaration name (<= 64 chars, valid identifier characters).
 */
function buildDeclarationName(serverName, toolName, usedNames) {
  const base = `mcp__${serverName}__${toolName}`.replace(/[^a-zA-Z0-9_.:-]/g, '_');
  let candidate = base.slice(0, 64);
  let counter = 1;
  while (usedNames.has(candidate)) {
    const suffix = `_${counter++}`;
    candidate = base.slice(0, 64 - suffix.length) + suffix;
  }
  usedNames.add(candidate);
  return candidate;
}

/**
 * Discover tools from all configured MCP servers and prepare Gemini functionDeclarations + executor.
 *
 * @param {Object} mcpServers - Map of serverName -> serverConfig from server.js
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ functionDeclarations: Array<Object>, callTool: Function, summary: Object }>}
 */
export async function createMcpToolRegistry(mcpServers = {}, options = {}) {
  const { signal } = options;
  const functionDeclarations = [];
  const toolHandlers = new Map();
  const usedNames = new Set();
  const summary = {};

  for (const [serverName, config] of Object.entries(mcpServers || {})) {
    if (!config) continue;

    try {
      if (config.type === 'http' && config.url) {
        const conn = new HttpMcpConnection(serverName, config);
        const tools = await conn.listTools(signal);
        summary[serverName] = { ok: true, count: tools.length };

        for (const tool of tools) {
          if (!tool?.name) continue;
          const declName = buildDeclarationName(serverName, tool.name, usedNames);
          const parameters = sanitizeSchemaForGemini(tool.inputSchema);

          functionDeclarations.push({
            name: declName,
            description: (tool.description || `${serverName} tool ${tool.name}`).slice(0, 1024),
            ...(parameters ? { parameters } : {})
          });

          toolHandlers.set(declName, async (args, callSignal) => {
            if (serverName === 'clickup') {
              enforceClickUpScope(tool.name, args);
            }
            return conn.callTool(tool.name, args, callSignal);
          });
        }
      } else if (config.type === 'stdio' && config.command) {
        const result = await callStdioMcp(config, 'tools/list', {}, signal);
        const tools = Array.isArray(result?.tools) ? result.tools : [];
        summary[serverName] = { ok: true, count: tools.length };

        for (const tool of tools) {
          if (!tool?.name) continue;
          const declName = buildDeclarationName(serverName, tool.name, usedNames);
          const parameters = sanitizeSchemaForGemini(tool.inputSchema);

          functionDeclarations.push({
            name: declName,
            description: (tool.description || `${serverName} tool ${tool.name}`).slice(0, 1024),
            ...(parameters ? { parameters } : {})
          });

          toolHandlers.set(declName, async (args, callSignal) => {
            return callStdioMcp(config, 'tools/call', { name: tool.name, arguments: args }, callSignal);
          });
        }
      }
    } catch (err) {
      summary[serverName] = { ok: false, error: err.message };
      console.warn(`[MCP:${serverName}] Failed to load tools: ${err.message}`);
    }
  }

  async function callTool(declarationName, args = {}, callSignal = undefined) {
    const handler = toolHandlers.get(declarationName);
    if (!handler) {
      throw new Error(`Unknown MCP tool: ${declarationName}`);
    }
    return handler(args, callSignal);
  }

  return {
    functionDeclarations,
    callTool,
    summary
  };
}
