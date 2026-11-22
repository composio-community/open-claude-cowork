#!/usr/bin/env node
import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { searchBraveContext, formatBraveContextForLLM } from '../services/brave-search.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

function sendResponse(id, result, error = null) {
  const response = {
    jsonrpc: '2.0',
    id
  };
  if (error) {
    response.error = error;
  } else {
    response.result = result;
  }
  process.stdout.write(JSON.stringify(response) + '\n');
}

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const request = JSON.parse(trimmed);
    const { id, method, params } = request;

    switch (method) {
      case 'initialize':
        sendResponse(id, {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'brave-search-mcp',
            version: '1.0.0'
          }
        });
        break;

      case 'notifications/initialized':
        // No response for notifications
        break;

      case 'ping':
        sendResponse(id, {});
        break;

      case 'tools/list':
        sendResponse(id, {
          tools: [
            {
              name: 'brave_search',
              description: 'Realiza búsquedas en la web usando Brave Search API optimizada para LLMs (grounding y fuentes).',
              inputSchema: {
                type: 'object',
                properties: {
                  query: {
                    type: 'string',
                    description: 'Término o pregunta de búsqueda'
                  },
                  search_lang: {
                    type: 'string',
                    description: 'Código de idioma (ej. "es", "en")',
                    default: 'es'
                  },
                  count: {
                    type: 'number',
                    description: 'Cantidad de fuentes y resultados (1 a 20)',
                    default: 10
                  }
                },
                required: ['query']
              }
            }
          ]
        });
        break;

      case 'tools/call':
        if (params?.name === 'brave_search') {
          const args = params.arguments || {};
          const q = args.query || args.q;
          const searchLang = args.search_lang || args.searchLang || 'es';
          const count = args.count ? Number(args.count) : 10;

          try {
            const searchResult = await searchBraveContext({
              query: q,
              searchLang,
              count
            });
            const formatted = formatBraveContextForLLM(searchResult);

            sendResponse(id, {
              content: [
                {
                  type: 'text',
                  text: formatted
                }
              ]
            });
          } catch (err) {
            sendResponse(id, {
              content: [
                {
                  type: 'text',
                  text: `Error en Brave Search: ${err.message}`
                }
              ],
              isError: true
            });
          }
        } else {
          sendResponse(id, null, {
            code: -32601,
            message: `Tool not found: ${params?.name}`
          });
        }
        break;

      default:
        if (id !== undefined) {
          sendResponse(id, null, {
            code: -32601,
            message: `Method not found: ${method}`
          });
        }
        break;
    }
  } catch (err) {
    console.error('[BraveMCP] Parse error:', err.message);
  }
});
