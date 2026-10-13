import { defineConfig } from 'tsdown'

/**
 * 租户服务发布三个入口：package.json 的 `bin` 指向的 `lib/bin.js`，`lib/index.js`，
 * 以及 `./invariant` 指向的 `lib/invariant.js`。包内这份配置取代仓库根的工作区入口，
 * 而根入口是 `lib/types/{index,invariant,startup}.js` 这个通配——覆盖不到 `bin`，
 * 所以三个入口在这里逐个写出；`bin` 可达的组合模块随它一起打包，
 * 类型声明由 `tsc -b` 产出（`dts: false`），与其它包一致。
 */
export default defineConfig({
  entry: ['lib/types/bin.js', 'lib/types/index.js', 'lib/types/invariant.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
