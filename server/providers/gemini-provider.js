import { BaseProvider } from './base-provider.js';
import { isConfiguredSecret } from '../services/env-utils.js';
import { createMcpToolRegistry } from '../services/mcp-client.js';
import { getClickUpScopeInstructions } from '../services/clickup-scope.js';

/**
 * Parse a single SSE `data:` JSON line and extract text parts and functionCall parts.
 */
function extractCandidateParts(dataStr, rawPartsCollector, textPartsCollector, functionCallsCollector) {
  if (!dataStr || dataStr === '[DONE]') return;
  try {
    const data = JSON.parse(dataStr);
    const candidates = data.candidates || [];
    for (const candidate of candidates) {
      const parts = candidate.content?.parts || [];
      for (const part of parts) {
        if (part.text) {
          textPartsCollector.push(part.text);
          rawPartsCollector.push({ text: part.text });
        }
        if (part.functionCall) {
          const fcPart = { functionCall: part.functionCall };
          if (part.thoughtSignature) {
            fcPart.thoughtSignature = part.thoughtSignature;
          }
          rawPartsCollector.push(fcPart);
          functionCallsCollector.push(part.functionCall);
        }
      }
    }
  } catch (parseError) {
    console.warn('[Gemini] Error parsing SSE chunk:', parseError.message);
  }
}

/**
 * Google Gemini LLM Provider implementation
 * Supports Google Generative Language API (REST SSE streaming, v1beta / v1, gemini-3.8-flash)
 */
export class GeminiProvider extends BaseProvider {
  constructor(config = {}) {
    super(config);
    this.baseUrl = config.baseUrl || process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
    this.wsUrl = config.wsUrl || process.env.GEMINI_WS_URL || 'wss://generativelanguage.googleapis.com/ws';
    this.version = config.version || process.env.GEMINI_API_VERSION || 'v1beta';
    this.defaultModel = config.model || process.env.GEMINI_MODEL || 'gemini-3.8-flash';
    this.apiKey = config.apiKey || null;

    // Track active abort controllers per chatId
    this.abortControllers = new Map();
    // Track conversation history per chatId: Array<{ role: 'user'|'model', parts: Array<{ text: string }> }>
    this.conversations = new Map();
  }

  get name() {
    return 'gemini';
  }

  /**
   * Abort an active query for a given chatId
   */
  abort(chatId) {
    const controller = this.abortControllers.get(chatId);
    if (controller) {
      console.log('[Gemini] Aborting query for chatId:', chatId);
      controller.abort();
      this.abortControllers.delete(chatId);
      return true;
    }
    return false;
  }

  /**
   * Execute a query using Google Gemini API with optional MCP function calling
   *
   * @param {Object} params
   * @param {string} params.prompt - The user message or prompt
   * @param {string} params.chatId - Chat session identifier
   * @param {Object} [params.mcpServers] - MCP server configurations
   * @param {string} [params.model] - Model name (e.g. 'gemini-3.8-flash')
   * @param {number} [params.maxTurns] - Maximum tool-calling turns
   * @yields {Object} Normalized response chunks
   */
  async *query(params) {
    const {
      prompt,
      chatId,
      mcpServers = {},
      model = null,
      maxTurns = 15
    } = params;

    const apiKey = (this.apiKey || process.env.GEMINI_API_KEY || '').trim();
    if (!isConfiguredSecret(apiKey)) {
      throw new Error(
        'GEMINI_API_KEY no está configurada o es un placeholder en .env. ' +
        'Por favor añade tu clave GEMINI_API_KEY válida en el archivo .env para usar el proveedor Gemini.'
      );
    }

    // Create abort controller for this request
    const abortController = new AbortController();
    if (chatId) {
      this.abortControllers.set(chatId, abortController);
    }

    const sessionId = (chatId && this.getSession(chatId)) || `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (chatId && !this.getSession(chatId)) {
      this.setSession(chatId, sessionId);
    }

    // Yield session init event
    yield {
      type: 'session_init',
      session_id: sessionId,
      provider: this.name
    };

    // Clean model name (strip leading 'models/' if present)
    const rawModel = model || this.defaultModel || 'gemini-3.8-flash';
    const selectedModel = rawModel.replace(/^models\//, '');

    const baseUrl = this.baseUrl.replace(/\/+$/, '');
    const version = this.version.replace(/^\/+|\/+$/g, '');
    const endpointUrl = `${baseUrl}/${version}/models/${selectedModel}:streamGenerateContent?alt=sse`;

    console.log(`[Gemini] Calling ${selectedModel} via ${endpointUrl}`);

    // Discover MCP tools if any MCP servers are configured
    const hasMcpServers = mcpServers && Object.keys(mcpServers).length > 0;
    const mcpRegistry = hasMcpServers
      ? await createMcpToolRegistry(mcpServers, { signal: abortController.signal })
      : { functionDeclarations: [], callTool: async () => ({}), summary: {} };

    if (hasMcpServers) {
      console.log('[Gemini] MCP tools summary:', JSON.stringify(mcpRegistry.summary));
    }

    // Retrieve or create conversation history for multi-turn
    const conversation = (chatId && this.conversations.get(chatId)) || [];
    const userMessage = {
      role: 'user',
      parts: [{ text: prompt }]
    };
    const workingContents = [...conversation, userMessage];

    let accumulatedText = '';
    const turnLimit = Math.max(1, Number(maxTurns) || 15);

    try {
      for (let turn = 0; turn < turnLimit; turn++) {
        const requestPayload = {
          contents: workingContents,
          generationConfig: {
            temperature: 0.7
          }
        };

        if (mcpRegistry.functionDeclarations.length > 0) {
          requestPayload.tools = [{ functionDeclarations: mcpRegistry.functionDeclarations }];
          const baseInstruction = 'You have access to connected MCP tools (including ClickUp, Brave Search, and Composio when configured). Whenever the user asks about ClickUp tasks, spaces, lists, docs, or live external data, call the appropriate MCP tool instead of saying you lack access.';
          const clickUpInstruction = mcpServers?.clickup ? `\n\n${getClickUpScopeInstructions()}` : '';
          requestPayload.systemInstruction = {
            parts: [{
              text: `${baseInstruction}${clickUpInstruction}`
            }]
          };
        }

        const response = await fetch(endpointUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
          },
          body: JSON.stringify(requestPayload),
          signal: abortController.signal
        });

        if (!response.ok) {
          let errorDetails = `HTTP ${response.status} ${response.statusText}`;
          try {
            const errJson = await response.json();
            if (errJson.error?.message) {
              errorDetails = errJson.error.message;
            }
          } catch {
            const rawText = await response.text().catch(() => '');
            if (rawText) errorDetails = rawText;
          }
          throw new Error(`[Gemini API Error] ${errorDetails}`);
        }

        // Parse Server-Sent Events stream
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        const turnModelParts = [];
        const turnFunctionCalls = [];

        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete trailing line

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) continue;

            if (trimmed.startsWith('data:')) {
              const dataStr = trimmed.slice(5).trim();
              const textParts = [];
              extractCandidateParts(dataStr, turnModelParts, textParts, turnFunctionCalls);
              for (const text of textParts) {
                accumulatedText += text;
                yield {
                  type: 'text',
                  content: text,
                  provider: this.name
                };
              }
            }
          }
        }

        // Process any remaining buffered line
        if (buffer.trim()) {
          const trimmed = buffer.trim();
          if (trimmed.startsWith('data:')) {
            const dataStr = trimmed.slice(5).trim();
            const textParts = [];
            extractCandidateParts(dataStr, turnModelParts, textParts, turnFunctionCalls);
            for (const text of textParts) {
              accumulatedText += text;
              yield {
                type: 'text',
                content: text,
                provider: this.name
              };
            }
          }
        }

        // If no function calls were requested, we are done
        if (turnFunctionCalls.length === 0) {
          break;
        }

        // Append model's functionCall turn to workingContents
        workingContents.push({
          role: 'model',
          parts: turnModelParts
        });

        const functionResponseParts = [];
        for (const fc of turnFunctionCalls) {
          const toolUseId = `gemini-tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const toolArgs = fc.args && typeof fc.args === 'object' ? fc.args : {};

          yield {
            type: 'tool_use',
            id: toolUseId,
            name: fc.name,
            input: toolArgs,
            provider: this.name
          };

          let toolResult;
          try {
            toolResult = await mcpRegistry.callTool(fc.name, toolArgs, abortController.signal);
          } catch (toolErr) {
            console.warn(`[Gemini] MCP tool ${fc.name} error:`, toolErr.message);
            toolResult = { isError: true, error: toolErr.message };
          }

          yield {
            type: 'tool_result',
            tool_use_id: toolUseId,
            result: toolResult,
            provider: this.name
          };

          functionResponseParts.push({
            functionResponse: {
              name: fc.name,
              response: { result: toolResult }
            }
          });
        }

        workingContents.push({
          role: 'user',
          parts: functionResponseParts
        });
      }

      // Persist conversation turns on successful completion
      if (chatId && accumulatedText) {
        conversation.push(userMessage);
        conversation.push({
          role: 'model',
          parts: [{ text: accumulatedText }]
        });
        this.conversations.set(chatId, conversation);
      }

      // Signal completion
      yield {
        type: 'done',
        provider: this.name
      };

      console.log('[Gemini] Stream completed successfully');
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log('[Gemini] Query aborted for chatId:', chatId);
        yield {
          type: 'aborted',
          provider: this.name
        };
      } else {
        throw error;
      }
    } finally {
      if (chatId) {
        this.abortControllers.delete(chatId);
      }
    }
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    await super.cleanup();
    this.conversations.clear();
    this.abortControllers.clear();
  }
}
