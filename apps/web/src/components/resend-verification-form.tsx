"use client";

import { Button } from "@blankfolio/ui/components/button";
import { Input } from "@blankfolio/ui/components/input";
import { Label } from "@blankfolio/ui/components/label";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";

export default function ResendVerificationForm({ email }: { email?: string }) {
	const [address, setAddress] = useState(email ?? "");
	const [state, setState] = useState<"idle" | "pending" | "sent" | "failed">(
		"idle",
	);

	return (
		<form
			className="account-form"
			onSubmit={async (event) => {
				event.preventDefault();
				setState("pending");
				const { error } = await authClient.sendVerificationEmail({
					email: address.trim(),
					callbackURL: `${window.location.origin}/email-verified`,
				});
				setState(error ? "failed" : "sent");
			}}
		>
			{!email && (
				<div className="field-stack">
					<Label htmlFor="verification-email">Email</Label>
					<Input
						id="verification-email"
						type="email"
						autoComplete="email"
						required
						value={address}
						onChange={(event) => setAddress(event.target.value)}
					/>
				</div>
			)}
			<div className="account-actions">
				<Button
					type="submit"
					className="folio-button folio-button-primary"
					disabled={state === "pending"}
				>
					{state === "pending" ? "Requesting…" : "Send a new verification link"}
				</Button>
			</div>
			<p className="form-note" role="status">
				{state === "sent" &&
					"If this address still needs verification, a new link is on its way. Links expire after one hour."}
			</p>
			{state === "failed" && (
				<p className="form-error" role="alert">
					A new link could not be requested right now. Wait a moment and try
					again.
				</p>
			)}
		</form>
	);
}
