import { afterAll, describe, expect, test } from 'bun:test'
import { cp, mkdir, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { parseCheckerOutput } from '../src/checkers'
import { check, type Diagnostic } from '../src/index'

const repoRoot = join(import.meta.dir, '..')
const fixture = join(import.meta.dir, 'fixtures', 'basic')
const node = Bun.which('node')

function keys(diagnostics: Diagnostic[], root: string): string[] {
  return diagnostics
    .map((diagnostic) => `${relative(root, diagnostic.file)}(${diagnostic.line},${diagnostic.column}) TS${diagnostic.code}: ${diagnostic.message}`)
    .toSorted()
}

function vueTsc(root: string): Diagnostic[] {
  const reference = Bun.spawnSync([node!, join(import.meta.dir, 'vue-tsc-reference.cjs'), '--noEmit', '--pretty', 'false', '-p', join(root, 'tsconfig.json')], {
    cwd: root,
  })
  return parseCheckerOutput(reference.stdout.toString(), root)
}

describe('check on the basic fixture', () => {
  test.skipIf(!node)('reports exactly what vue-tsc reports', async () => {
    const expected = vueTsc(fixture)
    expect(expected.length).toBeGreaterThan(0)

    const result = await check({ project: join(fixture, 'tsconfig.json'), checker: 'tsc', cwd: fixture })
    expect(keys(result.diagnostics, fixture)).toEqual(keys(expected, fixture))
  })

  test('bun check reports the same as tsc', async () => {
    const tsc = await check({ project: join(fixture, 'tsconfig.json'), checker: 'tsc', cwd: fixture })
    const bun = await check({ project: join(fixture, 'tsconfig.json'), checker: 'bun', cwd: fixture })
    expect(bun.incomplete).toBeUndefined()
    expect(keys(bun.diagnostics, fixture)).toEqual(keys(tsc.diagnostics, fixture))
  })

  test('an SFC whose generated code does not parse is reported, and everything else is still checked', async () => {
    const result = await check({ project: join(fixture, 'tsconfig.json'), checker: 'tsc', cwd: fixture })
    expect([...result.unparseable.keys()].map((file) => relative(fixture, file))).toEqual(['src/components/SlashSlash.vue'])
    // Without the stub, tsc would report the syntax error alone and type-check nothing.
    expect(keys(result.diagnostics, fixture)).toContain("src/format.ts(5,14) TS2322: Type 'number' is not assignable to type 'string'.")
  })
})

describe('line breaks other than \\n', () => {
  const root = join(import.meta.dir, 'fixtures', 'line-breaks')

  // U+2028, U+2029, a lone \r and \r\n, each before an error in <script> and in <template>.
  test.skipIf(!node)('errors after them are reported where vue-tsc reports them', async () => {
    const expected = vueTsc(root)
    expect(expected).toHaveLength(8)
    for (const checker of ['tsc', 'bun'] as const) {
      const result = await check({ project: join(root, 'tsconfig.json'), checker, cwd: root })
      expect(keys(result.diagnostics, root)).toEqual(keys(expected, root))
    }
  })
})

describe('SFCs outside the tsconfig include', () => {
  const root = join(import.meta.dir, 'fixtures', 'outside-include')

  // widgets/ is not included and a `*.vue` shim types any SFC; vue-tsc still checks the imported ones.
  test('an SFC reached only through imports is checked, an unused one is not', async () => {
    const result = await check({ project: join(root, 'tsconfig.json'), checker: 'tsc', cwd: root })
    const files = [...new Set(result.diagnostics.map((diagnostic) => relative(root, diagnostic.file)))].toSorted()
    expect(files).toEqual(['src/App.vue', 'widgets/Aliased.vue', 'widgets/Bad.vue', 'widgets/Deep.vue', 'widgets/Inner.vue'])
  })

  test.skipIf(!node)('reports exactly what vue-tsc reports', async () => {
    const expected = vueTsc(root)
    expect(expected.length).toBeGreaterThan(0)
    const result = await check({ project: join(root, 'tsconfig.json'), checker: 'tsc', cwd: root })
    expect(keys(result.diagnostics, root)).toEqual(keys(expected, root))
  })
})

describe('syntax errors', () => {
  const root = join(import.meta.dir, 'fixtures', 'syntax-errors')

  test('one in the user\'s code is an error at its .vue position, one in generated code is a codegen bug', async () => {
    for (const checker of ['tsc', 'bun'] as const) {
      const result = await check({ project: join(root, 'tsconfig.json'), checker, cwd: root })
      expect(keys(result.diagnostics, root)).toEqual([
        'src/ScriptSyntax.vue(3,1) TS1109: Expression expected.',
        'src/TemplateSyntax.vue(6,17) TS1003: Identifier expected.',
      ])
      expect([...result.unparseable.keys()].map((file) => relative(root, file))).toEqual(['src/SlashSlash.vue'])
    }
  })

  // vue-tsc reports the <script> one alone: it maps diagnostics by range, and `{{ count + }}` ends unmapped.
  test.skipIf(!node)('reports the <script> one where vue-tsc reports it', async () => {
    const expected = vueTsc(root)
    expect(keys(expected, root)).toEqual(['src/ScriptSyntax.vue(3,1) TS1109: Expression expected.'])
    const result = await check({ project: join(root, 'tsconfig.json'), checker: 'tsc', cwd: root })
    expect(keys(result.diagnostics, root)).toEqual(expect.arrayContaining(keys(expected, root)))
  })
})

describe('tsconfig options that print more than diagnostics', () => {
  test('do not fail the run', async () => {
    const copy = join(repoRoot, '.tmp', `listing-${crypto.randomUUID()}`)
    await mkdir(copy, { recursive: true })
    await cp(fixture, copy, { recursive: true, filter: (path) => !path.includes('node_modules') })
    const config = join(copy, 'tsconfig.json')
    const tsconfig = await Bun.file(config).json()
    const baseline = await check({ project: config, checker: 'tsc', cwd: copy })
    tsconfig.compilerOptions = { ...tsconfig.compilerOptions, listFiles: true, extendedDiagnostics: true, explainFiles: true }
    await Bun.write(config, JSON.stringify(tsconfig))
    for (const checker of ['tsc', 'bun'] as const) {
      const result = await check({ project: config, checker, cwd: copy })
      expect(keys(result.diagnostics, copy)).toEqual(keys(baseline.diagnostics, copy))
    }
    await rm(copy, { recursive: true, force: true })
  })
})

describe('cache', () => {
  const copy = join(repoRoot, '.tmp', `cache-${crypto.randomUUID()}`)
  afterAll(() => rm(copy, { recursive: true, force: true }))

  test('regenerates only changed SFCs and forgets deleted ones', async () => {
    await mkdir(copy, { recursive: true })
    await cp(fixture, copy, { recursive: true, filter: (path) => !path.includes('node_modules') })
    const project = join(copy, 'tsconfig.json')
    const first = await check({ project, cwd: copy })
    expect(first.regenerated).toBe(first.sfcs)

    const second = await check({ project, cwd: copy })
    expect(second.regenerated).toBe(0)
    expect(keys(second.diagnostics, copy)).toEqual(keys(first.diagnostics, copy))

    const clean = join(copy, 'src', 'components', 'Clean.vue')
    await Bun.write(clean, (await Bun.file(clean).text()).replace('count.value * 2', 'count.value.toUpperCase()'))
    const third = await check({ project, cwd: copy })
    expect(third.regenerated).toBe(1)
    expect(keys(third.diagnostics, copy).some((key) => key.startsWith('src/components/Clean.vue(5,') && key.includes('TS2339'))).toBe(true)

    const scripts = new Bun.Glob('**/Generic.vue.ts')
    const cacheRoot = join(copy, 'node_modules', '.cache')
    expect(await Array.fromAsync(scripts.scan(cacheRoot))).toHaveLength(1)
    await rm(join(copy, 'src', 'components', 'Generic.vue'))
    await check({ project, cwd: copy })
    expect(await Array.fromAsync(scripts.scan(cacheRoot))).toHaveLength(0)
  })

  test('a change to the tool regenerates every SFC', async () => {
    const tools = join(repoRoot, '.tmp', `tool-${crypto.randomUUID()}`)
    for (const name of ['a', 'b']) await cp(join(repoRoot, 'src'), join(tools, name, 'src'), { recursive: true })
    for (const name of ['a', 'b']) await cp(join(repoRoot, 'package.json'), join(tools, name, 'package.json'))
    const codegen = join(tools, 'b', 'src', 'codegen.ts')
    await Bun.write(codegen, (await Bun.file(codegen).text()) + '\n// changed\n')
    const changed = join(repoRoot, '.tmp', `cache-${crypto.randomUUID()}`)
    await mkdir(changed, { recursive: true })
    await cp(fixture, changed, { recursive: true, filter: (path) => !path.includes('node_modules') })
    const project = join(changed, 'tsconfig.json')

    const a: typeof import('../src/index') = await import(join(tools, 'a', 'src', 'index.ts'))
    const b: typeof import('../src/index') = await import(join(tools, 'b', 'src', 'index.ts'))
    await a.check({ project, cwd: changed })
    expect((await a.check({ project, cwd: changed })).regenerated).toBe(0)
    const after = await b.check({ project, cwd: changed })
    expect(after.regenerated).toBe(after.sfcs)
    await rm(tools, { recursive: true, force: true })
    await rm(changed, { recursive: true, force: true })
  })

  test('a run killed before writing its manifest leaves no script that a later run reuses', async () => {
    const stale = join(repoRoot, '.tmp', `cache-${crypto.randomUUID()}`)
    await mkdir(stale, { recursive: true })
    await cp(fixture, stale, { recursive: true, filter: (path) => !path.includes('node_modules') })
    const project = join(stale, 'tsconfig.json')
    await check({ project, cwd: stale })
    const [manifest] = await Array.fromAsync(new Bun.Glob('**/manifest.json').scan({ cwd: join(stale, 'node_modules', '.cache'), absolute: true }))
    const before = await Bun.file(manifest!).text()

    const clean = join(stale, 'src', 'components', 'Clean.vue')
    const text = await Bun.file(clean).text()
    await Bun.write(clean, text.replace('count.value * 2', 'count.value.toUpperCase()'))
    await check({ project, cwd: stale })
    // The new script is on disk, the manifest is the one from before: as if the run was killed between the two.
    await Bun.write(manifest!, before)
    await Bun.write(clean, text)

    const result = await check({ project, cwd: stale })
    expect(keys(result.diagnostics, stale).filter((key) => key.startsWith('src/components/Clean.vue'))).toEqual([])
    expect(result.regenerated).toBe(1)
    await rm(stale, { recursive: true, force: true })
  })
})
