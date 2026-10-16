import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, compileScript } from '@vue/compiler-sfc'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, '.tmp/compiled')
const compiledFiles = new Set()
export async function compileFile(relativePath) {
  const file = resolve(root, relativePath)
  const out = resolve(output, relativePath.replace(/\.(ts|vue)$/, '.mjs'))
  if (compiledFiles.has(file)) return out
  compiledFiles.add(file)
  let content = await readFile(file, 'utf8')
  if (file.endsWith('.vue')) {
    const { descriptor } = parse(content)
    content = compileScript(descriptor, { id: relativePath, inlineTemplate: true }).content
  }
  const imports = [...content.matchAll(/import\s+[^;\n]+?from\s+['"]([^'"]+)['"]/g)]
  for (const match of imports) {
    const target = match[1]
    if (!target.startsWith('.')) continue
    const dependency = resolve(dirname(file), target + (extname(target) ? '' : '.ts'))
    if (dependency.endsWith('.json')) {
      const identifier = match[0].match(/^import\s+(\w+)/)[1]
      content = content.replace(match[0], `const ${identifier} = ${await readFile(dependency, 'utf8')}`)
    } else {
      await compileFile(dependency.slice(root.length + 1))
      content = content.replace(match[0], match[0].replace(target, target.replace(/\.(ts|vue)$/, '') + '.mjs'))
    }
  }
  const javascript = ts.transpileModule(content, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, javascript)
  return out
}
