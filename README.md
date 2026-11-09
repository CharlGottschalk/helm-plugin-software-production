# helm-plugin-software-production

A [Helm](../helm) plugin for [tdt-software-production](https://usetdt.com) tasks:

- **Kanban** (tool): one project's tasks by status, Build on ready cards, the build
  skill's handoff on cards in progress. Drag a card, or use its Move menu, to change an
  internal task's status (below).
- **Ready tasks** (widget): ready or done tasks across linked projects, by priority.
- **Task pipeline** (widget): counts per status, Build on the first ready tasks.

All three share one task shape (`id, projectId, title, status, priority, dependencies,
blocked, link`) and one adapter layer (`src/shared/tasks.js`). The internal adapter reads
`.tdt-project/tdt-software-production/` through a `files` connection; the Linear adapter
reads a team's issues and the GitHub adapter a repository's issues or a Projects v2 board,
both over GraphQL through an `http` connection. The source follows the project's
`task_system` config unless an instance overrides it; other trackers wait for demand.

### Linear

1. In Helm, Settings → Connections → Services: add a profile named `linear`, base URL
   `https://api.linear.app`, header `Authorization`, token sent as is (a Linear personal
   API key; a read-only key is enough unless you move cards).
2. In the project's `config.json`:

   ```json
   "task_system": { "kind": "external", "provider": "linear", "project_ref": "ENG",
     "status_map": { "draft": "Backlog", "ready": "Todo", "doing": "In Progress",
       "blocked": "Blocked", "done": "Done", "cancelled": "Canceled" } }
   ```

   `project_ref` is the team key. `status_map` names a workflow state per status; states it
   doesn't name map by type (triage/backlog → draft, unstarted → ready, started → doing,
   completed → done, canceled → cancelled), and a move to a status with no state is refused.
   Without that config, set an instance's source to Linear and its **Linear team** setting
   (Kanban only); such a board moves cards but never offers a build.

### GitHub

1. In Helm, Settings → Connections → Services: add a profile named `github`, base URL
   `https://api.github.com`, header `Authorization`, sent as `Bearer` (a fine-grained token
   with Issues read, plus Projects read and write to move board cards; or a classic token
   with `repo`/`read:project`, `project` to move).
2. In the project's `config.json`, `project_ref` picks the mode:

   ```json
   "task_system": { "kind": "external", "provider": "github", "project_ref": "me/app" }
   ```

   `owner/repo` shows the repository's issues read-only: open → ready, closed → done, or
   cancelled when closed as not planned. `owner/projects/<number>` shows a user or
   organization Projects v2 board's issue items (pull requests and draft issues are skipped
   and counted in the board header) by its single-select `Status` field:

   ```json
   "task_system": { "kind": "external", "provider": "github", "project_ref": "me/projects/3",
     "status_field": "Status",
     "status_map": { "ready": "Todo", "doing": "In Progress", "blocked": "Blocked", "done": "Done" } }
   ```

   `status_map` names a board option per status (case-insensitive); options it doesn't name,
   and items with no status, read as draft. Without a `status_map` the board's defaults apply
   (Todo → ready, In Progress → doing, Done → done). Task ids are `<repo>-<number>`.
   Without that config, set an instance's source to GitHub and its **GitHub repository or
   board** setting (Kanban only); such a board moves cards but never offers a build.

## Declarations

| Connection | Kind | Allows |
| --- | --- | --- |
| `tdt` | tdt-mcp | `tdt_project_list` |
| `sp` | files (project) | list, read `.tdt-project/tdt-software-production/**` |
| `tasks` | files (project) | read, **write** `.tdt-project/tdt-software-production/tasks/*.md` (Kanban only) |
| `handoffs` | files (workspace) | read `.tdt/state/software-production/*/tasks/*.md` (Kanban only) |
| `linear` | http (service `linear`) | POST `/graphql`: `issues`, `states`; **write** `setState` (`issueUpdate` stateId, Kanban only) |
| `github` | http (service `github`) | POST `/graphql`: `issues`, `board`; **write** `setStatus` (`updateProjectV2ItemFieldValue` single-select option, Kanban only) |

Kanban and Task pipeline declare `orchestrate`; Helm asks you to confirm every build, and
the build skill rereads the task and refuses work that isn't ready. Kanban also declares
`chat` and `permissions.write`.

### Moving cards (Kanban)

- Draft, Ready and Blocked: Helm confirms a write that changes only the task's `Status:` line.
- Doing: one Helm dialog offers **Move and start build** (starts the build; the build skill
  sets `doing`, nothing is written here) or **Move only** (writes `Status: doing`).
- Done or Cancelled: no write; a confirmed hand-off runs `/tdt-software-production-close`.
- A task file changed since the board read it is refused (`conflict`), the board reloads,
  and nothing is overwritten. Cancelled or failed moves put the card back.
- Only files under `.tdt-project/tdt-software-production/tasks/` move.
- Linear cards: Draft, Ready, Blocked and Doing send one confirmed `issueUpdate` that sets
  only that issue's state (Helm shows the exact request). Into Doing offers the build only
  when the project's `task_system` is Linear; otherwise it is a plain confirmed move. A
  declined or failed request (including a GraphQL error) puts the card back with the error.
  Done and Cancelled hand off to the close skill as for internal tasks.
- GitHub board cards: the same, with one confirmed `updateProjectV2ItemFieldValue` that
  sets only that item's status field. Plain repository issues don't move: Done and
  Cancelled hand off to the close skill, other moves are refused with a pointer to Projects v2.

## Develop

```bash
npm install          # @usetdt/helm-sdk from ../helm/packages/sdk until it is published
npm run build        # src/ → dist/, then validate
npm run check        # parser and adapter self-check
helm plugin link .   # then review, approve and enable in Settings → Plugins
```

`dist/` is committed: Helm installs plugins without running scripts.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
