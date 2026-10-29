import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { EngineInterface, Hook, HookEvent, HookResult, On } from 'claude-code'

import { register } from '../hooks/register.ts'

const SHA = '6685e88ec4c448e914dbf6ae22fdef921b5a64af'
// Local repositories by their roots, with the origin remote each one has.
const REMOTES: Record<string, string> = {
  '/work/app': 'git@gitlab.com:group/app.git',
  '/work/lib': 'https://gitlab.com/group/lib.git',
  // A second worktree of group/app.
  '/worktrees/app': 'git@gitlab.com:group/app.git',
  '/work/self': 'ssh://git@gitlab.example.com:2222/team/self.git',
  '/work/github': 'https://user:s3cr3t@github.com/group/github.git',
  '/': 'git@gitlab.com:group/home.git',
}

const JOBS = [
  { id: 1, stage: 'build', name: 'build', status: 'success' },
  { id: 2, stage: 'test', name: 'unit', status: 'running' },
  { id: 3, stage: 'test', name: 'lint', status: 'pending' },
  { id: 4, stage: 'deploy', name: 'deploy', status: 'created' },
].map(job => ({ ...job, allow_failure: false, started_at: null, duration: null }))

type Setup = {
  status?: string
  env?: Record<string, string>
  hasGlab?: boolean
  glabError?: string
  hasFolders?: boolean
}

function rootOf(cwd: string): string {
  return Object.keys(REMOTES).find(root => root !== '/' && cwd.startsWith(root)) ?? '/'
}

function pipeline(host: string, project: string, status: string) {
  return {
    id: 42,
    iid: 7,
    ref: 'main',
    sha: SHA,
    status,
    web_url: `https://${host}/${project}/-/pipelines/42`,
    started_at: '2026-10-21T10:00:00.000Z',
    duration: null,
  }
}

// A fake engine beneath the mod: git and glab answered from the tables above,
// and what the mod shows recorded.
function setup({ status = 'running', env = {}, hasGlab = true, glabError, hasFolders = true }: Setup = {}) {
  const hooks: { event: string; matcher?: Record<string, string | RegExp>; hook: Hook }[] = []
  const glabCalls: string[][] = []
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  const notifications: string[] = []
  const commands: string[] = []
  const tools: string[] = []
  const state = new Map<string, { value: unknown; version: number }>()

  const $ = {
    process: {
      run: async (argv: readonly string[], init?: { cwd?: string }) => {
        const [tool, ...args] = argv
        const cwd = init?.cwd ?? '/'
        if (tool === 'git') {
          if (args.includes('--show-toplevel')) return ok(rootOf(cwd))
          if (args[0] === 'remote') return ok(REMOTES[rootOf(cwd)]!)
          return ok(SHA)
        }

        glabCalls.push([...argv])
        if (!hasGlab) throw new Error('spawn glab ENOENT')
        if (glabError) return { exitCode: 1, stdout: '', stderr: glabError }
        const host = args[2]!
        const path = args[3]!
        const project = decodeURIComponent(/projects\/([^/]+)/.exec(path)?.[1] ?? '')
        if (path.includes('/jobs')) return ok(JSON.stringify(JOBS))
        if (path.includes('/bridges')) return ok('[]')
        if (path.includes('?sha=')) return ok(JSON.stringify([pipeline(host, project, status)]))
        return ok(JSON.stringify(pipeline(host, project, status)))
      },
    },
    fs: {
      stat: async () => {
        if (!hasFolders) throw new Error('ENOENT')
        return { kind: 'dir' }
      },
    },
    env: { get: async (name: string) => env[name] },
    state: {
      get: async (ref: { plugin: string; key: string }) =>
        state.get(`${ref.plugin}/${ref.key}`) ?? { value: undefined, version: 0 },
      set: async (ref: { plugin: string; key: string }, value: unknown, options?: { ifVersion?: number }) => {
        const key = `${ref.plugin}/${ref.key}`
        const version = state.get(key)?.version ?? 0
        if (options?.ifVersion !== undefined && options.ifVersion !== version) return { isSet: false, version }
        state.set(key, { value, version: version + 1 })
        return { isSet: true, version: version + 1 }
      },
    },
    clock: { now: async () => 0, every: () => ({ cancel() {} }) },
    ui: {
      status: (text: string | undefined) => statuses.push(text),
      toast: (text: string) => toasts.push(text),
      notify: async (text: string) => notifications.push(text),
    },
    command: { register: async (spec: { name: string }) => commands.push(spec.name) },
    tool: { register: async (spec: { name: string }) => tools.push(spec.name) },
  } as unknown as EngineInterface

  const on = ((event: string, ...rest: unknown[]) => {
    const hook = rest.pop() as Hook
    hooks.push({ event, matcher: rest[0] as Record<string, string | RegExp> | undefined, hook })
  }) as On
  register(on, {})

  // Raises an event through the mod's matching hooks; `answer` is what the engine beneath gives.
  function raise(event: string, e: HookEvent, answer: HookResult = {}): Promise<HookResult> {
    const matching = hooks.filter(
      ({ event: name, matcher = {} }) =>
        name === event &&
        Object.entries(matcher).every(([field, want]) =>
          want instanceof RegExp ? want.test(String(e[field])) : e[field] === want,
        ),
    )
    const run = async (i: number, current: HookEvent): Promise<HookResult> =>
      i < matching.length
        ? ((await matching[i]!.hook($, current, next => run(i + 1, next))) as HookResult)
        : answer

    return run(0, e)
  }

  const start = () => raise('session.start', { cwd: '/' })
  const pipelineCommand = async (args = '') => (await raise('command.run', { command: 'pipeline', args })).text as string
  const bash = (command: string, output = '') => raise('tool.call', { tool: 'Bash', command }, { text: output })

  return { hooks, glabCalls, statuses, toasts, notifications, commands, tools, start, pipelineCommand, bash, raise }
}

function ok(stdout: string) {
  return { exitCode: 0, stdout: `${stdout}\n`, stderr: '' }
}

const PUSH_OUTPUT = 'To gitlab.com:group/lib.git\n   abc123..6685e88  main -> main'

test('registers its hooks on the events it handles', async () => {
  const mod = setup()
  const registered = mod.hooks.map(({ event, matcher }) => `${event} ${JSON.stringify(matcher ?? {})}`)
  assert.ok(registered.includes('session.start {}'))
  assert.ok(registered.includes('command.run {"command":"pipeline"}'))
  assert.ok(registered.includes('tool.call {"tool":"Bash"}'))
  assert.ok(registered.includes('tool.call {"tool":"mcp__ci-pipeline-status__watch_pipeline"}'))

  await mod.start()
  assert.deepEqual(mod.commands, ['pipeline'])
  assert.deepEqual(mod.tools, ['watch_pipeline'])
})

test('a git push of a pipeline that passed is reported as passed', async () => {
  const mod = setup({ status: 'success' })
  await mod.start()
  const ran = await mod.bash('cd /work/lib && git push', PUSH_OUTPUT)

  assert.equal(ran.text, PUSH_OUTPUT)
  assert.equal(mod.statuses.at(-1), 'CI ✓ lib ███░░░░░░░ 1/4')
  assert.deepEqual(mod.toasts, ['lib: pipeline #7 success on main'])
  assert.deepEqual(mod.notifications, ['lib: pipeline #7 success on main'])
})

test('a git push of a pipeline that failed is reported as failed', async () => {
  const mod = setup({ status: 'failed' })
  await mod.start()
  await mod.bash('cd /work/lib && git push', PUSH_OUTPUT)

  assert.equal(mod.statuses.at(-1), 'CI ✗ lib ███░░░░░░░ 1/4')
  assert.deepEqual(mod.toasts, ['lib: pipeline #7 failed on main'])
})

test('a running pipeline shows its progress and is not reported yet', async () => {
  const mod = setup()
  await mod.start()
  await mod.bash('git -C /work/lib push', PUSH_OUTPUT)

  assert.equal(mod.statuses.at(-1), 'CI ● lib ███░░░░░░░ 1/4')
  assert.deepEqual(mod.toasts, [])
})

test('Bash commands that are not a git push never call GitLab', async () => {
  const mod = setup()
  await mod.start()
  for (const command of ['ls -la', 'npm test', 'git status', 'cd /work/app && git commit -m "push it"']) {
    await mod.bash(command, 'output')
  }

  assert.deepEqual(mod.glabCalls, [])
  assert.deepEqual(mod.statuses, [])
})

test('without glab installed the mod says so and lets the push through', async () => {
  const mod = setup({ hasGlab: false })
  await mod.start()
  const ran = await mod.bash('cd /work/lib && git push', PUSH_OUTPUT)

  assert.equal(ran.text, PUSH_OUTPUT)
  assert.equal(mod.statuses.at(-1), 'CI ○ lib')
  assert.match(await mod.pipelineCommand('/work/lib'), /Cannot run glab .*Is it installed and on the PATH\?/)
})

test('when glab is not logged in the mod passes on what glab says', async () => {
  const mod = setup({ glabError: 'glab: 401 Unauthorized' })
  await mod.start()

  assert.equal(await mod.pipelineCommand('/work/lib'), 'group/lib: glab: 401 Unauthorized')
})

test('a reload redraws the status line of a finished pipeline', async () => {
  const mod = setup({ status: 'success' })
  await mod.start()
  await mod.bash('cd /work/lib && git push', PUSH_OUTPUT)
  // What an older version drew stays on screen until the mod draws again.
  mod.statuses.push('CI \x1b[32m✓ lib ███░░░░░░░ 1/4\x1b[39m')

  await mod.start()
  assert.equal(mod.statuses.at(-1), 'CI ✓ lib ███░░░░░░░ 1/4')
})

test('/pipeline with no repo touched watches the session folder', async () => {
  const mod = setup()
  await mod.start()

  assert.match(await mod.pipelineCommand(), /Watching pipeline #7 of group\/home \(running\)/)
  assert.equal(mod.statuses.at(-1), 'CI ● home ███░░░░░░░ 1/4')
})

test('/pipeline watches every repository the session touched', async () => {
  const mod = setup()
  await mod.start()
  await mod.raise('tool.call', { tool: 'Edit', file_path: '/work/app/src/main.ts' })
  await mod.bash('git -C /work/lib status')

  const text = await mod.pipelineCommand()
  assert.match(text, /group\/app/)
  assert.match(text, /group\/lib/)
  assert.doesNotMatch(text, /group\/home/)
  assert.equal(mod.statuses.at(-1), 'CI ● app ███░░░░░░░ 1/4 · ● lib ███░░░░░░░ 1/4')
})

test('running /pipeline again shows each pipeline once', async () => {
  const mod = setup()
  await mod.start()
  await mod.raise('tool.call', { tool: 'Edit', file_path: '/work/app/src/main.ts' })
  await mod.pipelineCommand()
  await mod.pipelineCommand()
  await mod.pipelineCommand('/work/app')

  assert.equal(mod.statuses.at(-1), 'CI ● app ███░░░░░░░ 1/4')
})

test('/pipeline shows a project once when the session touched two worktrees of it', async () => {
  const mod = setup()
  await mod.start()
  await mod.raise('tool.call', { tool: 'Edit', file_path: '/work/app/src/main.ts' })
  await mod.raise('tool.call', { tool: 'Edit', file_path: '/worktrees/app/src/main.ts' })

  assert.equal((await mod.pipelineCommand()).split('\n').length, 1)
  assert.equal(mod.statuses.at(-1), 'CI ● app ███░░░░░░░ 1/4')
})

test('a pipeline URL with other letter case replaces the watch of that project', async () => {
  const mod = setup()
  await mod.start()
  await mod.pipelineCommand('/work/app')
  await mod.pipelineCommand('https://gitlab.com/Group/App/-/pipelines/42')

  assert.equal(mod.statuses.at(-1), 'CI ● App ███░░░░░░░ 1/4')
})

test('/pipeline with a pipeline URL watches that pipeline', async () => {
  const mod = setup({ status: 'canceled' })
  await mod.start()

  assert.match(await mod.pipelineCommand('https://gitlab.com/group/app/-/pipelines/42'), /#7 of group\/app \(canceled\)/)
  assert.equal(mod.statuses.at(-1), 'CI ⊘ app ███░░░░░░░ 1/4')
})

test('/pipeline stop clears the status line', async () => {
  const mod = setup()
  await mod.start()
  await mod.pipelineCommand()

  assert.equal(await mod.pipelineCommand('stop'), 'Stopped watching pipelines.')
  assert.equal(mod.statuses.at(-1), undefined)
})

test('/pipeline names a folder that does not exist', async () => {
  const mod = setup({ hasFolders: false })
  await mod.start()

  assert.equal(await mod.pipelineCommand('../missing'), 'Cannot watch a pipeline: Folder not found: ../missing')
})

test('a self-hosted GitLab needs GITLAB_HOST', async () => {
  const without = setup()
  await without.start()
  assert.match(await without.pipelineCommand('/work/self'), /is not on a known GitLab host/)
  assert.deepEqual(without.glabCalls, [])

  const configured = setup({ env: { GITLAB_HOST: 'https://gitlab.example.com/' } })
  await configured.start()
  assert.match(await configured.pipelineCommand('/work/self'), /#7 of team\/self/)
  assert.ok(configured.glabCalls.every(argv => argv[3] === 'gitlab.example.com'))
})

test('credentials in a remote URL stay out of messages', async () => {
  const mod = setup()
  await mod.start()
  const text = await mod.pipelineCommand('/work/github')

  assert.match(text, /https:\/\/github\.com\/group\/github\.git/)
  assert.doesNotMatch(text, /s3cr3t/)
})
