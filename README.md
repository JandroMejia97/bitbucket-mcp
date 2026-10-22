# bitbucket-pr-mcp

MCP server for managing Pull Request comments on Bitbucket Cloud from Cursor or Claude Code.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your credentials
```

## Available tools

### Comments

| Tool                   | Description                         |
| ---------------------- | ----------------------------------- |
| `add_pr_comment`       | Creates a general or inline comment |
| `add_pr_comments_bulk` | Creates N comments in a single call |
| `list_pr_comments`     | Lists comments with pagination      |
| `get_pr_comment`       | Full details of a specific comment  |
| `update_pr_comment`    | Edits an existing comment           |
| `delete_pr_comment`    | Deletes a comment                   |
| `reply_to_pr_comment`  | Replies in an existing thread       |
| `resolve_pr_comment`   | Marks an inline comment as resolved |
| `unresolve_pr_comment` | Reopens a resolved comment          |

### Review & approval

| Tool                     | Description                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `create_pr`              | Opens a PR (adds default reviewers, refuses duplicates); dialog or preview + token   |
| `list_prs`               | Lists a repo's PRs by state/reviewer/author; `review_status` filters current page only |
| `submit_review`          | Posts all comments + sets verdict in one call (best for AI reviews)                  |
| `approve_pr`             | Approves the PR                                                                      |
| `remove_pr_approval`     | Removes a previously submitted approval                                              |
| `request_changes`        | Marks the PR as needing changes (blocks merge)                                       |
| `remove_changes_request` | Removes the changes_requested status                                                 |
| `get_pr_status`          | PR summary: state, author, reviewers, approval status                                |

### Recommended flow for AI code reviews

```text
0. list_prs           → review_status=pending (reviewer defaults to me, drafts hidden) → pick pr_id
1. get_pr_status      → check current state and reviewers
2. submit_review      → post all inline comments + summary + verdict atomically
```

> **Note:** The Bitbucket Cloud API does not expose a "pending comments" endpoint
> (unlike GitHub's draft reviews). `submit_review` approximates this by posting
> all comments in quick succession before setting the verdict.

### Creating PRs

Before any confirmation, `create_pr` checks for an OPEN PR from the same source branch (and the same destination, when one is given) and refuses if it finds one. If that lookup fails, no PR is created.

The user then sees a summary: title, branches, reviewers (default ones tagged), the description (the first 2000 characters, each line prefixed with `| `, plus a count of any characters not shown), draft, close source branch and warnings. How it is shown depends on the client:

- **Dialog** (the client supports form elicitation): the summary appears in a confirmation dialog, where the user can also toggle `close_source_branch` and `draft`. Only an accepted dialog creates the PR.
- **Preview** (no elicitation, or `BITBUCKET_CONFIRM_MODE=preview`): the tool returns a non-error PREVIEW with a `confirm_token`. The PR is created only when the call is repeated with identical arguments plus that token. The token is an HMAC of the final PR body (including the resolved reviewers) with a per-process secret. If anything changed since the preview, or the token is invalid, the tool returns a new preview instead of creating the PR.

In preview mode the model relays the preview to the user. The token proves that nothing changed since the preview. It does NOT prove that the user saw or approved it: a model could skip asking. This is an accepted risk; use the dialog flow when your client really shows it.
A Claude Code `Elicitation` hook can auto-answer the dialog; do not configure one for `create_pr`.

Some clients advertise elicitation but decline it without showing any dialog (seen in the Claude Code desktop app), so `create_pr` can never create a PR there.
For those, force the preview flow with `BITBUCKET_CONFIRM_MODE=preview` in `.env` or in the server `env` config:

| `BITBUCKET_CONFIRM_MODE` | Behavior                                                           |
| ------------------------ | ------------------------------------------------------------------ |
| `auto` (default)         | Dialog when the client advertises elicitation, preview otherwise   |
| `preview`                | Always preview + `confirm_token`; the user approves in the chat    |

## Tests

```bash
npm test
```

Runs `node --test` with an in-memory MCP client and a stubbed `fetch`: no network, no real credentials.

## Register in Claude Code

In `~/.claude.json`:

```json
{
  "mcpServers": {
    "bitbucket": {
      "command": "node",
      "args": ["/absolute/path/to/bitbucket-mcp/index.js"]
    }
  }
}
```

Or via CLI:

```bash
claude mcp add bitbucket -- node /absolute/path/to/bitbucket-mcp/index.js
```

## Register in Cursor

In Settings → MCP → Add server:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/bitbucket-mcp/index.js"]
}
```

Alternatively, pass credentials directly in the config (no `.env` needed):

```json
{
  "mcpServers": {
    "bitbucket": {
      "command": "node",
      "args": ["/absolute/path/to/bitbucket-mcp/index.js"],
      "env": {
        "BITBUCKET_EMAIL": "you@email.com",
        "BITBUCKET_API_TOKEN": "ATATxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

## Credentials

Generate an API token at: <https://id.atlassian.com/manage-profile/security/api-tokens>

Create it as an **API token with scopes**, app **Bitbucket**, with these scopes:

| Scope                         | Used by                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `read:pullrequest:bitbucket`  | `list_prs`, `get_pr_status`, `list_pr_comments`, `get_pr_comment`, `create_pr` (default reviewers, open-PR check) |
| `write:pullrequest:bitbucket` | Comments (create/edit/delete/resolve), approvals, change requests, `submit_review`, `create_pr` |
| `read:user:bitbucket`         | `GET /user` to resolve `"me"` in `list_prs` and exclude the author in `create_pr`; `GET /users/{id}` for `create_pr` reviewers |

No other scopes are needed (`read:workspace` and `read:repository` are not used).

The `.env` file must never be committed to the repository (it is listed in `.gitignore`).
