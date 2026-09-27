import Link from "next/link";

import {
	NewPasswordForm,
	RequestResetForm,
} from "@/components/password-recovery";

export default async function ResetPasswordPage({
	searchParams,
}: {
	searchParams: Promise<{ token?: string; error?: string }>;
}) {
	const { token, error } = await searchParams;

	return (
		<main className="folio-main">
			<div className="folio-page">
				<section className="account-state" aria-labelledby="recovery-title">
					<p className="eyebrow">Account recovery</p>
					<h1 className="display-title" id="recovery-title">
						{token
							? "Choose a new password."
							: error
								? "This recovery link cannot be used."
								: "Recover your account."}
					</h1>
					<p>
						{token
							? "Saving a new password signs out every other session on this account."
							: error
								? "Recovery links work once and expire after one hour. Request a new one below."
								: "Enter the email you registered with and we will send a recovery link if an account uses it."}
					</p>
					{token ? <NewPasswordForm token={token} /> : <RequestResetForm />}
					<div className="account-actions">
						<Link className="text-link" href="/login">
							Back to sign in
						</Link>
					</div>
				</section>
			</div>
		</main>
	);
}
