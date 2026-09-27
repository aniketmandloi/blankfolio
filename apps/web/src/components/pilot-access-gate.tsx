"use client";

import { Button } from "@blankfolio/ui/components/button";
import { useQuery } from "@tanstack/react-query";

import { authClient } from "@/lib/auth-client";
import { trpc } from "@/utils/trpc";

import ResendVerificationForm from "./resend-verification-form";
import { signOut } from "./user-menu";

const states = {
	"verification-required": {
		eyebrow: "Verify your email",
		title: "Confirm your address to continue.",
		body: "Research Projects open only for verified accounts invited to the pilot. Request a new verification link, open it, then return here.",
	},
	"pending-invitation": {
		eyebrow: "Invitation pending",
		title: "Your account is waiting for an invitation.",
		body: "Your email is verified. This pilot is invite-only, so Research Projects stay closed until the pilot operator invites this address. Contact the operator if you expected access.",
	},
	revoked: {
		eyebrow: "Access withdrawn",
		title: "Pilot access has been withdrawn.",
		body: "Your private projects are kept, but they cannot be opened or changed while access is withdrawn. Contact the pilot operator if you think this is a mistake.",
	},
};

/** Presentation only: every research operation is also refused by the API. */
export default function PilotAccessGate({
	children,
}: {
	children: React.ReactNode;
}) {
	const { data: session } = authClient.useSession();
	const access = useQuery(trpc.account.access.queryOptions());

	if (access.data?.status === "eligible") return children;

	return (
		<main className="folio-main">
			<div className="folio-page">
				{access.isPending ? (
					<div className="detail-loading" aria-live="polite">
						Checking pilot access…
					</div>
				) : access.isError ? (
					<section className="account-state" role="alert">
						<p className="eyebrow">Pilot access</p>
						<h1 className="display-title">Access could not be checked.</h1>
						<p>Your projects are unchanged. Try again in a moment.</p>
						<div className="account-actions">
							<Button
								type="button"
								variant="outline"
								className="folio-button folio-button-light"
								onClick={() => void access.refetch()}
							>
								Try again
							</Button>
						</div>
					</section>
				) : (
					<section className="account-state" aria-labelledby="access-title">
						<p className="eyebrow">{states[access.data.status].eyebrow}</p>
						<h1 className="display-title" id="access-title">
							{states[access.data.status].title}
						</h1>
						<p>{states[access.data.status].body}</p>
						{session && <p>Signed in as {session.user.email}.</p>}
						{access.data.status === "verification-required" && session && (
							<ResendVerificationForm email={session.user.email} />
						)}
						<div className="account-actions">
							<Button
								type="button"
								variant="outline"
								className="folio-button folio-button-light"
								onClick={signOut}
							>
								Sign out
							</Button>
						</div>
					</section>
				)}
			</div>
		</main>
	);
}
