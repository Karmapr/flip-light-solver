import { readdir, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { join, relative, dirname } from 'node:path';

const ROOT = import.meta.dirname;
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else found.push(path);
  }
  return found;
}

// 浏览器只认 .js，源码里为了 Node 能直接解析写的是 .ts
function rewriteSpecifiers(code) {
  return code
    .replace(/(\bfrom\s*['"])(\.{1,2}\/[^'"]+?)\.ts(['"])/g, '$1$2.js$3')
    .replace(/(\bimport\s*\(\s*['"])(\.{1,2}\/[^'"]+?)\.ts(['"])/g, '$1$2.js$3');
}

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

let compiled = 0;
for (const file of await walk(SRC)) {
  const rel = relative(SRC, file);
  if (file.endsWith('.ts')) {
    const dest = join(DIST, 'src', rel.slice(0, -3) + '.js');
    await mkdir(dirname(dest), { recursive: true });
    const source = await readFile(file, 'utf8');
    const output = rewriteSpecifiers(stripTypeScriptTypes(source, { mode: 'strip' }));
    await writeFile(dest, output, 'utf8');
    compiled++;
  } else {
    const dest = join(DIST, 'src', rel);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(file, dest);
  }
}

await copyFile(join(ROOT, 'index.html'), join(DIST, 'index.html'));

console.log(`构建完成：${compiled} 个 TS 模块 -> dist/`);
