/**
 * Shared Utility Functions
 *
 * General-purpose helper functions used across multiple modules.
 */

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Duration to sleep in milliseconds
 * @returns {Promise<void>} Resolves after the specified duration
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
