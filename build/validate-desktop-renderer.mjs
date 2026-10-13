import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseHtml } from 'parse5';
import postcss from 'postcss';
import { parseAst } from 'vite';

// build/validate-desktop-renderer.mjs
// Check the emitted desktop resources as file: URLs, without serving them over HTTP.
const DEFAULT_ENTRIES = ['index.html', 'stage-client.html', 'mod-export.html'];
const ownFile = fileURLToPath(import.meta.url);
const literal = node => node?.type === 'Literal' && typeof node.value === 'string' ? node.value
  : node?.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : null;

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Desktop renderer must not contain symlinks: ${file}`);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

function cssUnescape(value) {
  return value.replace(/\\([\da-f]{1,6}\s?|[^\r\n])/gi, (_, escape) =>
    /^[\da-f]/i.test(escape) ? String.fromCodePoint(parseInt(escape.trim(), 16)) : escape);
}

// Every resource edge must resolve to an existing file inside the packaged dist directory.
export function validateDesktopRenderer(distDirectory, { entrypoints = DEFAULT_ENTRIES, reachableOnly = false } = {}) {
  const root = path.resolve(distDirectory);
  const errors = [];
  const edges = [];
  const external = new Set();
  let dynamicExpressions = 0;
  const files = filesUnder(root);
  const fileSet = new Set(files);
  const pending = reachableOnly ? entrypoints.map(entry => path.join(root, entry)) : [...files];
  const inspected = new Set();
  const relative = file => path.relative(root, file).split(path.sep).join('/');
  const fail = (owner, message) => errors.push(`${relative(owner)}: ${message}`);
  const reference = (owner, raw, kind, moduleSpecifier = false) => {
    if (typeof raw !== 'string' || !raw.trim() || raw.startsWith('#')) return;
    const value = raw.trim();
    if (/^(?:https?:|data:|blob:)/i.test(value)) { external.add(value); return; }
    if (/^[\/\\]|^[a-z][\w+.-]*:/i.test(value)) {
      fail(owner, `${kind} is not file-relative: ${value}`); return;
    }
    if (moduleSpecifier && !/^\.\.?\//.test(value)) {
      fail(owner, `${kind} is an unresolved bare module: ${value}`); return;
    }
    try {
      const url = new URL(value, pathToFileURL(owner));
      url.search = ''; url.hash = '';
      const target = fileURLToPath(url);
      if (!target.startsWith(root + path.sep)) fail(owner, `${kind} escapes dist: ${value}`);
      else if (!fileSet.has(target)) fail(owner, `${kind} is missing: ${value}`);
      else {
        edges.push({ from: relative(owner), to: relative(target), kind });
        if (reachableOnly && !inspected.has(target)) pending.push(target);
      }
    } catch (error) { fail(owner, `${kind} has an invalid URL ${value}: ${error.message}`); }
  };
  const inspectJs = (source, owner) => {
    let ast;
    try { ast = parseAst(source); }
    catch (error) { fail(owner, `JavaScript parse failed: ${error.message}`); return; }
    walk(ast, node => {
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source)
        reference(owner, literal(node.source), 'static import', true);
      if (node.type === 'ImportExpression') {
        const value = literal(node.source);
        if (value === null) dynamicExpressions += 1;
        else reference(owner, value, 'dynamic import', true);
      }
      if (node.type === 'NewExpression' && node.callee?.name === 'URL'
        && node.arguments[1]?.type === 'MemberExpression'
        && node.arguments[1].object?.type === 'MetaProperty'
        && node.arguments[1].object.meta?.name === 'import'
        && node.arguments[1].property?.name === 'url')
        reference(owner, literal(node.arguments[0]), 'import.meta.url resource');
      if (node.type === 'CallExpression' && node.callee?.name === 'importScripts')
        node.arguments.forEach(argument => reference(owner, literal(argument), 'worker import'));
      // Vite's dependency table also carries lazy CSS and module-preload resource paths.
      if (node.type === 'VariableDeclarator' && node.id?.name === '__vite__mapDeps')
        walk(node.init, child => {
          if (child.type === 'ArrayExpression') child.elements.forEach(element =>
            reference(owner, literal(element), 'Vite preload dependency', true));
        });
    });
  };
  const inspectCss = (source, owner) => {
    try {
      const ast = postcss.parse(source, { from: owner });
      const urls = value => {
        const pattern = /url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)]*))\s*\)/gi;
        for (const match of value.matchAll(pattern))
          reference(owner, cssUnescape((match[1] ?? match[2] ?? match[3]).trim()), 'CSS url');
      };
      ast.walkDecls(declaration => urls(declaration.value));
      ast.walkAtRules(rule => {
        urls(rule.params);
        if (rule.name.toLowerCase() === 'import') {
          const match = rule.params.match(/^\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/);
          if (match) reference(owner, cssUnescape(match[1] ?? match[2]), 'CSS import');
        }
      });
    } catch (error) { fail(owner, `CSS parse failed: ${error.message}`); }
  };
  const inspectHtml = (source, owner) => {
    let entryModules = 0;
    const visit = node => {
      const attrs = Object.fromEntries((node.attrs ?? []).map(attr => [attr.name, attr.value]));
      if (node.tagName === 'base' && attrs.href && attrs.href !== './') fail(owner, 'Unexpected HTML base URL');
      if (attrs.src) reference(owner, attrs.src, `${node.tagName} src`);
      if (node.tagName === 'link' && attrs.href) reference(owner, attrs.href, 'link href');
      if (attrs.poster) reference(owner, attrs.poster, 'video poster');
      if (node.tagName === 'object' && attrs.data) reference(owner, attrs.data, 'object data');
      if (attrs.srcset && !attrs.srcset.includes('data:')) attrs.srcset.split(',').forEach(item =>
        reference(owner, item.trim().split(/\s+/)[0], 'srcset'));
      if (node.tagName === 'script') {
        if (attrs.type === 'module' && attrs.src) entryModules += 1;
        if (!attrs.src && (!attrs.type || ['module', 'text/javascript', 'application/javascript'].includes(attrs.type)))
          inspectJs((node.childNodes ?? []).map(child => child.value ?? '').join(''), owner);
      }
      if (node.tagName === 'style') inspectCss((node.childNodes ?? []).map(child => child.value ?? '').join(''), owner);
      if (attrs.style) inspectCss(`x { ${attrs.style} }`, owner);
      (node.childNodes ?? []).forEach(visit);
      if (node.content) visit(node.content);
    };
    visit(parseHtml(source));
    if (entrypoints.includes(relative(owner)) && !entryModules) fail(owner, 'No emitted module entry script');
  };

  for (const entry of entrypoints) {
    if (!fileSet.has(path.join(root, entry))) fail(path.join(root, entry), 'Required HTML entry is missing');
  }
  // Updates retain historical hashed files. Reachable mode follows only the new entry graph;
  // clean build output still uses the stricter scan of every emitted file by default.
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const file = pending[cursor];
    if (inspected.has(file) || !fileSet.has(file)) continue;
    inspected.add(file);
    const extension = path.extname(file).toLowerCase();
    if (!['.html', '.js', '.mjs', '.css', '.webmanifest'].includes(extension)) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (extension === '.html') inspectHtml(source, file);
    else if (extension === '.css') inspectCss(source, file);
    else if (extension === '.webmanifest') {
      try { for (const icon of JSON.parse(source).icons ?? []) reference(file, icon.src, 'manifest icon'); }
      catch (error) { fail(file, `Manifest parse failed: ${error.message}`); }
    } else inspectJs(source, file);
  }
  if (errors.length) throw new Error(`Desktop file:// contract failed (${errors.length}):\n${errors.join('\n')}`);
  return { status: 'passed', dist: root, entrypoints, mode: reachableOnly ? 'reachable-entry-graph' : 'all-emitted-files',
    files: files.length, inspectedFiles: inspected.size, resourceEdges: edges.length,
    edgeKinds: Object.fromEntries([...new Set(edges.map(edge => edge.kind))].sort().map(kind =>
      [kind, edges.filter(edge => edge.kind === kind).length])),
    externalUrls: external.size, dynamicExpressions,
    scope: 'All emitted HTML, static/literal dynamic imports, Vite preload maps, literal import.meta.url resources, CSS and manifest icons. Computed runtime URLs and external services require runtime testing.' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === ownFile) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => arg.startsWith('--') && arg !== '--reachable')) throw new Error('Only --reachable is supported');
    const directories = args.filter(arg => arg !== '--reachable');
    if (directories.length > 1) throw new Error('Provide one dist directory');
    console.log(JSON.stringify(validateDesktopRenderer(directories[0] ?? path.resolve(path.dirname(ownFile), '../dist'),
      { reachableOnly: args.includes('--reachable') }), null, 2));
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
