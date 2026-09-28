import { Button } from "@blankfolio/ui/components/button";
import { Input } from "@blankfolio/ui/components/input";
import { Label } from "@blankfolio/ui/components/label";
import { useForm } from "@tanstack/react-form";
import Link from "next/link";
import { toast } from "sonner";
import z from "zod";

import { authClient } from "@/lib/auth-client";
import { queryClient } from "@/utils/trpc";

import Loader from "./loader";

export default function SignInForm({
	onSwitchToSignUp,
	onUnverified,
	notice,
}: {
	onSwitchToSignUp: () => void;
	onUnverified: (email: string) => void;
	notice?: string;
}) {
	const { isPending } = authClient.useSession();

	const form = useForm({
		defaultValues: {
			email: "",
			password: "",
		},
		onSubmit: async ({ value }) => {
			await authClient.signIn.email(
				{
					email: value.email,
					password: value.password,
				},
				{
					onSuccess: () => {
						queryClient.clear();
						window.location.replace("/dashboard");
						toast.success("Sign in successful");
					},
					onError: (error) => {
						if (error.error.code === "EMAIL_NOT_VERIFIED") {
							onUnverified(value.email);
							return;
						}
						toast.error(error.error.message || error.error.statusText);
					},
				},
			);
		},
		validators: {
			onSubmit: z.object({
				email: z.email("Invalid email address"),
				password: z.string().min(8, "Password must be at least 8 characters"),
			}),
		},
	});

	if (isPending) {
		return <Loader />;
	}

	return (
		<main className="folio-main">
			<div className="folio-page">
				<section className="account-state" aria-labelledby="sign-in-title">
					<div>
						<h1 className="display-title" id="sign-in-title">
							Sign in
						</h1>
						<p className="page-intro">
							Turn a broad interest into a defensible research question.
						</p>
					</div>
					{notice && (
						<p className="muted-copy" role="status">
							{notice}
						</p>
					)}

					<form
						onSubmit={(e) => {
							e.preventDefault();
							e.stopPropagation();
							form.handleSubmit();
						}}
						className="account-form"
					>
						<div>
							<form.Field name="email">
								{(field) => (
									<div className="field-stack">
										<Label htmlFor={field.name}>Email</Label>
										<Input
											id={field.name}
											name={field.name}
											type="email"
											value={field.state.value}
											onBlur={field.handleBlur}
											onChange={(e) => field.handleChange(e.target.value)}
										/>
										{field.state.meta.errors.map((error) => (
											<p key={error?.message} className="form-error">
												{error?.message}
											</p>
										))}
									</div>
								)}
							</form.Field>
						</div>

						<div>
							<form.Field name="password">
								{(field) => (
									<div className="field-stack">
										<Label htmlFor={field.name}>Password</Label>
										<Input
											id={field.name}
											name={field.name}
											type="password"
											value={field.state.value}
											onBlur={field.handleBlur}
											onChange={(e) => field.handleChange(e.target.value)}
										/>
										{field.state.meta.errors.map((error) => (
											<p key={error?.message} className="form-error">
												{error?.message}
											</p>
										))}
									</div>
								)}
							</form.Field>
						</div>

						<form.Subscribe
							selector={(state) => ({
								canSubmit: state.canSubmit,
								isSubmitting: state.isSubmitting,
							})}
						>
							{({ canSubmit, isSubmitting }) => (
								<Button
									type="submit"
									className="folio-button folio-button-primary w-full"
									disabled={!canSubmit || isSubmitting}
								>
									{isSubmitting ? "Signing in…" : "Sign in"}
								</Button>
							)}
						</form.Subscribe>
					</form>

					<div className="account-actions">
						<Link href="/reset-password" className="text-link">
							Forgot your password?
						</Link>
						<Button
							variant="link"
							onClick={onSwitchToSignUp}
							className="h-auto p-0 text-link text-sm"
						>
							Need an account? Sign up
						</Button>
					</div>
				</section>
			</div>
		</main>
	);
}
