import { createHash } from "node:crypto";
import type { SourceRecord } from "@blankfolio/db/schema/literature";
import { z } from "zod";

export type SourceRequest = {
	queries: string[];
	dateFrom: string;
	dateTo: string;
	includeFoundations: boolean;
	limit: number;
	attempt: number;
};
export type SourceResult = {
	outcome: "succeeded" | "empty" | "partial";
	records: SourceRecord[];
	reportedCount: number;
	cursor: string | null;
	cacheAgeSeconds: number | null;
	truncated: boolean;
	/** Billable requests actually made, used to reconcile metered usage. */
	requests: number;
	errorClass: string | null;
};
export type LiteratureSource = {
	id: string;
	label: string;
	metered: boolean;
	filters: (scope: {
		dateFrom: string;
		dateTo: string;
		includeFoundations: boolean;
	}) => { applied: string[]; unsupported: string[] };
	search: (request: SourceRequest) => Promise<SourceResult>;
};

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

const digest = (text: string) =>
	createHash("sha256").update(text).digest("hex").slice(0, 12);

/**
 * Deterministic, free stand-ins for literature providers. Queries containing
 * `fixture:<behavior>` (or `fixture:<catalog|metered>-<behavior>` for one source) select
 * empty, partial, broad, cached, flaky, outage or uncertain outcomes.
 */
function fixtureSource(
	id: string,
	label: string,
	metered: boolean,
): LiteratureSource {
	const short = id.replace("fixture-", "");
	return {
		id,
		label,
		metered,
		filters: ({ dateFrom, dateTo, includeFoundations }) => ({
			applied: [
				`publication date ${dateFrom} to ${dateTo}`,
				...(includeFoundations && !metered ? ["older foundational work"] : []),
			],
			unsupported:
				includeFoundations && metered ? ["older foundational work"] : [],
		}),
		async search(request) {
			const text = request.queries.join(" ").toLowerCase();
			const has = (behavior: string) =>
				text.includes(`fixture:${behavior}`) ||
				text.includes(`fixture:${short}-${behavior}`);
			if (has("outage")) throw new TransientSourceError();
			if (has("flaky") && request.attempt === 1)
				throw new TransientSourceError(1);
			if (has("uncertain")) throw new UncertainSourceOutcome();
			const failedQuery = has("partial") ? request.queries.length - 1 : -1;
			const fromYear = Number(request.dateFrom.slice(0, 4));
			const toYear = Number(request.dateTo.slice(0, 4));
			const perQuery = has("empty") ? 0 : has("broad") ? 500 : 12;
			const foundations =
				request.includeFoundations && !metered && !has("empty") ? 3 : 0;
			const discovery: SourceRecord[] = [];
			const older: SourceRecord[] = [];
			request.queries.forEach((query, index) => {
				if (index === failedQuery) return;
				const hash = digest(query.trim().toLowerCase());
				for (let i = 0; i < perQuery; i++)
					discovery.push({
						key: `fixture:${hash}:${i}`,
						title: `Fixture study ${i + 1}: ${query.slice(0, 80)}`,
						authors: ["A. Fixture", "B. Example"],
						year: toYear - (i % (toYear - fromYear + 1)),
						doi: `10.5555/fixture.${hash}.${i}`,
						url: null,
						acquisitionReason: "discovery",
					});
				for (let i = 0; i < foundations; i++)
					older.push({
						key: `fixture:${hash}:foundation:${i}`,
						title: `Foundational fixture ${i + 1}: ${query.slice(0, 80)}`,
						authors: ["C. Precedent"],
						year: fromYear - 5 - i,
						doi: `10.5555/fixture.${hash}.foundation.${i}`,
						url: null,
						acquisitionReason: "foundation",
					});
			});
			const olderShare = Math.min(older.length, Math.floor(request.limit / 5));
			const records = [
				...discovery.slice(0, request.limit - olderShare),
				...older.slice(0, olderShare),
			];
			const reportedCount = discovery.length + older.length;
			const truncated = reportedCount > records.length;
			return {
				outcome:
					failedQuery >= 0
						? "partial"
						: records.length === 0
							? "empty"
							: "succeeded",
				records,
				reportedCount,
				cursor: truncated ? `offset:${records.length}` : null,
				cacheAgeSeconds: has("cached") ? 6 * 60 * 60 : null,
				truncated,
				requests: request.queries.length,
				errorClass: failedQuery >= 0 ? "query-failed" : null,
			};
		},
	};
}

export const literatureSources: Record<string, LiteratureSource> = {
	"fixture-catalog": fixtureSource(
		"fixture-catalog",
		"Fixture catalog (free)",
		false,
	),
	"fixture-metered": fixtureSource(
		"fixture-metered",
		"Fixture metered index (simulated cost)",
		true,
	),
};

/** Micro-dollars per query request; a metered source without a price is disabled. */
export type SourcePrices = Partial<Record<string, number>>;
export function parseSourcePrices(json: string | undefined): SourcePrices {
	if (!json) return {};
	const usd = z
		.record(z.string(), z.number().nonnegative())
		.parse(JSON.parse(json));
	return Object.fromEntries(
		Object.entries(usd).map(([id, price]) => [id, Math.round(price * 1e6)]),
	);
}
