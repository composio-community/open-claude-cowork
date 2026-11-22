import fs from 'fs';
import path from 'path';

/**
 * Service to manage and list Claude skills from .claude/skills directory
 */

const SKILL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate skillId to prevent directory traversal
 * @param {string} skillId
 * @returns {boolean}
 */
export function isValidSkillId(skillId) {
  return typeof skillId === 'string' && SKILL_ID_PATTERN.test(skillId);
}

/**
 * Parse frontmatter and header from SKILL.md
 * @param {string} content - Markdown file content
 * @returns {Object} Parsed metadata (name, description)
 */
function parseSkillMetadata(content, folderName) {
  let description = '';
  let name = folderName;

  // Check for YAML frontmatter
  if (content.startsWith('---')) {
    const endFrontmatter = content.indexOf('---', 3);
    if (endFrontmatter !== -1) {
      const frontmatter = content.slice(3, endFrontmatter);
      const nameMatch = frontmatter.match(/^name:\s*(?:"([^"]*)"|'([^']*)'|([^\n\r]+))/m);
      if (nameMatch) {
        name = (nameMatch[1] ?? nameMatch[2] ?? nameMatch[3] ?? '').trim();
      }
      const descBlockMatch = frontmatter.match(/^description:\s*[>|]-?\s*\r?\n((?:[ \t]+[^\n\r]*\r?\n?)+)/m);
      if (descBlockMatch) {
        description = descBlockMatch[1]
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .join(' ');
      } else {
        const descMatch = frontmatter.match(/^description:\s*(?:"([^"]*)"|'([^']*)'|([^\n\r]+))/m);
        if (descMatch) {
          description = (descMatch[1] ?? descMatch[2] ?? descMatch[3] ?? '').trim();
        }
      }
    }
  }

  // Fallback to first heading if no description in frontmatter
  if (!description) {
    const headingMatch = content.match(/^#\s+(.+)$/m);
    if (headingMatch) {
      description = headingMatch[1].trim();
    }
  }

  return { name, description };
}

/**
 * Scan project directory for skills
 * @param {string} projectRoot - Root directory of the repository
 * @returns {Array<Object>} List of discovered skills (without local filesystem paths)
 */
export function getAvailableSkills(projectRoot) {
  const skillsDir = path.join(projectRoot, '.claude', 'skills');
  const skills = [];

  if (!fs.existsSync(skillsDir)) {
    return skills;
  }

  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && isValidSkillId(entry.name)) {
        const skillPath = path.join(skillsDir, entry.name, 'SKILL.md');
        if (fs.existsSync(skillPath)) {
          const content = fs.readFileSync(skillPath, 'utf8');
          const meta = parseSkillMetadata(content, entry.name);
          skills.push({
            id: entry.name,
            name: meta.name || entry.name,
            description: meta.description || 'Custom Claude Skill'
          });
        }
      }
    }
  } catch (error) {
    console.error('[SkillsManager] Error reading skills directory:', error.message);
  }

  return skills;
}

/**
 * Get full content of a specific skill
 * @param {string} skillId - Folder name or skill identifier
 * @param {string} projectRoot - Root directory of the repository
 * @returns {string|null} Skill file content or null if invalid/not found
 */
export function getSkillContent(skillId, projectRoot) {
  if (!isValidSkillId(skillId)) {
    return null;
  }
  const skillPath = path.join(projectRoot, '.claude', 'skills', skillId, 'SKILL.md');
  if (fs.existsSync(skillPath)) {
    return fs.readFileSync(skillPath, 'utf8');
  }
  return null;
}
