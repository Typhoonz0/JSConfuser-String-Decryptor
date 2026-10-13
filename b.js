#!/usr/bin/env node
'use strict';
/*
 * strdecode.js - generic string-table deobfuscation helper (no dependencies).
 *
 * Handles the very common pattern:  decoder(210138, 9)  /  _0x1a2b("0x1f")
 * i.e. every string in the program was replaced by a call to one small decoder
 * function that looks the real string up in (or computes it from) a blob.
 *
 * Workflow
 *   1. FIND   which function is the decoder:
 *        node strdecode.js input.js --find
 *   2. READ   the decoder and the code it depends on (blob, helpers). Pick the
 *             line range that defines them, or copy them into a prelude file.
 *   3. DECODE run ONLY that prelude in an empty vm context, call the decoder for
 *             every literal call site, and substitute the results:
 *        node strdecode.js input.js --decoder NAME --lines 2-118
 *        node strdecode.js input.js --decoder NAME --prelude decoder.js
 *
 * SAFETY: the obfuscated file as a whole is never executed, only the prelude you
 * choose. It runs in a fresh `vm` context with no host objects passed in and a
 * timeout. Node's vm is NOT a hard security boundary, so read the prelude first
 * and, for anything untrusted, run this inside a container/VM with no network.
 */

const fs = require('fs');
const vm = require('vm');

// ---------- args ----------
function parseArgs(argv) {
  const o = { decoders: [], fold: true, shims: true, keepSuspect: false, timeout: 2000 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--find') o.find = true;
    else if (a === '--decoder') o.decoders.push(...next().split(',').filter(Boolean));
    else if (a === '--lines') o.lines = next();
    else if (a === '--prelude') o.prelude = next();
    else if (a === '--out') o.out = next();
    else if (a === '--dump') o.dump = next();
    else if (a === '--no-fold') o.fold = false;
    else if (a === '--no-shims') o.shims = false;
    else if (a === '--keep-suspect') o.keepSuspect = true;
    else if (a === '--timeout') o.timeout = Number(next());
    else if (a.startsWith('--')) die(`unknown option ${a}`);
    else rest.push(a);
  }
  o.input = rest[0];
  return o;
}

function die(msg) { console.error('error: ' + msg); process.exit(1); }

function usage() {
  console.log(`usage:
  node strdecode.js <input.js> --find
  node strdecode.js <input.js> --decoder NAME[,NAME2] (--lines A-B | --prelude FILE)
                    [--out FILE] [--dump table.json] [--no-fold] [--no-shims] [--keep-suspect] [--timeout MS]

  --find           list functions most often called with only literal arguments
                   (strong decoder candidates) and where they are defined
  --decoder        decoder function name(s) whose call sites should be replaced
  --lines A-B      use lines A..B (1-based, inclusive) of the input as the prelude
  --prelude FILE   use FILE as the prelude (decoder + blob + helpers)
  --out FILE       output path (default: <input>.readable.js)
  --dump FILE      also write every decoded call as JSON
  --no-fold        do not merge "a" + "b" into "ab" afterwards
  --no-shims       do not define TextDecoder/atob/btoa/window inside the sandbox
  --keep-suspect   substitute strings that look like garbage (wrong decoder?)
  --timeout MS     per-call and prelude time limit (default 2000)`);
}

// ---------- literal call-site matching ----------
const NUM = String.raw`-?\d+(?:\.\d+)?`;
const STR = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'`;
const LIT = `(?:${NUM}|${STR})`;
const ARGS = `${LIT}(?:\\s*,\\s*${LIT})*`;
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof',
  'function', 'void', 'delete', 'in', 'of', 'new', 'else', 'do', 'case', 'throw']);

function lineOf(text, idx) {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < idx; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

// ---------- --find ----------
function find(text) {
  const re = new RegExp(String.raw`(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(\s*(${ARGS})\s*\)`, 'g');
  const stats = new Map();
  let m;
  while ((m = re.exec(text))) {
    if (KEYWORDS.has(m[1])) continue;
    const s = stats.get(m[1]) || { calls: 0, uniq: new Set(), example: m[0] };
    s.calls++; s.uniq.add(m[2].replace(/\s+/g, ''));
    stats.set(m[1], s);
  }
  const top = [...stats.entries()].sort((a, b) => b[1].uniq.size - a[1].uniq.size).slice(0, 8);
  if (!top.length) return console.log('no calls with all-literal arguments found');
  console.log('most likely decoders (by number of distinct literal argument lists):\n');
  for (const [name, s] of top) {
    const esc = name.replace(/\$/g, '\\$');
    const defRe = new RegExp(String.raw`(?:function\s+${esc}\s*\(|(?:var|let|const)\s+${esc}\s*=|(?<![\w$.])${esc}\s*=\s*function)`, 'g');
    const defs = [];
    let d;
    while ((d = defRe.exec(text)) && defs.length < 3) defs.push(lineOf(text, d.index));
    console.log(`  ${name.padEnd(14)} ${String(s.calls).padStart(6)} calls, ${String(s.uniq.size).padStart(5)} distinct` +
      `   e.g. ${s.example.slice(0, 40)}   defined at line(s): ${defs.join(', ') || '?'}`);
  }
  console.log('\nnext: read the definition(s), decide which lines form the prelude, then run with --decoder/--lines.');
  console.log('tip: names get reused heavily in obfuscated code; a name defined at many lines usually has');
  console.log('     local copies. The first definition near the big string/array is normally the one you want.');
}

// ---------- prelude / sandbox ----------
const RISKY = ['require', 'process', 'import(', 'fetch', 'XMLHttpRequest', 'WebSocket', 'eval',
  'child_process', 'document', 'localStorage', 'importScripts', 'postMessage'];

// Pure-JS stand-ins that live INSIDE the sandbox (no host objects are shared).
// Decoders commonly need these; browsers/Node provide them, an empty vm context does not.
const SHIMS = String.raw`
(function (g) {
  g.window = g.self = g.global = g;
  if (typeof g.TextDecoder === 'undefined') {
    g.TextDecoder = function TextDecoder() {};
    g.TextDecoder.prototype.decode = function (b) {
      var s = '', i = 0, c;
      b = b || [];
      while (i < b.length) {
        c = b[i++];
        if (c >= 240) c = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
        else if (c >= 224) c = ((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
        else if (c >= 192) c = ((c & 31) << 6) | (b[i++] & 63);
        s += String.fromCodePoint(c);
      }
      return s;
    };
  }
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  if (typeof g.atob === 'undefined') g.atob = function (str) {
    str = String(str).replace(/[\s=]/g, ''); var out = '', bits = 0, acc = 0;
    for (var i = 0; i < str.length; i++) {
      var v = B64.indexOf(str.charAt(i)); if (v < 0 || v > 63) throw new Error('InvalidCharacterError');
      acc = (acc << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out += String.fromCharCode((acc >> bits) & 255); }
    }
    return out;
  };
  if (typeof g.btoa === 'undefined') g.btoa = function (str) {
    str = String(str); var out = '', i = 0;
    while (i < str.length) {
      var a = str.charCodeAt(i++), b = str.charCodeAt(i++), c = str.charCodeAt(i++);
      var n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63) +
             (isNaN(b) ? '=' : B64.charAt((n >> 6) & 63)) + (isNaN(c) ? '=' : B64.charAt(n & 63));
    }
    return out;
  };
})(this);
`;

function buildContext(preludeSrc, timeout, useShims) {
  const found = RISKY.filter(w => new RegExp(String.raw`(?<![\w$.])${w.replace('(', '\\(')}`).test(preludeSrc));
  if (found.length) console.error(`warning: prelude mentions: ${found.join(', ')} - review it before trusting this run`);
  const ctx = vm.createContext(Object.create(null)); // nothing from the host is exposed
  if (useShims) vm.runInContext(SHIMS, ctx, { timeout, filename: 'shims.js' });
  try {
    vm.runInContext(preludeSrc, ctx, { timeout, filename: 'prelude.js' });
  } catch (e) {
    die(`prelude failed to run: ${e && e.message}\n  (a missing dependency usually means the line range is too small)`);
  }
  return ctx;
}

function isSuspect(s) {
  // replacement characters or control characters (other than tab/newline/CR) usually mean wrong decoder/alphabet
  return /\uFFFD/.test(s) || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s);
}

// ---------- main ----------
function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.input) return usage();
  const text = fs.readFileSync(o.input, 'utf8');
  if (o.find) return find(text);

  if (!o.decoders.length) die('--decoder is required (run with --find to get candidates)');
  let preludeSrc;
  if (o.lines) {
    const m = /^(\d+)-(\d+)$/.exec(o.lines);
    if (!m) die('--lines must look like 2-118');
    preludeSrc = text.split('\n').slice(Number(m[1]) - 1, Number(m[2])).join('\n');
  } else if (o.prelude) {
    preludeSrc = fs.readFileSync(o.prelude, 'utf8');
  } else die('give --lines A-B or --prelude FILE');

  console.error(`prelude: ${preludeSrc.length} chars; decoders: ${o.decoders.join(', ')}`);
  const ctx = buildContext(preludeSrc, o.timeout, o.shims);
  for (const d of o.decoders) {
    if (vm.runInContext(`typeof ${d}`, ctx) !== 'function') {
      die(`'${d}' is not a function after running the prelude (wrong name, or its definition is outside the prelude)`);
    }
    // Obfuscators reuse names heavily; a name can end up bound to a built-in (e.g. String) at this scope,
    // which would "decode" every call into a plausible but wrong string.
    if (/\[native code\]/.test(vm.runInContext(`Function.prototype.toString.call(${d})`, ctx))) {
      die(`'${d}' resolves to a built-in function in this prelude, not a decoder (name reuse). Pick another name/range.`);
    }
  }

  const names = o.decoders.map(n => n.replace(/\$/g, '\\$')).join('|');
  const callRe = new RegExp(String.raw`(?<![\w$.])(${names})\s*\(\s*(${ARGS})\s*\)`, 'g');
  const cache = new Map();
  const table = {};
  let replaced = 0, failed = 0, suspect = 0;

  let out = text.replace(callRe, (whole, name, args, offset) => {
    const key = `${name}(${args.replace(/\s+/g, ' ')})`;
    let r = cache.get(key);
    if (!r) {
      try {
        const v = vm.runInContext(`${name}(${args})`, ctx, { timeout: o.timeout });
        if (typeof v === 'string' && isSuspect(v)) r = { skip: 'suspect', v };
        else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') r = { lit: JSON.stringify(v), v };
        else r = { skip: 'non-primitive' };
      } catch (e) { r = { skip: 'error', err: String(e && e.message) }; }
      cache.set(key, r);
    }
    table[key] = r.v !== undefined ? r.v : `<${r.skip}${r.err ? ': ' + r.err : ''}>`;
    if (r.lit !== undefined) { replaced++; return r.lit; }
    if (r.skip === 'suspect') {
      suspect++;
      if (o.keepSuspect) return JSON.stringify(r.v);
    } else failed++;
    return whole;
  });

  if (o.fold) {
    const cat = /("(?:[^"\\\n]|\\.)*")\s*\+\s*("(?:[^"\\\n]|\\.)*")/g;
    for (let prev = ''; prev !== out;) {
      prev = out;
      out = out.replace(cat, (_, a, b) => { try { return JSON.stringify(JSON.parse(a) + JSON.parse(b)); } catch { return _; } });
    }
  }

  const outPath = o.out || o.input.replace(/(\.[^.\/\\]+)?$/, '.readable.js');
  fs.writeFileSync(outPath, out);
  if (o.dump) fs.writeFileSync(o.dump, JSON.stringify(table, null, 1));
  console.error(`call sites replaced: ${replaced}  (distinct decoded: ${cache.size})`);
  if (failed) console.error(`errors/non-string results left in place: ${failed}`);
  if (suspect) console.error(`suspect (garbage-looking) results ${o.keepSuspect ? 'substituted anyway' : 'left in place'}: ${suspect}` +
    ' - if this is large, you probably have the wrong decoder or alphabet');
  console.error(`wrote ${outPath}${o.dump ? ' and ' + o.dump : ''}`);
}

main();