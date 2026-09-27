"use client";

import { Button } from "@blankfolio/ui/components/button";
import { Input } from "@blankfolio/ui/components/input";
import { Label } from "@blankfolio/ui/components/label";
import {
	useInfiniteQuery,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { Archive, ArrowUpRight, BookOpen, Plus, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";
import { trpc } from "@/utils/trpc";

type ProjectState = "active" | "archived";

function formatDate(value: Date | string) {
	return new Intl.DateTimeFormat("en", {
		month: "short",
		day: "numeric",
		year: "numeric",
	}).format(new Date(value));
}

function errorText(error: unknown) {
	return error instanceof Error ? error.message : "Please try again.";
}

export default function Dashboard() {
	const { data: session } = authClient.useSession();
	const [state, setState] = useState<ProjectState>("active");
	const [title, setTitle] = useState("");
	const [confirmingId, setConfirmingId] = useState<string | null>(null);
	const [actionError, setActionError] = useState("");
	const router = useRouter();
	const queryClient = useQueryClient();
	const projectList = useInfiniteQuery(
		trpc.projects.list.infiniteQueryOptions(
			{ state, limit: 100 },
			{ getNextPageParam: (lastPage) => lastPage.nextCursor },
		),
	);

	const refreshLists = () =>
		queryClient.invalidateQueries({
			queryKey: trpc.projects.list.queryKey(),
		});

	const createProject = useMutation(
		trpc.projects.create.mutationOptions({
			onSuccess: async (project) => {
				setTitle("");
				await refreshLists();
				router.push(`/projects/${project.id}`);
			},
		}),
	);
	const archiveProject = useMutation(
		trpc.projects.archive.mutationOptions({
			onSuccess: () => refreshLists(),
		}),
	);
	const unarchiveProject = useMutation(
		trpc.projects.unarchive.mutationOptions({
			onSuccess: () => refreshLists(),
		}),
	);

	const isActionPending =
		archiveProject.isPending || unarchiveProject.isPending;
	const projects = projectList.data?.pages.flatMap((page) => page.items) ?? [];

	async function confirmProjectAction(id: string) {
		setActionError("");
		try {
			if (state === "active") {
				await archiveProject.mutateAsync({ id });
			} else {
				await unarchiveProject.mutateAsync({ id });
			}
			setConfirmingId(null);
		} catch (error) {
			setActionError(errorText(error));
		}
	}

	return (
		<main className="folio-main">
			<div className="folio-page projects-page">
				<div className="page-heading">
					<div>
						<p className="eyebrow">Research desk · {session?.user.name}</p>
						<h1 className="display-title">Projects</h1>
						<p className="page-intro">
							A quiet place to shape a question into a research plan.
						</p>
					</div>
					<div className="folio-index" aria-hidden="true">
						<span>FIELD</span>
						<span>NOTES</span>
					</div>
				</div>

				<section
					className="new-project-panel"
					aria-labelledby="new-project-title"
				>
					<div className="new-project-copy">
						<div className="section-mark" aria-hidden="true">
							<Plus size={17} strokeWidth={1.7} />
						</div>
						<div>
							<p className="eyebrow">Begin with a question</p>
							<h2 id="new-project-title">Open a new research project</h2>
							<p>
								Give the investigation a working title. You can refine it later.
							</p>
						</div>
					</div>
					<form
						className="create-project-form"
						onSubmit={(event) => {
							event.preventDefault();
							createProject.mutate({ title: title.trim() });
						}}
					>
						<div className="field-stack create-title-field">
							<Label htmlFor="new-project-title-input">Working title</Label>
							<Input
								id="new-project-title-input"
								value={title}
								onChange={(event) => setTitle(event.target.value)}
								maxLength={120}
								placeholder="e.g. Mapping trust in clinical AI"
								autoComplete="off"
								aria-invalid={Boolean(createProject.error)}
								aria-describedby={
									createProject.error ? "create-project-error" : undefined
								}
							/>
						</div>
						<Button
							type="submit"
							className="folio-button folio-button-primary"
							disabled={createProject.isPending}
						>
							{createProject.isPending ? "Opening…" : "Create project"}
							<ArrowUpRight size={15} aria-hidden="true" />
						</Button>
					</form>
					{createProject.error && (
						<p
							className="form-error create-error"
							id="create-project-error"
							role="alert"
						>
							{errorText(createProject.error)} Your title is still here.
						</p>
					)}
				</section>

				<section
					className="project-shelf"
					aria-labelledby="project-shelf-title"
				>
					<div className="shelf-heading">
						<div>
							<p className="eyebrow">Your workspace</p>
							<h2 id="project-shelf-title">
								{state === "active" ? "Current projects" : "Archived projects"}
							</h2>
						</div>
						<fieldset className="project-tabs">
							<legend className="sr-only">Project status</legend>
							<Button
								type="button"
								variant="ghost"
								className={`tab-button ${state === "active" ? "is-selected" : ""}`}
								aria-pressed={state === "active"}
								onClick={() => {
									setState("active");
									setConfirmingId(null);
									setActionError("");
								}}
							>
								Active
							</Button>
							<Button
								type="button"
								variant="ghost"
								className={`tab-button ${state === "archived" ? "is-selected" : ""}`}
								aria-pressed={state === "archived"}
								onClick={() => {
									setState("archived");
									setConfirmingId(null);
									setActionError("");
								}}
							>
								Archive
							</Button>
						</fieldset>
					</div>

					{actionError && (
						<p className="form-error shelf-error" role="alert">
							{actionError} The project list is unchanged.
						</p>
					)}

					{projectList.isPending ? (
						<div className="empty-shelf" aria-live="polite">
							<BookOpen size={19} strokeWidth={1.5} aria-hidden="true" />
							<p>Gathering your project notes…</p>
						</div>
					) : projectList.isError ? (
						<div className="empty-shelf error-shelf" role="alert">
							<p>These project notes could not be loaded.</p>
							<p className="muted-copy">{errorText(projectList.error)}</p>
							<Button
								type="button"
								variant="outline"
								className="folio-button folio-button-light"
								onClick={() => void projectList.refetch()}
							>
								Try again
							</Button>
						</div>
					) : projects.length === 0 ? (
						<div className="empty-shelf">
							<div className="empty-stamp" aria-hidden="true">
								{state === "active" ? "01" : "—"}
							</div>
							<div>
								<h3>
									{state === "active"
										? "Your desk is clear."
										: "Nothing has been archived yet."}
								</h3>
								<p>
									{state === "active"
										? "Start with a title above, then sketch the scope of your question."
										: "Archived projects stay here until you bring them back."}
								</p>
							</div>
						</div>
					) : (
						<ul
							className="project-list"
							id="project-list"
							aria-busy={isActionPending}
						>
							{projects.map((project, index) => (
								<li className="project-row" key={project.id}>
									<div className="project-number" aria-hidden="true">
										{String(index + 1).padStart(2, "0")}
									</div>
									<div className="project-row-main">
										<Link
											className="project-title-link"
											href={`/projects/${project.id}`}
										>
											{project.title || "Untitled research project"}
											<ArrowUpRight size={15} aria-hidden="true" />
										</Link>
										<p className="project-meta">
											Revision {project.revision}{" "}
											<span aria-hidden="true">·</span> Updated{" "}
											{formatDate(project.updatedAt)}
										</p>
									</div>
									<div className="project-row-actions">
										{confirmingId === project.id ? (
											<fieldset className="inline-confirm">
												<legend className="sr-only">
													Confirm project status change
												</legend>
												<p>
													{state === "active"
														? "Archive this project? You can restore it later."
														: "Restore this project to your active list?"}
												</p>
												<Button
													type="button"
													className="folio-button folio-button-primary"
													disabled={isActionPending}
													onClick={() => void confirmProjectAction(project.id)}
												>
													{isActionPending
														? "Saving…"
														: state === "active"
															? "Confirm archive"
															: "Confirm restore"}
												</Button>
												<Button
													type="button"
													variant="ghost"
													className="folio-button folio-button-light"
													disabled={isActionPending}
													onClick={() => setConfirmingId(null)}
												>
													Cancel
												</Button>
											</fieldset>
										) : (
											<Button
												type="button"
												variant="ghost"
												className="row-action-button"
												disabled={isActionPending}
												onClick={() => {
													setActionError("");
													setConfirmingId(project.id);
												}}
											>
												{state === "active" ? (
													<Archive size={15} aria-hidden="true" />
												) : (
													<RotateCcw size={15} aria-hidden="true" />
												)}
												{state === "active" ? "Archive" : "Restore"}
											</Button>
										)}
									</div>
								</li>
							))}
						</ul>
					)}
					{projectList.hasNextPage && (
						<div className="load-more-row">
							<Button
								type="button"
								variant="outline"
								className="folio-button folio-button-light"
								disabled={projectList.isFetchingNextPage}
								onClick={() => void projectList.fetchNextPage()}
							>
								{projectList.isFetchingNextPage
									? "Loading more…"
									: "Load more projects"}
							</Button>
						</div>
					)}
				</section>
				<footer className="page-footnote">
					<span>Blankfolio research workspace</span>
					<span>Keep the question, scope, and evidence in view.</span>
				</footer>
			</div>
		</main>
	);
}
