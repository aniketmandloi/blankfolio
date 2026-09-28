/**
 * Responses shaped like OpenAlex's documented `/works` list answers (Work object, `meta`,
 * cursor paging and `X-RateLimit-*` headers; help.openalex.org, checked 28 September 2026).
 * Every value is synthetic; nothing here reaches the network.
 */
export type OpenAlexWorkFixture = {
	id: string;
	doi: string | null;
	ids: Record<string, string>;
	display_name: string | null;
	title: string | null;
	publication_date: string | null;
	publication_year: number | null;
	type: string | null;
	primary_location: {
		landing_page_url: string | null;
		pdf_url: string | null;
		version: string | null;
		is_oa: boolean;
		source: { display_name: string; type: string } | null;
	} | null;
	authorships: { author: { id: string; display_name: string } }[];
	abstract_inverted_index: Record<string, number[]> | null;
	referenced_works: string[];
	cited_by_count: number;
	updated_date: string;
	created_date: string;
	is_retracted: boolean;
};

export function openAlexWork(
	id: number,
	overrides: Partial<OpenAlexWorkFixture> = {},
): OpenAlexWorkFixture {
	const year = overrides.publication_year ?? 2024;
	const title = `Recorded work W${id}`;
	return {
		id: `https://openalex.org/W${id}`,
		doi: `https://doi.org/10.1234/Recorded.${id}`,
		ids: {
			openalex: `https://openalex.org/W${id}`,
			doi: `https://doi.org/10.1234/Recorded.${id}`,
		},
		display_name: title,
		title,
		publication_date: `${year}-05-17`,
		publication_year: year,
		type: "article",
		primary_location: {
			landing_page_url: `https://publisher.example/articles/${id}`,
			pdf_url: `https://publisher.example/articles/${id}.pdf`,
			version: "publishedVersion",
			is_oa: false,
			source: { display_name: "Journal of Recorded Results", type: "journal" },
		},
		authorships: [
			{ author: { id: "https://openalex.org/A1", display_name: "Ada Record" } },
			{ author: { id: "https://openalex.org/A2", display_name: "Ben Sample" } },
		],
		abstract_inverted_index: { Recorded: [0], abstract: [1] },
		referenced_works: [],
		cited_by_count: 3,
		updated_date: "2026-09-20T04:11:52.123456",
		created_date: "2025-01-02",
		is_retracted: false,
		...overrides,
	};
}

export function openAlexPage(
	results: OpenAlexWorkFixture[],
	count = results.length,
	nextCursor: string | null = null,
) {
	return {
		meta: {
			count,
			db_response_time_ms: 41,
			page: null,
			per_page: 100,
			next_cursor: nextCursor,
			groups_count: null,
		},
		results,
		group_by: [],
	};
}

type Handler = (url: URL, attempt: number) => Response | Promise<Response>;
export const rateHeaders = (remaining = 9_995, reset = 43_200) => ({
	"content-type": "application/json",
	"x-ratelimit-limit": "10000",
	"x-ratelimit-remaining": String(remaining),
	"x-ratelimit-credits-used": "1",
	"x-ratelimit-reset": String(reset),
});
export const json = (body: unknown, init: ResponseInit = {}) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: rateHeaders(),
		...init,
	});
export const timeout = () =>
	Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));

/** A recording `fetch` that routes each request to `handler`. */
export function openAlexFetch(handler: Handler) {
	const calls: { url: URL; authorization: string | null }[] = [];
	const fetch = async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		calls.push({
			url,
			authorization: new Headers(init?.headers).get("authorization"),
		});
		return handler(url, calls.length);
	};
	return { fetch: fetch as typeof globalThis.fetch, calls };
}
