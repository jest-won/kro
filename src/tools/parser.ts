/**
 * Parses <tool_use> XML blocks from model text responses.
 *
 * Expected format the model is prompted to produce:
 *   <tool_use>
 *   {"name": "Read", "input": {"file_path": "/foo/bar.js"}}
 *   </tool_use>
 */

/**
 * @typedef {{ name: string, id: string, input: Record<string, unknown> }} ToolUseBlock
 * @typedef {{ text: string, toolUses: ToolUseBlock[] }} ParseResult
 */

import crypto from 'crypto';

const TOOL_USE_RE = /<tool_use>\s*([\s\S]*?)\s*<\/tool_use>/g;
// <tool_use name="ToolName">{...}</tool_use>
const TOOL_USE_NAMED_RE = /<tool_use\s+name="(\w+)"[^>]*>\s*([\s\S]*?)\s*<\/tool_use>/g;

/** Extract a complete JSON object starting at `pos` (the '{' character). */
function extractJson(text, pos) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = pos; i < text.length; i++) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return text.slice(pos, i + 1);
        }
    }
    return null;
}

export function parseToolUses(text) {
    const toolUses = [];
    let match;

    // Format 1a: <tool_use name="ToolName">{input}</tool_use>
    TOOL_USE_NAMED_RE.lastIndex = 0;
    while ((match = TOOL_USE_NAMED_RE.exec(text)) !== null) {
        try {
            const name = match[1];
            const input = JSON.parse(match[2]);
            toolUses.push({
                id: `toolu_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`,
                name,
                input
            });
        } catch {
            // malformed JSON — skip
        }
    }

    // Format 1b: <tool_use>{"name":"X","input":{...}}</tool_use>
    TOOL_USE_RE.lastIndex = 0;
    while ((match = TOOL_USE_RE.exec(text)) !== null) {
        try {
            const parsed = JSON.parse(match[1]);
            toolUses.push({
                id: `toolu_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`,
                name: parsed.name,
                input: parsed.input ?? {}
            });
        } catch {
            // malformed JSON — skip
        }
    }

    // Format 2: [Tool] ToolName {"key":"value"}
    const bracketRe = /\[Tool\]\s+(\w+)\s+(\{)/g;
    let bMatch;
    while ((bMatch = bracketRe.exec(text)) !== null) {
        const name = bMatch[1];
        const start = bMatch.index + bMatch[0].length - 1;
        const json = extractJson(text, start);
        if (json !== null) {
            try {
                const input = JSON.parse(json);
                delete input.description;
                toolUses.push({
                    id: `toolu_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`,
                    name,
                    input
                });
            } catch {
                // malformed JSON — skip
            }
        }
    }

    // Format 3: bare JSON object that looks like a tool call (has known tool input keys)
    // e.g. {"pattern":"**/*","path":"..."} or {"command":"ls","description":"..."}
    // Only attempt if no other tool calls were found and text is mostly JSON
    if (toolUses.length === 0) {
        const trimmed = text.trim();
        if (trimmed.startsWith('{')) {
            const json = extractJson(trimmed, 0);
            if (json !== null) {
                try {
                    const obj = JSON.parse(json);
                    const name = inferToolName(obj);
                    if (name) {
                        delete obj.description;
                        toolUses.push({
                            id: `toolu_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`,
                            name,
                            input: obj
                        });
                    }
                } catch {
                    // not a tool call
                }
            }
        }
    }

    const cleanText = text
        .replace(TOOL_USE_NAMED_RE, '')
        .replace(TOOL_USE_RE, '')
        .replace(/\[Tool\]\s+\w+\s+\{[\s\S]*?\}/g, '')
        .trim();
    return { text: cleanText, toolUses };
}

/** Infer tool name from input object shape */
function inferToolName(obj) {
    if (obj.command !== undefined) return 'Bash';
    if (obj.file_path !== undefined && obj.old_string !== undefined) return 'Edit';
    if (obj.file_path !== undefined && obj.content !== undefined) return 'Write';
    if (obj.file_path !== undefined) return 'Read';
    if (obj.pattern !== undefined && (obj.output_mode !== undefined || obj.glob !== undefined || obj.type !== undefined)) return 'Grep';
    if (obj.pattern !== undefined) return 'Glob';
    if (obj.url !== undefined && obj.prompt !== undefined) return 'WebFetch';
    if (obj.query !== undefined) return 'WebSearch';
    if (obj.prompt !== undefined && (obj.description !== undefined || obj.subagent_type !== undefined)) return 'Agent';
    if (obj.questions !== undefined) return 'AskUserQuestion';
    if (obj.subject !== undefined && obj.description !== undefined) return 'TaskCreate';
    if (obj.taskId !== undefined) return 'TaskUpdate';
    if (obj.skill !== undefined) return 'Skill';
    return null;
}

export function hasToolUse(text) {
    TOOL_USE_NAMED_RE.lastIndex = 0;
    if (TOOL_USE_NAMED_RE.test(text)) return true;
    TOOL_USE_RE.lastIndex = 0;
    if (TOOL_USE_RE.test(text)) return true;
    return /\[Tool\]\s+\w+\s+\{/.test(text);
}
