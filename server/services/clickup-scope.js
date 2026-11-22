/**
 * ClickUp MCP scope guardrails and workspace metadata.
 * Restricts ClickUp searches and operations to the authorized lists, assignees, and custom fields.
 */

export const CLICKUP_ALLOWED_LISTS = {
  '48494459': 'Lista principal de Customer Service / Seguimiento',
  '223500803': 'Lista REFUND / Reembolsos'
};

export const CLICKUP_ALLOWED_LIST_IDS = ['48494459', '223500803'];

export const CLICKUP_ALLOWED_ASSIGNEES = {
  '101113624': 'Donna (por defecto en creación de casos, seguimiento y exportación)',
  '10678227': 'Lorenzo (asignado al duplicar casos hacia la lista de reembolsos 223500803)'
};

export const CLICKUP_ALLOWED_ASSIGNEE_IDS = ['101113624', '10678227'];

export const CLICKUP_CUSTOM_FIELDS = {
  sale_date: 'f910021f-74df-426d-bdf2-586867dbf5c6',
  amount_usd: 'a51386cd-755e-4c9c-af58-5686b5c2a82d',
  sharefile: 'd074e0d9-a8ce-4bf4-a49b-5eab81ee477f',
  reason: 'ee1a1e07-a9b6-4209-a7bc-87162005e2f2',
  contact_date: '63946f1c-7c02-455a-af2d-af7f5f41e3ea',
  seller: 'af1663e3-9d94-4edd-ad6a-cd775d0a1a70',
  zendesk_ticket: '3fc1dccf-e684-44f9-84ff-706481a7b4bc',
  region: '47368acc-f166-4b7b-ae11-ee0001cd0ad1'
};

const LIST_ARG_KEYS = ['list_id', 'listId', 'list_ids', 'listIds'];
const ASSIGNEE_ARG_KEYS = ['assignee', 'assignee_id', 'assigneeId', 'assignees', 'assignee_ids', 'assigneeIds'];
const BROAD_SCOPE_ARG_KEYS = ['team_id', 'teamId', 'workspace_id', 'workspaceId', 'space_id', 'spaceId', 'folder_id', 'folderId'];

function extractIds(value) {
  if (value === undefined || value === null || value === '') return [];
  const items = Array.isArray(value) ? value : [value];
  return items
    .map((item) => (typeof item === 'object' && item !== null ? item.id : item))
    .filter((id) => id !== undefined && id !== null && String(id).trim() !== '')
    .map((id) => String(id).trim());
}

/**
 * Validate ClickUp MCP tool arguments against the allowed lists, assignees, and scope rules.
 * Throws an Error when a call attempts to query or mutate outside the authorized ClickUp scope.
 *
 * @param {string} toolName
 * @param {Object} [args]
 */
export function enforceClickUpScope(toolName, args = {}) {
  const safeArgs = args && typeof args === 'object' ? args : {};
  const normalizedTool = String(toolName || '').toLowerCase();

  let hasValidListId = false;

  for (const key of LIST_ARG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(safeArgs, key)) {
      const ids = extractIds(safeArgs[key]);
      for (const id of ids) {
        if (!CLICKUP_ALLOWED_LIST_IDS.includes(id)) {
          throw new Error(
            `ClickUp scope restriction: list_id "${id}" is not allowed. ` +
            `Only query or update allowed lists: ${CLICKUP_ALLOWED_LIST_IDS.join(', ')}.`
          );
        }
        hasValidListId = true;
      }
    }
  }

  for (const key of ASSIGNEE_ARG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(safeArgs, key)) {
      const ids = extractIds(safeArgs[key]);
      for (const id of ids) {
        if (!CLICKUP_ALLOWED_ASSIGNEE_IDS.includes(id)) {
          throw new Error(
            `ClickUp scope restriction: assignee "${id}" is not allowed. ` +
            `Allowed assignees: 101113624 (Donna), 10678227 (Lorenzo).`
          );
        }
      }
    }
  }

  const hasBroadScopeArg = BROAD_SCOPE_ARG_KEYS.some(
    (key) => Object.prototype.hasOwnProperty.call(safeArgs, key) && extractIds(safeArgs[key]).length > 0
  );

  const isGlobalDiscoveryTool = /(workspace|hierarchy|get_spaces|list_spaces|get_folders|list_folders|get_teams|list_teams)/.test(normalizedTool);

  if ((isGlobalDiscoveryTool || hasBroadScopeArg) && !hasValidListId) {
    throw new Error(
      `ClickUp scope restriction: broad workspace/space/folder queries are disabled. ` +
      `Query directly using list_id 48494459 (Customer Service / Seguimiento) or 223500803 (REFUND / Reembolsos).`
    );
  }
}

/**
 * Build system instructions describing the authorized ClickUp lists, assignees, and custom field UUIDs.
 *
 * @returns {string}
 */
export function getClickUpScopeInstructions() {
  return [
    'ClickUp MCP Scope Rules (STRICT):',
    '- Restrict ALL ClickUp searches and task operations strictly to these list_id values:',
    '  * 48494459: Lista principal de Customer Service / Seguimiento',
    '  * 223500803: Lista REFUND / Reembolsos',
    '- Do NOT scan or search across broad workspace_id, team_id, space_id, or folder_id scopes; always query directly by list_id (48494459 or 223500803).',
    '- Allowed assignee IDs:',
    '  * 101113624: Donna (default for case creation, follow-up, and export)',
    '  * 10678227: Lorenzo (assigned when duplicating cases to refund list 223500803)',
    '- Customer data is stored in task title ("INVOICE - NOMBRE"), description, and these custom field UUIDs:',
    '  * Sale Date: f910021f-74df-426d-bdf2-586867dbf5c6',
    '  * Amount USD: a51386cd-755e-4c9c-af58-5686b5c2a82d',
    '  * ShareFile: d074e0d9-a8ce-4bf4-a49b-5eab81ee477f',
    '  * Reason: ee1a1e07-a9b6-4209-a7bc-87162005e2f2',
    '  * Contact Date: 63946f1c-7c02-455a-af2d-af7f5f41e3ea',
    '  * Seller: af1663e3-9d94-4edd-ad6a-cd775d0a1a70',
    '  * Zendesk Ticket: 3fc1dccf-e684-44f9-84ff-706481a7b4bc',
    '  * Region: 47368acc-f166-4b7b-ae11-ee0001cd0ad1'
  ].join('\n');
}
