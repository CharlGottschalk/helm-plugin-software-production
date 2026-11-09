# helm-plugin-software-production

A [Helm](../helm) plugin for [tdt-software-production](https://usetdt.com) tasks:

- **Kanban** (tool): one project's tasks by status, Build on ready cards, the build
  skill's handoff on cards in progress.
- **Ready tasks** (widget): ready or done tasks across linked projects, by priority.
- **Task pipeline** (widget): counts per status, Build on the first ready tasks.

All three share one task shape (`id, projectId, title, status, priority, dependencies,
blocked, link`) and one adapter layer (`src/shared/tasks.js`). The internal adapter reads
`.tdt-project/tdt-software-production/` through a `files` connection; the source follows
the project's `task_system` config unless an instance overrides it. Jira, Linear and
GitHub show "needs 023" until their adapters exist.

## Declarations

| Connection | Kind | Allows |
| --- | --- | --- |
| `tdt` | tdt-mcp | `tdt_project_list` |
| `sp` | files (project) | list, read `.tdt-project/tdt-software-production/**` |
| `handoffs` | files (workspace) | read `.tdt/state/software-production/*/tasks/*.md` (Kanban only) |

Kanban and Task pipeline declare `orchestrate`; Helm asks you to confirm every build, and
the build skill rereads the task and refuses work that isn't ready.

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
