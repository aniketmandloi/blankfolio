"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import {
	confirmLeavingUnsavedBrief,
	onUnsavedBriefChange,
} from "@/lib/unsaved-brief";

import { ModeToggle } from "./mode-toggle";
import UserMenu from "./user-menu";

export default function Header() {
	const [hasUnsavedBrief, setHasUnsavedBrief] = useState(false);
	const pathname = usePathname();
	const inProjects =
		pathname === "/dashboard" || pathname.startsWith("/projects/");

	useEffect(() => onUnsavedBriefChange(setHasUnsavedBrief), []);

	return (
		<header className="site-header">
			<div className="site-header-inner">
				<div className="site-header-primary">
					<Link
						className="site-wordmark"
						href="/dashboard"
						onClick={(event) =>
							confirmLeavingUnsavedBrief(event, hasUnsavedBrief)
						}
					>
						blankfolio
					</Link>
					<nav className="site-nav" aria-label="Primary navigation">
						<Link
							className="site-nav-link"
							href="/dashboard"
							aria-current={inProjects ? "page" : undefined}
							onClick={(event) =>
								confirmLeavingUnsavedBrief(event, hasUnsavedBrief)
							}
						>
							Projects
						</Link>
					</nav>
				</div>
				<div className="site-header-tools">
					<ModeToggle />
					<UserMenu />
				</div>
			</div>
		</header>
	);
}
