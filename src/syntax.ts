import ts from '@typescript/typescript6'

/** First syntax error of a generated script, or none. */
export interface SyntaxProblem {
  line: number
  column: number
  code: number
  message: string
  /** The generated line, for the report: the error is in code the user never wrote. */
  text: string
}

/** A syntax error at an offset of a generated script. */
export interface SyntaxError {
  start: number
  code: number
  message: string
}

function parse(scripts: Map<string, string>): [ts.SourceFile, readonly ts.DiagnosticWithLocation[]][] {
  const sourceFiles = new Map<string, ts.SourceFile>()
  for (const [fileName, text] of scripts) sourceFiles.set(fileName, ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest))
  const host: ts.CompilerHost = {
    getSourceFile: (fileName) => sourceFiles.get(fileName),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (fileName) => sourceFiles.has(fileName),
    readFile: () => undefined,
  }
  const program = ts.createProgram({
    rootNames: [...sourceFiles.keys()],
    options: { noLib: true, noResolve: true, allowJs: true, jsx: ts.JsxEmit.Preserve },
    host,
  })
  return [...sourceFiles.values()].map((sourceFile) => [sourceFile, program.getSyntacticDiagnostics(sourceFile)])
}

/**
 * Parses generated scripts with TypeScript 6's parser, without types or emit. Needed because neither
 * tsc nor `bun check` type-checks a program in which any file has a syntax error: tsc reports only the
 * syntax errors, bun check adds "Stopped before type checking". vue-tsc does not hit this, its program
 * proxy filters the unmapped syntax errors out first. One invalid generated script would turn the
 * whole run into a silent pass, so invalid scripts never reach the checker.
 */
export function findSyntaxProblems(scripts: Map<string, string>): Map<string, SyntaxProblem> {
  const problems = new Map<string, SyntaxProblem>()
  for (const [sourceFile, [first]] of parse(scripts)) {
    if (!first) continue
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(first.start)
    const starts = sourceFile.getLineStarts()
    problems.set(sourceFile.fileName, {
      line: line + 1,
      column: character + 1,
      code: first.code,
      message: ts.flattenDiagnosticMessageText(first.messageText, '\n'),
      text: sourceFile.text.slice(starts[line], starts[line + 1]),
    })
  }
  return problems
}

/** Every syntax error of each script. */
export function findSyntaxErrors(scripts: Map<string, string>): Map<string, SyntaxError[]> {
  return new Map(
    parse(scripts).map(([sourceFile, diagnostics]) => [
      sourceFile.fileName,
      diagnostics.map((diagnostic) => ({
        start: diagnostic.start,
        code: diagnostic.code,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      })),
    ]),
  )
}
