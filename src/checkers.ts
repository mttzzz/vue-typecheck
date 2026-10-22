import { dirname, join, resolve } from 'node:path'

import { readVersion } from './package-json'

export type CheckerKind = 'tsc' | 'bun'

/** A diagnostic as the checker printed it: position in the file it checked (maybe a generated script). */
export interface RawDiagnostic {
  /** Absolute path, or '' for a diagnostic without a file (a config error). */
  file: string
  line: number
  column: number
  code: number
  message: string
}

export interface CheckerRun {
  kind: CheckerKind
  diagnostics: RawDiagnostic[]
  /**
   * Set when the checker reported but did not type-check: `bun check` stops before type checking when
   * any file has a syntax error ("Stopped before type checking N files"), while tsc reports and goes on.
   */
  incomplete?: string
  exitCode: number
  output: string
  ms: number
}

export class CheckerError extends Error {}

const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error TS(\d+): (.*)$/
const GLOBAL_DIAGNOSTIC = /^error TS(\d+): (.*)$/
const STOPPED = /^note: Stopped before type checking .*$/m
const BUN_FOUND = /^Found (\d+) errors?\b/m
const BUN_CLEAN = /^✓ No type errors\b/m

/** bun check's note that it type-checked nothing (any syntax error stops it), if present. */
export function stoppedBeforeTypeChecking(output: string): string | undefined {
  return STOPPED.exec(output)?.[0]
}

/**
 * Both checkers print `file(line,col): error TSn: message` (tsc with `--pretty false`, bun check with
 * `--no-pretty`), message chains continue on lines indented by two spaces. Everything from bun's
 * `Found N errors` summary on is not a diagnostic.
 */
export function parseCheckerOutput(output: string, cwd: string): RawDiagnostic[] {
  const diagnostics: RawDiagnostic[] = []
  let current: RawDiagnostic | undefined
  for (const line of output.split('\n')) {
    const match = DIAGNOSTIC.exec(line)
    const global = match ? undefined : GLOBAL_DIAGNOSTIC.exec(line)
    if (match) {
      current = { file: resolve(cwd, match[1]!), line: Number(match[2]), column: Number(match[3]), code: Number(match[4]), message: match[5]! }
      diagnostics.push(current)
    } else if (global) {
      current = { file: '', line: 0, column: 0, code: Number(global[1]), message: global[2]! }
      diagnostics.push(current)
    } else if (current && line.startsWith('  ')) {
      current.message += '\n' + line
    } else {
      current = undefined
    }
  }
  return diagnostics
}

/**
 * Why a run cannot be trusted, if it cannot: a checker that crashed after printing some errors must
 * not pass for a run with only those errors. tsc 7 with `--noEmit` exits 1 when it reports errors and
 * prints nothing but diagnostics (a Go panic exits 2 and prints a trace); bun check exits 1 and ends
 * with `Found N errors`, or exits 0 with `✓ No type errors`.
 */
export function checkerProblem(kind: CheckerKind, output: string, exitCode: number, diagnostics: RawDiagnostic[]): string | undefined {
  if (exitCode !== (diagnostics.length > 0 ? 1 : 0)) return `exited with ${exitCode} after ${diagnostics.length} diagnostics`
  if (kind === 'tsc') {
    const other = output.split('\n').find((line) => line.trim() && !DIAGNOSTIC.test(line) && !GLOBAL_DIAGNOSTIC.test(line) && !line.startsWith('  '))
    return other === undefined ? undefined : `printed a line that is not a diagnostic: ${other}`
  }
  if (exitCode === 0) return BUN_CLEAN.test(output) ? undefined : 'printed no summary'
  const found = BUN_FOUND.exec(output)?.[1]
  if (found === undefined) return 'printed no summary'
  return Number(found) === diagnostics.length ? undefined : `reported ${found} errors, ${diagnostics.length} were read`
}

/** tsc 7 from the checked project (its version is the project's choice), run with bun: no node needed. */
async function tscCommand(projectRoot: string): Promise<string[]> {
  let packageJson: string
  try {
    packageJson = Bun.resolveSync('typescript/package.json', projectRoot)
  } catch {
    throw new CheckerError('--checker tsc needs typescript 7 installed in the project')
  }
  const version = await readVersion(packageJson)
  if (Number(version.split('.')[0]) < 7) throw new CheckerError(`--checker tsc needs typescript 7, the project has ${version}`)
  return [process.execPath, join(dirname(packageJson), 'bin', 'tsc'), '--noEmit', '--pretty', 'false']
}

export async function runChecker(kind: CheckerKind, configPath: string, projectRoot: string, cwd: string): Promise<CheckerRun> {
  const command =
    kind === 'tsc'
      ? [...(await tscCommand(projectRoot)), '-p', configPath]
      : [process.execPath, 'check', '-p', configPath, '--no-pretty', '--all']
  const started = performance.now()
  const proc = Bun.spawn(command, { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  const output = stdout + stderr
  const diagnostics = parseCheckerOutput(output, cwd)
  const problem = checkerProblem(kind, output, exitCode, diagnostics)
  if (problem) throw new CheckerError(`${command.join(' ')} ${problem}:\n${output}`)
  return {
    kind,
    diagnostics,
    incomplete: stoppedBeforeTypeChecking(output),
    exitCode,
    output,
    ms: performance.now() - started,
  }
}
