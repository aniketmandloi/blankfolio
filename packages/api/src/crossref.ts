import type {
	PublicationUpdate,
	RelatedVersion,
} from "@blankfolio/db/schema/literature";
import { z } from "zod";

export type StatusLookup =
	| {
			outcome: "checked";
			updates: PublicationUpdate[];
			relatedVersions: RelatedVersion[];
	  }
	| { outcome: "not-registered" }
	| {
			outcome: "failed";
			errorClass: string;
			/** Nothing suggests the same request would fail again. */
			retryable: boolean;
			retryAfterSeconds?: number;
	  };

/** Looks up what a registration agency knows about a DOI's corrections, retractions and versions. */
export type PublicationStatusSource = {
	id: string;
	/** Whether this agency registers the DOI at all; others are never sent. */
	covers: (doi: string) => boolean;
	/** The shortest gap between lookups across every worker. */
	minIntervalSeconds: number;
	lookup: (doi: string) => Promise<StatusLookup>;
};

const worksUrl = "https://api.crossref.org/works";
/** DataCite registers arXiv's DOIs, and fixture DOIs are fabricated. */
const otherAgencies = /^10\.(48550|5555)\//;
const relations: Record<string, RelatedVersion["relation"]> = {
	"has-preprint": "preprint",
	"is-preprint-of": "published-version",
};

const updateSchema = z.object({
	DOI: z.string().nullish(),
	type: z.string(),
	label: z.string().nullish(),
	source: z.string().nullish(),
	updated: z.object({ "date-time": z.string().nullish() }).nullish(),
});
const workSchema = z.object({
	message: z.object({
		"updated-by": z.array(updateSchema).nullish(),
		relation: z
			.record(
				z.string(),
				z.array(z.object({ "id-type": z.string(), id: z.string() })),
			)
			.nullish(),
	}),
});

function waitSeconds(headers: Headers) {
	const seconds = Number(headers.get("retry-after"));
	return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60;
}

/**
 * Crossref's single-record endpoint, free and unmetered. Identifying requests with `mailto`
 * joins the polite pool; without it the public pool's lower limits apply.
 */
export function createCrossrefStatus({
	mailto,
	fetch: fetchImpl = globalThis.fetch,
	timeoutMs = 30_000,
}: {
	mailto?: string;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
}): PublicationStatusSource {
	return {
		id: "crossref",
		covers: (doi) => !otherAgencies.test(doi),
		// The public pool allows five single-record requests a second.
		minIntervalSeconds: 0.2,
		async lookup(doi) {
			const query = mailto ? `?${new URLSearchParams({ mailto })}` : "";
			let response: Response;
			let body: unknown;
			try {
				response = await fetchImpl(
					`${worksUrl}/${encodeURIComponent(doi)}${query}`,
					{
						headers: { Accept: "application/json" },
						signal: AbortSignal.timeout(timeoutMs),
					},
				);
				if (response.status === 404) return { outcome: "not-registered" };
				if (response.status === 429)
					return {
						outcome: "failed",
						errorClass: "rate-limited",
						retryable: true,
						retryAfterSeconds: waitSeconds(response.headers),
					};
				if (response.status >= 500)
					return {
						outcome: "failed",
						errorClass: "source-error",
						retryable: true,
					};
				if (!response.ok)
					return {
						outcome: "failed",
						errorClass: "request-rejected",
						retryable: false,
					};
				body = await response.json();
			} catch {
				return { outcome: "failed", errorClass: "timeout", retryable: true };
			}
			const work = workSchema.safeParse(body);
			if (!work.success)
				return {
					outcome: "failed",
					errorClass: "invalid-response",
					retryable: false,
				};
			const { message } = work.data;
			return {
				outcome: "checked",
				updates: (message["updated-by"] ?? [])
					.map((update) => ({
						type: update.type,
						label: update.label ?? update.type,
						source: update.source ?? "publisher",
						notice: update.DOI ? `doi:${update.DOI.toLowerCase()}` : null,
						date: update.updated?.["date-time"]?.slice(0, 10) ?? null,
					}))
					.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "")),
				relatedVersions: Object.entries(message.relation ?? {}).flatMap(
					([name, targets]) => {
						const relation = relations[name];
						return relation
							? targets
									.filter((target) => target["id-type"] === "doi")
									.map((target) => ({
										identifier: `doi:${target.id.toLowerCase()}`,
										relation,
										note: "Crossref",
									}))
							: [];
					},
				),
			};
		},
	};
}
