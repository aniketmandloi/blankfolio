"use client";

import type { AppRouter } from "@blankfolio/api/routers/index";
import { Button } from "@blankfolio/ui/components/button";
import { Input } from "@blankfolio/ui/components/input";
import { Label } from "@blankfolio/ui/components/label";
import { Textarea } from "@blankfolio/ui/components/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import {
	Archive,
	ArrowLeft,
	Check,
	Clock3,
	FileClock,
	RotateCcw,
	Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { trpc } from "@/utils/trpc";

type ProjectDetailData = inferRouterOutputs<AppRouter>["projects"]["get"];
type HistoryEntry = ProjectDetailData["history"][number];

type BriefFields = ProjectDetailData["brief"];

type BriefField = keyof BriefFields;

const briefFieldLabels: Record<BriefField, string> = {
	evaluationTrack: "Topic track",
	title: "Working title",
	topic: "Research topic and question",
	experienceLevel: "Experience level",
	timeAvailability: "Time available",
	computeDescription: "Compute and materials",
	desiredContribution: "Desired contribution",
};

const evaluationTrackLabels = {
	unknown: "Not specified",
	"tabular-classification": "Tabular classification in empirical predictive ML",
	"outside-track": "Another topic, outside the initial evaluation track",
};

function BriefDisplay({ brief }: { brief: BriefFields }) {
	return (
		<dl className="revision-fields">
			{(Object.keys(briefFieldLabels) as BriefField[]).map((field) => (
				<div key={field}>
					<dt>{briefFieldLabels[field]}</dt>
					<dd>
						{field === "evaluationTrack"
							? evaluationTrackLabels[brief.evaluationTrack]
							: displayValue(brief[field])}
					</dd>
				</div>
			))}
		</dl>
	);
}

function formValues(brief: BriefFields): BriefFields {
	return {
		...brief,
		experienceLevel:
			brief.experienceLevel === "unknown" ? "" : brief.experienceLevel,
		timeAvailability:
			brief.timeAvailability === "unknown" ? "" : brief.timeAvailability,
		computeDescription:
			brief.computeDescription === "unknown" ? "" : brief.computeDescription,
		desiredContribution:
			brief.desiredContribution === "unknown" ? "" : brief.desiredContribution,
	};
}

function displayValue(value: string) {
	return value.trim() ? value : "Unknown";
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

function errorText(error: unknown) {
	return error instanceof Error ? error.message : "Please try again.";
}

function sameBrief(left: BriefFields, right: BriefFields) {
	return (
		left.evaluationTrack === right.evaluationTrack &&
		left.title === right.title &&
		left.topic === right.topic &&
		left.experienceLevel === right.experienceLevel &&
		left.timeAvailability === right.timeAvailability &&
		left.computeDescription === right.computeDescription &&
		left.desiredContribution === right.desiredContribution
	);
}

export default function ProjectOverview({ id }: { id: string }) {
	const projectQuery = useQuery(trpc.projects.get.queryOptions({ id }));
	const queryClient = useQueryClient();
	const router = useRouter();
	const [draft, setDraft] = useState<BriefFields | null>(null);
	const [savedBrief, setSavedBrief] = useState<BriefFields | null>(null);
	const [baseRevision, setBaseRevision] = useState<number | null>(null);
	const [historyItems, setHistoryItems] = useState<HistoryEntry[]>([]);
	const [historyCursor, setHistoryCursor] = useState<number | undefined>();
	const [historyPending, setHistoryPending] = useState(false);
	const [historyError, setHistoryError] = useState("");
	const [pendingAction, setPendingAction] = useState<
		"archive" | "restore" | "delete" | null
	>(null);
	const [actionError, setActionError] = useState("");
	const [recoveryError, setRecoveryError] = useState("");
	const [saveNotice, setSaveNotice] = useState("");
	const [recoveryPending, setRecoveryPending] = useState(false);
	const [recoveryNotice, setRecoveryNotice] = useState("");
	const [showLatestComparison, setShowLatestComparison] = useState(false);
	const hydratedId = useRef("");

	const saveBrief = useMutation(trpc.projects.saveBrief.mutationOptions());
	const archiveProject = useMutation(trpc.projects.archive.mutationOptions());
	const unarchiveProject = useMutation(
		trpc.projects.unarchive.mutationOptions(),
	);
	const deleteProject = useMutation(trpc.projects.delete.mutationOptions());

	useEffect(() => {
		const project = projectQuery.data;
		if (!project || hydratedId.current === project.id) return;

		const initial = formValues(project.brief);
		hydratedId.current = project.id;
		setDraft(initial);
		setSavedBrief(initial);
		setBaseRevision(project.revision);
		setHistoryItems(project.history);
		setHistoryCursor(project.historyNextCursor);
	}, [projectQuery.data]);

	const project = projectQuery.data;
	const isDirty = Boolean(draft && savedBrief && !sameBrief(draft, savedBrief));
	const newerRevisionExists = Boolean(
		project && baseRevision !== null && project.revision > baseRevision,
	);
	const isActionPending =
		archiveProject.isPending ||
		unarchiveProject.isPending ||
		deleteProject.isPending;
	const storedBriefLength = draft
		? draft.title.length +
			draft.topic.length +
			[
				draft.experienceLevel,
				draft.timeAvailability,
				draft.computeDescription,
				draft.desiredContribution,
			].reduce(
				(length, value) =>
					length + (value.trim() ? value.length : "unknown".length),
				0,
			)
		: 0;
	const saveError =
		storedBriefLength > 10_000
			? "Research brief must be 10,000 characters or fewer. Shorten the text before saving."
			: saveBrief.error
				? errorText(saveBrief.error)
				: "";
	const conflictDetected = saveBrief.error?.data?.code === "CONFLICT";

	useEffect(() => {
		window.dispatchEvent(
			new CustomEvent("blankfolio:unsaved-change", {
				detail: { dirty: isDirty },
			}),
		);
		return () => {
			window.dispatchEvent(
				new CustomEvent("blankfolio:unsaved-change", {
					detail: { dirty: false },
				}),
			);
		};
	}, [isDirty]);

	useEffect(() => {
		if (!isDirty) return;
		const warnBeforeUnload = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", warnBeforeUnload);
		return () => window.removeEventListener("beforeunload", warnBeforeUnload);
	}, [isDirty]);

	function updateDraft(field: BriefField, value: string) {
		setDraft((current) => {
			const base =
				current ??
				(projectQuery.data ? formValues(projectQuery.data.brief) : null);
			return base ? { ...base, [field]: value } : current;
		});
		setSaveNotice("");
	}

	async function submitBrief(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (
			!project ||
			!draft ||
			baseRevision === null ||
			project.state === "archived" ||
			isActionPending ||
			recoveryPending ||
			saveBrief.isPending
		)
			return;

		setSaveNotice("");
		try {
			const result = await saveBrief.mutateAsync({
				id,
				expectedRevision: baseRevision,
				brief: draft,
			});
			const nextValues = formValues(result.brief);
			setDraft(nextValues);
			setSavedBrief(nextValues);
			setBaseRevision(result.revision);
			setHistoryItems(result.history);
			setHistoryCursor(result.historyNextCursor);
			setShowLatestComparison(false);
			setRecoveryNotice("");
			queryClient.setQueryData(trpc.projects.get.queryKey({ id }), result);
			await queryClient.invalidateQueries({
				queryKey: trpc.projects.list.queryKey(),
			});
			setSaveNotice(`Saved as revision ${result.revision}.`);
		} catch {
			// The server error stays visible below; the controlled draft is left untouched.
		}
	}

	async function loadOlderHistory() {
		if (historyCursor === undefined) return;
		setHistoryPending(true);
		setHistoryError("");
		try {
			const page = await queryClient.fetchQuery(
				trpc.projects.history.queryOptions({
					id,
					limit: 20,
					cursor: historyCursor,
				}),
			);
			setHistoryItems((current) => {
				const known = new Set(current.map((item) => item.revision));
				return [
					...current,
					...page.items.filter((item) => !known.has(item.revision)),
				];
			});
			setHistoryCursor(page.nextCursor);
		} catch (error) {
			setHistoryError(errorText(error));
		} finally {
			setHistoryPending(false);
		}
	}

	async function refreshSavedRevision() {
		if (saveBrief.isPending || isActionPending || recoveryPending) return;
		setRecoveryPending(true);
		setRecoveryNotice("");
		setRecoveryError("");
		try {
			const refreshed = await projectQuery.refetch();
			if (!refreshed.data)
				throw (
					refreshed.error ??
					new Error("The saved revision could not be loaded.")
				);
			const latestValues = formValues(refreshed.data.brief);
			setBaseRevision(refreshed.data.revision);
			setSavedBrief(latestValues);
			setHistoryItems(refreshed.data.history);
			setHistoryCursor(refreshed.data.historyNextCursor);
			setShowLatestComparison(true);
			setRecoveryNotice(
				`Revision ${refreshed.data.revision} is now the save base. Your current draft has been kept.`,
			);
			setActionError("");
			saveBrief.reset();
		} catch (error) {
			setRecoveryError(errorText(error));
		} finally {
			setRecoveryPending(false);
		}
	}

	async function confirmProjectAction() {
		if (
			!project ||
			!pendingAction ||
			saveBrief.isPending ||
			recoveryPending ||
			isActionPending
		)
			return;
		setActionError("");
		try {
			if (pendingAction === "archive") {
				const result = await archiveProject.mutateAsync({ id });
				queryClient.setQueryData(trpc.projects.get.queryKey({ id }), result);
			} else if (pendingAction === "restore") {
				const result = await unarchiveProject.mutateAsync({ id });
				queryClient.setQueryData(trpc.projects.get.queryKey({ id }), result);
			} else {
				await deleteProject.mutateAsync({ id });
				await queryClient.invalidateQueries({
					queryKey: trpc.projects.list.queryKey(),
				});
				router.push("/dashboard");
				return;
			}
			await queryClient.invalidateQueries({
				queryKey: trpc.projects.list.queryKey(),
			});
			setPendingAction(null);
		} catch (error) {
			setActionError(errorText(error));
		}
	}

	if (!project) {
		return (
			<main className="folio-main">
				<div className="folio-page project-overview-page">
					<Link className="back-link" href="/dashboard">
						<ArrowLeft size={15} aria-hidden="true" /> Projects
					</Link>
					{projectQuery.isPending ? (
						<div className="detail-loading" aria-live="polite">
							<FileClock size={18} strokeWidth={1.5} aria-hidden="true" />
							Loading the saved brief…
						</div>
					) : (
						<section className="detail-unavailable" role="alert">
							<p className="eyebrow">Project unavailable</p>
							<h1 className="display-title">
								This project could not be opened.
							</h1>
							<p>{errorText(projectQuery.error)}</p>
							<Link className="text-link" href="/dashboard">
								Return to projects
							</Link>
						</section>
					)}
				</div>
			</main>
		);
	}

	const completeForDiscovery = Boolean(
		savedBrief?.title.trim() && savedBrief.topic.trim(),
	);
	const readOnly = project.state === "archived";
	const briefFields = draft ?? formValues(project.brief);

	return (
		<main className="folio-main">
			<div className="folio-page project-overview-page">
				<Link
					className="back-link"
					href="/dashboard"
					onClick={(event) => {
						if (
							isDirty &&
							!window.confirm(
								"Leave this project? Your unsaved brief edits will be lost.",
							)
						) {
							event.preventDefault();
						}
					}}
				>
					<ArrowLeft size={15} aria-hidden="true" /> Projects
				</Link>

				<header className="detail-heading">
					<div>
						<p className="eyebrow">
							{project.state === "archived"
								? "Archived project"
								: "Research project"}
							<span aria-hidden="true"> · </span> Revision {project.revision}
						</p>
						<h1 className="display-title detail-title">
							{briefFields.title || "Untitled research project"}
						</h1>
						<p className="page-intro">
							A working brief for the question, scope, and conditions of this
							investigation.
						</p>
					</div>
					<div className={`status-seal ${readOnly ? "status-seal-muted" : ""}`}>
						<span className="seal-dot" aria-hidden="true" />
						{readOnly ? "Archived" : "In progress"}
					</div>
				</header>

				<div className="detail-layout">
					<div className="detail-primary-column">
						<section className="brief-panel" aria-labelledby="brief-heading">
							<div className="panel-heading">
								<div>
									<p className="eyebrow">
										Project notebook · {project.id.slice(0, 8)}
									</p>
									<h2 id="brief-heading">Research brief</h2>
								</div>
								<div className="revision-chip">
									<FileClock size={14} aria-hidden="true" />
									Revision {baseRevision ?? project.revision}
								</div>
							</div>

							<form className="brief-form" onSubmit={submitBrief}>
								<fieldset
									className="brief-fieldset"
									disabled={
										readOnly ||
										saveBrief.isPending ||
										isActionPending ||
										recoveryPending
									}
								>
									<div className="field-stack">
										<Label htmlFor="brief-track">Topic track</Label>
										<select
											id="brief-track"
											className="h-8 w-full min-w-0 rounded-none border px-2 outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
											value={briefFields.evaluationTrack}
											onChange={(event) =>
												updateDraft("evaluationTrack", event.target.value)
											}
											aria-describedby="evaluation-track-hint"
										>
											{Object.entries(evaluationTrackLabels).map(
												([value, label]) => (
													<option key={value} value={value}>
														{label}
													</option>
												),
											)}
										</select>
										<p className="field-caption" id="evaluation-track-hint">
											{briefFields.evaluationTrack === "outside-track"
												? "This topic is outside the initial evaluation track; support has not been validated for it."
												: briefFields.evaluationTrack === "unknown"
													? "The initial evaluation scope is empirical predictive ML, starting with tabular classification. Choose your topic track; it is not inferred from your text."
													: "Within the initial evaluation scope. Scientific readiness still requires expert evaluation."}
										</p>
									</div>
									<div className="field-stack">
										<Label htmlFor="brief-title">Working title</Label>
										<Input
											id="brief-title"
											value={briefFields.title}
											onChange={(event) =>
												updateDraft("title", event.target.value)
											}
											maxLength={120}
											aria-invalid={Boolean(saveError)}
											aria-describedby={
												saveError ? "brief-save-error" : undefined
											}
										/>
									</div>

									<div className="field-stack">
										<Label htmlFor="brief-topic">
											Research topic and question
										</Label>
										<Textarea
											id="brief-topic"
											value={briefFields.topic}
											onChange={(event) =>
												updateDraft("topic", event.target.value)
											}
											maxLength={2_000}
											rows={4}
											placeholder="What would you like this investigation to clarify?"
											aria-invalid={Boolean(saveError)}
											aria-describedby={
												saveError ? "brief-save-error" : undefined
											}
										/>
										<p className="field-caption">
											Up to 2,000 characters. A provisional question is enough
											to begin.
										</p>
									</div>

									<div className="field-pair">
										<div className="field-stack">
											<Label htmlFor="brief-experience">Experience level</Label>
											<Input
												id="brief-experience"
												value={briefFields.experienceLevel}
												onChange={(event) =>
													updateDraft("experienceLevel", event.target.value)
												}
												maxLength={10_000}
												placeholder="Leave blank if unknown"
												aria-invalid={Boolean(saveError)}
												aria-describedby={
													saveError ? "brief-save-error" : "unknown-field-hint"
												}
											/>
										</div>
										<div className="field-stack">
											<Label htmlFor="brief-time">Time available</Label>
											<Input
												id="brief-time"
												value={briefFields.timeAvailability}
												onChange={(event) =>
													updateDraft("timeAvailability", event.target.value)
												}
												maxLength={10_000}
												placeholder="Leave blank if unknown"
												aria-invalid={Boolean(saveError)}
												aria-describedby={
													saveError ? "brief-save-error" : "unknown-field-hint"
												}
											/>
										</div>
									</div>

									<div className="field-stack">
										<Label htmlFor="brief-compute">Compute and materials</Label>
										<Textarea
											id="brief-compute"
											value={briefFields.computeDescription}
											onChange={(event) =>
												updateDraft("computeDescription", event.target.value)
											}
											maxLength={10_000}
											rows={3}
											placeholder="Leave blank if unknown"
											aria-invalid={Boolean(saveError)}
											aria-describedby={
												saveError ? "brief-save-error" : "unknown-field-hint"
											}
										/>
									</div>

									<div className="field-stack">
										<Label htmlFor="brief-contribution">
											Desired contribution
										</Label>
										<Textarea
											id="brief-contribution"
											value={briefFields.desiredContribution}
											onChange={(event) =>
												updateDraft("desiredContribution", event.target.value)
											}
											maxLength={10_000}
											rows={3}
											placeholder="Leave blank if unknown"
											aria-invalid={Boolean(saveError)}
											aria-describedby={
												saveError ? "brief-save-error" : "unknown-field-hint"
											}
										/>
									</div>
									<p
										className="field-caption field-hint"
										id="unknown-field-hint"
									>
										Blank constraints are saved as “unknown.”
									</p>
								</fieldset>

								<div className="brief-form-footer">
									<p
										className={`character-count ${storedBriefLength > 10_000 ? "count-over" : ""}`}
									>
										{storedBriefLength.toLocaleString()} / 10,000 characters
									</p>
									{saveError && (
										<p
											className="form-error brief-error"
											id="brief-save-error"
											role="alert"
										>
											{saveError} Your unsaved input is still here.
										</p>
									)}
									{saveNotice && (
										<p className="form-success" role="status">
											<Check size={15} aria-hidden="true" /> {saveNotice}
										</p>
									)}
									{newerRevisionExists && (
										<p className="form-error brief-error" role="status">
											A newer revision is saved elsewhere. Your draft remains
											here; saving it will ask the server to check for a
											conflict.
										</p>
									)}
									{(newerRevisionExists ||
										conflictDetected ||
										showLatestComparison) && (
										<div className="revision-recovery">
											<p className="field-caption">
												Check the saved revision, then use it as the save base
												while keeping your current edits.
											</p>
											<Button
												type="button"
												variant="outline"
												className="folio-button folio-button-light recovery-button"
												disabled={
													recoveryPending ||
													saveBrief.isPending ||
													isActionPending
												}
												onClick={() => void refreshSavedRevision()}
											>
												{recoveryPending
													? "Checking…"
													: "Check latest and keep my draft"}
											</Button>
											{recoveryNotice && (
												<p className="form-success" role="status">
													{recoveryNotice}
												</p>
											)}
											{recoveryError && (
												<p className="form-error" role="alert">
													{recoveryError} Your draft is still here.
												</p>
											)}
											{showLatestComparison && (
												<details className="latest-brief-panel" open>
													<summary>
														Latest saved revision · {project.revision}
													</summary>
													<BriefDisplay brief={project.brief} />
												</details>
											)}
										</div>
									)}
									<div className="brief-submit-row">
										<p className="field-caption">
											{readOnly
												? "Restore this project before editing its brief."
												: isDirty
													? "Changes are local until you save this revision."
													: "Your current draft matches the saved revision."}
										</p>
										<Button
											type="submit"
											className="folio-button folio-button-primary"
											disabled={
												readOnly ||
												!isDirty ||
												storedBriefLength > 10_000 ||
												saveBrief.isPending ||
												isActionPending ||
												recoveryPending
											}
										>
											{saveBrief.isPending ? "Saving brief…" : "Save brief"}
										</Button>
									</div>
								</div>
							</form>
						</section>

						<section
							className="history-panel"
							aria-labelledby="history-heading"
						>
							<div className="panel-heading history-heading">
								<div
									className="section-mark section-mark-small"
									aria-hidden="true"
								>
									<Clock3 size={15} strokeWidth={1.6} />
								</div>
								<div>
									<p className="eyebrow">A record of changes</p>
									<h2 id="history-heading">Revision history</h2>
								</div>
							</div>
							{historyItems.length === 0 ? (
								<p className="muted-copy">No saved revisions yet.</p>
							) : (
								<div className="history-list">
									{historyItems.map((revision) => (
										<details className="history-entry" key={revision.revision}>
											<summary>
												<span>Revision {revision.revision}</span>
												<time
													dateTime={new Date(revision.createdAt).toISOString()}
												>
													{formatDate(revision.createdAt)}
												</time>
											</summary>
											<BriefDisplay brief={revision.brief} />
										</details>
									))}
								</div>
							)}
							{historyError && (
								<p className="form-error" role="alert">
									{historyError} Saved revisions remain available above.
								</p>
							)}
							{historyCursor !== undefined && (
								<div className="history-load-row">
									<Button
										type="button"
										variant="outline"
										className="folio-button folio-button-light"
										disabled={historyPending}
										onClick={() => void loadOlderHistory()}
									>
										{historyPending
											? "Loading revisions…"
											: "Load older revisions"}
									</Button>
								</div>
							)}
						</section>
					</div>

					<aside className="detail-side-column">
						<section
							className={`next-step-card ${completeForDiscovery ? "is-ready" : ""}`}
							aria-labelledby="next-step-heading"
						>
							<p className="eyebrow">Next action</p>
							<div className="next-step-icon" aria-hidden="true">
								{completeForDiscovery ? <Check size={18} /> : <span>1</span>}
							</div>
							<h2 id="next-step-heading">
								{completeForDiscovery ? "Brief ready" : "Complete the brief"}
							</h2>
							<p>
								{completeForDiscovery
									? "Your saved title and topic are ready for a future literature discovery step."
									: "Add a working title and research topic to prepare this project for its next step."}
							</p>
							{completeForDiscovery ? (
								<span className="future-status">
									Discovery will be available in a future step
								</span>
							) : (
								<a className="text-link" href="#brief-title">
									Continue the brief <span aria-hidden="true">↗</span>
								</a>
							)}
							{isDirty && completeForDiscovery && (
								<p className="side-note">
									Save your edits to update the saved next action.
								</p>
							)}
						</section>

						<section
							className="project-actions-panel"
							aria-labelledby="project-actions-heading"
						>
							<p className="eyebrow">Project controls</p>
							<h2 id="project-actions-heading">Keep your desk in order</h2>
							<p className="muted-copy">
								{readOnly
									? "Restoring makes this project editable again."
									: "Archive a finished line of inquiry or remove a project you no longer need."}
							</p>
							<div className="project-control-buttons">
								<Button
									type="button"
									variant="outline"
									className="folio-button folio-button-light control-button"
									disabled={isActionPending}
									onClick={() => {
										setActionError("");
										setPendingAction(readOnly ? "restore" : "archive");
									}}
								>
									{readOnly ? (
										<RotateCcw size={15} aria-hidden="true" />
									) : (
										<Archive size={15} aria-hidden="true" />
									)}
									{readOnly ? "Restore project" : "Archive project"}
								</Button>
								{!readOnly && (
									<Button
										type="button"
										variant="ghost"
										className="folio-button delete-button control-button"
										disabled={isActionPending}
										onClick={() => {
											setActionError("");
											setPendingAction("delete");
										}}
									>
										<Trash2 size={15} aria-hidden="true" /> Delete project
									</Button>
								)}
							</div>
							{pendingAction && (
								<fieldset className="detail-confirm" aria-live="polite">
									<legend className="sr-only">Confirm project action</legend>
									<p>
										{pendingAction === "archive"
											? "Archive this project? Its brief and revision history will stay available."
											: pendingAction === "restore"
												? "Restore this project to your active workspace?"
												: "Delete this project permanently? Its saved brief will be removed."}
									</p>
									<div className="confirm-buttons">
										<Button
											type="button"
											className={`folio-button ${pendingAction === "delete" ? "folio-button-danger" : "folio-button-primary"}`}
											disabled={
												isActionPending ||
												saveBrief.isPending ||
												recoveryPending
											}
											onClick={() => void confirmProjectAction()}
										>
											{isActionPending
												? "Working…"
												: `Confirm ${pendingAction === "restore" ? "restore" : pendingAction}`}
										</Button>
										<Button
											type="button"
											variant="ghost"
											className="folio-button folio-button-light"
											disabled={isActionPending}
											onClick={() => setPendingAction(null)}
										>
											Cancel
										</Button>
									</div>
								</fieldset>
							)}
							{actionError && (
								<p className="form-error action-error" role="alert">
									{actionError} Your saved project remains unchanged.
								</p>
							)}
						</section>
						<p className="side-footnote">
							Blankfolio records revisions; researchers remain responsible for
							scientific decisions and claims.
						</p>
					</aside>
				</div>
				<footer className="page-footnote">
					<span>Project created {formatDate(project.createdAt)}</span>
					<span>Last saved {formatDate(project.updatedAt)}</span>
				</footer>
			</div>
		</main>
	);
}
