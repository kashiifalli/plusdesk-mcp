# PlusDesk MCP Server

An [MCP](https://modelcontextprotocol.io) server that connects Claude to **PlusDesk** (PulseDesk API), our in-house project management tool. Once it's connected, you can ask Claude in plain language to:

- create tasks, sub-tasks and checklist items
- fill in descriptions, estimates, dates, story points and labels
- assign tasks and move them between statuses, board columns, backlog, sprints and projects
- log and review time
- get insights: your workload, project health, team load, sprint progress and flow metrics

**Every person uses their own PlusDesk account.** Claude acts as you, with your permissions, and every change appears under your name in the ticket history.

---

## Contents

1. [Requirements](#requirements)
2. [Installation](#installation)
3. [Configuration](#configuration)
4. [Connecting to Claude](#connecting-to-claude)
5. [How to use it](#how-to-use-it)
6. [Tool reference](#tool-reference)
7. [How it behaves](#how-it-behaves)
8. [Permissions by role](#permissions-by-role)
9. [Troubleshooting](#troubleshooting)
10. [Security](#security)
11. [Development](#development)
12. [Project structure](#project-structure)

---

## Requirements

- Node.js **18 or newer** (developed on Node 22)
- A PlusDesk account in your workspace
- Claude Code (CLI or VS Code extension) or Claude Desktop

## Installation

```bash
git clone <repo-url> plusdesk-mcp
cd plusdesk-mcp
npm install
npm run build
```

The build writes the server to `dist/index.js`.

## Configuration

Copy the example file and fill in **your own** values:

```bash
cp .env.example .env
```

```ini
PLUSDESK_BASE_URL=http://187.127.112.163:8081/api/v1
PLUSDESK_TENANT_SLUG=<your workspace slug>

# Use EITHER a personal API token...
PLUSDESK_API_TOKEN=
# ...OR your own email and password
PLUSDESK_EMAIL=you@virtuosoft.pk
PLUSDESK_PASSWORD=your-password
```

| Variable | Required | Description |
|---|---|---|
| `PLUSDESK_BASE_URL` | Yes | PulseDesk API base URL, including `/api/v1` |
| `PLUSDESK_TENANT_SLUG` | Yes | Your workspace slug, sent as the `x-tenant-slug` header on every request |
| `PLUSDESK_API_TOKEN` | One of these two | Personal API token (preferred) |
| `PLUSDESK_EMAIL` + `PLUSDESK_PASSWORD` | One of these two | Your own login. The server logs in, then refreshes the token automatically |
| `PLUSDESK_READ_ONLY` | No | `true` disables every tool that changes data. Default `false` |
| `PLUSDESK_ALLOW_DIRECT_STATUS` | No | `true` lets Claude set a status even when no workflow transition allows it. Default `false` |
| `PLUSDESK_TIMEOUT_MS` | No | Request timeout in milliseconds. Default `30000` |
| `PLUSDESK_ENV_FILE` | No | Full path to the `.env` file. Use it when Claude starts the server from another folder |

> `.env` is git-ignored. Never commit it or share it, because it contains your credentials.

## Connecting to Claude

### Claude Code (CLI or VS Code)

```bash
claude mcp add PlusDesk --scope user -e PLUSDESK_ENV_FILE=E:/plusdesk-mcp/.env -- node E:/plusdesk-mcp/dist/index.js
```

Then check that it's connected:

```bash
claude mcp list        # should show: PlusDesk ... ✔ Connected
```

Start a **new** Claude Code session. In the session, type `/mcp` to see the PlusDesk tools.

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "PlusDesk": {
      "command": "node",
      "args": ["E:/plusdesk-mcp/dist/index.js"],
      "env": { "PLUSDESK_ENV_FILE": "E:/plusdesk-mcp/.env" }
    }
  }
}
```

Restart Claude Desktop.

> Change `E:/plusdesk-mcp` to wherever you cloned the repo.

## How to use it

Just talk to Claude. You never need IDs:

- **Tickets:** use their key, e.g. `TICK-13525`
- **Projects:** use their key or name, e.g. `IDAT12` or "Import Document AI Tower"
- **People:** use an email, a name, or `me`
- **Columns and statuses:** use the name you see on the board, e.g. "In Review"

### Example prompts

**Your day**
- "What's on my plate in PlusDesk?"
- "What's overdue or blocked for me?"

**Create tasks**
- "Create a high-priority task in IDAT12: 'Build OCR pipeline', estimate 8 hours, due Oct 31, in the To Do column, assigned to me."
- "Create a bug in IDAT12: 'PDF upload fails over 10MB'. Steps: upload a 12MB PDF, click Save. Environment: staging."

**Sub-tasks and checklists**
- "Add sub-tasks under TICK-13525: 'Set up Tesseract', 'Write parser tests', 'Deploy to staging'."
- "Add a checklist item 'Review with Ali' to TICK-13525, due Oct 20."
- "Mark the checklist item 'Review with Ali' on TICK-13525 as done."

**Fill in details**
- "Write a proper description and acceptance criteria for TICK-13525 and set 5 story points."
- "Set TICK-13525 to start Oct 16 and end Oct 24, estimate 12 hours."

**Assign and move**
- "Assign TICK-13525 to ali.akbar@virtuosoft.pk."
- "Move TICK-13525 to In Progress."
- "Move TICK-13525 to the In Review column."
- "Send TICK-13526 back to the backlog."
- "Mark TICK-13525 as blocked: waiting for sample documents from the client."

**Time tracking**
- "Log 2.5 hours on TICK-13525 for today: implemented field extraction."
- "Show my timesheet for this week."
- "How much time has been logged on TICK-13525?"

**Insights**
- "Give me a health report for Import Document AI Tower."
- "Who is overloaded in IDAT12?"
- "Show cycle time for IDAT12 over the last 30 days."
- "What changed on TICK-13525 recently?"

## Tool reference

All tools are prefixed with `plusdesk_`.

### Context and lookup (read-only)

| Tool | What it does |
|---|---|
| `whoami` | Shows the account the server is acting as |
| `list_projects` | Lists projects visible to you, with their keys |
| `get_project` | Gets a project's members, boards and columns, allowed ticket types and stats |
| `find_users` | Searches people by name or email, optionally only those assignable in a project |
| `list_sprints` | Lists sprints for a project board, or all active and planned sprints |
| `search` | Global search across tickets and projects by title or key |
| `list_tasks` | Lists tickets with filters: project, assignee, status, priority, type, parent, sprint, label, overdue, due range, text |
| `get_task` | Gets full ticket detail, plus checklist, sub-tasks, comments, worklogs, links and history |

### Create and fill in

| Tool | What it does |
|---|---|
| `create_task` | Creates a task, story, bug, epic, etc., with all details, placed in a board column or the backlog |
| `update_task` | Changes any detail: title, description, priority, dates, estimate, points, labels, epic, sprint, custom fields |
| `create_subtask` | `mode: "ticket"` creates a full sub-task ticket. `mode: "checklist"` adds a lightweight checklist item |
| `update_checklist_item` | Marks a checklist item done or pending, renames, reassigns, re-dates or reorders it |
| `delete_checklist_item` | Removes a checklist item ⚠️ needs confirmation |
| `add_comment` | Comments on a ticket (optionally internal) |
| `link_tasks` | Links two tickets: blocks, relates-to, duplicates, depends_on… |
| `set_blocked` | Blocks a ticket (with a reason and blocking ticket) or unblocks it |
| `delete_task` | Deletes a ticket ⚠️ needs confirmation and the delete permission |

### Assign and move

| Tool | What it does |
|---|---|
| `assign_task` | Assigns or unassigns one or many tickets |
| `move_task` | Moves a ticket to **one** destination: a `status`, a board `column`, the `backlog`, a `sprint`, or another `project` |
| `list_next_statuses` | Shows which statuses a ticket can move to next, and why others are blocked |
| `bulk_update` | Changes priority, labels, status, column, or closes up to 100 tickets ⚠️ needs confirmation |

### Time tracking

| Tool | What it does |
|---|---|
| `log_time` | Logs hours on a ticket (description required, date defaults to today) |
| `list_worklogs` | Lists time entries on a ticket, or a timesheet for a date range (default: you, last 7 days) |
| `update_worklog` | Edits one of your own time entries |
| `delete_worklog` | Deletes one of your own time entries ⚠️ needs confirmation |

### Insights (read-only)

| Tool | What it does |
|---|---|
| `my_work` | Your dashboard: assigned, overdue, blocked, due soon, recently completed |
| `project_insights` | Project health: open work by status, priority and person, plus overdue, blocked, stale and due-soon tickets, aging, velocity, throughput, risks |
| `team_workload` | Open, overdue and blocked tickets and estimated hours per person |
| `sprint_report` | Sprint burndown, progress by status, blocked items, velocity |
| `flow_analytics` | Cycle time, lead time, cumulative flow, blocked-time or aging analysis for a date range |
| `time_report` | Hours logged, as a project rollup if your role allows it, otherwise your own time by ticket and day |
| `activity` | Recent activity feed, optionally for one ticket |

## How it behaves

- **Status changes follow the workflow.** "Move to In Progress" runs the matching workflow transition. If the move isn't allowed, Claude explains why and lists the statuses you *can* move to.
- **Columns and statuses are linked.** Moving a card to a board column updates its status, and a status change moves the card.
- **Two kinds of subtask:**
  - *Sub-task tickets* are real tickets with their own status, assignee and time tracking.
  - *Checklist items* are lightweight to-dos inside a ticket. Their dates must fall inside the parent ticket's start and end dates.
- **Validation before sending.** Claude gets a clear error message, without calling the API, if any of these rules is broken:
  - bugs need a description and steps to reproduce
  - stories and epics need a description
  - story points must be 1, 2, 3, 5, 8, 13 or 21
  - the ticket type must be allowed in the project
- **Destructive actions need confirmation.** Deleting tickets, worklogs or checklist items, and bulk updates, are refused unless Claude passes `confirm: true`. Claude should ask you first.
- **AI auto-triage.** PlusDesk's own AI may change a new ticket's priority or labels a few seconds after it's created. Ask Claude to re-read the ticket if exact values matter.
- **Tokens.** The server logs in once, reuses the token, and refreshes it automatically when it expires. Temporary server errors are retried.

## Permissions by role

The server can only do what your PlusDesk role allows. Some reports need manager or admin roles:

| Feature | Developer | Manager / Admin |
|---|---|---|
| Create, update, assign, move, comment, log time | ✅ | ✅ |
| Delete tickets | ❌ | ✅ |
| `project_insights`, `team_workload` (computed from tickets) | ✅ | ✅ |
| PlusDesk workload heatmap, AI project overview, SLA predictions, ETA | ❌ | ✅ (added to insights automatically) |
| Project-wide time rollup in `time_report` | ❌ (your own time only) | ✅ |
| Other people's timesheets | ❌ | ✅ (`worklog:read_team`) |

When a report isn't permitted, the insight tools leave it out and use what you can see. A 403 error means *your role doesn't allow it*, not that the server is broken.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Missing configuration: …` | Claude couldn't find your `.env`. Add `-e PLUSDESK_ENV_FILE=<full path to .env>` when registering the server |
| `Tenant not found` | `PLUSDESK_TENANT_SLUG` is wrong |
| `401: Invalid email or password` | Check `PLUSDESK_EMAIL` / `PLUSDESK_PASSWORD`, or use an API token |
| `403 … your PlusDesk role does not allow this action` | Your role lacks permission. See [Permissions by role](#permissions-by-role) |
| `Ticket TICK-… not found` | The key is wrong, or the ticket is in a project you're not a member of |
| `No workflow transition leads to "X"` | That status isn't reachable from the current one. Try the statuses listed in the message |
| `"…" matches several users/projects` | Be more specific: use the email or the project key |
| Tools don't appear in Claude | Run `npm run build`, check `claude mcp list` shows ✔ Connected, then start a **new** session |
| Changes to the code have no effect | Run `npm run build` and restart the Claude session |

Error messages include a `correlationId`. Send it to the PlusDesk backend team to trace the request in server logs.

## Security

- Credentials are read only from environment variables or your local `.env`. They're never hardcoded or logged.
- Each person uses their own account, so actions are attributed correctly and limited by their role.
- Prefer a **personal API token** over a password, and rotate it if it's ever exposed.
- Set `PLUSDESK_READ_ONLY=true` for a setup that can look but not change anything.
- The server sticks to task management. It does **not** expose admin, billing, tenant, SSO or integration settings.

## Development

```bash
npm run dev          # run from TypeScript source over stdio
npm run build        # compile to dist/
npm run typecheck    # type-check only
npm test             # unit tests (vitest)
```

**End-to-end test** against a sandbox project. It creates tickets titled `[MCP-E2E] …` and exercises every tool:

```bash
npx tsx scripts/e2e.ts IDAT12             # run from source
E2E_DIST=1 npx tsx scripts/e2e.ts IDAT12  # run against the compiled build
npx tsx scripts/cleanup-e2e.ts IDAT12     # remove the test worklogs afterwards
```

> Use only a sandbox project for e2e runs. Developers can't delete tickets, so an admin has to delete the `[MCP-*]` test tickets.

**Call a single tool** for debugging:

```bash
npx tsx scripts/peek.ts plusdesk_get_task '{"ticket":"TICK-13525"}'
npx tsx scripts/peek.ts plusdesk_project_insights '{"project":"IDAT12"}'
```

### Adding a tool

1. Pick the matching file in `src/tools/`, or add a new one and register it in `src/server.ts`.
2. Use `defineTool(server, ctx, name, { title, description, kind, input }, handler)`:
   - `kind` is `read`, `write` or `destructive`. Write and destructive tools are hidden in read-only mode, and destructive ones should call `requireConfirm`.
   - Resolve names to IDs with `ctx.resolve`, e.g. `ticketId`, `projectId`, `userId`, `board`, `column`, `sprintId`.
   - Return `ok(summary, data)`. Use the `format.ts` helpers to keep responses small.
3. Add the tool to `scripts/e2e.ts`, then run `npm run build`.

## Project structure

```
plusdesk-mcp/
├── src/
│   ├── index.ts          # entry point (stdio transport)
│   ├── server.ts         # creates the MCP server and registers all tools
│   ├── config.ts         # reads env / .env and validates it
│   ├── client.ts         # HTTP client: tenant header, login, token refresh, retries, errors
│   ├── resolvers.ts      # names → IDs (projects, users, ticket keys, boards, columns, sprints) with caching
│   ├── format.ts         # trims API responses for the model; ok / fail helpers
│   └── tools/
│       ├── registry.ts   # defineTool helper, shared params, confirmation guard
│       ├── context.ts    # lookup and read tools
│       ├── tasks.ts      # create, update, subtasks, checklist, assign, comment, link, block, delete
│       ├── move.ts       # move_task, list_next_statuses, bulk_update
│       ├── time.ts       # worklogs and timesheets
│       └── insights.ts   # dashboards, project health, workload, sprint, analytics, time reports
├── test/unit.test.ts     # unit tests
├── scripts/              # e2e test, single-tool caller, e2e cleanup
├── .env.example          # configuration template
└── README.md
```
