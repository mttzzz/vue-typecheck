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

describe('check on the basic fixture', () => {
  test.skipIf(!node)('reports exactly what vue-tsc reports', async () => {
    const reference = Bun.spawnSync([node!, join(import.meta.dir, 'vue-tsc-reference.cjs'), '--noEmit', '--pretty', 'false', '-p', join(fixture, 'tsconfig.json')], {
      cwd: fixture,
    })
    const expected = parseCheckerOutput(reference.stdout.toString(), fixture)
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

  test('an unknown prop on a functional component is not reported, as in vue-tsc', async () => {
    const result = await check({ project: join(fixture, 'tsconfig.json'), checker: 'tsc', cwd: fixture })
    expect(keys(result.diagnostics, fixture).filter((key) => key.startsWith('src/components/UnknownProp.vue'))).toEqual([])
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
})
