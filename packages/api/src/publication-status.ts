import type {
	PaperStatusCheck,
	PublicationUpdate,
} from "@blankfolio/db/schema/literature";

/** Most severe first; the first update type present decides the state. */
const severity: [PublicationState, string[], "disallowed" | "review"][] = [
	["retracted", ["retraction"], "disallowed"],
	["withdrawn", ["withdrawal"], "disallowed"],
	["removed", ["removal"], "disallowed"],
	["concern", ["expression_of_concern", "partial_retraction"], "review"],
	[
		"corrected",
		["correction", "erratum", "corrigendum", "addendum", "clarification"],
		"review",
	],
];
export type PublicationState =
	| "retracted"
	| "withdrawn"
	| "removed"
	| "concern"
	| "corrected"
	| "updated"
	| "no-known-updates"
	| "unknown";

/**
 * What a snapshot recorded about a paper's corrections and retractions. Retracted, withdrawn
 * or removed work cannot count as ordinary positive support; other notices need review. A
 * missing or failed check is `unknown`, never clearance.
 */
export function publicationStatusView(
	check: PaperStatusCheck | null,
	providerUpdates: PublicationUpdate[],
	latestRevision: number | undefined,
) {
	const checked =
		check?.check === "checked" || check?.check === "not-registered"
			? check
			: null;
	const updates = [...(checked?.updates ?? []), ...providerUpdates].sort(
		(a, b) => (a.date ?? "").localeCompare(b.date ?? ""),
	);
	const types = new Set(updates.map((update) => update.type));
	const [state, , positiveSupport] = severity.find(([, names]) =>
		names.some((name) => types.has(name)),
	) ?? [
		updates.length
			? "updated"
			: check?.check === "checked"
				? "no-known-updates"
				: "unknown",
		[],
		updates.length ? "review" : "allowed",
	];
	return {
		state,
		positiveSupport,
		check: check?.check ?? "not-run",
		checkedAt: checked?.checkedAt ?? null,
		/** A later check found a different status; this snapshot keeps the one it recorded. */
		newerStatusKnown:
			checked !== null &&
			latestRevision !== undefined &&
			latestRevision > checked.revision,
		updates,
	};
}
