// A stand-in for the `claude-code` module's types, covering only what this mod
// uses, so `tsc` runs where Claude Code is not installed (in CI). Claude Code
// lays the full declarations in .claude-plugin/types/ when it loads the mod;
// `claude plugin validate .` checks the mod against them.
declare module 'claude-code' {
  // Filled in by the mod's own contract, types/index.d.ts.
  export interface PluginState {}
  export interface McpToolInputs {}

  export type StateRef<P extends keyof PluginState, K extends keyof PluginState[P]> = {
    readonly plugin: P
    readonly key: K
  }

  export type Timer = { cancel(): void }

  export type ProcessRunResult = { exitCode: number; stdout: string; stderr: string }

  export interface EngineInterface {
    process: {
      run(
        argv: readonly string[],
        init?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
      ): Promise<ProcessRunResult>
    }
    fs: { stat(path: string): Promise<{ kind: string }> }
    env: { get(name: string): Promise<string | undefined> }
    state: {
      get<P extends keyof PluginState, K extends keyof PluginState[P]>(
        ref: StateRef<P, K>,
      ): Promise<{ value: PluginState[P][K] | undefined; version: number }>
      set<P extends keyof PluginState, K extends keyof PluginState[P]>(
        ref: StateRef<P, K>,
        value: PluginState[P][K],
        options?: { ifVersion?: number },
      ): Promise<{ isSet: boolean; version: number }>
    }
    clock: {
      now(): Promise<number>
      every(ms: number, callback: () => void): Timer
    }
    ui: {
      status(text: string | undefined): unknown
      toast(text: string): unknown
      notify(text: string, options?: { title?: string }): Promise<unknown>
    }
    command: {
      register(spec: { name: string; description: string; argumentHint?: string }): Promise<unknown>
    }
    tool: {
      register(spec: { name: string; description: string; inputSchema: object }): Promise<unknown>
    }
  }

  // Events and results are typed per event in the real API; here they are left open.
  export type HookEvent = { readonly [field: string]: any }
  export type HookResult = { readonly [field: string]: any }
  export type Hook = (
    $: EngineInterface,
    e: HookEvent,
    next: (e: HookEvent) => Promise<HookResult>,
  ) => unknown

  export type On = {
    (event: string, hook: Hook): void
    (event: string, matcher: Record<string, string | RegExp>, hook: Hook): void
  }

  export type Register = (on: On, options: Record<string, unknown>) => unknown
}
