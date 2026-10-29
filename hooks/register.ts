import type { EngineInterface, Register, Timer } from 'claude-code'

import type {
  PipelineJob,
  PipelineSnapshot,
  PipelineTarget,
  PipelineWatch,
  TouchedRepo,
} from '../types'

const POLL_MS = 10_000
const GIVE_UP_MS = 10 * 60_000
const STATUS_BAR = 10
const TOOL = 'watch_pipeline'
const GITLAB_COM = 'gitlab.com'

const WATCHES = { plugin: 'ci-pipeline-status', key: 'watches' } as const
const REPOS = { plugin: 'ci-pipeline-status', key: 'repos' } as const

const FINISHED = new Set(['success', 'failed', 'canceled', 'skipped'])
const PIPELINE_URL = /^https?:\/\/([^/\s]+)\/(.+?)\/-\/pipelines\/(\d+)/
// A git remote: `git@host:group/project.git`, `ssh://git@host:22/group/project`
// or `https://host/group/project.git`.
const REMOTE = /^(?:[a-z][a-z+.-]*:\/\/)?(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i
// Folders a Bash command works in: `cd <dir>` and `git -C <dir>`.
const COMMAND_DIRS = /(?:\bcd|\bgit\s+-C)\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g
const GIT_PUSH = /\bgit\b(?:\s+-C\s+\S+)?\s+push\b/
// The remote line git push writes: `To gitlab.com:group/project.git`.
const PUSHED_TO = /^To\s+(\S+)\s*$/m

const GLYPH: Record<string, string> = {
  success: '✓',
  failed: '✗',
  running: '●',
  manual: '▶',
  canceled: '⊘',
  skipped: '»',
  pending: '○',
}

type GitlabPipeline = {
  id: number
  iid: number
  ref: string
  sha: string
  status: string
  web_url: string
  started_at: string | null
  duration: number | null
}

type GitlabJob = {
  id: number
  name: string
  stage: string
  status: string
  allow_failure: boolean
  started_at: string | null
  duration: number | null
  downstream_pipeline?: { status: string } | null
}

type Project = { host: string; project: string }

// The session's state is written read-modify-write, retried when another write got in between.
async function readWatches($: EngineInterface): Promise<PipelineWatch[]> {
  return (await $.state.get(WATCHES)).value ?? []
}

async function updateWatches($: EngineInterface, change: (list: PipelineWatch[]) => PipelineWatch[]) {
  for (;;) {
    const { value = [], version } = await $.state.get(WATCHES)
    if ((await $.state.set(WATCHES, change(value), { ifVersion: version })).isSet) return
  }
}

async function readRepos($: EngineInterface): Promise<TouchedRepo[]> {
  return (await $.state.get(REPOS)).value ?? []
}

async function updateRepos($: EngineInterface, change: (list: TouchedRepo[]) => TouchedRepo[]) {
  for (;;) {
    const { value = [], version } = await $.state.get(REPOS)
    if ((await $.state.set(REPOS, change(value), { ifVersion: version })).isSet) return
  }
}

// gitlab.com, plus the self-hosted server that GITLAB_HOST points glab at.
async function gitlabHosts($: EngineInterface): Promise<string[]> {
  const configured = (await $.env.get('GITLAB_HOST'))
    ?.trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .toLowerCase()

  return configured && configured !== GITLAB_COM ? [GITLAB_COM, configured] : [GITLAB_COM]
}

// The GitLab project a remote or push target names, when it is on a known GitLab host.
function parseRemote(remote: string, hosts: string[]): Project | undefined {
  const match = REMOTE.exec(remote.trim())
  const host = match?.[1]?.toLowerCase()

  return host && hosts.includes(host) ? { host, project: match![2]! } : undefined
}

// Keeps credentials in an https remote out of messages.
function redact(remote: string): string {
  return remote.replace(/\/\/[^@/\s]+@/, '//')
}

// GitLab paths are case-insensitive, so `Group/App` and `group/app` are one project.
function keyOf(one: Project): string {
  return `${one.host}/${one.project}`.toLowerCase()
}

async function glab<T>($: EngineInterface, host: string, path: string): Promise<T> {
  const ran = await $.process
    .run(['glab', 'api', '--hostname', host, path], { timeoutMs: 20_000 })
    .catch((error: unknown) => {
      throw new Error(`Cannot run glab (${errorText(error)}). Is it installed and on the PATH?`)
    })
  if (ran.exitCode !== 0) {
    throw new Error(ran.stderr.trim() || `glab api ${path} exited with ${ran.exitCode}`)
  }

  return JSON.parse(ran.stdout) as T
}

async function git($: EngineInterface, dir: string, ...args: string[]): Promise<string> {
  const ran = await $.process.run(['git', ...args], { cwd: dir })
  if (ran.exitCode !== 0) {
    throw new Error(ran.stderr.trim() || `git ${args.join(' ')} failed in ${dir}`)
  }

  return ran.stdout.trim()
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function shortName(project: string): string {
  return project.split('/').pop() ?? project
}

async function resolveRepo($: EngineInterface, dir: string): Promise<TouchedRepo> {
  const found = await $.fs.stat(dir).catch(() => undefined)
  if (found?.kind !== 'dir') {
    throw new Error(`Folder not found: ${dir}`)
  }
  const root = await git($, dir, 'rev-parse', '--show-toplevel')
  const remote = await git($, root, 'remote', 'get-url', 'origin')
  const project = parseRemote(remote, await gitlabHosts($))
  if (!project) {
    throw new Error(`The origin of ${root} is not on a known GitLab host: ${redact(remote)}`)
  }

  return { dir: root, ...project }
}

async function headTarget($: EngineInterface, repo: TouchedRepo): Promise<PipelineTarget> {
  return { host: repo.host, project: repo.project, sha: await git($, repo.dir, 'rev-parse', 'HEAD') }
}

// A pipeline URL pins that pipeline. Anything else is a local repository
// folder: the mod then follows the pipelines of that folder's HEAD commit.
async function resolveTarget($: EngineInterface, arg: string): Promise<PipelineTarget> {
  const url = PIPELINE_URL.exec(arg)
  if (url) {
    const host = url[1]!.toLowerCase()
    if (!(await gitlabHosts($)).includes(host)) {
      throw new Error(`${host} is not a known GitLab host. Set GITLAB_HOST for a self-hosted GitLab.`)
    }
    return { host, project: url[2]!, pipelineId: Number(url[3]) }
  }

  return headTarget($, await resolveRepo($, arg))
}

// Remembers the GitLab repository that holds `dir`, if any.
async function touch($: EngineInterface, dir: string): Promise<TouchedRepo | undefined> {
  const known = (await readRepos($)).find(repo => dir === repo.dir || dir.startsWith(`${repo.dir}/`))
  const repo = known ?? (await resolveRepo($, dir).catch(() => undefined))
  if (repo) {
    await updateRepos($, list => [...list.filter(one => one.dir !== repo.dir), repo])
  }

  return repo
}

function commandDirs(command: string): string[] {
  return [...command.matchAll(COMMAND_DIRS)]
    .map(match => match[1]!.replace(/^["']|["']$/g, ''))
    .filter(dir => !dir.startsWith('~') && !dir.startsWith('-'))
}

function toJob(job: GitlabJob): PipelineJob {
  return {
    id: job.id,
    name: job.name,
    stage: job.stage,
    status: job.downstream_pipeline?.status ?? job.status,
    allowFailure: job.allow_failure,
    startedAt: job.started_at,
    durationSec: job.duration,
  }
}

async function fetchSnapshot(
  $: EngineInterface,
  watched: PipelineTarget,
): Promise<PipelineSnapshot | null> {
  const { host } = watched
  const project = encodeURIComponent(watched.project)
  let id = watched.pipelineId
  if (id === undefined) {
    const [latest] = await glab<GitlabPipeline[]>(
      $,
      host,
      `projects/${project}/pipelines?sha=${watched.sha}&per_page=1`,
    )
    if (!latest) {
      return null
    }
    id = latest.id
  }

  const base = `projects/${project}/pipelines/${id}`
  const [pipeline, jobs, bridges] = await Promise.all([
    glab<GitlabPipeline>($, host, base),
    glab<GitlabJob[]>($, host, `${base}/jobs?per_page=100`),
    glab<GitlabJob[]>($, host, `${base}/bridges?per_page=100`),
  ])

  return {
    id: pipeline.id,
    iid: pipeline.iid,
    project: watched.project,
    ref: pipeline.ref,
    sha: pipeline.sha,
    status: pipeline.status,
    webUrl: pipeline.web_url,
    startedAt: pipeline.started_at,
    durationSec: pipeline.duration,
    jobs: [...jobs, ...bridges].map(toJob).sort((a, b) => a.id - b.id),
  }
}

function glyphOf(status: string): string {
  return GLYPH[status] ?? (status === 'preparing' ? GLYPH.running! : GLYPH.pending!)
}

// Manual jobs that never ran are left out, so a finished pipeline reads as complete.
function progressOf(jobs: PipelineJob[]) {
  const counted = jobs.filter(job => job.status !== 'manual')

  return { done: counted.filter(job => FINISHED.has(job.status)).length, total: counted.length }
}

function bar(done: number, total: number, width: number): string {
  const filled = total === 0 ? 0 : Math.round((done / total) * width)

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function isActive(watch: PipelineWatch): boolean {
  return !watch.isGivenUp && !(watch.snapshot && FINISHED.has(watch.snapshot.status))
}

// A watch the mod gave up on leaves the status line; a toast said why.
function statusLine(list: PipelineWatch[]): string | undefined {
  const shown = list.filter(watch => !watch.isGivenUp)
  if (shown.length === 0) {
    return undefined
  }
  const parts = shown.map(({ target, snapshot }) => {
    if (!snapshot) return `○ ${shortName(target.project)}`
    const { done, total } = progressOf(snapshot.jobs)

    return `${glyphOf(snapshot.status)} ${shortName(target.project)} ${bar(done, total, STATUS_BAR)} ${done}/${total}`
  })

  return `CI ${parts.join(' · ')}`
}

let timer: Timer | undefined
let isPolling = false

async function patch($: EngineInterface, target: PipelineTarget, change: Partial<PipelineWatch>) {
  await updateWatches($, list =>
    list.map(watch => (keyOf(watch.target) === keyOf(target) ? { ...watch, ...change } : watch)),
  )
}

async function hasPipelines($: EngineInterface, target: PipelineTarget): Promise<boolean> {
  const project = encodeURIComponent(target.project)
  const any = await glab<GitlabPipeline[]>($, target.host, `projects/${project}/pipelines?per_page=1`)

  return any.length > 0
}

async function giveUp($: EngineInterface, target: PipelineTarget, message: string) {
  await patch($, target, { message, isGivenUp: true })
  $.ui.toast(`${shortName(target.project)}: ${message}`)
}

// A watch gives up on a project without pipelines at once, and after 10 minutes
// without an answer from GitLab: no pipeline for the commit, or only errors.
async function pollOne($: EngineInterface, watch: PipelineWatch, now: number) {
  const { target } = watch
  const isOverdue = now - watch.since > GIVE_UP_MS
  try {
    const shot = await fetchSnapshot($, target)
    if (!shot) {
      if (!(await hasPipelines($, target))) {
        await giveUp($, target, 'This project has no CI pipelines, so it is not watched.')
      } else if (isOverdue) {
        await giveUp($, target, `No pipeline appeared for ${target.sha?.slice(0, 8)} in 10 minutes.`)
      } else {
        await patch($, target, { message: `Waiting for a pipeline on ${target.sha?.slice(0, 8)}. Is it pushed?` })
      }
      return
    }

    await patch($, target, { snapshot: shot, message: null, since: now })
    const before = watch.snapshot
    const isNewlyFinished =
      FINISHED.has(shot.status) && (before?.id !== shot.id || !FINISHED.has(before.status))
    if (isNewlyFinished) {
      const text = `${shortName(target.project)}: pipeline #${shot.iid} ${shot.status} on ${shot.ref}`
      $.ui.toast(text)
      void $.ui.notify(text, { title: 'CI pipeline' }).catch(() => undefined)
    }
  } catch (error) {
    if (isOverdue) {
      await giveUp($, target, `Stopped after 10 minutes of errors: ${errorText(error)}`)
    } else {
      await patch($, target, { message: errorText(error) })
    }
  }
}

async function poll($: EngineInterface) {
  if (isPolling) {
    return
  }

  isPolling = true
  try {
    const now = await $.clock.now()
    await Promise.all((await readWatches($)).filter(isActive).map(watch => pollOne($, watch, now)))
    const after = await readWatches($)
    $.ui.status(statusLine(after))
    if (!after.some(isActive)) {
      stopTimer()
    }
  } finally {
    isPolling = false
  }
}

function stopTimer() {
  timer?.cancel()
  timer = undefined
}

function startTimer($: EngineInterface) {
  timer ??= $.clock.every(POLL_MS, () => void poll($))
}

// Adds the targets to the watched list, replacing an earlier watch of the same project.
// A project named twice, as by two worktrees of it, is watched once: the last one wins.
async function watchTargets($: EngineInterface, given: PipelineTarget[]): Promise<string> {
  const targets = [...new Map(given.map(one => [keyOf(one), one])).values()]
  const since = await $.clock.now()
  const keys = targets.map(keyOf)
  await updateWatches($, list => [
    ...list.filter(watch => !keys.includes(keyOf(watch.target))),
    ...targets.map(one => ({ target: one, snapshot: null, message: 'Loading…', since, isGivenUp: false })),
  ])
  await poll($)
  if ((await readWatches($)).some(isActive)) {
    startTimer($)
  }

  const watched = (await readWatches($)).filter(watch => keys.includes(keyOf(watch.target)))

  return watched
    .map(({ target, snapshot, message }) =>
      snapshot
        ? `Watching pipeline #${snapshot.iid} of ${target.project} (${snapshot.status}): ${snapshot.webUrl}`
        : `${target.project}: ${message}`,
    )
    .join('\n')
}

// With no argument: every repository touched this session, or the session's own folder.
async function watch($: EngineInterface, arg: string): Promise<string> {
  if (arg) {
    return watchTargets($, [await resolveTarget($, arg)])
  }

  const touched = await readRepos($)
  if (touched.length === 0) {
    return watchTargets($, [await resolveTarget($, '.')])
  }

  const settled = await Promise.allSettled(touched.map(repo => headTarget($, repo)))
  const targets = settled.flatMap(one => (one.status === 'fulfilled' ? [one.value] : []))
  const failures = settled.flatMap((one, i) =>
    one.status === 'rejected' ? [`${touched[i]!.project}: ${errorText(one.reason)}`] : [],
  )

  return [targets.length > 0 ? await watchTargets($, targets) : '', ...failures].filter(Boolean).join('\n')
}

async function unwatch($: EngineInterface) {
  stopTimer()
  await updateWatches($, () => [])
  $.ui.status(undefined)
}

// After a successful git push, watch the pushed repository's HEAD pipeline.
async function watchPush($: EngineInterface, command: string, output: string) {
  const line = PUSHED_TO.exec(output)?.[1]
  const pushed = line ? parseRemote(line, await gitlabHosts($)) : undefined
  const touched = await readRepos($)
  const repo =
    touched.find(one => pushed && keyOf(one) === keyOf(pushed)) ??
    (await Promise.all(commandDirs(command).map(dir => touch($, dir)))).find(Boolean)
  if (repo) {
    await watchTargets($, [await headTarget($, repo)])
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pipeline',
      description:
        'Watch GitLab CI pipelines in the status line: every repo touched this session (default), a repo folder, a pipeline URL, or "stop"',
      argumentHint: '[folder | pipeline URL | stop]',
    })
    await $.tool.register({
      name: TOOL,
      description:
        'Shows the progress of GitLab CI pipelines to the user in the status line. ' +
        'Pushes are picked up by themselves; call it for a pipeline the user asks to see, ' +
        'with a local repository folder or a GitLab pipeline URL. With neither, it watches ' +
        'every repository touched this session. It returns at once; it does not wait for the pipeline.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: 'Local repository folder; its HEAD commit is watched.' },
          url: { type: 'string', description: 'A GitLab pipeline URL, used instead of folder.' },
        },
      },
    })

    // A reload keeps the status line an older version drew: draw it anew, and
    // carry on with pipelines that have not finished, as the timer was dropped.
    const list = await readWatches($)
    if (list.length > 0) {
      $.ui.status(statusLine(list))
    }
    if (list.some(isActive)) {
      startTimer($)
    }

    return next(e)
  })

  on('command.run', { command: 'pipeline' }, async ($, e) => {
    if (e.args.trim() === 'stop') {
      await unwatch($)
      return { text: 'Stopped watching pipelines.' }
    }

    try {
      return { text: await watch($, e.args.trim()) }
    } catch (error) {
      return { text: `Cannot watch a pipeline: ${errorText(error)}` }
    }
  })

  on('tool.call', { tool: 'mcp__ci-pipeline-status__watch_pipeline' }, async ($, e) => {
    try {
      const text = await watch($, (e.url ?? e.folder ?? '').trim())
      return { result: { text }, text }
    } catch (error) {
      const text = `Cannot watch a pipeline: ${errorText(error)}`
      return { result: { text }, text, isError: true }
    }
  })

  // Remember the repositories the session edits files in.
  on('tool.call', { tool: /^(Edit|Write|NotebookEdit)$/ }, async ($, e, next) => {
    const ran = await next(e)
    const input = e as { file_path?: string; notebook_path?: string }
    const path = input.file_path ?? input.notebook_path ?? ''
    if (ran.deny === undefined && !ran.isError && path.includes('/')) {
      await touch($, path.slice(0, path.lastIndexOf('/'))).catch(() => undefined)
    }

    return ran
  })

  // Remember the repositories Bash works in, and watch what git push sends.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) {
      return ran
    }

    try {
      await Promise.all(commandDirs(e.command).map(dir => touch($, dir)))
      if (GIT_PUSH.test(e.command)) {
        await watchPush($, e.command, ran.text ?? '')
      }
    } catch (error) {
      $.ui.toast(`ci-pipeline-status: ${errorText(error)}`)
    }

    return ran
  })
}
