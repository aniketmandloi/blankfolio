import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { authClient } from "@/lib/auth-client";

import ProjectOverview from "./project-overview";

export default async function ProjectPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const session = await authClient.getSession({
		fetchOptions: {
			headers: await headers(),
			throw: true,
		},
	});

	if (!session?.user) {
		redirect("/login");
	}

	const { id } = await params;
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
	) {
		notFound();
	}

	return <ProjectOverview id={id} />;
}
