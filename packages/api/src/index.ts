import { initTRPC, TRPCError } from "@trpc/server";

import type { Context } from "./context";
import { pilotAccessMessages, pilotAccessStatus } from "./pilot-access";

export const t = initTRPC.context<Context>().create({
	errorFormatter({ shape, error }) {
		return {
			...shape,
			message:
				error.code === "INTERNAL_SERVER_ERROR"
					? "Research operation failed. Try again later."
					: shape.message,
			data: { ...shape.data, stack: undefined },
		};
	},
});

export const router = t.router;

export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
	if (!ctx.session) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "Authentication required",
			cause: "No session",
		});
	}
	return next({
		ctx: {
			...ctx,
			session: ctx.session,
		},
	});
});

/** Checked before any project lookup, so ineligible accounts learn nothing about project IDs. */
export const researchProcedure = protectedProcedure.use(
	async ({ ctx, next }) => {
		const access = await pilotAccessStatus(ctx.db, ctx.session.user.id);
		if (access !== "eligible")
			throw new TRPCError({
				code: "FORBIDDEN",
				message: pilotAccessMessages[access],
			});
		return next();
	},
);
