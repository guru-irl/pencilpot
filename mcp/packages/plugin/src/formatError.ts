/**
 * Formats an error thrown while handling a plugin task into a rich, agent-friendly
 * string.
 *
 * The plugin previously forwarded only `error.message`, discarding the error name, stack,
 * and cause. That made Penpot Plugin-API failures opaque (see
 * AI-ULTRA-PERFORMANCE-PLAN.md, lever R4). This keeps:
 *   - `name: message` (so the agent can tell a `TypeError` from a validation error),
 *   - the top few stack frames (enough to locate the failure without flooding context),
 *   - the cause chain, if any.
 *
 * @param error - the thrown value
 * @returns a multi-line description
 */
export function formatPluginError(error: unknown): string {
    if (error instanceof Error) {
        const parts: string[] = [`${error.name}: ${error.message}`];

        if (error.stack) {
            // drop the first line (it repeats "name: message") and keep a few frames
            const frames = error.stack
                .split("\n")
                .slice(1)
                .map((line) => line.trim())
                .filter((line) => line.length > 0)
                .slice(0, 3);
            if (frames.length > 0) {
                parts.push(frames.join("\n"));
            }
        }

        const cause = (error as { cause?: unknown }).cause;
        if (cause !== undefined && cause !== null) {
            const causeText =
                cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
            parts.push(`caused by: ${causeText}`);
        }

        return parts.join("\n");
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
