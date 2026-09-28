"use client";

import type { AppRouter } from "@blankfolio/api/routers/index";
import { Button } from "@blankfolio/ui/components/button";
import { Input } from "@blankfolio/ui/components/input";
import { Label } from "@blankfolio/ui/components/label";
import { Textarea } from "@blankfolio/ui/components/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { ArrowLeft, Check, FileClock, Plus, X } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { trpc } from "@/utils/trpc";

type Outputs = inferRouterOutputs<AppRouter>["literature"];
type ScopeView = Outputs["scope"];
type Scope = ScopeView["scope"];
type Job = Outputs["jobs"]["items"][number];
type SourceOutcome = Outputs["snapshot"]["sources"][number];

const activeStates: Job["state"][] = ["queued", "running"];
const pollMilliseconds = 5_000;

const jobStateText: Record<Job["state"], string> = {
	queued: "Queued",
	running: "Searching",
	succeeded: "Snapshot saved",
	failed: "Failed",
	cancelled: "Cancelled",
};
const cancelReasonText: Record<NonNullable<Job["cancelReason"]>, string> = {
	researcher: "You cancelled this search.",
	archived: "Cancelled when the project was archived.",
	deleted: "Cancelled when the project was deleted.",
	"access-withdrawn": "Cancelled because pilot access was withdrawn.",
};
const errorText: Record<string, string> = {
	"all-sources-failed":
		"Every selected source failed, so no Literature Snapshot was created. This says nothing about gaps in the literature.",
	"worker-error":
		"The search stopped after repeated worker errors. Completed source results were kept.",
	"source-unavailable": "Unavailable after three attempts.",
	"uncertain-outcome":
		"The source may have processed a billed request but no answer arrived. Its reserved cost stays counted and it was not retried automatically.",
	"budget-exceeded": "Stopped by a spending limit.",
	"pricing-unknown": "Disabled because pricing is not configured.",
	"source-disabled": "This source is no longer enabled.",
	"query-failed": "At least one query failed at this source.",
};
const outcomeText: Record<SourceOutcome["status"], string> = {
	pending: "Waiting",
	running: "Searching",
	succeeded: "Answered",
	empty: "No matching records",
	partial: "Partial answer",
	failed: "Failed",
};

function dollars(micros: number) {
	return `$${(micros / 1e6).toFixed(2)}`;
}
function formatDate(value: Date | string) {
	return new Intl.DateTimeFormat("en", {
		month: "long",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date(value));
}
function messageOf(error: unknown) {
	return error instanceof Error ? error.message : "Please try again.";
}
function sameScope(left: Scope, right: Scope) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function OutcomeDetails({ outcome }: { outcome: SourceOutcome }) {
	return (
		<details className="history-entry">
			<summary>
				<span>{outcome.label}</span>
				<span className="outcome-status">
					{outcomeText[outcome.status]}
					{outcome.truncated ? " · truncated" : ""}
					{outcome.cacheAgeSeconds !== null ? " · cached" : ""}
				</span>
			</summary>
			<dl className="revision-fields">
				<div>
					<dt>Queries sent</dt>
					<dd>{outcome.effectiveQueries.join("\n")}</dd>
				</div>
				<div>
					<dt>Filters applied</dt>
					<dd>{outcome.appliedFilters.join("\n") || "None"}</dd>
				</div>
				<div>
					<dt>Not supported here</dt>
					<dd>{outcome.unsupportedFilters.join("\n") || "None"}</dd>
				</div>
				<div>
					<dt>Records</dt>
					<dd>
						{outcome.receivedCount === null
							? "None received"
							: `${outcome.receivedCount} received of ${outcome.reportedCount ?? "unknown"} reported (limit ${outcome.allocation})`}
					</dd>
				</div>
				{outcome.cacheAgeSeconds !== null && (
					<div>
						<dt>Cached data</dt>
						<dd>
							Served from a cache about{" "}
							{Math.round(outcome.cacheAgeSeconds / 3600)} hours old.
						</dd>
					</div>
				)}
				<div>
					<dt>Attempts</dt>
					<dd>{outcome.attempts}</dd>
				</div>
				{outcome.errorClass && (
					<div>
						<dt>Limitation</dt>
						<dd>{errorText[outcome.errorClass] ?? outcome.errorClass}</dd>
					</div>
				)}
			</dl>
		</details>
	);
}

function SnapshotView({
	projectId,
	snapshotId,
}: {
	projectId: string;
	snapshotId: string;
}) {
	const snapshotQuery = useQuery(
		trpc.literature.snapshot.queryOptions({ projectId, snapshotId }),
	);
	const snapshot = snapshotQuery.data;
	if (!snapshot)
		return (
			<p className="muted-copy" aria-live="polite">
				{snapshotQuery.isPending
					? "Loading the Literature Snapshot…"
					: messageOf(snapshotQuery.error)}
			</p>
		);
	return (
		<section className="history-panel" aria-labelledby="snapshot-heading">
			<h2 id="snapshot-heading">
				Searched{" "}
				<time dateTime={new Date(snapshot.createdAt).toISOString()}>
					{formatDate(snapshot.createdAt)}
				</time>
			</h2>
			<p className="field-caption">
				Literature Snapshot from scope revision {snapshot.scopeRevision}
			</p>
			<p className="field-caption">
				{snapshot.coverage === "partial"
					? "Partial coverage: at least one source failed, answered partially or was truncated. Review each source below."
					: "Every selected source answered within the record cap. This is a bounded search, not an exhaustive one."}{" "}
				Published {snapshot.scope.dateFrom} to {snapshot.scope.dateTo}
				{snapshot.scope.includeFoundations
					? ", plus older foundational work where supported."
					: "."}{" "}
				{snapshot.paperCount} of at most {snapshot.recordCap} records kept.
			</p>
			<div className="history-list">
				{snapshot.sources.map((outcome) => (
					<OutcomeDetails key={outcome.source} outcome={outcome} />
				))}
			</div>
			{snapshot.papers.length === 0 ? (
				<p className="muted-copy paper-empty">
					No papers matched this scope. An empty search is not evidence of a
					gap: revise the queries, dates or sources and search again.
				</p>
			) : (
				<ol className="paper-list">
					{snapshot.papers.map((paper) => (
						<li key={paper.id}>
							<p className="paper-title">{paper.title}</p>
							<p className="field-caption">
								{paper.authors.join(", ")} · {paper.year}
								{paper.doi ? ` · doi:${paper.doi}` : ""} · found by{" "}
								{snapshot.sources.find((s) => s.source === paper.source)
									?.label ?? paper.source}
								{paper.acquisitionReason === "foundation"
									? " · older foundational work"
									: ""}
							</p>
						</li>
					))}
				</ol>
			)}
		</section>
	);
}

export default function LiteratureWorkspace({ id }: { id: string }) {
	const queryClient = useQueryClient();
	const projectQuery = useQuery(trpc.projects.get.queryOptions({ id }));
	const scopeQuery = useQuery(
		trpc.literature.scope.queryOptions({ projectId: id }),
	);
	const budgetQuery = useQuery(
		trpc.literature.budget.queryOptions({ projectId: id }),
	);
	const jobsQuery = useQuery({
		...trpc.literature.jobs.queryOptions({ projectId: id }),
		refetchInterval: (query) => {
			const failures = query.state.fetchFailureCount;
			if (failures) return Math.min(pollMilliseconds * 2 ** failures, 60_000);
			return query.state.data?.items.some((job) =>
				activeStates.includes(job.state),
			)
				? pollMilliseconds
				: false;
		},
		refetchOnWindowFocus: true,
		refetchOnReconnect: true,
	});
	const saveScope = useMutation(trpc.literature.saveScope.mutationOptions());
	const submitSearch = useMutation(
		trpc.literature.submitSearch.mutationOptions(),
	);
	const cancelJob = useMutation(trpc.literature.cancel.mutationOptions());
	const [draft, setDraft] = useState<Scope | null>(null);
	const [base, setBase] = useState<ScopeView | null>(null);
	const [saveNotice, setSaveNotice] = useState("");
	const [confirmKey, setConfirmKey] = useState<string | null>(null);
	const [selectedSnapshot, setSelectedSnapshot] = useState<string | null>(null);
	const finishedJobs = useRef<number | null>(null);

	useEffect(() => {
		if (scopeQuery.data && !base) {
			setBase(scopeQuery.data);
			setDraft(scopeQuery.data.scope);
		}
	}, [scopeQuery.data, base]);

	const jobs = jobsQuery.data?.items ?? [];
	const finishedCount = jobs.filter(
		(job) => !activeStates.includes(job.state),
	).length;
	useEffect(() => {
		if (finishedJobs.current !== null && finishedCount > finishedJobs.current)
			void queryClient.invalidateQueries({
				queryKey: trpc.literature.budget.queryKey({ projectId: id }),
			});
		finishedJobs.current = finishedCount;
	}, [finishedCount, id, queryClient]);

	const project = projectQuery.data;
	const readOnly = project?.state === "archived";
	const isDirty = Boolean(draft && base && !sameScope(draft, base.scope));
	const brief = project?.brief;
	const briefReady = Boolean(brief?.title.trim() && brief.topic.trim());
	const sources = base?.sources ?? [];
	const blocked = new Map(
		(budgetQuery.data?.sources ?? []).map((source) => [
			source.id,
			source.blockedBy,
		]),
	);
	const latestSnapshotId =
		selectedSnapshot ?? jobs.find((job) => job.snapshotId)?.snapshotId ?? null;

	function update(changes: Partial<Scope>) {
		setDraft((current) => (current ? { ...current, ...changes } : current));
		setSaveNotice("");
		setConfirmKey(null);
	}

	async function submitScope(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!draft || !base || saveScope.isPending) return;
		try {
			const saved = await saveScope.mutateAsync({
				projectId: id,
				expectedRevision: base.revision,
				scope: draft,
			});
			setBase(saved);
			setDraft(saved.scope);
			queryClient.setQueryData(
				trpc.literature.scope.queryKey({ projectId: id }),
				saved,
			);
			setSaveNotice(`Saved as scope revision ${saved.revision}.`);
		} catch {
			// The server message stays visible below; the draft is kept.
		}
	}

	async function reloadSavedScope() {
		const refreshed = await scopeQuery.refetch();
		if (!refreshed.data) return;
		setBase(refreshed.data);
		saveScope.reset();
		setSaveNotice(
			`Scope revision ${refreshed.data.revision} is now the save base. Your draft has been kept.`,
		);
	}

	async function confirmSearch() {
		if (!base || !confirmKey || submitSearch.isPending) return;
		try {
			await submitSearch.mutateAsync({
				projectId: id,
				scopeRevision: base.revision,
				idempotencyKey: confirmKey,
				queries: base.scope.queries,
			});
			setConfirmKey(null);
			await queryClient.invalidateQueries({
				queryKey: trpc.literature.jobs.queryKey({ projectId: id }),
			});
		} catch {
			// Retrying reuses the same key, so a lost response cannot start a second search.
		}
	}

	async function cancel(jobId: string) {
		try {
			await cancelJob.mutateAsync({ projectId: id, jobId });
		} finally {
			await queryClient.invalidateQueries({
				queryKey: trpc.literature.jobs.queryKey({ projectId: id }),
			});
		}
	}

	if (!project || !draft || !base)
		return (
			<main className="folio-main">
				<div className="folio-page project-overview-page">
					<Link className="back-link" href={`/projects/${id}`}>
						<ArrowLeft size={15} aria-hidden="true" /> Project
					</Link>
					<div className="detail-loading" aria-live="polite" role="status">
						<FileClock size={18} strokeWidth={1.5} aria-hidden="true" />
						{projectQuery.error || scopeQuery.error
							? messageOf(projectQuery.error ?? scopeQuery.error)
							: "Loading the Literature Scope…"}
					</div>
				</div>
			</main>
		);

	const canSearch =
		!readOnly && briefReady && base.revision > 0 && !isDirty && !confirmKey;
	const selectedSources = sources.filter((source) =>
		base.scope.sources.includes(source.id),
	);

	return (
		<main className="folio-main">
			<div className="folio-page project-overview-page">
				<Link className="back-link" href={`/projects/${id}`}>
					<ArrowLeft size={15} aria-hidden="true" /> Project brief
				</Link>
				<header className="detail-heading">
					<div>
						<h1 className="display-title detail-title">
							{project.title || "Untitled research project"}
						</h1>
						<p className="page-intro">
							Literature ·{" "}
							{base.revision
								? `Scope revision ${base.revision}`
								: "Proposed scope"}
						</p>
					</div>
				</header>

				<div className="detail-layout">
					<div className="detail-primary-column">
						<section className="brief-panel" aria-labelledby="scope-heading">
							<h2 id="scope-heading">Literature Scope</h2>
							<p className="field-caption">
								{base.proposed
									? "Proposed from the brief's topic and title."
									: `Based on brief revision ${base.briefRevision}.`}
							</p>
							<form className="brief-form" onSubmit={submitScope}>
								<fieldset
									className="brief-fieldset"
									disabled={readOnly || saveScope.isPending}
								>
									<fieldset className="brief-fieldset">
										<legend className="field-legend">Search queries</legend>
										{draft.queries.map((query, index) => (
											// biome-ignore lint/suspicious/noArrayIndexKey: queries are positional and their inputs fully controlled
											<div className="query-row" key={`query-${index}`}>
												<Label htmlFor={`scope-query-${index}`}>
													Query {index + 1}
												</Label>
												<div className="query-input">
													<Textarea
														id={`scope-query-${index}`}
														value={query}
														rows={2}
														maxLength={2_000}
														onChange={(event) =>
															update({
																queries: draft.queries.map((value, i) =>
																	i === index ? event.target.value : value,
																),
															})
														}
													/>
													{draft.queries.length > 1 && (
														<Button
															type="button"
															variant="ghost"
															className="folio-button folio-button-light"
															aria-label={`Remove query ${index + 1}`}
															onClick={() =>
																update({
																	queries: draft.queries.filter(
																		(_, i) => i !== index,
																	),
																})
															}
														>
															<X size={15} aria-hidden="true" />
														</Button>
													)}
												</div>
											</div>
										))}
										{draft.queries.length < 3 && (
											<Button
												type="button"
												variant="outline"
												className="folio-button folio-button-light add-query"
												onClick={() =>
													update({ queries: [...draft.queries, ""] })
												}
											>
												<Plus size={15} aria-hidden="true" /> Add query
											</Button>
										)}
										<p className="field-caption">
											One to three queries, up to 2,000 characters each. Only
											these queries are sent to sources; no other brief field
											is.
										</p>
									</fieldset>

									<fieldset className="brief-fieldset">
										<legend className="field-legend">Sources</legend>
										{sources.map((source) => {
											const blockedBy = blocked.get(source.id);
											return (
												<label className="source-option" key={source.id}>
													<input
														type="checkbox"
														checked={draft.sources.includes(source.id)}
														onChange={(event) =>
															update({
																sources: event.target.checked
																	? [...draft.sources, source.id]
																	: draft.sources.filter(
																			(value) => value !== source.id,
																		),
															})
														}
													/>
													<span>
														{source.label}
														<span className="field-caption">
															{!source.metered
																? " Free."
																: source.priceMicrosPerQuery === null
																	? " Disabled: pricing is not configured."
																	: ` ${dollars(source.priceMicrosPerQuery)} per query, reserved before each attempt.${blockedBy ? " A spending limit currently blocks it." : ""}`}
														</span>
													</span>
												</label>
											);
										})}
									</fieldset>

									<div className="field-pair">
										<div className="field-stack">
											<Label htmlFor="scope-from">Published from</Label>
											<Input
												id="scope-from"
												type="date"
												value={draft.dateFrom}
												onChange={(event) =>
													update({ dateFrom: event.target.value })
												}
											/>
										</div>
										<div className="field-stack">
											<Label htmlFor="scope-to">Published to</Label>
											<Input
												id="scope-to"
												type="date"
												value={draft.dateTo}
												onChange={(event) =>
													update({ dateTo: event.target.value })
												}
											/>
										</div>
									</div>
									<p className="field-caption">
										The default window is the previous five years through today
										(UTC).
									</p>
									<label className="source-option">
										<input
											type="checkbox"
											checked={draft.includeFoundations}
											onChange={(event) =>
												update({ includeFoundations: event.target.checked })
											}
										/>
										<span>
											Also look for older foundational work
											<span className="field-caption">
												{" "}
												Labelled separately; each source shows whether it
												supports this.
											</span>
										</span>
									</label>
									<div className="field-stack">
										<Label htmlFor="scope-include">Inclusion criteria</Label>
										<Textarea
											id="scope-include"
											value={draft.inclusionCriteria}
											rows={2}
											maxLength={2_000}
											onChange={(event) =>
												update({ inclusionCriteria: event.target.value })
											}
										/>
									</div>
									<div className="field-stack">
										<Label htmlFor="scope-exclude">Exclusion criteria</Label>
										<Textarea
											id="scope-exclude"
											value={draft.exclusionCriteria}
											rows={2}
											maxLength={2_000}
											onChange={(event) =>
												update({ exclusionCriteria: event.target.value })
											}
										/>
										<p className="field-caption">
											Criteria are recorded with the scope for screening; they
											are not sent to sources.
										</p>
									</div>
								</fieldset>
								<div className="brief-form-footer">
									{saveScope.error && (
										<p className="form-error" role="alert">
											{messageOf(saveScope.error)} Your unsaved scope is still
											here.
										</p>
									)}
									{saveScope.error?.data?.code === "CONFLICT" && (
										<Button
											type="button"
											variant="outline"
											className="folio-button folio-button-light recovery-button"
											onClick={() => void reloadSavedScope()}
										>
											Check latest and keep my draft
										</Button>
									)}
									{saveNotice && (
										<p className="form-success" role="status">
											<Check size={15} aria-hidden="true" /> {saveNotice}
										</p>
									)}
									<div className="brief-submit-row">
										<p className="field-caption">
											{readOnly
												? "Restore this project before changing its scope."
												: isDirty || base.proposed
													? "Save the scope before searching."
													: "The saved scope matches this form."}
										</p>
										<Button
											type="submit"
											className="folio-button folio-button-primary"
											disabled={
												readOnly ||
												saveScope.isPending ||
												(!isDirty && !base.proposed)
											}
										>
											{saveScope.isPending ? "Saving scope…" : "Save scope"}
										</Button>
									</div>
								</div>
							</form>
						</section>

						<section className="history-panel" aria-labelledby="jobs-heading">
							<h2 id="jobs-heading">Searches</h2>
							<p className="field-caption">
								Searches keep running after you leave this page.
							</p>
							{!briefReady && (
								<p className="field-caption">
									Save a working title and topic in the{" "}
									<Link className="text-link" href={`/projects/${id}`}>
										brief
									</Link>{" "}
									before searching.
								</p>
							)}
							{confirmKey ? (
								<fieldset className="detail-confirm" aria-live="polite">
									<legend className="sr-only">Confirm search</legend>
									<p>These exact queries will be sent:</p>
									<ol className="confirm-queries">
										{base.scope.queries.map((query) => (
											<li key={query}>{query}</li>
										))}
									</ol>
									<p className="field-caption">
										To: {selectedSources.map((s) => s.label).join(", ")}.
										Nothing else from your brief is sent.
									</p>
									{submitSearch.error && (
										<p className="form-error" role="alert">
											{messageOf(submitSearch.error)}
										</p>
									)}
									<div className="confirm-buttons">
										<Button
											type="button"
											className="folio-button folio-button-primary"
											disabled={submitSearch.isPending}
											onClick={() => void confirmSearch()}
										>
											{submitSearch.isPending
												? "Submitting…"
												: submitSearch.error
													? "Try again"
													: "Send these queries"}
										</Button>
										<Button
											type="button"
											variant="ghost"
											className="folio-button folio-button-light"
											disabled={submitSearch.isPending}
											onClick={() => {
												setConfirmKey(null);
												submitSearch.reset();
											}}
										>
											Cancel
										</Button>
									</div>
								</fieldset>
							) : (
								<Button
									type="button"
									className="folio-button folio-button-primary"
									disabled={!canSearch}
									onClick={() => setConfirmKey(crypto.randomUUID())}
								>
									Review and search
								</Button>
							)}
							{jobsQuery.error && (
								<p className="form-error" role="alert">
									{messageOf(jobsQuery.error)} Retrying with a longer delay.
								</p>
							)}
							<ul className="job-list" aria-live="polite">
								{jobs.map((job) => (
									<li className="job-row" key={job.id}>
										<div>
											<p className="job-state">
												{jobStateText[job.state]}
												<span className="field-caption">
													{" "}
													· scope revision {job.scopeRevision} ·{" "}
													{job.finishedSources} of {job.sourceCount} sources
													finished
												</span>
											</p>
											<p className="field-caption">
												Submitted {formatDate(job.createdAt)}
												{job.finishedAt
													? ` · ended ${formatDate(job.finishedAt)}`
													: ""}
											</p>
											{job.cancelReason && (
												<p className="field-caption">
													{cancelReasonText[job.cancelReason]}
												</p>
											)}
											{job.errorClass && (
												<p className="field-caption">
													{errorText[job.errorClass] ?? job.errorClass}
												</p>
											)}
										</div>
										<div className="job-actions">
											{job.snapshotId && (
												<Button
													type="button"
													variant="outline"
													className="folio-button folio-button-light"
													aria-pressed={latestSnapshotId === job.snapshotId}
													onClick={() => setSelectedSnapshot(job.snapshotId)}
												>
													View snapshot
												</Button>
											)}
											{activeStates.includes(job.state) && (
												<Button
													type="button"
													variant="ghost"
													className="folio-button delete-button"
													disabled={cancelJob.isPending}
													onClick={() => void cancel(job.id)}
												>
													Cancel search
												</Button>
											)}
										</div>
									</li>
								))}
							</ul>
							{jobs.length === 0 && !jobsQuery.isPending && (
								<p className="muted-copy">No searches yet.</p>
							)}
						</section>

						{latestSnapshotId && (
							<SnapshotView projectId={id} snapshotId={latestSnapshotId} />
						)}
					</div>

					<aside className="detail-side-column">
						<section
							className="project-actions-panel"
							aria-labelledby="budget-heading"
						>
							<h2 id="budget-heading">Budget status</h2>
							<p className="field-caption">
								{budgetQuery.data?.period ?? "This month"} (UTC)
							</p>
							{budgetQuery.data ? (
								<dl className="revision-fields">
									<div>
										<dt>This project</dt>
										<dd>
											{dollars(budgetQuery.data.projectCommittedMicros)} of{" "}
											{dollars(budgetQuery.data.limits.projectMonth)} used or
											reserved
										</dd>
									</div>
									<div>
										<dt>Per search</dt>
										<dd>At most {dollars(budgetQuery.data.limits.run)}</dd>
									</div>
									{budgetQuery.data.sources
										.filter((source) => source.metered)
										.map((source) => (
											<div key={source.id}>
												<dt>{source.label}</dt>
												<dd>
													{source.blockedBy === "pricing-unknown"
														? "Disabled: pricing is not configured"
														: source.blockedBy
															? "Blocked by a spending limit"
															: "Available"}
												</dd>
											</div>
										))}
								</dl>
							) : (
								<p className="muted-copy">
									{budgetQuery.error
										? messageOf(budgetQuery.error)
										: "Loading budget…"}
								</p>
							)}
							<p className="field-caption">
								Free sources and your saved work stay available when metered
								sources are disabled or a limit is reached.
							</p>
						</section>
					</aside>
				</div>
			</div>
		</main>
	);
}
