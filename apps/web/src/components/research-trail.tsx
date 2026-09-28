import Link from "next/link";
import type { CSSProperties, MouseEvent } from "react";

const stages: { id: string; label: string; path?: string }[] = [
	{ id: "brief", label: "Brief", path: "" },
	{ id: "literature", label: "Literature", path: "/literature" },
	{ id: "gaps", label: "Gaps" },
	{ id: "plan", label: "Plan" },
	{ id: "experiments", label: "Experiments" },
	{ id: "manuscript", label: "Manuscript" },
];

export default function ResearchTrail({
	projectId,
	current,
	onNavigate,
}: {
	projectId: string;
	current: "brief" | "literature";
	onNavigate?: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
	return (
		<nav className="research-trail" aria-label="Research stages">
			<ol>
				{stages.map((stage, index) => (
					<li
						key={stage.id}
						className="trail-stage"
						aria-current={stage.id === current ? "step" : undefined}
						data-later={stage.path === undefined ? "" : undefined}
						style={{ "--stage": index } as CSSProperties}
					>
						<span className="trail-dot" aria-hidden="true" />
						{stage.id === current ? (
							<span className="trail-label">{stage.label}</span>
						) : stage.path !== undefined ? (
							<Link
								className="trail-link"
								href={`/projects/${projectId}${stage.path}`}
								onClick={onNavigate}
							>
								{stage.label}
							</Link>
						) : (
							<>
								{stage.label}
								<span className="trail-later">Later</span>
							</>
						)}
					</li>
				))}
			</ol>
		</nav>
	);
}
