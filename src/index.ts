import { type CheckerKind, type CheckerRun, type RawDiagnostic, runChecker } from './checkers'
import { createGenerator, type Generate } from './codegen'
import { type Diagnostic, mapDiagnostics, mapSyntaxErrors } from './diagnostics'
import { loadProject, type Project } from './project'
import { findSyntaxProblems, type SyntaxProblem } from './syntax'
import { prepareWorkspace, type Workspace } from './workspace'

export { CheckerError, type CheckerKind, type RawDiagnostic } from './checkers'
export type { Diagnostic } from './diagnostics'
export { ConfigError } from './project'
export type { SyntaxProblem } from './syntax'

export interface CheckOptions {
  /** tsconfig with the .vue files, e.g. `.nuxt/tsconfig.app.json`. */
  project: string
  checker?: CheckerKind
  /** Directory paths are printed relative to and checkers run in; defaults to `process.cwd()`. */
  cwd?: string
}

export interface CheckResult {
  checker: CheckerKind
  diagnostics: Diagnostic[]
  /** Diagnostics in generated glue code that map to nothing reportable (vue-tsc drops them too). */
  dropped: RawDiagnostic[]
  /**
   * SFC → first syntax error of its generated script, when none of its syntax errors maps to the .vue.
   * These SFCs were NOT checked (their importers see a stub), and the run must fail: @vue/language-core
   * produced code that does not parse. Syntax errors that map are in `diagnostics`; their SFCs are not
   * type-checked either.
   */
  unparseable: Map<string, SyntaxProblem>
  /** The checker did not type-check (see `CheckerRun.incomplete`): no diagnostics is not a pass. */
  incomplete?: string
  sfcs: number
  regenerated: number
  /** Milliseconds per phase. */
  timings: { prepare: number; check: number; map: number }
}

export interface CompareResult {
  tsc: CheckerRun
  bun: CheckerRun
  /** Errors each checker reports in a normal run: its diagnostics mapped into the user's files. */
  reported: Record<CheckerKind, number>
  /** Raw diagnostics (positions in the generated workspace, glue code included) only one of the checkers reported. */
  onlyTsc: RawDiagnostic[]
  onlyBun: RawDiagnostic[]
  /** Syntax errors in the user's SFCs (see `CheckResult.unparseable`). */
  syntaxErrors: Diagnostic[]
  unparseable: Map<string, SyntaxProblem>
}

interface Prepared {
  project: Project
  generate: Generate
  workspace: Workspace
  cwd: string
}

async function prepare(options: CheckOptions): Promise<Prepared> {
  const project = loadProject(options.project)
  const generate = createGenerator(project)
  const workspace = await prepareWorkspace(project, generate)
  return { project, generate, workspace, cwd: options.cwd ?? process.cwd() }
}

/**
 * Second line of defence behind the parse check in prepareWorkspace: a generated script the checker
 * found a syntax error in (a cache written by an older build, a parser difference between TypeScript 6
 * and the checker) means the checker type-checked nothing. Diagnostics of such scripts are always
 * dropped as unmapped, so they are re-parsed exactly as the checker read them, from disk.
 */
async function unparseableAfterCheck(diagnostics: RawDiagnostic[], workspace: Workspace): Promise<Map<string, SyntaxProblem>> {
  const unparseable = new Map(workspace.unparseable)
  const suspects = [...new Set(diagnostics.map((diagnostic) => diagnostic.file))].filter((file) => workspace.scripts.has(file))
  if (suspects.length === 0) return unparseable
  const texts = new Map(await Promise.all(suspects.map(async (file) => [file, await Bun.file(file).text()] as const)))
  for (const [file, problem] of findSyntaxProblems(texts)) unparseable.set(workspace.scripts.get(file)!, problem)
  return unparseable
}

export async function check(options: CheckOptions): Promise<CheckResult> {
  const checker = options.checker ?? 'tsc'
  let mark = performance.now()
  const { project, generate, workspace, cwd } = await prepare(options)
  const prepareMs = performance.now() - mark
  const run = await runChecker(checker, workspace.configPath, project.root, cwd)
  mark = performance.now()
  const { diagnostics, dropped } = mapDiagnostics(run.diagnostics, workspace, generate)
  const syntax = mapSyntaxErrors(await unparseableAfterCheck(dropped, workspace), workspace, generate)
  return {
    checker,
    diagnostics: [...syntax.diagnostics, ...diagnostics],
    dropped,
    unparseable: syntax.unparseable,
    incomplete: run.incomplete,
    sfcs: workspace.sources.size,
    regenerated: workspace.regenerated,
    timings: { prepare: prepareMs, check: run.ms, map: performance.now() - mark },
  }
}

function key(diagnostic: RawDiagnostic): string {
  return `${diagnostic.file}\0${diagnostic.line}\0${diagnostic.column}\0${diagnostic.code}\0${diagnostic.message}`
}

/**
 * Runs both checkers on the same generated workspace, one after the other. Codegen, workspace and
 * parsing are shared, so any difference comes from the checkers themselves.
 */
export async function compare(options: Omit<CheckOptions, 'checker'>): Promise<CompareResult> {
  const { project, generate, workspace, cwd } = await prepare(options)
  const tsc = await runChecker('tsc', workspace.configPath, project.root, cwd)
  const bun = await runChecker('bun', workspace.configPath, project.root, cwd)
  const tscKeys = new Set(tsc.diagnostics.map(key))
  const bunKeys = new Set(bun.diagnostics.map(key))
  const syntax = mapSyntaxErrors(await unparseableAfterCheck([...tsc.diagnostics, ...bun.diagnostics], workspace), workspace, generate)
  return {
    tsc,
    bun,
    reported: {
      tsc: mapDiagnostics(tsc.diagnostics, workspace, generate).diagnostics.length,
      bun: mapDiagnostics(bun.diagnostics, workspace, generate).diagnostics.length,
    },
    onlyTsc: tsc.diagnostics.filter((diagnostic) => !bunKeys.has(key(diagnostic))),
    onlyBun: bun.diagnostics.filter((diagnostic) => !tscKeys.has(key(diagnostic))),
    syntaxErrors: syntax.diagnostics,
    unparseable: syntax.unparseable,
  }
}
