import Link from "next/link";

import ResendVerificationForm from "@/components/resend-verification-form";

export default async function EmailVerifiedPage({
	searchParams,
}: {
	searchParams: Promise<{ error?: string }>;
}) {
	const { error } = await searchParams;

	return (
		<main className="folio-main">
			<div className="folio-page">
				{error ? (
					<section
						className="account-state"
						aria-labelledby="verification-link-title"
					>
						<p className="eyebrow">Verification link</p>
						<h1 className="display-title" id="verification-link-title">
							{error === "TOKEN_EXPIRED"
								? "This link has expired."
								: "This link cannot be used."}
						</h1>
						<p>
							Verification links work once and expire after one hour. Enter your
							email to request a new one.
						</p>
						<ResendVerificationForm />
						<div className="account-actions">
							<Link className="text-link" href="/login">
								Back to sign in
							</Link>
						</div>
					</section>
				) : (
					<section
						className="account-state"
						aria-labelledby="email-verified-title"
					>
						<p className="eyebrow">Email verified</p>
						<h1 className="display-title" id="email-verified-title">
							Your address is confirmed.
						</h1>
						<p>
							Sign in to continue. Research Projects open once your account has
							been invited to the pilot.
						</p>
						<div className="account-actions">
							<Link className="text-link" href="/login">
								Sign in
							</Link>
						</div>
					</section>
				)}
			</div>
		</main>
	);
}
