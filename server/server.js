import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';
import { Composio } from '@composio/core';
import { getProvider, getAvailableProviders, initializeProviders } from './providers/index.js';
import { searchBraveContext } from './services/brave-search.js';
import { getAvailableSkills, getSkillContent, isValidSkillId } from './services/skills-manager.js';
import { isConfiguredSecret } from './services/env-utils.js';
import { getClickUpScopeInstructions } from './services/clickup-scope.js';
import {
  getAuthorizationUrl,
  exchangeCodeForToken,
  getActiveOAuthToken,
  getOAuthStatus,
  disconnectOAuth
} from './services/clickup-oauth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';
const rendererDir = path.join(__dirname, '..', 'renderer');

// Lazy Composio client (only instantiated when a real COMPOSIO_API_KEY is configured)
let composio = null;

function getComposioClient() {
  if (!isConfiguredSecret(process.env.COMPOSIO_API_KEY)) {
    return null;
  }
  if (!composio) {
    composio = new Composio();
  }
  return composio;
}

const composioSessions = new Map();
let defaultComposioSession = null;

// Pre-initialize Composio session on startup and write opencode.json before Opencode starts
async function initializeComposioSession() {
  const defaultUserId = 'default-user';
  const client = getComposioClient();
  if (!client) {
    console.log('[COMPOSIO] COMPOSIO_API_KEY not configured (or placeholder), skipping Composio session');
    updateOpencodeConfig(null, null);
    return;
  }
  console.log('[COMPOSIO] Pre-initializing session for:', defaultUserId);
  try {
    defaultComposioSession = await client.create(defaultUserId);
    composioSessions.set(defaultUserId, defaultComposioSession);
    console.log('[COMPOSIO] Session ready with MCP URL:', defaultComposioSession.mcp.url);

    // Update opencode.json with the MCP config
    updateOpencodeConfig(defaultComposioSession.mcp.url, defaultComposioSession.mcp.headers);
    console.log('[OPENCODE] Updated opencode.json with MCP config');
  } catch (error) {
    console.error('[COMPOSIO] Failed to pre-initialize session:', error.message);
    updateOpencodeConfig(null, null);
  }
}

// Write MCP config to opencode.json without persisting plaintext secrets for local stdio servers
function updateOpencodeConfig(composioUrl, composioHeaders) {
  const opencodeConfigPath = path.join(__dirname, 'opencode.json');
  const config = {
    mcp: {}
  };

  if (composioUrl) {
    config.mcp.composio = {
      type: 'remote',
      url: composioUrl,
      headers: composioHeaders || {}
    };
  }

  // ClickUp MCP Server (supports both CLICKUP_API_KEY from .env and dynamic OAuth token)
  const clickUpUrl = process.env.CLICKUP_MCP_URL || 'https://mcp.clickup.com/mcp';
  const clickUpConfig = {
    type: 'remote',
    url: clickUpUrl
  };
  const activeClickUpToken = isConfiguredSecret(process.env.CLICKUP_API_KEY)
    ? process.env.CLICKUP_API_KEY.trim()
    : getActiveOAuthToken();

  if (activeClickUpToken) {
    clickUpConfig.headers = {
      Authorization: `Bearer ${activeClickUpToken}`
    };
  }
  config.mcp.clickup = clickUpConfig;

  // Brave Search MCP Server (brave-mcp.js loads BRAVE_API_KEY directly from root .env)
  if (isConfiguredSecret(process.env.BRAVE_API_KEY)) {
    const braveMcpScript = path.join(__dirname, 'mcp', 'brave-mcp.js');
    config.mcp.brave = {
      type: 'local',
      command: [process.execPath, braveMcpScript]
    };
  }

  // Filesystem MCP Server
  const defaultFsPath = process.platform === 'win32' ? 'C:\\Users' : process.cwd();
  const filesystemPath = process.env.FILESYSTEM_MCP_PATH || defaultFsPath;
  config.mcp.filesystem = {
    type: 'local',
    command: ['npx', '-y', '@modelcontextprotocol/server-filesystem', filesystemPath]
  };

  fs.writeFileSync(opencodeConfigPath, JSON.stringify(config, null, 2));
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(rendererDir));

// Chat endpoint using provider abstraction
app.post('/api/chat', async (req, res) => {
  const {
    message,
    chatId,
    userId = 'default-user',
    provider: providerName = 'claude',  // Per-request provider selection
    model = null  // Per-request model selection
  } = req.body;

  console.log('[CHAT] Request received:', message);
  console.log('[CHAT] Chat ID:', chatId);
  console.log('[CHAT] Provider:', providerName);
  console.log('[CHAT] Model:', model || '(default)');

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  // Reload .env dynamically to catch any API keys updated while running
  try {
    dotenv.config({ path: path.join(__dirname, '..', '.env'), override: true });
  } catch (err) {
    // ignore
  }

  // Validate provider
  const availableProviders = getAvailableProviders();
  if (!availableProviders.includes(providerName.toLowerCase())) {
    return res.status(400).json({
      error: `Invalid provider: ${providerName}. Available: ${availableProviders.join(', ')}`
    });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Processing request...' })}\n\n`);

  const heartbeatInterval = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': heartbeat\n\n');
    }
  }, 15000);

  res.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  try {
    // Get or create Composio session for this user if configured
    let composioSession = composioSessions.get(userId);
    const composioClient = getComposioClient();
    if (!composioSession && composioClient) {
      try {
        console.log('[COMPOSIO] Creating new session for user:', userId);
        res.write(`data: ${JSON.stringify({ type: 'status', message: 'Initializing Composio session...' })}\n\n`);
        composioSession = await composioClient.create(userId);
        composioSessions.set(userId, composioSession);
        console.log('[COMPOSIO] Session created with MCP URL:', composioSession.mcp.url);

        // Update opencode.json with the MCP config
        updateOpencodeConfig(composioSession.mcp.url, composioSession.mcp.headers);
      } catch (compErr) {
        console.warn('[COMPOSIO] Could not create session:', compErr.message);
      }
    }

    // Get the provider instance
    const provider = getProvider(providerName);

    // Build MCP servers config - passed to provider
    const mcpServers = {};

    // 1. Composio MCP (if available)
    if (composioSession?.mcp?.url) {
      mcpServers.composio = {
        type: 'http',
        url: composioSession.mcp.url,
        headers: composioSession.mcp.headers
      };
    }

    // 2. ClickUp MCP Server (supports CLICKUP_API_KEY from .env or active OAuth token)
    const clickUpUrl = process.env.CLICKUP_MCP_URL || 'https://mcp.clickup.com/mcp';
    const clickUpServer = {
      type: 'http',
      url: clickUpUrl
    };
    const activeClickUpAuth = isConfiguredSecret(process.env.CLICKUP_API_KEY)
      ? process.env.CLICKUP_API_KEY.trim()
      : getActiveOAuthToken();

    if (activeClickUpAuth) {
      clickUpServer.headers = {
        Authorization: `Bearer ${activeClickUpAuth}`
      };
    }
    mcpServers.clickup = clickUpServer;

    // 3. Brave Search MCP Server (local stdio; brave-mcp.js reads root .env)
    if (isConfiguredSecret(process.env.BRAVE_API_KEY)) {
      const braveMcpScript = path.join(__dirname, 'mcp', 'brave-mcp.js');
      mcpServers.brave = {
        type: 'stdio',
        command: process.execPath,
        args: [braveMcpScript]
      };
    }

    // 4. Filesystem MCP Server (local stdio)
    const defaultFsPath = process.platform === 'win32' ? 'C:\\Users' : process.cwd();
    const filesystemPath = process.env.FILESYSTEM_MCP_PATH || defaultFsPath;
    mcpServers.filesystem = {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', filesystemPath],
      shell: process.platform === 'win32'
    };

    // Check if user specifically requested a skill (e.g. /skills or /skill <name> <query>)
    let processedPrompt = message;
    const projectRoot = path.resolve(__dirname, '..');

    if (message.trim() === '/skills') {
      const skills = getAvailableSkills(projectRoot);
      const skillsListText = skills.length > 0
        ? `### 🛠️ Skills disponibles:\n\n` + skills.map(s => `- **\`${s.id}\`**: ${s.description}`).join('\n\n') + `\n\nPuedes invocar cualquier skill escribiendo:\n\`\`\`/skill ${skills[0].id} [tu instrucción o pregunta]\`\`\``
        : 'No se encontraron skills configuradas en `.claude/skills`.';

      res.write(`data: ${JSON.stringify({ type: 'text', content: skillsListText, provider: providerName })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done', provider: providerName })}\n\n`);
      clearInterval(heartbeatInterval);
      res.end();
      return;
    }

    const skillMatch = message.trim().match(/^\/skill(?:\s+(\S+))?(?:\s+([\s\S]*))?$/);
    if (skillMatch) {
      const skillId = skillMatch[1];
      const userQuery = skillMatch[2] || '';
      const availableSkills = getAvailableSkills(projectRoot);

      if (!skillId || !isValidSkillId(skillId)) {
        const availableText = availableSkills.length > 0
          ? availableSkills.map(s => `- **\`${s.id}\`**: ${s.description}`).join('\n')
          : 'Ninguna skill disponible.';
        res.write(`data: ${JSON.stringify({
          type: 'text',
          content: `Nombre de skill inválido o faltante. Skills disponibles:\n\n${availableText}\n\nUso: \`/skill <nombre> [instrucción]\``,
          provider: providerName
        })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', provider: providerName })}\n\n`);
        clearInterval(heartbeatInterval);
        res.end();
        return;
      }

      const skillContent = getSkillContent(skillId, projectRoot);
      if (skillContent) {
        processedPrompt = `[INSTRUCCIÓN DE SKILL: Activa y aplica la siguiente skill "${skillId}":\n\n${skillContent}\n]\n\nSolicitud del usuario:\n${userQuery || 'Aplica las directrices de esta skill.'}`;
      } else {
        console.warn(`[SKILL] Skill ${skillId} no encontrada`);
        const availableText = availableSkills.length > 0
          ? availableSkills.map(s => `- **\`${s.id}\`**: ${s.description}`).join('\n')
          : 'Ninguna skill disponible.';
        res.write(`data: ${JSON.stringify({
          type: 'text',
          content: `No se encontró la skill \`${skillId}\`.\n\nSkills disponibles:\n\n${availableText}`,
          provider: providerName
        })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', provider: providerName })}\n\n`);
        clearInterval(heartbeatInterval);
        res.end();
        return;
      }
    }

    // Inject ClickUp scope instructions for non-Gemini providers when ClickUp is referenced
    if (provider.name !== 'gemini' && mcpServers.clickup && /clickup|48494459|223500803|reembolso|refund/i.test(processedPrompt)) {
      processedPrompt = `[${getClickUpScopeInstructions()}]\n\n${processedPrompt}`;
    }

    console.log('[CHAT] Using provider:', provider.name);
    console.log('[CHAT] MCP servers:', Object.keys(mcpServers).map((k) => `${k}(auth=${Boolean(mcpServers[k]?.headers?.Authorization)})`).join(', ') || 'none');
    console.log('[CHAT] All stored sessions:', Array.from(provider.sessions.entries()));

    // Stream responses from the provider
    try {
      for await (const chunk of provider.query({
        prompt: processedPrompt,
        chatId,
        userId,
        mcpServers,
        model,
        allowedTools: [
          'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
          'WebSearch', 'WebFetch', 'TodoWrite', 'Skill',
          'mcp__*'
        ],
        maxTurns: 100
      })) {
        if (chunk.type === 'tool_use') {
          console.log('[SSE] Sending tool_use:', chunk.name);
        }
        if (chunk.type === 'text') {
          console.log('[SSE] Sending text chunk, length:', chunk.content?.length || 0);
        }
        // Send chunk as SSE
        const data = `data: ${JSON.stringify(chunk)}\n\n`;
        res.write(data);
      }
    } catch (streamError) {
      console.error('[CHAT] Stream error during iteration:', streamError);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: streamError.message })}\n\n`);
      }
    }

    clearInterval(heartbeatInterval);
    if (!res.writableEnded) {
      res.end();
    }
    console.log('[CHAT] Stream completed');
  } catch (error) {
    clearInterval(heartbeatInterval);
    console.error('[CHAT] Error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    res.end();
  }
});

// Abort endpoint to stop active queries
app.post('/api/abort', (req, res) => {
  const { chatId, provider: providerName = 'claude' } = req.body;

  if (!chatId) {
    return res.status(400).json({ error: 'chatId is required' });
  }

  console.log('[ABORT] Request to abort chatId:', chatId, 'provider:', providerName);

  try {
    const provider = getProvider(providerName);
    const aborted = provider.abort(chatId);

    if (aborted) {
      console.log('[ABORT] Successfully aborted chatId:', chatId);
      res.json({ success: true, message: 'Query aborted' });
    } else {
      console.log('[ABORT] No active query found for chatId:', chatId);
      res.json({ success: false, message: 'No active query to abort' });
    }
  } catch (error) {
    console.error('[ABORT] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get available providers endpoint
app.get('/api/providers', (_req, res) => {
  res.json({
    providers: getAvailableProviders(),
    default: 'claude'
  });
});

// Health check endpoint
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    providers: getAvailableProviders()
  });
});

// Direct search endpoint for Brave Search (grounding context)
app.post('/api/search', async (req, res) => {
  try {
    const { q, count = 10, search_lang = 'es' } = req.body;
    if (!q || typeof q !== 'string' || !q.trim()) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    const parsedCount = Number.parseInt(count, 10);
    const clampedCount = Number.isFinite(parsedCount)
      ? Math.min(20, Math.max(1, parsedCount))
      : 10;
    const safeLang = typeof search_lang === 'string' && /^[a-zA-Z-]{2,10}$/.test(search_lang.trim())
      ? search_lang.trim()
      : 'es';

    const data = await searchBraveContext({
      query: q,
      count: clampedCount,
      searchLang: safeLang
    });

    res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('[SEARCH] Error during Brave Search:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Skills endpoint: list and inspect skills
app.get('/api/skills', (_req, res) => {
  try {
    const projectRoot = path.resolve(__dirname, '..');
    const skills = getAvailableSkills(projectRoot).map(({ id, name, description }) => ({
      id,
      name,
      description
    }));
    res.json({
      success: true,
      skills
    });
  } catch (error) {
    console.error('[SKILLS] Error loading skills:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/skills/:skillId', (req, res) => {
  try {
    const { skillId } = req.params;
    if (!isValidSkillId(skillId)) {
      return res.status(400).json({ success: false, error: 'Invalid skillId format' });
    }

    const projectRoot = path.resolve(__dirname, '..');
    const content = getSkillContent(skillId, projectRoot);
    if (!content) {
      return res.status(404).json({ success: false, error: `Skill "${skillId}" not found` });
    }
    res.json({
      success: true,
      skillId,
      content
    });
  } catch (error) {
    console.error('[SKILLS] Error reading skill:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// MCP configuration and status endpoint
app.get('/api/mcp/status', (_req, res) => {
  const hasClickUpKey = isConfiguredSecret(process.env.CLICKUP_API_KEY);
  const oauthStatus = getOAuthStatus();
  const clickUpConnected = hasClickUpKey || oauthStatus.authenticated;
  const hasBraveKey = isConfiguredSecret(process.env.BRAVE_API_KEY);
  const hasComposioKey = isConfiguredSecret(process.env.COMPOSIO_API_KEY);

  res.json({
    clickup: {
      url: process.env.CLICKUP_MCP_URL || 'https://mcp.clickup.com/mcp',
      configured: true,
      hasApiKey: hasClickUpKey,
      authenticated: clickUpConnected,
      authMode: hasClickUpKey ? 'api_key' : (oauthStatus.authenticated ? 'oauth' : 'oauth_required'),
      oauth: oauthStatus
    },
    brave: {
      type: 'stdio',
      endpoint: 'https://api.search.brave.com/res/v1/llm/context',
      configured: hasBraveKey
    },
    composio: {
      configured: hasComposioKey,
      sessionActive: Boolean(defaultComposioSession?.mcp?.url)
    }
  });
});

// Helper to determine canonical OAuth redirect URI
function getOAuthRedirectUri(req) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host') || `localhost:${PORT}`;
  return `${protocol}://${host}/api/auth/clickup/callback`;
}

// ClickUp OAuth 2.0 endpoints
app.get('/api/auth/clickup/login', async (req, res) => {
  try {
    const redirectUri = getOAuthRedirectUri(req);
    const authUrl = await getAuthorizationUrl(redirectUri);

    if (req.query.json === 'true') {
      return res.json({ success: true, authUrl });
    }
    res.redirect(authUrl);
  } catch (err) {
    console.error('[CLICKUP OAUTH] Login error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/auth/clickup/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Error de Autenticación ClickUp</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; text-align: center; }
            .card { background: #1e293b; padding: 2.5rem; border-radius: 1rem; box-shadow: 0 10px 25px rgba(0,0,0,0.5); max-width: 440px; border: 1px solid #ef4444; }
            .icon { font-size: 3rem; margin-bottom: 1rem; color: #ef4444; }
            h2 { margin: 0 0 0.5rem 0; font-size: 1.4rem; color: #fca5a5; }
            p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; }
            .btn { display: inline-block; margin-top: 1.5rem; padding: 0.6rem 1.2rem; background: #475569; color: white; border-radius: 0.5rem; cursor: pointer; border: none; font-size: 0.9rem; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="icon">✕</div>
            <h2>Autorización denegada o fallida</h2>
            <p>${error_description || error || 'El proceso de autorización no pudo completarse.'}</p>
            <button class="btn" onclick="window.close()">Cerrar Ventana</button>
          </div>
        </body>
      </html>
    `);
  }

  if (!code || !state) {
    return res.status(400).send('Parámetros "code" y "state" requeridos en el callback.');
  }

  try {
    await exchangeCodeForToken(code, state);
    updateOpencodeConfig(defaultComposioSession?.mcp?.url, defaultComposioSession?.mcp?.headers);

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>ClickUp Conectado Exitosamente</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; text-align: center; }
            .card { background: #1e293b; padding: 2.5rem; border-radius: 1rem; box-shadow: 0 10px 25px rgba(0,0,0,0.5); max-width: 440px; border: 1px solid #334155; }
            .icon { font-size: 3rem; margin-bottom: 1rem; color: #10b981; }
            h2 { margin: 0 0 0.5rem 0; font-size: 1.5rem; }
            p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; }
            .btn { display: inline-block; margin-top: 1.5rem; padding: 0.6rem 1.2rem; background: #6366f1; color: white; border-radius: 0.5rem; cursor: pointer; border: none; font-size: 0.9rem; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="icon">✓</div>
            <h2>¡ClickUp Conectado!</h2>
            <p>Tu cuenta y espacios de ClickUp se han vinculado correctamente al servidor MCP.</p>
            <p>Esta ventana se cerrará automáticamente en unos segundos...</p>
            <button class="btn" onclick="window.close()">Cerrar Ventana</button>
          </div>
          <script>
            try {
              if (window.opener) {
                window.opener.postMessage({ type: 'CLICKUP_AUTH_SUCCESS' }, '*');
              }
            } catch (e) {
              console.warn(e);
            }
            setTimeout(() => {
              window.close();
            }, 2500);
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('[CLICKUP OAUTH] Token exchange error:', err);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Error al vincular ClickUp</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; text-align: center; }
            .card { background: #1e293b; padding: 2.5rem; border-radius: 1rem; box-shadow: 0 10px 25px rgba(0,0,0,0.5); max-width: 440px; border: 1px solid #ef4444; }
            .icon { font-size: 3rem; margin-bottom: 1rem; color: #ef4444; }
            h2 { margin: 0 0 0.5rem 0; font-size: 1.4rem; color: #fca5a5; }
            p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="icon">✕</div>
            <h2>Error en el canje de token</h2>
            <p>${err.message}</p>
          </div>
        </body>
      </html>
    `);
  }
});

app.get('/api/auth/clickup/status', (_req, res) => {
  res.json({
    success: true,
    ...getOAuthStatus()
  });
});

app.post('/api/auth/clickup/disconnect', (_req, res) => {
  disconnectOAuth();
  updateOpencodeConfig(defaultComposioSession?.mcp?.url, defaultComposioSession?.mcp?.headers);
  res.json({ success: true, disconnected: true });
});

// Generate opencode.json before initializing providers (so opencode serve reads up-to-date MCP config)
await initializeComposioSession();
await initializeProviders();

// Start server and keep reference to prevent garbage collection
const server = app.listen(PORT, HOST, () => {
  console.log(`\n✓ Server running on http://${HOST}:${PORT} (local: http://localhost:${PORT})`);
  console.log(`✓ Web UI served from: ${rendererDir}`);
  console.log(`✓ Chat endpoint: POST http://localhost:${PORT}/api/chat`);
  console.log(`✓ Providers endpoint: GET http://localhost:${PORT}/api/providers`);
  console.log(`✓ Health check: GET http://localhost:${PORT}/api/health`);
  console.log(`✓ Available providers: ${getAvailableProviders().join(', ')}\n`);
});

// Keep the process alive
server.on('error', (err) => {
  console.error('Server error:', err);
});

// Prevent the process from exiting
process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
