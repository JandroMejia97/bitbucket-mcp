---
name: bitbucket-pr-review
description: Manage Bitbucket Cloud pull requests through the bitbucket MCP server. Use when the user asks to list, inspect, review, comment on, approve, request changes on, or open a Bitbucket PR, or to reply to, resolve, or delete PR comments. Requires the bitbucket MCP server to be registered and configured with BITBUCKET_EMAIL and BITBUCKET_API_TOKEN.
---

# Bitbucket PR review

Use the `bitbucket` MCP tools to work with Bitbucket Cloud pull requests. Every tool call needs `workspace`, `repo` and `pr_id` unless noted otherwise.

## Tools

### Comments

| Tool | Use it to |
| --- | --- |
| `add_pr_comment` | Create a general comment, or an inline comment with `file_path` and `line` |
| `add_pr_comments_bulk` | Create several comments in one call, with a delay between requests |
| `list_pr_comments` | List comments, paginated |
| `get_pr_comment` | Read one comment in full |
| `update_pr_comment` | Edit a comment's text |
| `delete_pr_comment` | Delete a comment |
| `reply_to_pr_comment` | Reply inside an existing thread |
| `resolve_pr_comment` | Mark an inline comment as resolved |
| `unresolve_pr_comment` | Reopen a resolved comment |

### Review and approval

| Tool | Use it to |
| --- | --- |
| `list_prs` | List a repo's PRs, filtered by state, reviewer or author |
| `get_pr_status` | Read a PR's state, author, reviewers and approval status |
| `submit_review` | Post comments and set the verdict in one call |
| `approve_pr` | Approve the PR |
| `remove_pr_approval` | Remove a previous approval |
| `request_changes` | Mark the PR as needing changes, which blocks merge |
| `remove_changes_request` | Clear the changes-requested status |
| `create_pr` | Open a PR. Requires confirmation (see below) |

## Workflows

**Review a PR:**
1. `list_prs` with the pending-review filter, to find the PR ID.
2. `get_pr_status` to check its state and reviewers.
3. `submit_review` to post all inline comments, the summary and the verdict together.

Bitbucket has no pending-comments endpoint. `submit_review` posts the comments in quick succession and then sets the verdict. Do not post comments one by one and then approve, unless the user asks for that.

**Answer a thread:** `get_pr_comment` to read it, then `reply_to_pr_comment`. Use `resolve_pr_comment` only when the user asks.

**Open a PR:** `create_pr` checks for an existing OPEN PR from the same source branch and refuses to create a duplicate. Then:
- In a client that shows a confirmation dialog, the user confirms there.
- Otherwise (`BITBUCKET_CONFIRM_MODE=preview`), the tool returns a preview with a `confirm_token`. Show the preview to the user and wait for their approval. Call `create_pr` again with the same arguments and the token only after they approve. Do not skip the approval step.

## Rules

- Never approve, request changes, delete, or create a PR without the user's explicit request.
- Never create or resolve comments in bulk unless the user asked for it.
- Never print or store `BITBUCKET_API_TOKEN`.
- When a tool returns an error, report the error text as it is.
