import { protectedProcedure, publicProcedure, router } from "../index";
import { accountRouter } from "./account";
import { projectsRouter } from "./projects";

export const appRouter = router({
	account: accountRouter,
	projects: projectsRouter,
	healthCheck: publicProcedure.query(() => {
		return "OK";
	}),
	privateData: protectedProcedure.query(({ ctx }) => {
		return {
			message: "This is private",
			user: ctx.session.user,
		};
	}),
});
export type AppRouter = typeof appRouter;
