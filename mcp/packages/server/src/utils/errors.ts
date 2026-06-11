/**
 * Produces a concise, agent-friendly description of an error for inclusion in a tool
 * response.
 *
 * The previous behaviour wrapped errors with `String(error)`, which renders an `Error`
 * as `"Error: <message>"`. Combined with the plugin-side `"Error handling task:"` prefix,
 * agents saw doubly-wrapped, noisy strings like
 * `Tool execution failed: Error: Error handling task: <terse msg>`
 * (see AI-ULTRA-PERFORMANCE-PLAN.md, lever R4). This unwraps the message and only keeps
 * the error name when it is informative (i.e. not the generic `"Error"`).
 *
 * @param error - the thrown value
 * @returns a single-line-ish description suitable for an LLM
 */
export function describeError(error: unknown): string {
    if (error instanceof Error) {
        const name = error.name && error.name !== "Error" ? `${error.name}: ` : "";
        return `${name}${error.message}`;
    }
    if (typeof error === "string") {
        return error;
    }
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}
