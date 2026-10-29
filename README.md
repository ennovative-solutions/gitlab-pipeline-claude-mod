# ci-pipeline-status

[![CI](https://github.com/ennovative-solutions/gitlab-pipeline-claude-mod/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ennovative-solutions/gitlab-pipeline-claude-mod/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code mod](https://img.shields.io/badge/Claude%20Code-mod-orange.svg)](#installation)

A Claude Code mod that shows the progress of GitLab CI pipelines in the status line.
After a `git push`, you see the pipeline run, pass or fail without leaving the session:

```
CI ● web-app ████████░░ 14/17 · ✓ api-service ██████████ 6/6
```

## Features

- Starts watching by itself after a successful `git push` to GitLab.
- Shows one entry per watched pipeline: a status glyph, the project, a progress bar and the job count.
- Marks a finished pipeline: `✓` when it passed, `✗` when it failed, `⊘` when it was canceled.
- Shows a toast and sends a desktop notification when a pipeline finishes.
- Watches several repositories at once: every repository the session touched.
- Adds a `/pipeline` command, and a `watch_pipeline` tool that Claude can call itself.
- Works with gitlab.com and with a self-hosted GitLab.
- Talks to GitLab through the `glab` command-line tool. The mod stores no token.

## Requirements

- [Claude Code](https://code.claude.com), with support for mods (plugins with function hooks).
- [`glab`](https://gitlab.com/gitlab-org/cli), the GitLab CLI, logged in to your GitLab server.
  When you log in with a personal access token, the `read_api` scope is enough.

```
brew install glab
glab auth login
```

## Installation

At the Claude Code prompt in a terminal:

```
/plugin install ci-pipeline-status --marketplace ennovative-solutions/gitlab-pipeline-claude-mod
```

Answer `y` to add the marketplace, then pick a scope.

You can also add the marketplace first and install from it:

```
/plugin marketplace add ennovative-solutions/gitlab-pipeline-claude-mod
/plugin install ci-pipeline-status@ennovative-solutions
```

From a shell:

```
claude plugin install ci-pipeline-status --marketplace ennovative-solutions/gitlab-pipeline-claude-mod
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins.
Choose Add marketplace with `ennovative-solutions/gitlab-pipeline-claude-mod`, then Add plugin.

## Configuration

The mod reads one optional environment variable.

| Variable | Default | What it does |
|---|---|---|
| `GITLAB_HOST` | not set | The host of a self-hosted GitLab, such as `gitlab.example.com` or `https://gitlab.example.com`. Repositories on that host are watched as well as those on gitlab.com. |

`GITLAB_HOST` is the same variable `glab` reads, so one setting serves both.
Set it in the shell that starts Claude Code, or in the `env` block of `~/.claude/settings.json`.
Log `glab` in to that host as well:

```
glab auth login --hostname gitlab.example.com
```

There is no token to configure: `glab` keeps the login.

## Usage

| Command | What it watches |
|---|---|
| `/pipeline` | The pipelines of every repository touched in this session. With no repository touched yet, the pipeline of the current folder. |
| `/pipeline ../web-app` | The pipeline of the HEAD commit in that local repository folder. |
| `/pipeline https://gitlab.com/.../-/pipelines/123` | That one pipeline. |
| `/pipeline stop` | Nothing. The mod stops watching and clears the status line. |

`/pipeline <folder>` and `/pipeline <url>` add a pipeline to the list.
They do not replace the pipelines already watched.

### What happens by itself

The mod remembers which repositories the session touches.
A repository counts as touched when Claude edits or writes a file in it.
A Bash command with `cd <dir>` or `git -C <dir>` also touches that repository.
Reading files does not count.

After a successful `git push`, the mod starts watching the pushed repository.
It reads the `To <host>:<project>.git` line in the push output to find the repository.

Claude can also start a watch itself, with the `watch_pipeline` tool.

### How it behaves

- The mod polls GitLab every 10 seconds.
- The mod watches the pipeline of the HEAD commit, not the latest pipeline of the branch.
  Before GitLab creates that pipeline, the status line shows `○ <project>`.
- A project without any CI pipelines is not watched.
- After 10 minutes without a pipeline, or with only errors from GitLab, the mod stops checking that repository.
  It shows a toast with the reason and removes the project from the status line.
- A downstream pipeline counts as a job with the downstream pipeline's status.
- Manual jobs that never ran do not count in the progress.
- The mod stops polling once every watched pipeline has finished.
- When `glab` is missing or not logged in, the mod says so in `/pipeline` and leaves your commands alone.

### Limits

A plain `git push` sometimes does not start a watch.
This happens when the push output has no `To ...` line and the command names no folder.
Run `/pipeline` in that case.

## Contributing

Issues and pull requests are welcome.

```
npm install
npm test            # behaviour tests, Node's built-in test runner
npm run typecheck   # tsc --noEmit
```

The tests run the mod's `register` function against a fake engine.
They answer `git` and `glab` from fixtures, so they need no GitLab account or network.

To try a change in Claude Code, start a session with the mod loaded from your clone:

```
claude --plugin-dir .
claude plugin validate .
```

Claude Code lays the full API types in `.claude-plugin/types/` when it loads the mod.
`typings/claude-code.d.ts` is a small stand-in for those types, so the type-check also runs in CI.

Every pull request runs CI: JSON validation, a version check, the type-check, the tests and a gitleaks secret scan.
A pull request is merged only when CI passes.

### Releasing a version

The version lives in `.claude-plugin/plugin.json` and `package.json`, and CI fails when they differ.
Set the new version in both:

```
npm version 0.5.0 --no-git-tag-version
```

Then change `"version"` in `.claude-plugin/plugin.json` to the same number.
Once the change is on `main` and CI passes, CI tags that commit `v0.5.0`.

## License

[MIT](LICENSE) © 2026 Ennovative Solutions
