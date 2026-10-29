// What the mod watches. `pipelineId` pins one pipeline; without it the mod
// follows the newest pipeline that runs on `sha`. `host` is the GitLab server.
export type PipelineTarget = {
  host: string
  project: string
  pipelineId?: number
  sha?: string
}

export type PipelineJob = {
  id: number
  name: string
  stage: string
  status: string
  allowFailure: boolean
  startedAt: string | null
  durationSec: number | null
}

export type PipelineSnapshot = {
  id: number
  iid: number
  project: string
  ref: string
  sha: string
  status: string
  webUrl: string
  startedAt: string | null
  durationSec: number | null
  jobs: PipelineJob[]
}

// One watched project. `since` is when the watch started or last got a pipeline
// from GitLab, in epoch ms. A watch is given up after 10 minutes without one.
export type PipelineWatch = {
  target: PipelineTarget
  snapshot: PipelineSnapshot | null
  message: string | null
  since: number
  isGivenUp: boolean
}

// A GitLab repository the session edited or ran git in. `dir` is its root.
export type TouchedRepo = {
  dir: string
  host: string
  project: string
}

declare module 'claude-code' {
  // The tool the mod registers at session.start.
  interface McpToolInputs {
    'mcp__ci-pipeline-status__watch_pipeline': { folder?: string; url?: string }
  }

  interface PluginState {
    'ci-pipeline-status': {
      watches: PipelineWatch[]
      repos: TouchedRepo[]
    }
  }
}
