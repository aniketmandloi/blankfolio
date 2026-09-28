/**
 * Answers shaped like Crossref's `GET /works/{doi}` (message `updated-by`/`update-to` entries
 * with `type`, `label`, `source` and `updated`, `relation`, and the `x-rate-limit-*` headers of
 * the polite single-record pool; checked against a live record on 28 September 2026).
 * Every value is synthetic; nothing here reaches the network.
 */
export type CrossrefUpdate = {
	DOI: string;
	type: string;
	label: string;
	source: "publisher" | "retraction-watch";
	updated: { "date-parts": number[][]; "date-time": string; timestamp: number };
	"record-id"?: string;
};

export function crossrefUpdate(
	type: string,
	label: string,
	date: string,
	overrides: Partial<CrossrefUpdate> = {},
): CrossrefUpdate {
	const time = Date.parse(`${date}T00:00:00Z`);
	return {
		DOI: `10.1234/notice.${type}.${date}`,
		type,
		label,
		source: "retraction-watch",
		updated: {
			"date-parts": [date.split("-").map(Number)],
			"date-time": `${date}T00:00:00Z`,
			timestamp: time,
		},
		"record-id": "4036",
		...overrides,
	};
}

export function crossrefWork(
	doi: string,
	message: {
		"updated-by"?: CrossrefUpdate[];
		"update-to"?: CrossrefUpdate[];
		relation?: Record<
			string,
			{ "id-type": string; id: string; "asserted-by": string }[]
		>;
		type?: string;
	} = {},
) {
	return {
		status: "ok",
		"message-type": "work",
		"message-version": "1.0.0",
		message: {
			DOI: doi.toLowerCase(),
			type: "journal-article",
			title: [`Recorded Crossref work ${doi}`],
			publisher: "Recorded Publisher",
			indexed: {
				"date-parts": [[2026, 9, 25]],
				"date-time": "2026-09-25T00:46:39Z",
				timestamp: 1790297199869,
				version: "4.1.0",
			},
			relation: {},
			...message,
		},
	};
}

export const crossrefHeaders = {
	"content-type": "application/json",
	"x-rate-limit-limit": "10",
	"x-rate-limit-interval": "1s",
	"x-concurrency-limit": "3",
	"x-api-pool": "polite-single",
};
export const crossrefJson = (body: unknown, init: ResponseInit = {}) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: crossrefHeaders,
		...init,
	});
export const crossrefNotFound = () =>
	new Response("Resource not found.", {
		status: 404,
		headers: { "content-type": "text/plain" },
	});
