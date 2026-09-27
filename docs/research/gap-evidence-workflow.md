# Defensible research gaps: evidence and workflow

**Scope:** web-first AI/ML research planning for a first-paper researcher, from a candidate gap through experiments and submission preparation. **Source check:** official pages available on 27 September 2026. Statements about current products and venue policies below are sourced facts; proposed product behavior is a design recommendation, not a claim that venues require it.

## Finding

A research gap is an inference bounded by a question, corpus, search method, and date. A quiet search result does not prove nobody has done the work. The product should help a researcher state and test a narrow opportunity claim, show the evidence and counterevidence behind it, and carry that record into a feasible research plan and paper. It should never certify novelty or predict acceptance.

## What products already cover

Elicit describes a systematic-review flow for refining protocols, combining database and semantic search, screening with exclusion reasons and supporting quotes, extracting values with source evidence, and synthesizing claims with sentence-level citations and search-method reporting. Scite offers full-text citation search and classifies citation statements as supporting, contrasting, or mentioning, with the citation context visible. These first-party descriptions suggest that search, extraction, cited synthesis, and citation context are established product features. The opportunity is the connected decision trail: why a specific gap claim follows from a bounded search, what would overturn it, and how it turns into a test and a defensible paper claim. ([Elicit systematic reviews](https://elicit.com/solutions/systematic-review), [Scite features](https://scite.ai/features))

## Recommended gap vocabulary

Represent a gap as a structured claim with one primary type and optional tags. This is a product taxonomy, not a universal scholarly standard:

- **Coverage:** a population, domain, language, data regime, setting, or time period has little direct evidence.
- **Comparison:** a relevant method, baseline, comparator, or deployment condition has not been compared fairly or directly.
- **Outcome or measurement:** an important outcome, metric, construct, or evaluation protocol is missing or weakly validated.
- **Robustness or generalization:** evidence is narrow across seeds, distribution shifts, subgroups, environments, scale, or adversarial conditions.
- **Method or mechanism:** an identified limitation, assumption, or unresolved mechanism needs analysis or a different method.
- **Conflicting evidence:** credible studies disagree, or findings vary by assumptions, implementation, or context.
- **Reproducibility or artifact:** results or claims lack enough accessible detail/artifacts for independent checking.
- **Feasibility or responsible use:** a technically studied method lacks evidence on cost, access, privacy, safety, or other consequential constraints.

The system should preserve the author's own wording and allow “other.” It must distinguish _not studied in the searched set_, _a paper explicitly identifies this limitation_, _studies report conflicting results_, and _a researcher proposes a new direction_. These are different evidence states.

## Evidence record and acceptance gates

Each candidate gap should be editable and carry: (1) a precise claim and scope (task, population/domain, method or comparison, outcome, setting); (2) a queryable search protocol (sources/databases, exact query or semantic-search prompt, date, filters, inclusion/exclusion criteria, and screening decisions); (3) a linked paper set with stable IDs, versions, and publication status; (4) claim-level source spans/page/table references, with extractor confidence and human verification state; and (5) supportive, contrary, and ambiguous evidence, plus known coverage limits. Retain source wording; label the system's paraphrase as a synthesis. A paper's “future work” sentence is evidence that its authors proposed an avenue, not evidence that the avenue remains untouched.

Use explicit, reversible gates:

1. **Scoped:** the researcher can say what counts as in-scope and what does not.
2. **Searchable:** another person can rerun or inspect the sources and screening trail. Show when a source is unavailable, a corpus is partial, or only metadata/abstracts were searched. Never translate “not found” into “does not exist.”
3. **Contested:** run targeted counter-searches for synonyms, adjacent terminology, older work, workshops/preprints, related benchmarks, and evidence against the claim. Record whether conflicting citation signals are about the same task and conditions; a citation label alone cannot settle that.
4. **Worth investigating:** the researcher explains why the possible contribution matters and for whom. Keep significance separate from novelty and from feasibility.
5. **Plan-ready:** a human-approved question, hypotheses or research questions, data/access and ethics constraints, baselines, outcomes, procedure, resources, and decision rule exist. Suggest appropriate evaluation choices from the design; do not impose significance tests or repeated runs universally. A theorem, qualitative study, benchmark, or expensive system evaluation needs different evidence.
6. **Evidence-backed result:** record deviations, null/negative results, artifacts, versions, compute, and limitations alongside positive results. Link each eventual paper claim to its planned test and observed result. Missing or non-reproducible evidence should remain visible, not be filled in by generated prose.
7. **Submission-ready:** select a venue and date, then retrieve that venue's current author checklist, format, ethics, anonymity, and AI-use rules. Generate a checklist with source links and human sign-off; policies vary and change.

This pattern fits documented venue expectations without turning them into a single universal rubric. NeurIPS 2026 calls for sufficient information to reproduce results, a paper checklist, and disclosure of important, original, or non-standard LLM/agent use in methodology; authors remain responsible for correctness and references. Its checklist says a justified “no” is acceptable for many questions and asks authors to explain limitations. ICML 2026 permits AI assistance in author research/writing while placing responsibility on authors and encouraging disclosure of notable methodological use. ACM RESPECT 2026 asks for full disclosure of generative AI-created content in that event's work. These are examples, not interchangeable rules for all venues. ([NeurIPS 2026 Main Track Handbook](https://neurips.cc/Conferences/2026/MainTrackHandbook), [NeurIPS Paper Checklist](https://neurips.cc/public/guides/PaperChecklist), [ICML 2026 Call for Papers](https://icml.cc/Conferences/2026/CallForPapers), [ACM RESPECT 2026 AI policy](https://respect.acm.org/2026/index.php/policies-on-generative-ai-llms-and-related-tools/))

## Coverage and trust limits

Show indexed sources and last-updated dates; search queries and dates; unavailable full text; language and publication-type filters; duplicates; citation graph boundaries; and whether preprints, workshops, theses, negative results, non-English work, or recent papers may be missed. Make “unknown” a first-class value. Citation support/contrast classifications are retrieval signals, not a quality score or causal verdict. A citation may support only a narrow clause or cite a paper for background. Require users to inspect the cited passage and neighboring context before using it as support. Where studies disagree, expose differences in datasets, settings, metrics, and assumptions before summarizing.

The product should present “candidate gap with this evidence and these limits,” never “novel,” “first,” or “guaranteed publishable” as an automated verdict. Novelty remains a human judgment informed by an incomplete and moving record; acceptance also depends on execution, contribution, venue fit, and reviewer judgment.

## Evaluation proposals

Evaluate the workflow on a set of expert-adjudicated research questions with deliberately included near-neighbor work and counterexamples. Measure (a) whether each displayed claim is entailed by its linked source passage; (b) recall of seeded relevant and contradictory studies within declared corpus limits; (c) whether researchers detect when search coverage is insufficient; (d) agreement between independent experts on gap type and evidence state, with adjudication for disagreements; and (e) whether generated research plans preserve traceability from gap to proposed test and from result to paper claim. Run a first-paper user study comparing the workflow with their current literature tools: observe unsupported novelty claims, missed counterevidence, correction burden, plan reviewability, and time to an expert-reviewed plan. Report methods, task mix, uncertainty, and failure cases; do not optimize for acceptance prediction.
