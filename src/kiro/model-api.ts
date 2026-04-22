/**
 * Model API for Kiro/AWS CodeWhisperer
 *
 * Provides model listing and usage limit APIs.
 */

import { logger } from '../utils/logger.js';

/**
 * List available models from Kiro
 * Returns models in Anthropic format for API compatibility
 *
 * @returns {Promise<Object>} Anthropic-format models list
 */
export async function listKiroModels() {
    const models = [
        // Claude models
        { id: 'claude-opus-4-7',   kiro_id: 'claude-opus-4.7',   description: 'Claude Opus 4.7 - Latest Opus, strongest agentic coding (Experimental, IDC only)' },
        { id: 'claude-opus-4-6',   kiro_id: 'claude-opus-4.6',   description: 'Claude Opus 4.6 - Deep reasoning, large codebase planning' },
        { id: 'claude-opus-4-5',   kiro_id: 'claude-opus-4.5',   description: 'Claude Opus 4.5 - Maximum reasoning depth' },
        { id: 'claude-sonnet-4-6', kiro_id: 'claude-sonnet-4.6', description: 'Claude Sonnet 4.6 - Near-Opus intelligence, token efficient' },
        { id: 'claude-sonnet-4-5', kiro_id: 'claude-sonnet-4.5', description: 'Claude Sonnet 4.5 - Best for complex agents and coding' },
        { id: 'claude-sonnet-4-0', kiro_id: 'claude-sonnet-4.0', description: 'Claude Sonnet 4.0 - Consistent, no routing layers' },
        { id: 'claude-haiku-4-5',  kiro_id: 'claude-haiku-4.5',  description: 'Claude Haiku 4.5 - Fastest, near-frontier at low cost' },
        // Open weight models
        { id: 'minimax-m2-5',      kiro_id: 'minimax-m2.5',      description: 'MiniMax M2.5 - Frontier-class coding at low cost (0.25x)' },
        { id: 'glm-5',             kiro_id: 'glm-5',             description: 'GLM-5 - Repo-scale agentic work, 200K context (0.5x)' },
        { id: 'deepseek-3-2',      kiro_id: 'deepseek-3.2',      description: 'DeepSeek 3.2 - Agentic workflows at low cost (0.25x)' },
        { id: 'minimax-m2-1',      kiro_id: 'minimax-m2.1',      description: 'MiniMax M2.1 - Multilingual programming (0.15x)' },
        { id: 'qwen3-coder-next',  kiro_id: 'qwen3-coder-next',  description: 'Qwen3 Coder Next - 256K context, most cost-effective (0.05x)' },
        // Auto
        { id: 'auto',              kiro_id: 'auto',              description: 'Auto - Kiro routes to optimal model per task (1.0x)' },
    ].map(m => ({
        ...m,
        created: Date.now(),
        object: 'model',
        owned_by: m.id.startsWith('claude') ? 'anthropic' : 'amazon',
    }));

    return { object: 'list', data: models };
}

