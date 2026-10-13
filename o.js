#!/usr/bin/env node
'use strict';
// Run once:   node extract_strings.js deobfuscated.js
// Output:     deobfuscated.js.strings.tsv   (kind <TAB> first_line <TAB> count <TAB> JSON string)
//
// Decodes every string in this obfuscator's output without executing the target file:
//   decoded  - calls like fn(210138, 9); each call is resolved through its own scope to the wrapper
//              function, the blob it slices and the base-91 alphabet of its decoder (73 of them here)
//   concat   - constant "a" + "b" + decoded(...) chains, folded into one string
//   literal  - plain string literals (the giant blob and base64 modules are summarised, not dumped)
//   alias    - `switch(key){ case "k": return G["name"] }` tables: opaque key -> global property name
//   wasm     - printable strings found inside embedded base64 WebAssembly modules
//   suspect  - decoded results that look like garbage (control / replacement characters)
// Needs @babel/parser and @babel/traverse; installed next to this script automatically if missing.

const fs = require('fs');
let parse, traverse;
try {
  ({ parse } = require('@babel/parser')); traverse = require('@babel/traverse').default;
} catch {
  console.error('installing @babel/parser and @babel/traverse next to this script (one time)...');
  require('child_process').execSync('npm install --no-save --no-audit --no-fund @babel/parser @babel/traverse',
    { stdio: 'inherit', cwd: __dirname });
  ({ parse } = require('@babel/parser')); traverse = require('@babel/traverse').default;
}

const inPath = process.argv[2] || 'deobfuscated.js';
const outPath = inPath + '.strings.tsv';
const src = fs.readFileSync(inPath, 'utf8');
console.error(`parsing ${inPath} (${src.length} chars)...`);
const ast = parse(src, { sourceType: 'script', errorRecovery: true });

// ---------- base-91 variant decoder (same algorithm as every decoder in the file) ----------
function dec91(str, A) {
  const out = []; let acc = 0, bits = 0, d = -1;
  for (let i = 0; i < str.length; i++) {
    const v = A.indexOf(str[i]);
    if (v === -1) continue;
    if (d < 0) d = v;
    else {
      d += v * 91; acc |= d << bits; bits += (d & 8191) > 88 ? 13 : 14;
      do { out.push(acc & 255); acc >>= 8; bits -= 8; } while (bits > 7);
      d = -1;
    }
  }
  if (d > -1) out.push((acc | d << bits) & 255);
  return Buffer.from(out).toString('utf8');
}

// ---------- scope-aware wrapper resolution ----------
// wrapper:  function W(a, b) { return D(BLOB.slice(a, a + b)); }
const wrapperCache = new Map();
function alphabetOf(fnPath) {
  let found = null;
  fnPath.get('body').traverse({
    StringLiteral(q) {
      const v = q.node.value;
      if (!found && v.length === 91 && new Set(v).size === 91 && q.getFunctionParent() === fnPath) found = v;
    },
  });
  return found;
}
function analyzeWrapper(fp) {
  if (wrapperCache.has(fp.node)) return wrapperCache.get(fp.node);
  let res = null;
  try {
    const n = fp.node, body = n.body.body;
    if (n.params.length === 2 && n.params.every(p => p.type === 'Identifier') && body && body.length === 1 &&
        body[0].type === 'ReturnStatement' && body[0].argument && body[0].argument.type === 'CallExpression') {
      const [p0, p1] = n.params.map(p => p.name);
      const call = body[0].argument, inner = call.arguments[0];
      if (call.callee.type === 'Identifier' && call.arguments.length === 1 && inner && inner.type === 'CallExpression' &&
          inner.callee.type === 'MemberExpression' && !inner.callee.computed && inner.callee.property.name === 'slice' &&
          inner.callee.object.type === 'Identifier' && inner.arguments.length === 2 &&
          inner.arguments[0].type === 'Identifier' && inner.arguments[0].name === p0 &&
          inner.arguments[1].type === 'BinaryExpression' && inner.arguments[1].operator === '+' &&
          inner.arguments[1].left.name === p0 && inner.arguments[1].right.name === p1) {
        const dB = fp.scope.getBinding(call.callee.name), bB = fp.scope.getBinding(inner.callee.object.name);
        if (dB && dB.path.isFunctionDeclaration() && bB && bB.path.isVariableDeclarator() &&
            bB.path.node.init && bB.path.node.init.type === 'StringLiteral') {
          const alphabet = alphabetOf(dB.path);
          if (alphabet) res = { alphabet, blob: bB.path.node.init.value };
        }
      }
    }
  } catch { /* leave unresolved */ }
  wrapperCache.set(fp.node, res);
  return res;
}

const callCache = new Map();
function decodeCall(p) {
  const n = p.node;
  if (callCache.has(n)) return callCache.get(n);
  let res;
  if (n.callee.type === 'Identifier' && n.arguments.length === 2 && n.arguments.every(a => a.type === 'NumericLiteral')) {
    const b = p.scope.getBinding(n.callee.name);
    if (b && b.path.isFunctionDeclaration()) {
      const w = analyzeWrapper(b.path);
      if (w) {
        const [off, len] = n.arguments.map(a => a.value);
        res = dec91(w.blob.slice(off, off + len), w.alphabet);
      }
    }
  }
  callCache.set(n, res);
  return res;
}

// constant evaluator: string | number | undefined
const evCache = new Map();
function ev(p) {
  const n = p.node;
  if (evCache.has(n)) return evCache.get(n);
  let r;
  switch (n.type) {
    case 'StringLiteral': case 'NumericLiteral': r = n.value; break;
    case 'TemplateLiteral': if (n.expressions.length === 0) r = n.quasis[0].value.cooked; break;
    case 'CallExpression': r = decodeCall(p); break;
    case 'BinaryExpression':
      if (n.operator === '+') {
        const l = ev(p.get('left')), rr = ev(p.get('right'));
        if (l !== undefined && rr !== undefined && (typeof l === 'string' || typeof rr === 'string')) r = String(l) + String(rr);
      }
      break;
  }
  evCache.set(n, r);
  return r;
}

// ---------- collect ----------
const found = new Map(); // kind \0 string -> {kind, line, count, s}
function add(kind, s, line) {
  const k = kind + '\0' + s, e = found.get(k);
  if (e) e.count++; else found.set(k, { kind, line, count: 1, s });
}
const isSuspect = s => /\uFFFD/.test(s) || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s);
const wasmMods = [];
let decodedCalls = 0;

traverse(ast, {
  CallExpression(p) {
    const s = decodeCall(p);
    if (typeof s === 'string') { decodedCalls++; add(isSuspect(s) ? 'suspect' : 'decoded', s, p.node.loc.start.line); }
  },
  BinaryExpression(p) {
    if (p.node.operator !== '+') return;
    const s = ev(p);
    if (typeof s !== 'string') return;
    const par = p.parentPath;
    if (par.isBinaryExpression({ operator: '+' }) && typeof ev(par) === 'string') return; // only maximal chains
    add('concat', s, p.node.loc.start.line);
  },
  StringLiteral(p) {
    const v = p.node.value;
    if (!v) return;
    if (/^AGFzbQ[A-Za-z0-9+/]+=*$/.test(v) && v.length >= 200) { wasmMods.push({ b64: v, line: p.node.loc.start.line }); return; }
    if (v.length > 5000) { add('literal', `<${v.length}-char blob>`, p.node.loc.start.line); return; }
    add('literal', v, p.node.loc.start.line);
  },
  SwitchStatement(p) {
    const rows = [];
    for (const c of p.get('cases')) {
      if (!c.node.test || c.node.consequent.length !== 1 || c.node.consequent[0].type !== 'ReturnStatement') continue;
      const ret = c.get('consequent.0.argument');
      if (!ret.node || !ret.isMemberExpression({ computed: true }) || ret.node.object.type !== 'Identifier') continue;
      const key = ev(c.get('test')), name = ev(ret.get('property'));
      if (typeof key === 'string' && typeof name === 'string') rows.push([key, ret.node.object.name, name, c.node.loc.start.line]);
    }
    if (rows.length >= 5) for (const [k, obj, name, line] of rows) add('alias', `${k} => ${obj}[${JSON.stringify(name)}]`, line);
  },
});

// ---------- WASM strings ----------
// base64 modules can be plain literals or decoded/concatenated strings; pull them out of every kind
for (const [k, e] of [...found]) {
  if (e.s.length >= 200 && /^AGFzbQ[A-Za-z0-9+/]+=*$/.test(e.s)) { wasmMods.push({ b64: e.s, line: e.line }); found.delete(k); }
  else if (e.s.length > 5000 && e.kind !== 'wasm') { found.delete(k); add(e.kind, `<${e.s.length}-char string, starts ${JSON.stringify(e.s.slice(0, 40))}>`, e.line); }
}
let wasmStrings = 0;
wasmMods.forEach((m, i) => {
  const buf = Buffer.from(m.b64, 'base64');
  if (buf.readUInt32BE(0) !== 0x0061736d) return;
  const text = buf.toString('latin1');
  for (const mm of text.matchAll(/[\x20-\x7e\t\n]{6,}/g)) { add('wasm', `[module ${i + 1}, ${buf.length} bytes] ${mm[0]}`, m.line); wasmStrings++; }
});

// ---------- write ----------
const order = ['decoded', 'concat', 'alias', 'literal', 'wasm', 'suspect'];
const rows = [...found.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.line - b.line);
fs.writeFileSync(outPath, 'kind\tfirst_line\tcount\tstring\n' +
  rows.map(r => `${r.kind}\t${r.line}\t${r.count}\t${JSON.stringify(r.s)}`).join('\n') + '\n');

const by = {}; for (const r of rows) by[r.kind] = (by[r.kind] || 0) + 1;
console.error(`decoder wrappers resolved: ${[...wrapperCache.values()].filter(Boolean).length}` +
  ` (of ${wrapperCache.size} candidates examined)`);
console.error(`decoded call sites: ${decodedCalls}`);
console.error('distinct strings by kind: ' + JSON.stringify(by));
console.error(`wasm modules: ${wasmMods.length}, printable strings from them: ${wasmStrings}`);
console.error(`wrote ${outPath}  (${rows.length} rows)`);