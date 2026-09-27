"use client";

import { Button } from "@blankfolio/ui/components/button";
import { Input } from "@blankfolio/ui/components/input";
import { Label } from "@blankfolio/ui/components/label";
import Link from "next/link";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";

export function RequestResetForm() {
	const [email, setEmail] = useState("");
	const [state, setState] = useState<"idle" | "pending" | "sent" | "failed">(
		"idle",
	);

	return (
		<form
			className="account-form"
			onSubmit={async (event) => {
				event.preventDefault();
				setState("pending");
				const { error } = await authClient.requestPasswordReset({
					email: email.trim(),
					redirectTo: `${window.location.origin}/reset-password`,
				});
				setState(error ? "failed" : "sent");
			}}
		>
			<div className="field-stack">
				<Label htmlFor="recovery-email">Email</Label>
				<Input
					id="recovery-email"
					type="email"
					autoComplete="email"
					required
					value={email}
					onChange={(event) => setEmail(event.target.value)}
				/>
			</div>
			<div className="account-actions">
				<Button
					type="submit"
					className="folio-button folio-button-primary"
					disabled={state === "pending"}
				>
					{state === "pending" ? "Requesting…" : "Send a recovery link"}
				</Button>
			</div>
			<p className="form-note" role="status">
				{state === "sent" &&
					"If an account uses this address, a recovery link is on its way. It works once and expires after one hour."}
			</p>
			{state === "failed" && (
				<p className="form-error" role="alert">
					A recovery link could not be requested right now. Wait a moment and
					try again.
				</p>
			)}
		</form>
	);
}

export function NewPasswordForm({ token }: { token: string }) {
	const [password, setPassword] = useState("");
	const [confirmation, setConfirmation] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<{ expired: boolean; message: string }>();
	const mismatch = confirmation !== "" && confirmation !== password;

	return (
		<form
			className="account-form"
			onSubmit={async (event) => {
				event.preventDefault();
				if (mismatch) return;
				setPending(true);
				setError(undefined);
				const result = await authClient.resetPassword({
					newPassword: password,
					token,
				});
				if (!result.error) {
					window.location.replace("/login?reset=done");
					return;
				}
				setPending(false);
				setError({
					expired: result.error.code === "INVALID_TOKEN",
					message:
						result.error.code === "INVALID_TOKEN"
							? "This recovery link has expired or was already used."
							: (result.error.message ?? "The password could not be updated."),
				});
			}}
		>
			<div className="field-stack">
				<Label htmlFor="new-password">New password</Label>
				<Input
					id="new-password"
					type="password"
					autoComplete="new-password"
					minLength={8}
					required
					value={password}
					onChange={(event) => setPassword(event.target.value)}
					aria-describedby="new-password-hint"
				/>
				<p className="form-note" id="new-password-hint">
					At least 8 characters. Other signed-in sessions end when you save.
				</p>
			</div>
			<div className="field-stack">
				<Label htmlFor="confirm-password">Confirm new password</Label>
				<Input
					id="confirm-password"
					type="password"
					autoComplete="new-password"
					required
					value={confirmation}
					onChange={(event) => setConfirmation(event.target.value)}
					aria-invalid={mismatch}
					aria-describedby={mismatch ? "confirm-password-error" : undefined}
				/>
				{mismatch && (
					<p className="form-error" id="confirm-password-error">
						The passwords do not match.
					</p>
				)}
			</div>
			<div className="account-actions">
				<Button
					type="submit"
					className="folio-button folio-button-primary"
					disabled={pending || mismatch}
				>
					{pending ? "Saving…" : "Save new password"}
				</Button>
			</div>
			{error && (
				<p className="form-error" role="alert">
					{error.message}{" "}
					{error.expired && (
						<Link className="text-link" href="/reset-password">
							Request a new link
						</Link>
					)}
				</p>
			)}
		</form>
	);
}
