import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { CheckerError, checkerProblem, parseCheckerOutput, runChecker, stoppedBeforeTypeChecking } from '../src/checkers'

/* Real outputs, trimmed: the parser is the contract with two external tools' text formats. */
const TSC = `src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.
src/b.ts(10,1): error TS2345: Argument of type 'string | number' is not assignable to parameter of type 'number'.
  Type 'string' is not assignable to type 'number'.
error TS5083: Cannot read file '/x/tsconfig.base.json'.
`

const BUN = `src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.
src/b.vue.ts(58,50): error TS1003: Identifier expected.
note: Stopped before type checking 5 files. Fix the errors above to see the rest.
Found 2 errors in 2 files, checked 0 files [29.12ms]

  1  src/a.ts:3
  1  src/b.vue.ts:58
`

describe('parseCheckerOutput', () => {
  test('tsc: positions, codes and multi-line messages; global errors have no file', () => {
    expect(parseCheckerOutput(TSC, '/p')).toEqual([
      { file: '/p/src/a.ts', line: 3, column: 7, code: 2322, message: "Type 'string' is not assignable to type 'number'." },
      {
        file: '/p/src/b.ts',
        line: 10,
        column: 1,
        code: 2345,
        message:
          "Argument of type 'string | number' is not assignable to parameter of type 'number'.\n  Type 'string' is not assignable to type 'number'.",
      },
      { file: '', line: 0, column: 0, code: 5083, message: "Cannot read file '/x/tsconfig.base.json'." },
    ])
  })

  test('bun check: the summary and its file table are not diagnostics', () => {
    expect(parseCheckerOutput(BUN, '/p').map((diagnostic) => `${diagnostic.file}:${diagnostic.line}:${diagnostic.code}`)).toEqual([
      '/p/src/a.ts:3:2322',
      '/p/src/b.vue.ts:58:1003',
    ])
  })
})

describe('stoppedBeforeTypeChecking', () => {
  test('bun check saying it type-checked nothing is detected; a normal run is not', () => {
    expect(stoppedBeforeTypeChecking(BUN)).toBe('note: Stopped before type checking 5 files. Fix the errors above to see the rest.')
    expect(stoppedBeforeTypeChecking(TSC)).toBeUndefined()
  })
})

describe('checkerProblem', () => {
  const read = (output: string) => parseCheckerOutput(output, '/p')

  test('complete runs: errors with exit 1, none with exit 0', () => {
    expect(checkerProblem('tsc', TSC, 1, read(TSC))).toBeUndefined()
    expect(checkerProblem('tsc', '', 0, [])).toBeUndefined()
    expect(checkerProblem('bun', BUN, 1, read(BUN))).toBeUndefined()
    expect(checkerProblem('bun', '✓ No type errors in 83 files [53.02ms]\n', 0, [])).toBeUndefined()
  })

  test('a checker that crashed after printing errors is not a complete run', () => {
    const panic = `${TSC}panic: runtime error: invalid memory address or nil pointer dereference\n\ngoroutine 1 [running]:\n`
    expect(checkerProblem('tsc', panic, 2, read(panic))).toBe('exited with 2 after 3 diagnostics')
    expect(checkerProblem('tsc', panic, 1, read(panic))).toStartWith('printed a line that is not a diagnostic: panic:')
    const cut = BUN.slice(0, BUN.indexOf('note:'))
    expect(checkerProblem('bun', cut, 1, read(cut))).toBe('printed no summary')
    const partial = BUN.replace('src/a.ts(3,7)', 'src/a.ts:3')
    expect(checkerProblem('bun', partial, 1, read(partial))).toBe('reported 2 errors, 1 were read')
    expect(checkerProblem('bun', '', 0, [])).toBe('printed no summary')
    expect(checkerProblem('bun', '', 137, [])).toBe('exited with 137 after 0 diagnostics')
  })
})

describe('runChecker', () => {
  const root = join(import.meta.dir, '..', '.tmp', `crash-${crypto.randomUUID()}`)
  afterAll(() => rm(root, { recursive: true, force: true }))

  test('fails when tsc crashes after printing an error', async () => {
    const typescript = join(root, 'node_modules', 'typescript')
    await mkdir(join(typescript, 'bin'), { recursive: true })
    await Bun.write(join(typescript, 'package.json'), JSON.stringify({ name: 'typescript', version: '7.0.2' }))
    await Bun.write(
      join(typescript, 'bin', 'tsc'),
      `console.log("src/a.ts(1,7): error TS2322: Type 'number' is not assignable to type 'string'.")\nconsole.error('panic: out of memory')\nprocess.exit(2)\n`,
    )
    await expect(runChecker('tsc', join(root, 'tsconfig.json'), root, root)).rejects.toThrow(CheckerError)
  })
})
