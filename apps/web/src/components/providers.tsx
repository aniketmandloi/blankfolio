"use client";

import { Toaster } from "@blankfolio/ui/components/sonner";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { authClient } from "@/lib/auth-client";
import { queryClient } from "@/utils/trpc";

import { ThemeProvider } from "./theme-provider";

function AccountBoundary({ children }: { children: React.ReactNode }) {
	const { data: session, isPending } = authClient.useSession();
	const currentIdentity = session?.user.id ?? null;
	const pathname = usePathname();
	const protectedRoute =
		pathname === "/dashboard" || pathname.startsWith("/projects/");
	const [cacheIdentity, setCacheIdentity] = useState<string | null>();

	useEffect(() => {
		if (isPending) return;
		if (protectedRoute && !currentIdentity) {
			queryClient.clear();
			window.location.replace("/login");
			return;
		}
		if (cacheIdentity === undefined) {
			queryClient.clear();
			setCacheIdentity(currentIdentity);
		} else if (cacheIdentity !== currentIdentity) {
			queryClient.clear();
			// A new document also discards callbacks from the previous account's
			// in-flight mutations, which could otherwise refill a cleared cache.
			window.location.replace(currentIdentity ? "/dashboard" : "/login");
		}
	}, [cacheIdentity, currentIdentity, isPending, protectedRoute]);

	if (
		isPending ||
		cacheIdentity === undefined ||
		cacheIdentity !== currentIdentity ||
		(protectedRoute && !currentIdentity)
	) {
		return (
			<div
				className="flex min-h-screen items-center justify-center"
				role="status"
			>
				Checking account…
			</div>
		);
	}
	return children;
}

export default function Providers({ children }: { children: React.ReactNode }) {
	return (
		<ThemeProvider
			attribute="class"
			defaultTheme="system"
			enableSystem
			disableTransitionOnChange
		>
			<QueryClientProvider client={queryClient}>
				<AccountBoundary>
					{children}
					<ReactQueryDevtools />
				</AccountBoundary>
			</QueryClientProvider>
			<Toaster richColors />
		</ThemeProvider>
	);
}
