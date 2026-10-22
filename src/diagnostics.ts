import type { CodeInformation, Mapping } from '@vue/language-core'

import type { RawDiagnostic } from './checkers'
import type { Generate, GeneratedScript } from './codegen'
import type { Workspace } from './workspace'

/** A diagnostic in the user's own files: SFC positions are in the .vue, 1-based like tsc's. */
export interface Diagnostic {
  /** Absolute path, or '' for a diagnostic without a file. */
  file: string
  line: number
  column: number
  code: number
  message: string
}

export interface MappedDiagnostics {
  diagnostics: Diagnostic[]
  /** Raised in generated glue code that maps to nothing reportable; vue-tsc drops the same ones. */
  dropped: RawDiagnostic[]
}

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}

function toLineColumn(starts: number[], offset: number): [line: number, column: number] {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (starts[mid]! <= offset) low = mid
    else high = mid - 1
  }
  return [low + 1, offset - starts[low]! + 1]
}

/** Volar's rule (`shouldReportDiagnostics`): no `verification`, no report; `shouldReport` decides per code. */
function shouldReport(data: CodeInformation, code: number): boolean {
  if (!data.verification) return false
  if (typeof data.verification === 'object' && data.verification.shouldReport) return data.verification.shouldReport(undefined, code)
  return true
}

function isEmpty(mapping: Mapping<CodeInformation>): boolean {
  return mapping.lengths.every((length) => length === 0)
}

/**
 * Checkers print where a diagnostic starts, not how long it is, so Volar's range lookup (what vue-tsc
 * uses) is not available. At the start of a token a zero-length boundary marker (the `:` of `:size`)
 * and the token's own mapping (`size`) both match; vue-tsc reports the token, so a non-empty mapping
 * wins over an empty one. It wins before `shouldReport` runs: the token can silence a code (TS2353
 * on an unknown prop) that the marker would still report.
 */
export function mapDiagnostics(raw: RawDiagnostic[], workspace: Workspace, generate: Generate): MappedDiagnostics {
  const generated = new Map<string, (GeneratedScript & { starts: number[] }) | undefined>()
  const sourceStarts = new Map<string, number[]>()
  const diagnostics: Diagnostic[] = []
  const dropped: RawDiagnostic[] = []

  for (const diagnostic of raw) {
    const source = workspace.scripts.get(diagnostic.file)
    if (source === undefined) {
      diagnostics.push(diagnostic)
      continue
    }
    const sourceText = workspace.sources.get(source)!
    if (!generated.has(diagnostic.file)) {
      const script = generate(source, sourceText)
      generated.set(diagnostic.file, script && { ...script, starts: lineStarts(script.text) })
    }
    const script = generated.get(diagnostic.file)
    const offset = script && script.starts[diagnostic.line - 1]! + diagnostic.column - 1
    const located = script && offset !== undefined ? [...script.map.toSourceLocation(offset)] : []
    const tokens = located.filter(([, mapping]) => !isEmpty(mapping))
    const [sourceOffset] = (tokens.length > 0 ? tokens : located).find(([, mapping]) => shouldReport(mapping.data, diagnostic.code)) ?? []
    if (sourceOffset === undefined) {
      dropped.push(diagnostic)
      continue
    }
    if (!sourceStarts.has(source)) sourceStarts.set(source, lineStarts(sourceText))
    const [line, column] = toLineColumn(sourceStarts.get(source)!, sourceOffset)
    diagnostics.push({ ...diagnostic, file: source, line, column })
  }
  return { diagnostics, dropped }
}
