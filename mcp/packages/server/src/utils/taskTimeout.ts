/**
 * Resolution of the plugin-task execution timeout.
 *
 * The timeout bounds how long a single `execute_code` (or other plugin task) may run
 * before the bridge gives up waiting for a response. A hardcoded 30s ceiling was the
 * main blocker for large batch operations (see AI-ULTRA-PERFORMANCE-PLAN.md, lever L1),
 * so it is now configurable via the `PENPOT_MCP_TASK_TIMEOUT_SECS` environment variable
 * and overridable per call.
 */

/** Fallback timeout, in seconds, used when nothing else is configured. */
export const DEFAULT_TASK_TIMEOUT_SECS = 30;

/**
 * Resolves the effective task timeout in seconds.
 *
 * Precedence: a valid positive `override` wins; otherwise a valid positive value parsed
 * from `envValue` is used; otherwise {@link DEFAULT_TASK_TIMEOUT_SECS}.
 *
 * @param envValue - raw value of `PENPOT_MCP_TASK_TIMEOUT_SECS` (or undefined)
 * @param override - an explicit per-call override in seconds (or undefined)
 */
export function resolveTaskTimeoutSecs(envValue: string | undefined, override?: number): number {
    if (override !== undefined && Number.isFinite(override) && override > 0) {
        return override;
    }
    if (envValue !== undefined) {
        const parsed = parseInt(envValue, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return DEFAULT_TASK_TIMEOUT_SECS;
}
