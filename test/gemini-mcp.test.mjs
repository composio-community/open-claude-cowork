import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSchemaForGemini, createMcpToolRegistry } from '../server/services/mcp-client.js';
import { GeminiProvider } from '../server/providers/gemini-provider.js';

function sseResponse(events) {
  const bodyText = events.map((ev) => `data: ${JSON.stringify(ev)}\n\n`).join('');
  return new Response(bodyText, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}

test('sanitizeSchemaForGemini strips unsupported keywords and normalizes nullable types', () => {
  const input = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: ['string', 'null'], description: 'Search text' },
      limit: { type: 'integer', default: 10 },
      emptyObj: { type: 'object', properties: {} }
    },
    required: ['query', 'nonexistent']
  };

  const sanitized = sanitizeSchemaForGemini(input);
  assert.equal(sanitized.type, 'OBJECT');
  assert.equal(sanitized.$schema, undefined);
  assert.equal(sanitized.additionalProperties, undefined);
  assert.deepEqual(sanitized.required, ['query']);
  assert.deepEqual(sanitized.properties.query, {
    type: 'STRING',
    nullable: true,
    description: 'Search text'
  });
  assert.deepEqual(sanitized.properties.limit, { type: 'INTEGER' });
  assert.equal(sanitized.properties.emptyObj, undefined);
});

test('createMcpToolRegistry discovers HTTP MCP tools over SSE and executes tools/call', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });

    if (body.method === 'initialize') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-123' }
      });
    }
    if (body.method === 'notifications/initialized') {
      return new Response('', { status: 202 });
    }
    if (body.method === 'tools/list') {
      return sseResponse([
        {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [
              {
                name: 'get_tasks',
                description: 'List ClickUp tasks',
                inputSchema: {
                  type: 'object',
                  properties: { list_id: { type: 'string' } },
                  required: ['list_id']
                }
              }
            ]
          }
        }
      ]);
    }
    if (body.method === 'tools/call') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: 'Task 1: Fix MCP' }] }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected RPC method: ${body.method}`);
  };

  try {
    const registry = await createMcpToolRegistry({
      clickup: {
        type: 'http',
        url: 'https://mcp.clickup.com/mcp',
        headers: { Authorization: 'Bearer test-token' }
      }
    });

    assert.equal(registry.summary.clickup.ok, true);
    assert.equal(registry.summary.clickup.count, 1);
    assert.equal(registry.functionDeclarations.length, 1);
    assert.equal(registry.functionDeclarations[0].name, 'mcp__clickup__get_tasks');

    const result = await registry.callTool('mcp__clickup__get_tasks', { list_id: '48494459' });
    assert.equal(result.content[0].text, 'Task 1: Fix MCP');

    const toolCallReq = calls.find((c) => c.body.method === 'tools/call');
    assert.equal(toolCallReq.headers.Authorization, 'Bearer test-token');
    assert.equal(toolCallReq.headers['Mcp-Session-Id'], 'sess-123');
    assert.deepEqual(toolCallReq.body.params, { name: 'get_tasks', arguments: { list_id: '48494459' } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GeminiProvider.query executes MCP functionCall loop and yields tool_use, tool_result, and final text', async () => {
  const originalFetch = globalThis.fetch;
  const geminiPayloads = [];
  let geminiTurn = 0;

  globalThis.fetch = async (url, init) => {
    if (url === 'https://mcp.clickup.com/mcp') {
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (body.method === 'notifications/initialized') {
        return new Response('', { status: 202 });
      }
      if (body.method === 'tools/list') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [{ name: 'search_tasks', description: 'Search tasks', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }]
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (body.method === 'tools/call') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text: 'Found task #42' }] }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }

    if (String(url).includes('streamGenerateContent')) {
      const payload = JSON.parse(init.body);
      geminiPayloads.push(payload);
      geminiTurn += 1;

      if (geminiTurn === 1) {
        return sseResponse([
          {
            candidates: [{
              content: {
                parts: [{
                  functionCall: { name: 'mcp__clickup__search_tasks', args: { q: 'demo' } },
                  thoughtSignature: 'sig-1'
                }]
              }
            }]
          }
        ]);
      }

      return sseResponse([
        {
          candidates: [{
            content: {
              parts: [{ text: 'Encontré la tarea #42 en ClickUp.' }]
            }
          }]
        }
      ]);
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const provider = new GeminiProvider({ apiKey: 'AIzaSyFakeTestKey123456' });
    const chunks = [];

    for await (const chunk of provider.query({
      prompt: 'Busca la tarea demo en ClickUp',
      chatId: 'chat-mcp-1',
      mcpServers: {
        clickup: {
          type: 'http',
          url: 'https://mcp.clickup.com/mcp',
          headers: { Authorization: 'Bearer oauth-tok' }
        }
      }
    })) {
      chunks.push(chunk);
    }

    assert.equal(geminiPayloads.length, 2);
    assert.equal(geminiPayloads[0].tools[0].functionDeclarations[0].name, 'mcp__clickup__search_tasks');
    assert.equal(geminiPayloads[1].contents.at(-1).parts[0].functionResponse.name, 'mcp__clickup__search_tasks');

    const toolUse = chunks.find((c) => c.type === 'tool_use');
    const toolResult = chunks.find((c) => c.type === 'tool_result');
    const textChunk = chunks.find((c) => c.type === 'text');
    const doneChunk = chunks.find((c) => c.type === 'done');

    assert.ok(toolUse);
    assert.equal(toolUse.name, 'mcp__clickup__search_tasks');
    assert.ok(toolResult);
    assert.equal(toolResult.result.content[0].text, 'Found task #42');
    assert.equal(textChunk.content, 'Encontré la tarea #42 en ClickUp.');
    assert.ok(doneChunk);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
