import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TOKEN_FILE = path.join(__dirname, '..', '.clickup-token.json');
const CLIENT_CACHE_FILE = path.join(__dirname, '..', '.clickup-client.json');

const OAUTH_ENDPOINTS = {
  issuer: 'https://mcp.clickup.com',
  authorization: 'https://mcp.clickup.com/oauth/authorize',
  token: 'https://mcp.clickup.com/oauth/token',
  register: 'https://mcp.clickup.com/oauth/register'
};

// In-memory state storage with 10-minute TTL
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

let currentTokenData = null;

// Initialize token from disk if exists
try {
  if (fs.existsSync(TOKEN_FILE)) {
    const raw = fs.readFileSync(TOKEN_FILE, 'utf-8');
    currentTokenData = JSON.parse(raw);
  }
} catch (err) {
  console.warn('[ClickUpOAuth] Could not load persisted token:', err.message);
}

function base64UrlEncode(buffer) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generateCodeVerifier() {
  return base64UrlEncode(crypto.randomBytes(32));
}

function generateCodeChallenge(verifier) {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return base64UrlEncode(hash);
}

function cleanExpiredStates() {
  const now = Date.now();
  for (const [state, data] of pendingStates.entries()) {
    if (now - data.createdAt > STATE_TTL_MS) {
      pendingStates.delete(state);
    }
  }
}

/**
 * Get cached dynamic client or register a new one at ClickUp MCP
 */
async function getOrRegisterClient(redirectUri) {
  let cachedClients = {};
  try {
    if (fs.existsSync(CLIENT_CACHE_FILE)) {
      cachedClients = JSON.parse(fs.readFileSync(CLIENT_CACHE_FILE, 'utf-8'));
      if (cachedClients[redirectUri]?.client_id) {
        return cachedClients[redirectUri];
      }
    }
  } catch {
    // Ignore cache error, re-register
  }

  const payload = {
    client_name: 'OpenClaudeCowork',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  };

  const res = await fetch(OAUTH_ENDPOINTS.register, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to register dynamic OAuth client (${res.status}): ${errText}`);
  }

  const clientData = await res.json();
  cachedClients[redirectUri] = clientData;
  try {
    fs.writeFileSync(CLIENT_CACHE_FILE, JSON.stringify(cachedClients, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[ClickUpOAuth] Could not cache client registration:', err.message);
  }

  return clientData;
}

/**
 * Initiates the PKCE OAuth authorization flow and returns the authorization URL
 */
export async function getAuthorizationUrl(redirectUri) {
  cleanExpiredStates();
  const client = await getOrRegisterClient(redirectUri);

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = base64UrlEncode(crypto.randomBytes(16));

  pendingStates.set(state, {
    codeVerifier,
    redirectUri,
    clientId: client.client_id,
    createdAt: Date.now()
  });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirectUri,
    scope: 'read write',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state: state
  });

  return `${OAUTH_ENDPOINTS.authorization}?${params.toString()}`;
}

/**
 * Exchanges authorization code and code_verifier for an access token
 */
export async function exchangeCodeForToken(code, state) {
  cleanExpiredStates();
  const stateData = pendingStates.get(state);
  if (!stateData) {
    throw new Error('Invalid or expired OAuth state parameter');
  }
  pendingStates.delete(state);

  const formBody = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: stateData.clientId,
    code,
    redirect_uri: stateData.redirectUri,
    code_verifier: stateData.codeVerifier
  });

  const res = await fetch(OAUTH_ENDPOINTS.token, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: formBody.toString()
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to exchange authorization code for token (${res.status}): ${errText}`);
  }

  const tokenResponse = await res.json();
  currentTokenData = {
    accessToken: tokenResponse.access_token,
    tokenType: tokenResponse.token_type || 'Bearer',
    expiresIn: tokenResponse.expires_in,
    obtainedAt: Date.now(),
    scope: tokenResponse.scope
  };

  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(currentTokenData, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[ClickUpOAuth] Could not persist token to disk:', err.message);
  }

  return currentTokenData;
}

/**
 * Gets the current active access token (from OAuth) if available
 */
export function getActiveOAuthToken() {
  if (!currentTokenData?.accessToken) {
    return null;
  }
  // Optional check for expiry if expires_in is provided
  if (currentTokenData.expiresIn) {
    const elapsedSec = (Date.now() - currentTokenData.obtainedAt) / 1000;
    if (elapsedSec > currentTokenData.expiresIn - 60) {
      console.warn('[ClickUpOAuth] Token expired or about to expire');
      return null;
    }
  }
  return currentTokenData.accessToken;
}

/**
 * Get OAuth status info
 */
export function getOAuthStatus() {
  const token = getActiveOAuthToken();
  return {
    authenticated: !!token,
    hasToken: !!currentTokenData?.accessToken,
    obtainedAt: currentTokenData?.obtainedAt || null,
    scope: currentTokenData?.scope || null
  };
}

/**
 * Disconnect and remove active OAuth session
 */
export function disconnectOAuth() {
  currentTokenData = null;
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      fs.unlinkSync(TOKEN_FILE);
    }
  } catch (err) {
    console.warn('[ClickUpOAuth] Could not remove token file:', err.message);
  }
  return { disconnected: true };
}
