"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

import { ModeToggle } from "./mode-toggle";
import UserMenu from "./user-menu";

export default function Header() {
	const [hasUnsavedBrief, setHasUnsavedBrief] = useState(false);

	useEffect(() => {
		const onUnsavedChange = (event: Event) => {
			const detail = (event as CustomEvent<{ dirty: boolean }>).detail;
			setHasUnsavedBrief(Boolean(detail?.dirty));
		};
		window.addEventListener("blankfolio:unsaved-change", onUnsavedChange);
		return () =>
			window.removeEventListener("blankfolio:unsaved-change", onUnsavedChange);
	}, []);

	return (
		<header className="site-header">
			<div className="site-header-inner">
				<div className="site-header-primary">
					<Link
						className="site-wordmark"
						href="/dashboard"
						onClick={(event) => {
							if (
								hasUnsavedBrief &&
								!window.confirm(
									"Leave this project? Your unsaved brief edits will be lost.",
								)
							) {
								event.preventDefault();
							}
						}}
					>
						<span className="wordmark-mark" aria-hidden="true">
							b.
						</span>
						<span>blankfolio</span>
					</Link>
					<span className="header-divider" aria-hidden="true" />
					<nav className="site-nav" aria-label="Primary navigation">
						<Link
							className="site-nav-link"
							href="/dashboard"
							onClick={(event) => {
								if (
									hasUnsavedBrief &&
									!window.confirm(
										"Leave this project? Your unsaved brief edits will be lost.",
									)
								) {
									event.preventDefault();
								}
							}}
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
