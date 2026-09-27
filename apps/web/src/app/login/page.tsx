"use client";

import { Button } from "@blankfolio/ui/components/button";
import { use, useState } from "react";

import ResendVerificationForm from "@/components/resend-verification-form";
import SignInForm from "@/components/sign-in-form";
import SignUpForm from "@/components/sign-up-form";

type View =
	| { name: "sign-in" | "sign-up" }
	| { name: "verify"; email: string; registered: boolean };

export default function LoginPage({
	searchParams,
}: {
	searchParams: Promise<{ reset?: string }>;
}) {
	const { reset } = use(searchParams);
	const [view, setView] = useState<View>({ name: "sign-in" });
	const verify = (email: string, registered: boolean) =>
		setView({ name: "verify", email, registered });

	if (view.name === "verify")
		return (
			<main className="folio-main">
				<div className="folio-page">
					<section
						className="account-state"
						aria-labelledby="verify-email-title"
					>
						<p className="eyebrow">Verify your email</p>
						<h1 className="display-title" id="verify-email-title">
							{view.registered
								? "Check your inbox."
								: "Verify your email first."}
						</h1>
						<p>
							{view.registered
								? `A verification link is on its way to ${view.email}. If that address already has an account, sign in or reset your password instead.`
								: `${view.email} has not been verified yet.`}{" "}
							Open the link, then sign in. Research Projects open for verified
							accounts that have been invited to the pilot.
						</p>
						<ResendVerificationForm email={view.email} />
						<div className="account-actions">
							<Button
								type="button"
								variant="outline"
								className="folio-button folio-button-light"
								onClick={() => setView({ name: "sign-in" })}
							>
								Back to sign in
							</Button>
						</div>
					</section>
				</div>
			</main>
		);

	return view.name === "sign-in" ? (
		<SignInForm
			notice={
				reset === "done"
					? "Your password was updated and other sessions were signed out. Sign in with the new password."
					: undefined
			}
			onSwitchToSignUp={() => setView({ name: "sign-up" })}
			onUnverified={(email) => verify(email, false)}
		/>
	) : (
		<SignUpForm
			onSwitchToSignIn={() => setView({ name: "sign-in" })}
			onRegistered={(email) => verify(email, true)}
		/>
	);
}
