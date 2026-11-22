/**
 * Web fallback shim for window.electronAPI when running in a standard web browser
 * (e.g., inside a local Docker container, Cloud Run local emulator, or Google Cloud Run).
 * When running inside Electron desktop, preload.js already exposes window.electronAPI
 * via contextBridge, so this shim does nothing.
 */
(function initWebBridge() {
  if (typeof window === 'undefined' || window.electronAPI) {
    return;
  }

  // Use same-origin relative URLs by default so any port (3001, 8080, Cloud Run HTTPS) works seamlessly
  const SERVER_URL = window.OPEN_CLAUDE_BACKEND_URL || '';
  let currentAbortController = null;

  console.log('[WEB-BRIDGE] Running in browser/container mode; initializing web electronAPI shim');

  window.electronAPI = {
    abortCurrentRequest: () => {
      if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
      }
    },

    stopQuery: async (chatId, provider = 'claude') => {
      try {
        const response = await fetch(`${SERVER_URL}/api/abort`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId, provider })
        });
        return await response.json();
      } catch (error) {
        console.error('[WEB-BRIDGE] Error stopping query:', error);
        return { success: false, error: error.message };
      }
    },

    sendMessage: async (message, chatId, provider = 'claude', model = null) => {
      if (currentAbortController) {
        currentAbortController.abort();
      }

      currentAbortController = new AbortController();
      const signal = currentAbortController.signal;

      const response = await fetch(`${SERVER_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, chatId, provider, model }),
        signal
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status} ${response.statusText}`);
      }

      return {
        getReader: async function () {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          return {
            read: async () => {
              const { done, value } = await reader.read();
              return {
                done,
                value: done ? undefined : decoder.decode(value, { stream: true })
              };
            }
          };
        }
      };
    },

    getProviders: async () => {
      try {
        const response = await fetch(`${SERVER_URL}/api/providers`);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
      } catch (error) {
        console.error('[WEB-BRIDGE] Error fetching providers:', error);
        return { providers: ['claude'], default: 'claude' };
      }
    },

    getSkills: async () => {
      try {
        const response = await fetch(`${SERVER_URL}/api/skills`);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
      } catch (error) {
        console.error('[WEB-BRIDGE] Error fetching skills:', error);
        return { success: false, skills: [], error: error.message };
      }
    },

    getSkillContent: async (skillId) => {
      try {
        const response = await fetch(`${SERVER_URL}/api/skills/${encodeURIComponent(skillId)}`);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
      } catch (error) {
        console.error('[WEB-BRIDGE] Error fetching skill content:', error);
        return { success: false, error: error.message };
      }
    },

    searchBrave: async (query, options = {}) => {
      try {
        const response = await fetch(`${SERVER_URL}/api/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            q: query,
            count: options.count || 10,
            search_lang: options.search_lang || 'es'
          })
        });
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
      } catch (error) {
        console.error('[WEB-BRIDGE] Error querying Brave Search:', error);
        return { success: false, error: error.message };
      }
    },

    getMcpStatus: async () => {
      try {
        const response = await fetch(`${SERVER_URL}/api/mcp/status`);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
      } catch (error) {
        console.error('[WEB-BRIDGE] Error fetching MCP status:', error);
        return { clickup: { configured: false }, brave: { configured: false } };
      }
    },

    disconnectClickUp: async () => {
      try {
        const response = await fetch(`${SERVER_URL}/api/auth/clickup/disconnect`, {
          method: 'POST'
        });
        return await response.json();
      } catch (error) {
        console.error('[WEB-BRIDGE] Error disconnecting ClickUp:', error);
        return { success: false, error: error.message };
      }
    }
  };
})();
