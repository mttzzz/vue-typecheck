# vue-typecheck

Type-check Vue SFCs with **TypeScript 7**: `tsc` 7 or `bun check`.

TypeScript 7 has no JS API, so `vue-tsc` cannot run on it, and Vue Language Tools' replacement (content
mappers) needs TypeScript 7.1. `vue-typecheck` gets the same result today:

1. every SFC of the program, included by the tsconfig or imported, is turned into the TypeScript that
   `vue-tsc` checks, by the official
   [`@vue/language-core`](https://github.com/vuejs/language-tools/tree/master/packages/language-core)
   codegen (TypeScript 6's JS API is loaded only to parse `<script>` blocks for it);
2. the generated scripts are written to `node_modules/.cache/vue-typecheck`, next to a generated
   tsconfig that `extends` yours: `rootDirs` and `paths` make `./Foo.vue` and `~/components/Foo.vue`
   resolve to `Foo.vue.ts`;
3. the checker runs on that tsconfig, and its errors are mapped back to `.vue` positions with Volar's
   source map and its "should report" rules, the same filter `vue-tsc` applies.

On a Nuxt app with 219 SFCs and ~1,900 files:

| | errors | time |
|---|---|---|
| `vue-tsc` 3.3.13 on TypeScript 6 (Node) | reference | 18–19 s |
| `vue-typecheck` (`tsc` 7.0.2) | identical to `vue-tsc`: codes, messages, lines, columns | 5.7–6.0 s |
| `vue-typecheck --checker bun` (Bun 1.4.3) | identical to `tsc` 7 on this app (see below for where it is not) | 1.9–2.0 s |

Only changed SFCs are regenerated; a warm run spends a few milliseconds on codegen.

## Install

```sh
bun add -d github:mttzzz/vue-typecheck typescript@^7
```

Requires Bun ≥ 1.4.3. `--checker tsc` uses the project's own `typescript` 7.

## Usage

```sh
vue-typecheck -p tsconfig.app.json                   # tsc 7
vue-typecheck -p tsconfig.app.json --checker bun     # bun check
vue-typecheck compare -p tsconfig.app.json           # both, print what only one reports
```

Nuxt: `nuxt prepare && vue-typecheck -p .nuxt/tsconfig.app.json`. The tsconfig may carry
`vueCompilerOptions` (Volar plugins such as vue-router's typed routes are loaded from it).

| flag | |
|---|---|
| `-p, --project` | tsconfig to check (default `tsconfig.json`) |
| `--checker tsc\|bun` | checker (default `tsc`) |
| `--timing` | phase times |
| `--dropped` | errors raised in generated glue code that map to nothing reportable (`vue-tsc` drops them too) |

Exit code: 0 clean, 1 type errors or an SFC that could not be checked, 2 usage or config error.

The same is available as an API: `check({ project, checker })` and `compare({ project })` from
`@mttzzz/vue-typecheck`.

## Guarantees and limits

- **No silent passes.** Neither `tsc` nor `bun check` type-checks a program in which any file has a
  syntax error (`tsc` says nothing about it, `bun check` prints "Stopped before type checking"). Every
  generated script is parsed first; one that does not parse is replaced by a stub, the rest of the
  project is checked, and the SFC is reported as **not type-checked** (exit 1). A syntax error that maps
  back to the .vue is in your code (`const a = 1 +`): it is reported there as an error, as `vue-tsc`
  does, and only the others are reported as codegen bugs.
- **Known codegen bug:** since `@vue/language-core` 3.3.12
  ([vuejs/language-tools#6230](https://github.com/vuejs/language-tools/pull/6230)) a prop value
  containing `//`, such as `href="https://vuejs.org"`, generates TypeScript that does not parse.
  `vue-tsc` hides it (the syntax error is in an unmapped region); here the SFC is reported. Until it is
  fixed upstream, move such values into `<script>`.
- Positions: checkers print where an error starts, not its length (a span in `bun check` output is
  requested in [oven-sh/bun#45708](https://github.com/oven-sh/bun/issues/45708)). At a token start, a
  zero-length boundary mapping and the token's own mapping both match; the token wins, which matched
  `vue-tsc` on every case in the tests.
- Not supported yet: project references (`-b`), SFCs outside the directory of the nearest
  `package.json` above the tsconfig.

## `bun check` vs `tsc`

`compare` runs both checkers on the same generated files, so any difference is the checkers'. It prints
the errors each one reports and lists the raw diagnostics (positions in the generated files) that only
one of them found. Known differences on Bun 1.4.3:

- false TS2589 on heavy generic types such as nitropack's typed `$fetch` (`InternalApi`); which calls
  fail depends on the checking order
  ([oven-sh/bun#45691](https://github.com/oven-sh/bun/issues/45691)). Nuxt 4.6 route types
  (`experimental.routeTypedFetch`) do not trigger it.

## License

MIT
