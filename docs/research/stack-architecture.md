# Research architecture on the fixed stack

**Question.** How should the fixed TypeScript stack support research jobs now and a future Expo client, without assuming details of the Better T Stack starter that has not yet been provided?

**Recommendation.** Keep one modular application and one PostgreSQL system of record. Run the Next.js web app and a Node.js Hono API as the synchronous entry points; mount tRPC on Hono for typed first-party web and mobile calls. Run a separate Node worker process from the same codebase for durable research tasks. Keep domain workflows, persistence, and provider interfaces in shared packages. This is a provisional design to reconcile with the supplied starter, not a claim about what it contains.

## Facts from primary sources

- Next.js Route Handlers are public HTTP endpoints, and Next.js notes that serverless hosts may terminate long-running handlers. This supports keeping request handlers short and using them to authenticate, validate, persist, enqueue, and return a job ID. [Next.js Backend for Frontend guide](https://nextjs.org/docs/app/guides/backend-for-frontend)
- Hono runs on Node.js as well as other JavaScript runtimes. tRPC supports multiple HTTP adapters and typed clients, so the fixed Hono/tRPC pair can expose a typed API to clients without coupling the workflow to Next.js. [Hono docs](https://hono.dev/docs), [tRPC](https://trpc.io/)
- Better Auth documents an Expo integration with secure client cookie storage and an example tRPC client that sends the stored cookie. Future mobile support therefore can reuse the same auth server and API with a native client plugin; it does not require moving domain logic into Expo. [Better Auth Expo integration](https://better-auth.com/docs/integrations/expo)
- pg-boss is a Node.js job queue backed by PostgreSQL. Its documented features include retries, backoff, dead-letter queues, scheduling, and enqueueing within an existing database transaction. [pg-boss README](https://github.com/timgit/pg-boss)
- S3 presigned URLs grant time-limited object access and can allow direct uploads without giving the client AWS credentials. [Amazon S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- OpenAI's Responses API accepts PDFs as file inputs, and Structured Outputs can constrain generated data to a JSON Schema. Schema validity alone does not establish that claims are true or supported. [OpenAI file inputs](https://developers.openai.com/api/docs/guides/file-inputs), [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- pgvector stores vectors in PostgreSQL and supports exact search by default plus approximate HNSW and IVFFlat indexes. [pgvector](https://github.com/pgvector/pgvector)

## Provisional decisions

### App shape and API

Use the Next.js app for web UI and server-rendered reads where useful. Use Hono as the canonical application API host and mount tRPC beneath a stable path such as `/trpc`. Keep API context construction responsible for resolving Better Auth sessions and workspace/project access; procedures call application services, not Drizzle directly. Make file upload preparation/completion and provider webhooks ordinary Hono routes because they are infrastructure-specific HTTP interactions. The web client and eventual Expo app both call the same API; mobile receives the same typed tRPC router and sends Better Auth's stored cookie. Use Node.js for Hono and workers so the runtime aligns with the fixed stack and avoids moving research or PDF work into a short-lived web request.

Treat this composition as a starter validation gate: confirm its Hono/tRPC adapter, auth cookie domain/path, CSRF and CORS settings, and server runtime before implementation. Avoid a second copy of auth configuration or domain logic in Next.js route handlers.

### Research job lifecycle

Use pg-boss for the first durable job queue; do not add Redis or a separate workflow service initially. In one PostgreSQL transaction, save the request and enqueue a job. A worker claims it, updates a persisted status (`queued`, `running`, `needs_review`, `completed`, `failed`, `cancelled`), and stores stage results. Make each stage idempotent and retryable. Record progress/events in tables so web and mobile can poll through tRPC; defer push notifications and live sockets until needed.

Represent the product's research chain explicitly in relational records: project/question → source/document → extracted passages and claims → evidence links → plan → experiment/run → manuscript sections. Store each AI result as a versioned proposal with prompt version, provider/model identifier, input references, and review state. A claim must point to one or more source passage IDs; preserve page/section locators and user corrections. Keep source metadata, relationships, job status, usage, and review history in PostgreSQL/Drizzle. Put original files and generated exports in private object storage; persist object keys and checksums, not public URLs.

### Documents and AI

Provisional object store: private Amazon S3, accessed through an object-storage interface. The API authorizes an upload, creates a unique project-scoped object key, and returns a short-lived presigned PUT. On completion, verify ownership, content type, size, and checksum before queueing parsing; never trust the client-reported type alone. This default should be revisited against the actual deployment and starter credentials. S3-compatible providers can fit behind the same adapter if AWS is not the chosen host.

Selected initial parser: use PDF.js (`pdfjs-dist`) as a deterministic Node PDF text extractor for text PDFs and retain page boundaries; mark scanned or low-text PDFs as `needs_review` until OCR is deliberately chosen. PDF.js is a general-purpose PDF parsing/rendering platform; fidelity on research tables and scans remains an integration test. [PDF.js](https://mozilla.github.io/pdf.js/) The first AI provider is OpenAI Responses API, behind a narrow `ResearchModelProvider` interface. Send extracted, bounded text for routine extraction and use native PDF input only for a demonstrated visual-layout need. Request schema-constrained claim/evidence objects, then verify every cited passage ID exists and store the passage excerpt/page used. The model proposes; the app checks references and the researcher accepts or edits. Snapshot provider and model identifiers per run; select models by required capabilities (PDF/image input, structured output, context size) in configuration, not by a baked-in latest model name. Use stateless calls with `store=false` for routine extracted-text processing; this does not eliminate abuse-monitoring retention or all feature-specific state. Avoid provider-hosted files/retrieval initially and surface external processing to users. [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)

Use PostgreSQL full-text search and metadata filters first. Add pgvector only when relevance tests show a concrete retrieval gap; keep embeddings nullable/versioned and preserve text search as a fallback. Similarity is a retrieval aid, not evidence validation.

### Cost and operational controls

Treat budgets as product policy, not provider pricing guarantees. Before calling a provider, enforce per-file page/byte ceilings, per-job source/chunk limits, per-project monthly token/request budgets, and a global concurrency cap. Start with fixed configurable ceilings and conservative worker concurrency; tune from measured usage. Track input/output tokens, provider/model, task type, duration, retries, and estimated cost in a usage ledger; warn before the project cap and reject or require an explicit reset/upgrade at the cap. Bound retries and send exhausted jobs to a visible failed state. Do not store API keys in browser/mobile code, log document contents, or silently rerun failed paid work.

## Validation gates before committing to implementation

1. Inspect the provided starter for workspace layout, Node/runtime assumptions, auth adapter, Drizzle schema/migrations, and existing tRPC/Hono wiring; preserve its conventions where they fit this design.
2. Prove the web cookie and native Better Auth Expo flow against the shared Hono API, including allowed origins and deep links.
3. Test representative born-digital, table-heavy, and scanned PDFs. Check extracted text quality, page locators, privacy/retention requirements, provider file limits, and per-job cost. Choose OCR only after these tests.
4. Confirm the deployment supports a persistent Node worker and S3-compatible private storage. If the host only runs short-lived functions, deploy the worker separately while keeping the same code and PostgreSQL queue.
5. Measure full-text retrieval against representative research questions before adding pgvector; evaluate whether model-generated evidence links remain traceable and useful to a human reviewer.
