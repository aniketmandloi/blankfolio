/**
 * Atom feeds shaped like the arXiv API's `/api/query` answers (entry `id` with version,
 * `published`/`updated`, `arxiv:doi`, `arxiv:journal_ref`, `arxiv:comment` and
 * `opensearch:totalResults`; info.arxiv.org/help/api/user-manual, checked 28 September 2026).
 * Every value is synthetic; nothing here reaches the network.
 */
export type ArxivEntryFixture = {
	id: string;
	version: number;
	title: string;
	summary: string | null;
	authors: string[];
	published: string;
	updated: string;
	doi: string | null;
	journalRef: string | null;
	comment: string | null;
};

export function arxivEntry(
	id: string,
	overrides: Partial<ArxivEntryFixture> = {},
): ArxivEntryFixture {
	return {
		id,
		version: 1,
		title: `Recorded preprint ${id}`,
		summary: "A recorded abstract & its <details>.",
		authors: ["Ada Record", "Ben Sample"],
		published: "2024-08-09T11:30:52Z",
		updated: "2024-08-09T11:30:52Z",
		doi: null,
		journalRef: null,
		comment: null,
		...overrides,
	};
}

const escapeXml = (text: string) =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function entryXml(entry: ArxivEntryFixture) {
	const abs = `https://arxiv.org/abs/${entry.id}v${entry.version}`;
	return `  <entry>
    <id>http://arxiv.org/abs/${entry.id}v${entry.version}</id>
    <title>${escapeXml(entry.title)}</title>
    <updated>${entry.updated}</updated>
    <link href="${abs}" rel="alternate" type="text/html"/>
    <link href="https://arxiv.org/pdf/${entry.id}v${entry.version}" rel="related" type="application/pdf" title="pdf"/>
${entry.summary === null ? "" : `    <summary>${escapeXml(entry.summary)}</summary>\n`}    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
    <published>${entry.published}</published>
${entry.comment === null ? "" : `    <arxiv:comment>${escapeXml(entry.comment)}</arxiv:comment>\n`}${entry.journalRef === null ? "" : `    <arxiv:journal_ref>${escapeXml(entry.journalRef)}</arxiv:journal_ref>\n`}${entry.doi === null ? "" : `    <arxiv:doi>${entry.doi}</arxiv:doi>\n`}    <arxiv:primary_category term="cs.LG"/>
${entry.authors.map((name) => `    <author>\n      <name>${escapeXml(name)}</name>\n    </author>`).join("\n")}
  </entry>`;
}

export function arxivFeed(
	entries: ArxivEntryFixture[],
	total = entries.length,
	start = 0,
) {
	return `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom">
  <id>https://arxiv.org/api/recorded</id>
  <title>arXiv Query: recorded</title>
  <updated>2026-09-28T17:53:49Z</updated>
  <opensearch:itemsPerPage>${entries.length}</opensearch:itemsPerPage>
  <opensearch:totalResults>${total}</opensearch:totalResults>
  <opensearch:startIndex>${start}</opensearch:startIndex>
${entries.map(entryXml).join("\n")}
</feed>
`;
}

export const atom = (body: string, init: ResponseInit = {}) =>
	new Response(body, {
		status: 200,
		headers: { "content-type": "application/atom+xml; charset=utf-8" },
		...init,
	});
