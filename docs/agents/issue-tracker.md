# Issue tracker: GitHub

Issues and specs live in GitHub Issues for aniketmandloi/blankfolio.
Use the gh CLI from this repo.

## Conventions

- Create: gh issue create --title "..." --body-file <file>
- Read: gh issue view <number> --comments
- List: gh issue list --state open --json number,title,body,labels,comments
  Add label and state filters as needed.
- Comment: gh issue comment <number> --body-file <file>
- Apply labels: gh issue edit <number> --add-label "..."
- Remove labels: gh issue edit <number> --remove-label "..."
- Close: gh issue close <number> --comment "..."

For multiline issue bodies and comments, write the exact text to a
temporary file and pass it with --body-file.

Infer the repository from git remote -v; gh does this automatically
when run inside this clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub issues and pull requests share a number space. For an ambiguous
reference, try gh pr view <number>, then gh issue view <number>.

## Skill operations

When a skill says "publish to the issue tracker", create a GitHub issue.
When it says "fetch the relevant ticket", read the issue with comments.

## Wayfinding operations

- Map: one issue labelled wayfinder:map, holding Notes,
  Decisions-so-far, and Fog.
- Child ticket: link it to the map as a GitHub sub-issue. If sub-issues
  are unavailable, add it to a task list in the map body and put
  "Part of #<map>" at the top of the child body.
- Ticket types: wayfinder:research, wayfinder:prototype,
  wayfinder:grilling, and wayfinder:task.
- Blocking: use GitHub native issue dependencies. Add a blocker with
  gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by
  -F issue_id=<blocker-db-id>.
  Obtain the database ID with
  gh api repos/<owner>/<repo>/issues/<number> --jq .id.
  If dependencies are unavailable, record "Blocked by: #<number>"
  at the top of the child body.
- Frontier: inspect the map's open children in map order. Pick the
  first unassigned child whose blockers are all closed.
- Claim: gh issue edit <number> --add-assignee @me.
- Resolve: comment with the answer, close the child, then append a
  gist and link to the map's Decisions-so-far.
