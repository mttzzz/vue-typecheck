#!/usr/bin/env bun
import { relative } from 'node:path'
import { parseArgs } from 'node:util'

import {
  type CheckerKind,
  CheckerError,
  check,
  compare,
  ConfigError,
  type Diagnostic,
  type RawDiagnostic,
  type SyntaxProblem,
} from './index'

const USAGE = `Usage:
  vue-typecheck [-p <tsconfig>] [--checker tsc|bun] [--timing] [--dropped]
  vue-typecheck compare [-p <tsconfig>]

Type-checks Vue SFCs with TypeScript 7: every SFC becomes the TypeScript that vue-tsc checks
(@vue/language-core), a generated tsconfig puts it next to your code, and the checker's errors are
mapped back to .vue positions.

  -p, --project   tsconfig to check (default: tsconfig.json)
  --checker       tsc: the project's TypeScript 7 (default); bun: \`bun check\`
  --timing        print phase times
  --dropped       list errors raised in generated glue code that map to nothing reportable
  compare         run both checkers on the same generated files and print what only one reports
`

function format(diagnostic: Diagnostic | RawDiagnostic, cwd: string): string {
  const where = diagnostic.file ? `${relative(cwd, diagnostic.file)}(${diagnostic.line},${diagnostic.column}): ` : ''
  return `${where}error TS${diagnostic.code}: ${diagnostic.message}`
}

/** An SFC whose generated TypeScript does not parse is reported, never silently skipped. */
function formatUnparseable(source: string, problem: SyntaxProblem, cwd: string): string {
  return (
    `${relative(cwd, source)}: error: not type-checked, @vue/language-core generated TypeScript that does not parse\n` +
    `  TS${problem.code} at generated ${problem.line}:${problem.column}: ${problem.message}\n` +
    `  ${problem.text.trim().slice(0, 200)}\n` +
    `  This is a codegen bug, not an error in your code. Known case: a prop value containing \`//\`\n` +
    `  (vuejs/language-tools, see the README); move the value into <script>.`
  )
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: 'string', short: 'p', default: 'tsconfig.json' },
      checker: { type: 'string', default: 'tsc' },
      timing: { type: 'boolean', default: false },
      dropped: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help) {
    console.log(USAGE)
    return 0
  }
  const cwd = process.cwd()

  if (positionals[0] === 'compare') {
    const result = await compare({ project: values.project, cwd })
    for (const [source, problem] of result.unparseable) console.log(formatUnparseable(source, problem, cwd))
    for (const diagnostic of result.syntaxErrors) console.log(format(diagnostic, cwd))
    for (const [name, kind] of [['tsc', 'tsc'], ['bun check', 'bun']] as const) {
      const run = result[kind]
      const glue = run.diagnostics.length - result.reported[kind]
      console.log(
        `${name}: ${result.reported[kind]} errors${glue > 0 ? ` (+${glue} in generated glue code)` : ''}, ${run.ms.toFixed(0)} ms${run.incomplete ? ` — ${run.incomplete}` : ''}`,
      )
    }
    for (const [name, list] of [['only tsc', result.onlyTsc], ['only bun check', result.onlyBun]] as const) {
      if (list.length === 0) continue
      console.log(`\n${name} (${list.length}):`)
      for (const diagnostic of list) console.log(format(diagnostic, cwd))
    }
    const same = result.onlyTsc.length === 0 && result.onlyBun.length === 0 && !result.bun.incomplete
    console.log(same ? '\nsame diagnostics' : '\ndiagnostics differ')
    return same ? 0 : 1
  }
  if (positionals.length > 0) {
    console.error(USAGE)
    return 2
  }

  if (values.checker !== 'tsc' && values.checker !== 'bun') {
    console.error(`--checker must be tsc or bun, got ${values.checker}`)
    return 2
  }
  const checker: CheckerKind = values.checker
  const result = await check({ project: values.project, checker, cwd })
  for (const [source, problem] of result.unparseable) console.log(formatUnparseable(source, problem, cwd))
  for (const diagnostic of result.diagnostics) console.log(format(diagnostic, cwd))
  if (values.dropped) for (const diagnostic of result.dropped) console.error(`[dropped] ${format(diagnostic, cwd)}`)

  const name = checker === 'bun' ? 'bun check' : 'tsc'
  const files = new Set(result.diagnostics.map((diagnostic) => diagnostic.file))
  const failures = result.diagnostics.length + result.unparseable.size
  const unchecked = result.unparseable.size > 0 ? `, ${result.unparseable.size} SFC not checked` : ''
  console.log(
    failures === 0
      ? `No type errors in ${result.sfcs} SFC (${name})`
      : `\nFound ${result.diagnostics.length} errors in ${files.size} files${unchecked} (${name})`,
  )
  if (values.timing) {
    const { prepare, check: checkMs, map } = result.timings
    console.log(
      `prepare ${prepare.toFixed(0)} ms (${result.regenerated}/${result.sfcs} SFC regenerated) · check ${checkMs.toFixed(0)} ms · map ${map.toFixed(0)} ms`,
    )
  }
  if (result.incomplete) {
    console.error(`\n${name} did not type-check: ${result.incomplete}`)
    return 1
  }
  return failures > 0 ? 1 : 0
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  if (error instanceof ConfigError || error instanceof CheckerError) {
    console.error(error.message)
    process.exitCode = 2
  } else {
    throw error
  }
}
