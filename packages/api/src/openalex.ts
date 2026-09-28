import type {
	AcquisitionReason,
	SourceRecord,
} from "@blankfolio/db/schema/literature";
import { z } from "zod";
import type {
	LiteratureSource,
	SourceRequest,
	SourceResult,
} from "./literature-sources";
import {
	maxRetryAfterSeconds,
	SourceUnavailableError,
	TransientSourceError,
	UncertainSourceOutcome,
} from "./source-errors";

/** OpenAlex bills keyword searches and list/filter calls separately; singleton lookups are free. */
export const openAlexRoutes = {
	search: "openalex-search",
	filter: "openalex-filter",
} as const;
const worksUrl = "https://api.openalex.org/works";
const select =
	"id,doi,ids,display_name,publication_date,publication_year,type,primary_location,authorships,abstract_inverted_index,referenced_works,updated_date";
const perPage = 100;
/** Cached answers younger than this are reused instead of calling OpenAlex again. */
const freshCacheSeconds = 24 * 60 * 60;
/** Discovery results whose references seed the older-work expansion. */
const foundationSeeds = 25;

const workSchema = z.object({
	id: z.string(),
	doi: z.string().nullish(),
	ids: z.record(z.string(), z.unknown()).nullish(),
	display_name: z.string().nullish(),
	publication_date: z.string().nullish(),
	publication_year: z.number().int().nullish(),
	type: z.string().nullish(),
	primary_location: z
		.object({
			landing_page_url: z.string().nullish(),
			version: z.string().nullish(),
		})
		.nullish(),
	authorships: z
		.array(
			z.object({
				author: z.object({ display_name: z.string().nullish() }).nullish(),
			}),
		)
		.nullish(),
	abstract_inverted_index: z.record(z.string(), z.unknown()).nullish(),
	referenced_works: z.array(z.string()).nullish(),
	updated_date: z.string().nullish(),
});
const pageSchema = z.object({
	meta: z.object({ count: z.number(), next_cursor: z.string().nullish() }),
	results: z.array(workSchema),
});
type Work = z.infer<typeof workSchema>;
/** What is cached: the abstract itself is dropped, only its availability is kept. */
type Page = {
	meta: { count: number; next_cursor: string | null };
	results: (Omit<Work, "abstract_inverted_index"> & {
		has_abstract: boolean;
	})[];
};
const cachedPageSchema = z.object({
	meta: z.object({ count: z.number(), next_cursor: z.string().nullable() }),
	results: z.array(workSchema.extend({ has_abstract: z.boolean() })),
});

function compact(page: z.infer<typeof pageSchema>): Page {
	return {
		meta: {
			count: page.meta.count,
			next_cursor: page.meta.next_cursor ?? null,
		},
		results: page.results.map(({ abstract_inverted_index, ...work }) => ({
			...work,
			has_abstract: Boolean(
				abstract_inverted_index && Object.keys(abstract_inverted_index).length,
			),
		})),
	};
}

const shortId = (id: string) => id.replace(/^https?:\/\/openalex\.org\//i, "");
const normalizeDoi = (doi: string) =>
	doi.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)/i, "").toLowerCase();

/** A query that is exactly a DOI or OpenAlex work ID becomes a direct lookup filter. */
function lookupFilter(query: string) {
	const text = query.trim();
	const doi = text.match(
		/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)?(10\.\d{4,9}\/[^\s,|]+)$/i,
	)?.[1];
	if (doi) return `doi:${doi.toLowerCase()}`;
	const work = text.match(/^(?:https?:\/\/openalex\.org\/)?(W\d+)$/i)?.[1];
	return work ? `openalex:${work.toUpperCase()}` : null;
}

function dayBefore(date: string) {
	return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000)
		.toISOString()
		.slice(0, 10);
}

function httpUrl(value: string | null | undefined) {
	if (!value) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:"
			? url.href
			: null;
	} catch {
		return null;
	}
}

function toRecord(
	work: Page["results"][number],
	acquisitionReason: AcquisitionReason,
): SourceRecord | null {
	const id = shortId(work.id);
	const year =
		work.publication_year ??
		(work.publication_date
			? Number(work.publication_date.slice(0, 4))
			: Number.NaN);
	if (!Number.isInteger(year)) return null;
	const doi = work.doi ? normalizeDoi(work.doi) : null;
	const arxiv = doi?.match(/^10\.48550\/arxiv\.(.+)$/)?.[1];
	const pmid = String(work.ids?.pmid ?? "").match(/(\d+)\/?$/)?.[1];
	const version = work.primary_location?.version;
	return {
		key: doi ? `doi:${doi}` : `openalex:${id}`,
		title: work.display_name?.trim() || `Untitled OpenAlex work ${id}`,
		authors: (work.authorships ?? [])
			.flatMap((authorship) => authorship.author?.display_name ?? [])
			.slice(0, 50),
		year,
		doi,
		url:
			httpUrl(work.primary_location?.landing_page_url) ??
			(doi ? `https://doi.org/${doi}` : `https://openalex.org/${id}`),
		acquisitionReason,
		identifiers: [
			...(doi ? [`doi:${doi}`] : []),
			`openalex:${id}`,
			...(arxiv ? [`arxiv:${arxiv}`] : []),
			...(pmid ? [`pmid:${pmid}`] : []),
		],
		publicationDate: work.publication_date ?? null,
		preprint:
			work.type === "preprint" || version === "submittedVersion"
				? true
				: version === "publishedVersion"
					? false
					: null,
		workType: work.type ?? null,
		abstractAvailable: work.has_abstract,
		sourceUpdatedAt: work.updated_date ?? null,
	};
}

/** Seconds from `Retry-After` or `X-RateLimit-Reset`, accepting delays or epoch times. */
function waitSeconds(headers: Headers, now: Date) {
	const value = headers.get("retry-after") ?? headers.get("x-ratelimit-reset");
	if (!value) return null;
	const number = Number(value);
	const seconds = Number.isFinite(number)
		? number > 1e9
			? number - now.getTime() / 1000
			: number
		: (Date.parse(value) - now.getTime()) / 1000;
	return Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : null;
}

type Plan = {
	lookups: string[];
	searches: { query: string; limit: number; pages: number }[];
	foundationLimit: number;
};
function plan({
	queries,
	limit,
	includeFoundations,
	routes,
}: Pick<
	SourceRequest,
	"queries" | "limit" | "includeFoundations" | "routes"
>): Plan {
	const filterPriced = routes.includes(openAlexRoutes.filter);
	const lookups = filterPriced
		? queries.flatMap((query) => lookupFilter(query) ?? [])
		: [];
	const searched = queries.filter(
		(query) => !filterPriced || !lookupFilter(query),
	);
	const foundationLimit =
		includeFoundations && filterPriced ? Math.floor(limit / 4) : 0;
	const discovery = Math.max(0, limit - foundationLimit - lookups.length);
	return {
		lookups,
		searches: searched.map((query, index) => {
			const share =
				Math.floor(discovery / searched.length) +
				(index < discovery % searched.length ? 1 : 0);
			return { query, limit: share, pages: Math.ceil(share / perPage) };
		}),
		foundationLimit,
	};
}

type Failure = {
	errorClass: string;
	retryAfter: number;
	/** The request may have been billed. */
	uncertain?: boolean;
	/** Retrying the same request cannot help. */
	permanent?: boolean;
};

export function createOpenAlexSource({
	apiKey,
	fetch: fetchImpl = globalThis.fetch,
	timeoutMs = 30_000,
	now = () => new Date(),
}: {
	apiKey?: string;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	now?: () => Date;
}): LiteratureSource {
	return {
		id: "openalex",
		label: "OpenAlex",
		routes: [openAlexRoutes.search, openAlexRoutes.filter],
		quotaRequired: true,
		filters: (scope, routes) => {
			const filterPriced = routes.includes(openAlexRoutes.filter);
			const identifiers = scope.queries.some((query) => lookupFilter(query));
			return {
				applied: [
					`from_publication_date:${scope.dateFrom},to_publication_date:${scope.dateTo} on search queries`,
					...(identifiers && filterPriced
						? [
								"identifier queries looked up directly (doi: or openalex: filter) without the date filter",
							]
						: []),
					...(scope.includeFoundations && filterPriced
						? [
								`older foundational work: works cited by the top ${foundationSeeds} results, to_publication_date:${dayBefore(scope.dateFrom)}`,
							]
						: []),
				],
				unsupported: [
					...(scope.includeFoundations && !filterPriced
						? ["older foundational work (citation lookups are not priced)"]
						: []),
					...(identifiers && !filterPriced
						? [
								"direct identifier lookups (not priced, so identifier queries were searched as text)",
							]
						: []),
				],
			};
		},
		maxRequests: (request) => {
			const { lookups, searches, foundationLimit } = plan(request);
			const filters = lookups.length + (foundationLimit ? 1 : 0);
			return {
				[openAlexRoutes.search]: searches.reduce((n, s) => n + s.pages, 0),
				...(filters ? { [openAlexRoutes.filter]: filters } : {}),
			};
		},
		async search(request): Promise<SourceResult> {
			if (!apiKey) throw new SourceUnavailableError("credentials-missing");
			const { lookups, searches, foundationLimit } = plan(request);
			const usage: Record<string, number> = {};
			const bill = (route: string) => {
				usage[route] = (usage[route] ?? 0) + 1;
			};
			let answered = false;
			let failure: Failure | null = null;
			let stale = false;
			let cacheAgeSeconds: number | null = null;
			let pauseSeconds: number | undefined;

			async function call(
				route: string,
				url: string,
			): Promise<{ page: Page } | { failure: Failure }> {
				let response: Response;
				try {
					response = await fetchImpl(url, {
						headers: {
							Authorization: `Bearer ${apiKey}`,
							Accept: "application/json",
						},
						signal: AbortSignal.timeout(timeoutMs),
					});
				} catch {
					bill(route);
					return {
						failure: { errorClass: "timeout", retryAfter: 0, uncertain: true },
					};
				}
				const wait = waitSeconds(response.headers, now());
				if (response.status === 429)
					return {
						failure: { errorClass: "rate-limited", retryAfter: wait ?? 1 },
					};
				if (response.status >= 500)
					return { failure: { errorClass: "source-error", retryAfter: 0 } };
				if (!response.ok)
					return {
						failure: {
							errorClass: "request-rejected",
							retryAfter: 0,
							permanent: true,
						},
					};
				bill(route);
				if (response.headers.get("x-ratelimit-remaining") === "0" && wait)
					pauseSeconds = Math.max(pauseSeconds ?? 0, wait);
				let body: unknown;
				try {
					body = await response.json();
				} catch {
					return {
						failure: { errorClass: "timeout", retryAfter: 0, uncertain: true },
					};
				}
				const page = pageSchema.safeParse(body);
				return page.success
					? { page: compact(page.data) }
					: {
							failure: {
								errorClass: "invalid-response",
								retryAfter: 0,
								permanent: true,
							},
						};
			}

			/** One page from a fresh cache, OpenAlex, or after a failure a stale cache; null if none. */
			async function get(
				route: string,
				params: Record<string, string>,
			): Promise<Page | null> {
				const url = `${worksUrl}?${new URLSearchParams({ ...params, select })}`;
				const hit = await request.cache.get(url);
				const cached = hit ? cachedPageSchema.safeParse(hit.body) : null;
				const age = hit
					? Math.max(
							0,
							Math.round((now().getTime() - hit.fetchedAt.getTime()) / 1000),
						)
					: 0;
				const fromCache = () => {
					answered = true;
					cacheAgeSeconds = Math.max(cacheAgeSeconds ?? 0, age);
					return cached?.success ? cached.data : null;
				};
				if (cached?.success && age <= freshCacheSeconds) return fromCache();
				if (!failure) {
					const answer = await call(route, url);
					if ("page" in answer) {
						answered = true;
						await request.cache.set(url, answer.page);
						return answer.page;
					}
					failure = answer.failure;
					// Nothing answered yet: let the worker retry, hold or fail the whole attempt.
					const retryable =
						!failure.uncertain &&
						!failure.permanent &&
						!request.finalAttempt &&
						failure.retryAfter <= maxRetryAfterSeconds;
					if (!answered && (!cached?.success || retryable)) {
						if (failure.uncertain) throw new UncertainSourceOutcome();
						if (failure.permanent)
							throw new SourceUnavailableError(failure.errorClass, usage);
						throw new TransientSourceError(failure.retryAfter);
					}
				}
				if (!cached?.success) return null;
				stale = true;
				return fromCache();
			}

			const records: SourceRecord[] = [];
			const references: string[][] = [];
			const seen = new Set<string>();
			const add = (
				work: Page["results"][number],
				reason: AcquisitionReason,
			) => {
				const id = shortId(work.id);
				if (seen.has(id)) return false;
				const record = toRecord(work, reason);
				if (!record) return false;
				seen.add(id);
				records.push(record);
				references.push((work.referenced_works ?? []).map(shortId));
				return true;
			};
			let reportedCount = 0;
			let truncated = false;

			for (const filter of lookups) {
				const page = await get(openAlexRoutes.filter, {
					filter,
					per_page: "1",
				});
				if (!page) continue;
				reportedCount += page.meta.count;
				const [work] = page.results;
				if (work) add(work, "direct-lookup");
			}

			const cursors: (string | null)[] = [];
			for (const { query, limit, pages } of searches) {
				let cursor: string | null = "*";
				let collected = 0;
				for (let fetched = 0; cursor && fetched < pages; fetched++) {
					const page = await get(openAlexRoutes.search, {
						search: query,
						filter: `from_publication_date:${request.dateFrom},to_publication_date:${request.dateTo}`,
						per_page: String(Math.min(perPage, limit - collected)),
						cursor,
					});
					if (!page) break;
					if (fetched === 0) reportedCount += page.meta.count;
					for (const work of page.results)
						if (collected < limit && add(work, "discovery")) collected++;
					cursor = page.results.length ? page.meta.next_cursor : null;
					if (collected >= limit) break;
				}
				if (cursor) truncated = true;
				cursors.push(cursor);
			}

			if (foundationLimit) {
				const citedBy = new Map<string, number>();
				for (const cited of references.slice(0, foundationSeeds))
					for (const id of cited)
						if (!seen.has(id)) citedBy.set(id, (citedBy.get(id) ?? 0) + 1);
				const candidates = [...citedBy.entries()]
					.sort((a, b) => b[1] - a[1])
					.slice(0, perPage)
					.map(([id]) => id);
				const page = candidates.length
					? await get(openAlexRoutes.filter, {
							filter: `openalex:${candidates.join("|")},to_publication_date:${dayBefore(request.dateFrom)}`,
							per_page: String(perPage),
						})
					: null;
				if (page) {
					reportedCount += page.meta.count;
					let kept = 0;
					for (const work of [...page.results].sort(
						(a, b) =>
							(citedBy.get(shortId(b.id)) ?? 0) -
							(citedBy.get(shortId(a.id)) ?? 0),
					))
						if (kept < foundationLimit && add(work, "citation")) kept++;
					if (page.meta.count > kept) truncated = true;
				}
			}

			const failed = failure as Failure | null;
			return {
				outcome: failed ? "partial" : records.length ? "succeeded" : "empty",
				records,
				reportedCount,
				cursor: cursors.some(Boolean) ? JSON.stringify(cursors) : null,
				cacheAgeSeconds,
				truncated,
				usage,
				errorClass: failed ? (stale ? "stale-cache" : failed.errorClass) : null,
				...(pauseSeconds ? { pauseSeconds } : {}),
			};
		},
	};
}
