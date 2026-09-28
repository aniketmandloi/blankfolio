/** A provider asking for a longer wait is treated as unavailable for this run. */
export const maxRetryAfterSeconds = 60;

/** The provider refused before doing billable work, so another attempt is safe. */
export class TransientSourceError extends Error {
	constructor(readonly retryAfterSeconds = 0) {
		super("source-unavailable");
	}
}
/** The request may have been processed and billed; its outcome is unknown. */
export class UncertainSourceOutcome extends Error {
	constructor() {
		super("uncertain-outcome");
	}
}
/** Another attempt cannot help, e.g. missing credentials; `usage` is what was billed anyway. */
export class SourceUnavailableError extends Error {
	constructor(
		readonly errorClass: string,
		readonly usage: Record<string, number> = {},
	) {
		super(errorClass);
	}
}
