import { protectedProcedure, publicProcedure, router } from "../index";
import { projectsRouter } from "./projects";

export const appRouter = router({
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
