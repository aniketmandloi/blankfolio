import { createHash } from "node:crypto";
import type {
	LiteratureScope,
	SourceRecord,
} from "@blankfolio/db/schema/literature";
import { z } from "zod";
import { createArxivSource } from "./arxiv";
import { createOpenAlexSource } from "./openalex";
import { TransientSourceError, UncertainSourceOutcome } from "./source-errors";

export {
	maxRetryAfterSeconds,
	SourceUnavailableError,
	TransientSourceError,
	UncertainSourceOutcome,
} from "./source-errors";

export const recordCap = 200;
/** Held back from every discovery run for the later arXiv and status stages. */
export const laterStageReserve = 40;
/** Records each selected source may contribute; the reserve is never allocated. */
export const sourceAllocation = (sourceCount: number) =>
	Math.floor((recordCap - laterStageReserve) / sourceCount);
/** Cached provider responses older than this are deleted and never served, even as stale. */
export const responseCacheRetentionSeconds = 7 * 24 * 60 * 60;

/** A record's exact identifiers, most stable first; its key is always one of them. */
export function recordAliases(record: SourceRecord) {
	return [
		...new Set([
			...(record.doi ? [`doi:${record.doi.toLowerCase()}`] : []),
			...(record.identifiers ?? []),
			record.key,
		]),
	];
}

export type SourceCache = {
	get: (key: string) => Promise<{ body: unknown; fetchedAt: Date } | null>;
	set: (key: string, body: unknown) => Promise<void>;
};
export type SourceRequest = {
	queries: string[];
	dateFrom: string;
	dateTo: string;
	includeFoundations: boolean;
	limit: number;
	attempt: number;
	/** No automatic attempt follows this one, so a stale cached answer beats none. */
	finalAttempt: boolean;
	/** Paid routes with a configured price; the source must not call any other paid route. */
	routes: string[];
	cache: SourceCache;
	/** Runs one provider request as the deployment's only one, spaced by `minIntervalSeconds`. */
	pace: <T>(request: () => Promise<T>) => Promise<T>;
};
export type SourceResult = {
	outcome: "succeeded" | "empty" | "partial";
	records: SourceRecord[];
	reportedCount: number;
	cursor: string | null;
	cacheAgeSeconds: number | null;
	truncated: boolean;
	/**
	 * Billable requests per route, used to reconcile metered usage. A request whose outcome is
	 * unknown counts as billed.
	 */
	usage: Record<string, number>;
	errorClass: string | null;
	/** The provider asked every caller to wait this long before its next request. */
	pauseSeconds?: number;
};
type ChargeRequest = Pick<
	SourceRequest,
	"queries" | "limit" | "includeFoundations" | "routes"
>;
export type LiteratureSource = {
	id: string;
	label: string;
	/** Paid routes, each priced separately; the first is required and the rest are optional stages. */
	routes: string[];
	/** A deployment-wide daily quota must be configured before this source runs. */
	quotaRequired: boolean;
	/** Returns fabricated records; offered only where fixture sources are enabled. */
	fixture?: boolean;
	/** Provider terms allow one connection at a time with this gap, across every worker. */
	minIntervalSeconds?: number;
	filters: (
		scope: LiteratureScope,
		routes: string[],
	) => { applied: string[]; unsupported: string[] };
	/** The most billable requests per route one attempt can make; reserved before it starts. */
	maxRequests: (request: ChargeRequest) => Record<string, number>;
	search: (request: SourceRequest) => Promise<SourceResult>;
};

const digest = (text: string) =>
	createHash("sha256").update(text).digest("hex").slice(0, 12);

/**
 * Deterministic, free stand-ins for literature providers. Records name a query only by its
 * digest: papers are shared public facts that outlive the private project that searched them.
 * Queries containing `fixture:<behavior>` (or `fixture:<catalog|metered>-<behavior>` for one
 * source) select empty, partial, broad, cached, flaky, outage or uncertain outcomes.
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
		routes: metered ? [id] : [],
		quotaRequired: false,
		fixture: true,
		filters: ({ dateFrom, dateTo, includeFoundations }) => ({
			applied: [
				`publication date ${dateFrom} to ${dateTo}`,
				...(includeFoundations && !metered ? ["older foundational work"] : []),
			],
			unsupported:
				includeFoundations && metered ? ["older foundational work"] : [],
		}),
		maxRequests: ({ queries }) => (metered ? { [id]: queries.length } : {}),
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
				for (let i = 0; i < perQuery; i++) {
					const year = toYear - (i % (toYear - fromYear + 1));
					discovery.push({
						key: `fixture:${hash}:${i}`,
						title: `Fixture study ${i + 1} for query ${hash}`,
						authors: ["A. Fixture", "B. Example"],
						year,
						doi: `10.5555/fixture.${hash}.${i}`,
						url: null,
						acquisitionReason: "discovery",
						publicationDate: `${year}-03-01`,
						preprint: i % 3 === 0 ? true : i % 3 === 1 ? false : null,
						abstractAvailable: i % 2 === 0,
					});
				}
				for (let i = 0; i < foundations; i++)
					older.push({
						key: `fixture:${hash}:foundation:${i}`,
						title: `Foundational fixture ${i + 1} for query ${hash}`,
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
				usage: metered ? { [id]: request.queries.length } : {},
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
	/** Without credentials it fails visibly; the worker supplies a configured instance. */
	openalex: createOpenAlexSource({}),
	arxiv: createArxivSource({}),
};

/** Micro-dollars per request on each paid route; a source whose required route is unpriced is disabled. */
export type SourcePrices = Partial<Record<string, number>>;
/** Micro-dollars per UTC day per source, shared by every worker in the deployment. */
export type SourceQuotas = Partial<Record<string, number>>;
function parseUsdTable(json: string | undefined) {
	if (!json) return {};
	const usd = z
		.record(z.string(), z.number().nonnegative())
		.parse(JSON.parse(json));
	return Object.fromEntries(
		Object.entries(usd).map(([id, price]) => [id, Math.round(price * 1e6)]),
	);
}
/** JSON of US dollars per request, keyed by route. */
export const parseSourcePrices = (json: string | undefined): SourcePrices =>
	parseUsdTable(json);
/** JSON of US dollars per UTC day, keyed by source. */
export const parseSourceQuotas = (json: string | undefined): SourceQuotas =>
	parseUsdTable(json);

export type SourceSettings = {
	prices: SourcePrices;
	quotas: SourceQuotas;
	/** Fixture sources fabricate papers, so only tests and local development enable them. */
	fixtureSources: boolean;
};
/** Which paid routes are usable now, or why the whole source is disabled. */
export function sourceAvailability(
	source: LiteratureSource,
	{ prices, quotas, fixtureSources }: SourceSettings,
) {
	const [required] = source.routes;
	const blockedBy =
		source.fixture && !fixtureSources
			? ("fixtures-disabled" as const)
			: required !== undefined && prices[required] === undefined
				? ("pricing-unknown" as const)
				: source.quotaRequired && quotas[source.id] === undefined
					? ("quota-unknown" as const)
					: null;
	return {
		blockedBy,
		routes: source.routes.filter((route) => prices[route] !== undefined),
	};
}
/** The conservative maximum one attempt can cost, reserved before it starts. */
export function maxChargeMicros(
	source: LiteratureSource,
	request: ChargeRequest,
	prices: SourcePrices,
) {
	return Object.entries(source.maxRequests(request)).reduce(
		(total, [route, requests]) => total + (prices[route] ?? 0) * requests,
		0,
	);
}
export const usageMicros = (
	usage: Record<string, number>,
	prices: SourcePrices,
) =>
	Object.entries(usage).reduce(
		(total, [route, requests]) => total + (prices[route] ?? 0) * requests,
		0,
	);
