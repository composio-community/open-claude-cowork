import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLICKUP_ALLOWED_LIST_IDS,
  CLICKUP_ALLOWED_ASSIGNEE_IDS,
  CLICKUP_CUSTOM_FIELDS,
  enforceClickUpScope,
  getClickUpScopeInstructions
} from '../server/services/clickup-scope.js';
import { createMcpToolRegistry } from '../server/services/mcp-client.js';
import { GeminiProvider } from '../server/providers/gemini-provider.js';

test('clickup-scope constants match authorized lists, assignees, and custom field UUIDs', () => {
  assert.deepEqual(CLICKUP_ALLOWED_LIST_IDS, ['48494459', '223500803']);
  assert.deepEqual(CLICKUP_ALLOWED_ASSIGNEE_IDS, ['101113624', '10678227']);
  assert.equal(CLICKUP_CUSTOM_FIELDS.sale_date, 'f910021f-74df-426d-bdf2-586867dbf5c6');
  assert.equal(CLICKUP_CUSTOM_FIELDS.amount_usd, 'a51386cd-755e-4c9c-af58-5686b5c2a82d');
  assert.equal(CLICKUP_CUSTOM_FIELDS.sharefile, 'd074e0d9-a8ce-4bf4-a49b-5eab81ee477f');
  assert.equal(CLICKUP_CUSTOM_FIELDS.reason, 'ee1a1e07-a9b6-4209-a7bc-87162005e2f2');
  assert.equal(CLICKUP_CUSTOM_FIELDS.contact_date, '63946f1c-7c02-455a-af2d-af7f5f41e3ea');
  assert.equal(CLICKUP_CUSTOM_FIELDS.seller, 'af1663e3-9d94-4edd-ad6a-cd775d0a1a70');
  assert.equal(CLICKUP_CUSTOM_FIELDS.zendesk_ticket, '3fc1dccf-e684-44f9-84ff-706481a7b4bc');
  assert.equal(CLICKUP_CUSTOM_FIELDS.region, '47368acc-f166-4b7b-ae11-ee0001cd0ad1');
});

test('enforceClickUpScope allows authorized list_ids and assignees, and blocks unauthorized ones', () => {
  assert.doesNotThrow(() => enforceClickUpScope('get_tasks', { list_id: '48494459', assignee: '101113624' }));
  assert.doesNotThrow(() => enforceClickUpScope('create_task', { listId: 223500803, assignees: [10678227] }));

  assert.throws(
    () => enforceClickUpScope('get_tasks', { list_id: '99999999' }),
    /list_id "99999999" is not allowed/
  );
  assert.throws(
    () => enforceClickUpScope('create_task', { list_id: '48494459', assignee_ids: ['12345'] }),
    /assignee "12345" is not allowed/
  );
  assert.throws(
    () => enforceClickUpScope('get_workspace_hierarchy', {}),
    /broad workspace\/space\/folder queries are disabled/
  );
  assert.throws(
    () => enforceClickUpScope('search_tasks', { workspace_id: '9001' }),
    /broad workspace\/space\/folder queries are disabled/
  );
});

test('createMcpToolRegistry blocks out-of-scope ClickUp calls before hitting remote MCP', async () => {
  const originalFetch = globalThis.fetch;
  let toolCallHitNetwork = false;

  globalThis.fetch = async (url, init) => {
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
          tools: [{ name: 'get_tasks', description: 'List tasks', inputSchema: { type: 'object', properties: { list_id: { type: 'string' } } } }]
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (body.method === 'tools/call') {
      toolCallHitNetwork = true;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), { status: 200 });
    }
    throw new Error(`Unexpected method: ${body.method}`);
  };

  try {
    const registry = await createMcpToolRegistry({
      clickup: {
        type: 'http',
        url: 'https://mcp.clickup.com/mcp',
        headers: { Authorization: 'Bearer tok' }
      }
    });

    await assert.rejects(
      () => registry.callTool('mcp__clickup__get_tasks', { list_id: '111111' }),
      /list_id "111111" is not allowed/
    );
    assert.equal(toolCallHitNetwork, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GeminiProvider includes ClickUp scope instructions when clickup MCP server is configured', async () => {
  const originalFetch = globalThis.fetch;
  let capturedPayload = null;

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
            tools: [{ name: 'get_tasks', description: 'Get tasks', inputSchema: { type: 'object', properties: { list_id: { type: 'string' } } } }]
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }

    if (String(url).includes('streamGenerateContent')) {
      capturedPayload = JSON.parse(init.body);
      return new Response(
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const provider = new GeminiProvider({ apiKey: 'AIzaSyFakeTestKey123456' });
    for await (const _chunk of provider.query({
      prompt: 'Revisa los casos de ClickUp',
      chatId: 'scope-test-1',
      mcpServers: {
        clickup: {
          type: 'http',
          url: 'https://mcp.clickup.com/mcp',
          headers: { Authorization: 'Bearer tok' }
        }
      }
    })) {
      // drain
    }

    const sysText = capturedPayload?.systemInstruction?.parts?.[0]?.text || '';
    assert.ok(sysText.includes('48494459'));
    assert.ok(sysText.includes('223500803'));
    assert.ok(sysText.includes('101113624'));
    assert.ok(sysText.includes('10678227'));
    assert.ok(sysText.includes('f910021f-74df-426d-bdf2-586867dbf5c6'));
    assert.ok(getClickUpScopeInstructions().includes('a51386cd-755e-4c9c-af58-5686b5c2a82d'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
