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
| `list_prs`               | Lists a repo's PRs by state/reviewer/author; `review_status` filters current page only |
| `submit_review`          | Posts all comments + sets verdict in one call (best for AI reviews)                  |
| `approve_pr`             | Approves the PR                                                                      |
| `remove_pr_approval`     | Removes a previously submitted approval                                              |
| `request_changes`        | Marks the PR as needing changes (blocks merge)                                       |
| `remove_changes_request` | Removes the changes_requested status                                                 |
| `get_pr_status`          | PR summary: state, author, reviewers, approval status                                |

### Recommended flow for AI code reviews

```text
0. list_prs           → reviewer=me review_status=pending → pick pr_id
1. get_pr_status      → check current state and reviewers
2. submit_review      → post all inline comments + summary + verdict atomically
```

> **Note:** The Bitbucket Cloud API does not expose a "pending comments" endpoint
> (unlike GitHub's draft reviews). `submit_review` approximates this by posting
> all comments in quick succession before setting the verdict.

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

Required scope: **Pull Requests → Write**

The `.env` file must never be committed to the repository (it is listed in `.gitignore`).
