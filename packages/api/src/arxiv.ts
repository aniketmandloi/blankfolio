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
} from "./source-errors";

const queryUrl = "https://export.arxiv.org/api/query";
const perPage = 100;
/** Cached answers younger than this are reused instead of calling arXiv again. */
const freshCacheSeconds = 24 * 60 * 60;

/** New-style (`2206.15306`) or old-style (`cs/0112017`) identifiers, without a version. */
const idPattern = String.raw`(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})`;
/** A query that is exactly an arXiv identifier, abstract URL or arXiv DOI becomes a lookup. */
function lookupId(query: string) {
	return (
		query
			.trim()
			.match(
				new RegExp(
					String.raw`^(?:arxiv:|https?:\/\/arxiv\.org\/abs\/|(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)?10\.48550\/arxiv\.)?${idPattern}(?:v\d+)?$`,
					"i",
				),
			)?.[1]
			?.toLowerCase() ?? null
	);
}

/**
 * Every word must appear somewhere in the record. Words are lowercased so none is read as an
 * `AND`/`OR`/`ANDNOT` operator, and punctuation that arXiv's query syntax would interpret is dropped.
 */
function searchExpression(query: string, dateFrom: string, dateTo: string) {
	const terms = query
		.toLowerCase()
		.split(/\s+/)
		.map((word) => word.replace(/[^\p{L}\p{N}.-]/gu, ""))
		.filter(Boolean);
	if (!terms.length) return null;
	const day = (date: string) => date.replaceAll("-", "");
	return `${terms.map((term) => `all:${term}`).join(" AND ")} AND submittedDate:[${day(dateFrom)}0000 TO ${day(dateTo)}2359]`;
}

type Plan = {
	ids: string[];
	searches: { expression: string; limit: number }[];
	unsearchable: number;
};
function plan({
	queries,
	limit,
	dateFrom,
	dateTo,
}: Pick<SourceRequest, "queries" | "limit" | "dateFrom" | "dateTo">): Plan {
	const ids = [...new Set(queries.flatMap((query) => lookupId(query) ?? []))];
	const expressions = queries
		.filter((query) => !lookupId(query))
		.map((query) => searchExpression(query, dateFrom, dateTo));
	const searched = expressions.filter((e): e is string => e !== null);
	const discovery = Math.max(0, limit - ids.length);
	return {
		ids,
		searches: searched.map((expression, index) => ({
			expression,
			limit:
				Math.floor(discovery / searched.length) +
				(index < discovery % searched.length ? 1 : 0),
		})),
		unsearchable: expressions.length - searched.length,
	};
}

const entrySchema = z.object({
	id: z.string(),
	version: z.number().int().positive(),
	title: z.string(),
	hasAbstract: z.boolean(),
	authors: z.array(z.string()),
	published: z.string(),
	updated: z.string().nullable(),
	doi: z.string().nullable(),
	journalRef: z.string().nullable(),
	comment: z.string().nullable(),
});
/** What is cached: abstracts are dropped, only their availability is kept. */
const pageSchema = z.object({
	total: z.number().int().nonnegative(),
	entries: z.array(entrySchema),
});
type Page = z.infer<typeof pageSchema>;

const entities: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};
function decode(text: string) {
	return text.replace(
		/&(#x[\da-f]+|#\d+|[a-z]+);/gi,
		(entity, name: string) => {
			if (name[0] !== "#") return entities[name.toLowerCase()] ?? entity;
			const code =
				name[1]?.toLowerCase() === "x"
					? Number.parseInt(name.slice(2), 16)
					: Number(name.slice(1));
			return Number.isInteger(code) && code <= 0x10ffff
				? String.fromCodePoint(code)
				: entity;
		},
	);
}
const clean = (text: string) => decode(text).replace(/\s+/g, " ").trim();
function element(xml: string, tag: string) {
	const match = xml.match(
		new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`),
	);
	return match?.[1] === undefined ? null : clean(match[1]);
}

/** Reads the Atom feed; null when it is not one, or when arXiv answers with an error entry. */
function parseFeed(xml: string): Page | null {
	if (!/<feed[\s>]/.test(xml)) return null;
	const total = Number(element(xml, "opensearch:totalResults"));
	if (!Number.isInteger(total)) return null;
	const entries: Page["entries"] = [];
	for (const [, body = ""] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
		const idUrl = element(body, "id") ?? "";
		if (/\/api\/errors/.test(idUrl)) return null;
		const id = idUrl.match(
			new RegExp(String.raw`arxiv\.org\/abs\/${idPattern}v(\d+)$`, "i"),
		);
		const published = element(body, "published");
		if (!id?.[1] || !id[2] || !published) continue;
		const summary = element(body, "summary");
		const doi = element(body, "arxiv:doi");
		entries.push({
			id: id[1].toLowerCase(),
			version: Number(id[2]),
			title: element(body, "title") ?? "",
			hasAbstract: Boolean(summary),
			authors: [...body.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/g)]
				.map(([, name = ""]) => clean(name))
				.filter(Boolean),
			published,
			updated: element(body, "updated"),
			doi: doi ? (doi.split(/\s+/)[0]?.toLowerCase() ?? null) : null,
			journalRef: element(body, "arxiv:journal_ref"),
			comment: element(body, "arxiv:comment"),
		});
	}
	return { total, entries };
}

function toRecord(
	entry: Page["entries"][number],
	acquisitionReason: AcquisitionReason,
): SourceRecord | null {
	const year = Number(entry.published.slice(0, 4));
	if (!Number.isInteger(year)) return null;
	const doi = `10.48550/arxiv.${entry.id}`;
	return {
		key: `arxiv:${entry.id}`,
		title: entry.title || `Untitled arXiv preprint ${entry.id}`,
		authors: entry.authors.slice(0, 50),
		year,
		doi,
		url: `https://arxiv.org/abs/${entry.id}v${entry.version}`,
		acquisitionReason,
		identifiers: [`doi:${doi}`, `arxiv:${entry.id}`],
		publicationDate: entry.published.slice(0, 10),
		preprint: true,
		workType: "preprint",
		abstractAvailable: entry.hasAbstract,
		version: `v${entry.version}`,
		versionDate: entry.updated?.slice(0, 10) ?? null,
		relatedVersions: entry.doi
			? [
					{
						identifier: `doi:${entry.doi}`,
						relation: "published-version",
						note: entry.journalRef,
					},
				]
			: [],
	};
}

function waitSeconds(headers: Headers, now: Date) {
	const value = headers.get("retry-after");
	if (!value) return null;
	const number = Number(value);
	const seconds = Number.isFinite(number)
		? number
		: (Date.parse(value) - now.getTime()) / 1000;
	return Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : null;
}

type Failure = { errorClass: string; retryAfter: number; permanent?: boolean };

/**
 * arXiv's legacy API is free and its metadata CC0, but its terms allow one request every three
 * seconds over a single connection for everything the deployment runs, which `pace` enforces.
 */
export function createArxivSource({
	fetch: fetchImpl = globalThis.fetch,
	timeoutMs = 30_000,
	now = () => new Date(),
}: {
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	now?: () => Date;
}): LiteratureSource {
	return {
		id: "arxiv",
		label: "arXiv",
		routes: [],
		quotaRequired: false,
		minIntervalSeconds: 3,
		filters: (scope) => {
			const { ids, searches, unsearchable } = plan({ ...scope, limit: 0 });
			return {
				applied: [
					...searches.map((search) => search.expression),
					...(ids.length
						? [
								"arXiv identifiers looked up directly (id_list) without the date filter",
							]
						: []),
				],
				unsupported: [
					...(scope.includeFoundations
						? ["older foundational work (arXiv has no citation data)"]
						: []),
					...(unsearchable
						? ["a query with no searchable words was not sent to arXiv"]
						: []),
				],
			};
		},
		maxRequests: () => ({}),
		async search(request): Promise<SourceResult> {
			const { ids, searches } = plan(request);
			let answered = false;
			let failure: Failure | null = null;
			let stale = false;
			let cacheAgeSeconds: number | null = null;

			async function call(
				url: string,
			): Promise<{ page: Page } | { failure: Failure }> {
				let answer: { status: number; headers: Headers; body: string };
				try {
					answer = await request.pace(async () => {
						const response = await fetchImpl(url, {
							headers: { Accept: "application/atom+xml" },
							signal: AbortSignal.timeout(timeoutMs),
						});
						return {
							status: response.status,
							headers: response.headers,
							body: response.ok ? await response.text() : "",
						};
					});
				} catch {
					return { failure: { errorClass: "timeout", retryAfter: 0 } };
				}
				const wait = waitSeconds(answer.headers, now());
				if (answer.status === 429 || answer.status === 503)
					return {
						failure: { errorClass: "rate-limited", retryAfter: wait ?? 3 },
					};
				if (answer.status >= 500)
					return { failure: { errorClass: "source-error", retryAfter: 0 } };
				if (answer.status >= 400)
					return {
						failure: {
							errorClass: "request-rejected",
							retryAfter: 0,
							permanent: true,
						},
					};
				const page = parseFeed(answer.body);
				return page
					? { page }
					: {
							failure: {
								errorClass: "invalid-response",
								retryAfter: 0,
								permanent: true,
							},
						};
			}

			/** One page from a fresh cache, arXiv, or after a failure a stale cache; null if none. */
			async function get(params: Record<string, string>): Promise<Page | null> {
				const url = `${queryUrl}?${new URLSearchParams(params)}`;
				const hit = await request.cache.get(url);
				const cached = hit ? pageSchema.safeParse(hit.body) : null;
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
					const answer = await call(url);
					if ("page" in answer) {
						answered = true;
						await request.cache.set(url, answer.page);
						return answer.page;
					}
					failure = answer.failure;
					const retryable =
						!failure.permanent &&
						!request.finalAttempt &&
						failure.retryAfter <= maxRetryAfterSeconds;
					if (!answered && (!cached?.success || retryable)) {
						if (failure.permanent)
							throw new SourceUnavailableError(failure.errorClass);
						throw new TransientSourceError(failure.retryAfter);
					}
				}
				if (!cached?.success) return null;
				stale = true;
				return fromCache();
			}

			const records: SourceRecord[] = [];
			const seen = new Set<string>();
			const add = (
				entry: Page["entries"][number],
				reason: AcquisitionReason,
			) => {
				if (seen.has(entry.id)) return false;
				const record = toRecord(entry, reason);
				if (!record) return false;
				seen.add(entry.id);
				records.push(record);
				return true;
			};
			let reportedCount = 0;
			let truncated = false;

			if (ids.length) {
				const page = await get({
					id_list: ids.join(","),
					max_results: String(ids.length),
				});
				if (page) {
					reportedCount += page.total;
					for (const entry of page.entries) add(entry, "direct-lookup");
				}
			}

			const cursors: (number | null)[] = [];
			for (const { expression, limit } of searches) {
				let start: number | null = 0;
				let collected = 0;
				while (start !== null && collected < limit) {
					const page = await get({
						search_query: expression,
						start: String(start),
						max_results: String(Math.min(perPage, limit - collected)),
						sortBy: "relevance",
						sortOrder: "descending",
					});
					if (!page) break;
					if (start === 0) reportedCount += page.total;
					for (const entry of page.entries)
						if (collected < limit && add(entry, "discovery")) collected++;
					const next: number = start + page.entries.length;
					start = page.entries.length && next < page.total ? next : null;
				}
				if (start !== null) truncated = true;
				cursors.push(start);
			}

			const failed = failure as Failure | null;
			return {
				outcome: failed ? "partial" : records.length ? "succeeded" : "empty",
				records,
				reportedCount,
				cursor: cursors.some((c) => c !== null)
					? JSON.stringify(cursors)
					: null,
				cacheAgeSeconds,
				truncated,
				usage: {},
				errorClass: failed ? (stale ? "stale-cache" : failed.errorClass) : null,
			};
		},
	};
}
