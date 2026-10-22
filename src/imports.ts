import { sep } from 'node:path'

import ts from '@typescript/typescript6'

import type { Project } from './project'

export interface ImportResolver {
  /**
   * Specifiers a file imports that may resolve into the project: relative, `#` imports and `paths` aliases.
   * TypeScript never resolves a `#` import to an SFC: SFCs behind one are reached through the .ts it leads to.
   */
  specifiers(text: string): string[]
  /**
   * Files the specifiers resolve to, as the checker resolves them, under the project root and outside
   * node_modules. `./Foo.vue` resolves to the SFC: the checker finds its generated `Foo.vue.ts` there.
   */
  resolve(file: string, specifiers: string[]): string[]
}

export function createImportResolver(project: Project): ImportResolver {
  const sfcOf = (file: string) =>
    project.vueOptions.extensions.some((extension) => file.endsWith(extension + '.ts')) && ts.sys.fileExists(file.slice(0, -3))
      ? file.slice(0, -3)
      : undefined
  const host: ts.ModuleResolutionHost = {
    fileExists: (file) => sfcOf(file) !== undefined || ts.sys.fileExists(file),
    readFile: ts.sys.readFile,
    directoryExists: ts.sys.directoryExists,
    realpath: ts.sys.realpath,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getDirectories: ts.sys.getDirectories,
  }
  const cache = ts.createModuleResolutionCache(project.root, (file) => file, project.compilerOptions)
  const aliases = Object.keys(project.paths).map((pattern) => pattern.split('*'))
  const mayBeLocal = (specifier: string) =>
    /^[./#]/.test(specifier) ||
    aliases.some(([prefix = '', suffix]) => (suffix === undefined ? specifier === prefix : specifier.startsWith(prefix) && specifier.endsWith(suffix)))
  const nodeModules = sep + 'node_modules' + sep
  return {
    specifiers: (text) => [...new Set(ts.preProcessFile(text, true, true).importedFiles.map(({ fileName }) => fileName))].filter(mayBeLocal),
    resolve: (file, specifiers) =>
      specifiers.flatMap((specifier) => {
        const resolved = ts.resolveModuleName(specifier, file, project.compilerOptions, host, cache).resolvedModule?.resolvedFileName
        const target = resolved && (sfcOf(resolved) ?? resolved)
        return target && target.startsWith(project.root + sep) && !target.includes(nodeModules) ? [target] : []
      }),
  }
}
