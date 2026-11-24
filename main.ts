// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, standard library alone. Run as `node main.ts [options] [PATCH]`.
//
// Sections 1-4, 9, 10 (command line, output and exit codes, safe paths, format
// detection, JSON edits, all-or-nothing write) follow the kit starter; sections
// 5-8 (three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A
// patches) are implemented here.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines plus its own line break and whether it ends with one. */
interface FileDoc {
  lines: string[];
  br: string;
  final: boolean;
}

function parseDoc(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function docText(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** One line of an old/new block: text, and whether it is a context line. */
interface BlockLine {
  text: string;
  ctx: boolean;
}

/** Line equality at a matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  const trimEnd = (s: string): string => s.replace(/[ \t]+$/, '');
  if (tier === 1) return trimEnd(a) === trimEnd(b);
  const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return trimBoth(a) === trimBoth(b);
}

/** All 0-based positions where O occurs in file at tier (overlaps allowed). */
function occurrences(file: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = 0; i + O.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(file[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, 1, 2) at which O occurs at least once, or null. */
function findTier(file: string[], O: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(file, O, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** First tier at which O occurs at or after `from`, or null. */
function findTierFrom(file: string[], O: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(file, O, t).filter((p) => p >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** First line at or after cursor equal to anchor (single line, section 5). */
function findSingleLine(file: string[], anchor: string, cursor: number, strict: boolean): number | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    for (let i = cursor; i < file.length; i++) {
      if (lineEq(file[i]!, anchor, t)) return i;
    }
  }
  return null;
}

/**
 * Build the replacement lines for a matched O at position pos.
 * Context lines are written as the file's own matched line; other lines of N
 * are written as they are, except at tier 2 where they are re-indented:
 * P (leading ws of O's first line) is replaced by F (leading ws of the
 * file's first matched line) when the line starts with P.
 */
function buildReplacement(file: string[], pos: number, O: BlockLine[], N: BlockLine[], tier: number): string[] {
  const ctxOIdx: number[] = [];
  O.forEach((e, i) => {
    if (e.ctx) ctxOIdx.push(i);
  });
  const F = tier === 2 && O.length > 0 ? leadingWs(file[pos]!) : '';
  const P = tier === 2 && O.length > 0 ? leadingWs(O[0]!.text) : '';
  const out: string[] = [];
  let c = 0;
  for (const e of N) {
    if (e.ctx) {
      out.push(file[pos + ctxOIdx[c]!]!);
      c++;
    } else {
      let t = e.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, for the R lines of the output (section 2). */
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  /** Old start line A (1-based) from the @@ header. */
  A: number;
  /** Context and - lines, in body order. */
  O: BlockLine[];
  /** Context and + lines, in body order. */
  N: BlockLine[];
  /** A \ line follows the hunk's last context or + line. */
  noNLAfterLast: boolean;
  /** The hunk has a + line. */
  hasPlus: boolean;
  /** A \ line follows the hunk's last + line. */
  lastPlusNoNL: boolean;
}

interface Section {
  /** Old path, or null for /dev/null (no file). */
  oldPath: string | null;
  /** New path, or null for /dev/null (no file). */
  newPath: string | null;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
  /** A ---/+++ pair named the paths (headerPath, null = /dev/null). */
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  /** rename from/to lines, when no ---/+++ pair does. */
  renameOld: string | null;
  renameNew: string | null;
  /** Paths from the diff --git line. */
  diffOld: string | null;
  diffNew: string | null;
}

/** Path from a --- or +++ header line, or null for /dev/null. */
function headerPath(line: string): string | null {
  const t = line.slice(4).split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  return t.replace(/^[ab]\//, '');
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let hasPair = false;
  let curHunk: { A: number; body: { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string }[] } | null = null;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const diffGitRe = /^diff --git a\/(\S+) b\/(\S+)\s*$/;

  const finishHunk = (): void => {
    if (curHunk === null || cur === null) return;
    const body = curHunk.body;
    while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
    const O: BlockLine[] = [];
    const N: BlockLine[] = [];
    let noNLAfterLast = false;
    let lastPlusNoNL = false;
    let hasPlus = false;
    let lastCtxNew = -1;
    let lastPlus = -1;
    body.forEach((e, i) => {
      if (e.kind === 'ctx') {
        O.push({ text: e.text, ctx: true });
        N.push({ text: e.text, ctx: true });
        lastCtxNew = i;
      } else if (e.kind === 'old') {
        O.push({ text: e.text, ctx: false });
      } else if (e.kind === 'new') {
        N.push({ text: e.text, ctx: false });
        hasPlus = true;
        lastCtxNew = i;
        lastPlus = i;
      }
    });
    if (lastCtxNew >= 0 && body[lastCtxNew + 1]?.kind === 'bs') noNLAfterLast = true;
    if (lastPlus >= 0 && body[lastPlus + 1]?.kind === 'bs') lastPlusNoNL = true;
    cur.hunks.push({ A: curHunk.A, O, N, noNLAfterLast, hasPlus, lastPlusNoNL });
    curHunk = null;
  };

  const newSection = (): Section => {
    const s: Section = {
      oldPath: null,
      newPath: null,
      isNew: false,
      isDeleted: false,
      hunks: [],
      pairOld: undefined,
      pairNew: undefined,
      renameOld: null,
      renameNew: null,
      diffOld: null,
      diffNew: null,
    };
    sections.push(s);
    return s;
  };

  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (curHunk !== null) {
      if (
        line.startsWith('diff --git ') ||
        (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) ||
        line.startsWith('@@')
      ) {
        finishHunk();
        continue;
      }
      if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '') {
        if (line.startsWith(' ')) curHunk.body.push({ kind: 'ctx', text: line.slice(1) });
        else if (line.startsWith('-')) curHunk.body.push({ kind: 'old', text: line.slice(1) });
        else if (line.startsWith('+')) curHunk.body.push({ kind: 'new', text: line.slice(1) });
        else if (line.startsWith('\\')) curHunk.body.push({ kind: 'bs', text: line.slice(1) });
        else curHunk.body.push({ kind: 'ctx', text: '' });
        i++;
        continue;
      }
      finishHunk();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = diffGitRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${lineNo}`);
      cur = newSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      inHeader = true;
      hasPair = false;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !hasPair) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
        hasPair = true;
        i += 2;
        continue;
      }
      cur = newSection();
      inHeader = true;
      hasPair = true;
      cur.pairOld = headerPath(line);
      cur.pairNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${lineNo + 1}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = hunkRe.exec(line);
      if (!m || cur === null) throw new Exit2(`error: parse ${lineNo}`);
      curHunk = { A: parseInt(m[1]!, 10), body: [] };
      inHeader = false;
      i++;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('+++ ')) {
        cur.pairNew = headerPath(line);
      } else if (line.startsWith('rename from ')) {
        if (!hasPair) cur.renameOld = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (!hasPair) cur.renameNew = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.isNew = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.isDeleted = true;
      }
      i++;
      continue;
    }
    i++;
  }
  finishHunk();
  // Resolve paths: ---/+++ pair wins, then rename, then diff --git.
  // undefined = not named anywhere; null = named as /dev/null.
  for (const s of sections) {
    let oldP: string | null | undefined = s.pairOld;
    let newP: string | null | undefined = s.pairNew;
    if (oldP === undefined) oldP = s.renameOld ?? s.diffOld;
    if (newP === undefined) newP = s.renameNew ?? s.diffNew;
    if (oldP === undefined && newP !== undefined) oldP = newP;
    if (newP === undefined && oldP !== undefined) newP = oldP;
    s.oldPath = oldP ?? null;
    s.newPath = newP ?? null;
  }
  return sections;
}

/** Apply one hunk to a file document; throws Fail('no-match', path). */
function applyHunk(doc: FileDoc, hunk: Hunk, d: number, strict: boolean, path: string): FileDoc {
  const file = doc.lines;
  if (hunk.O.length === 0) {
    const insertPos = Math.max(0, Math.min(hunk.A + d, file.length));
    const newLines = hunk.N.map((e) => e.text);
    const out = [...file.slice(0, insertPos), ...newLines, ...file.slice(insertPos)];
    const final = insertPos === file.length ? !hunk.noNLAfterLast : doc.final;
    return { lines: out, br: doc.br, final };
  }
  const found = findTier(file, hunk.O.map((e) => e.text), strict);
  if (!found) throw new Fail('no-match', path);
  const target = hunk.A - 1 + d;
  let pos = found.occ[0]!;
  let best = Math.abs(pos - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < best) {
      pos = p;
      best = dist;
    }
  }
  const repl = buildReplacement(file, pos, hunk.O, hunk.N, found.tier);
  const out = [...file.slice(0, pos), ...repl, ...file.slice(pos + hunk.O.length)];
  const final = pos + hunk.O.length === file.length ? !hunk.noNLAfterLast : doc.final;
  return { lines: out, br: doc.br, final };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((sec) => {
    return (tree: Tree): void => {
      const oldP = sec.oldPath;
      const newP = sec.newPath;
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
      const isCreate = oldP === null || sec.isNew;
      const isDelete = !isCreate && (newP === null || sec.isDeleted);
      if (isCreate) {
        if (newP === null) return;
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const plus: string[] = [];
        let lastPlusNoNL = false;
        for (const h of sec.hunks) {
          for (const e of h.N) if (!e.ctx) plus.push(e.text);
          if (h.hasPlus) lastPlusNoNL = h.lastPlusNoNL;
        }
        tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastPlusNoNL ? '' : '\n'));
        return;
      }
      if (isDelete) {
        if (oldP === null) return;
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
        return;
      }
      const src = oldP!;
      const dst = newP!;
      const isMove = src !== dst;
      const cur = tree.get(src);
      if (cur === null) throw new Fail('missing', src);
      if (isMove && tree.get(dst) !== null) throw new Fail('exists', dst);
      let doc = parseDoc(cur);
      let d = 0;
      for (const h of sec.hunks) {
        doc = applyHunk(doc, h, d, strict, src);
        d += h.N.length - h.O.length;
      }
      const out = docText(doc);
      if (isMove) {
        tree.now.set(src, null);
        tree.now.set(dst, out);
        tree.moves.push({ old: src, new: dst });
      } else {
        tree.now.set(src, out);
      }
    };
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const doc = parseDoc(cur);
    const found = findTier(doc.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const O = oldLines.map((t) => ({ text: t, ctx: false }));
    const N = newLines.map((t) => ({ text: t, ctx: false }));
    const repl = buildReplacement(doc.lines, pos, O, N, found.tier);
    const out = [...doc.lines.slice(0, pos), ...repl, ...doc.lines.slice(pos + oldLines.length)];
    tree.now.set(path, docText({ lines: out, br: doc.br, final: doc.final }));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    let s = -1;
    for (let j = i; j < n; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(srEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4Chunk {
  /** Anchor text, or null when the @@ line carries none. */
  anchor: string | null;
  O: BlockLine[];
  N: BlockLine[];
  /** The chunk ends at *** End of File (anchors it to the file's end). */
  eof: boolean;
}

function v4aAddEdit(path: string, secLines: string[]): Edit {
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, secLines.length === 0 ? '' : secLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4Chunk[], strict: boolean): Edit {
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let doc = parseDoc(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const pos = findSingleLine(doc.lines, ch.anchor, cursor, strict);
        if (pos === null) throw new Fail('no-match', path);
        cursor = pos + 1;
      }
      if (ch.O.length === 0) {
        const insertPos = ch.eof ? doc.lines.length : cursor;
        const newLines = ch.N.map((e) => e.text);
        doc = {
          lines: [...doc.lines.slice(0, insertPos), ...newLines, ...doc.lines.slice(insertPos)],
          br: doc.br,
          final: doc.final,
        };
        cursor = insertPos + newLines.length;
        continue;
      }
      if (ch.eof) {
        const endPos = doc.lines.length - ch.O.length;
        if (endPos < cursor) throw new Fail('no-match', path);
        const max = strict ? 0 : 2;
        let tier: number | null = null;
        for (let t = 0; t <= max; t++) {
          if (ch.O.every((e, j) => lineEq(doc.lines[endPos + j]!, e.text, t))) {
            tier = t;
            break;
          }
        }
        if (tier === null) throw new Fail('no-match', path);
        const repl = buildReplacement(doc.lines, endPos, ch.O, ch.N, tier);
        doc = {
          lines: [...doc.lines.slice(0, endPos), ...repl, ...doc.lines.slice(endPos + ch.O.length)],
          br: doc.br,
          final: doc.final,
        };
        cursor = endPos + repl.length;
        continue;
      }
      const found = findTierFrom(doc.lines, ch.O.map((e) => e.text), cursor, strict);
      if (!found) throw new Fail('no-match', path);
      const pos = found.occ[0]!;
      const repl = buildReplacement(doc.lines, pos, ch.O, ch.N, found.tier);
      doc = {
        lines: [...doc.lines.slice(0, pos), ...repl, ...doc.lines.slice(pos + ch.O.length)],
        br: doc.br,
        final: doc.final,
      };
      cursor = pos + repl.length;
    }
    const out = docText(doc);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last--;
  if (last === first || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const body = lines.slice(first + 1, last);
  const edits: Edit[] = [];
  let i = 0;
  const n = body.length;
  const secRe = /^\*\*\* (Add File|Delete File|Update File): (.*)$/;
  while (i < n) {
    const line = body[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const m = secRe.exec(line);
    if (!m) throw new Exit2(`error: parse ${first + 1 + i + 1}`);
    const kind = m[1]!;
    const path = m[2]!.trim();
    const secLine = first + 1 + i + 1;
    i++;
    if (kind === 'Add File') {
      const secLines: string[] = [];
      while (i < n) {
        const l = body[i]!;
        if (secRe.test(l) || l.trim() === '*** End Patch') break;
        if (l.startsWith('+')) secLines.push(l.slice(1));
        else if (blank(l)) secLines.push('');
        else throw new Exit2(`error: parse ${first + 1 + i + 1}`);
        i++;
      }
      while (secLines.length > 0 && blank(secLines[secLines.length - 1]!)) secLines.pop();
      edits.push(v4aAddEdit(path, secLines));
    } else if (kind === 'Delete File') {
      edits.push(v4aDeleteEdit(path));
    } else {
      // Update File: optional Move to, then chunks.
      while (i < n && blank(body[i]!)) i++;
      let moveTo: string | null = null;
      if (i < n && body[i]!.startsWith('*** Move to: ')) {
        moveTo = body[i]!.slice('*** Move to: '.length).trim();
        i++;
        while (i < n && blank(body[i]!)) i++;
      }
      const chunks: V4Chunk[] = [];
      let curChunk: { anchor: string | null; body: { kind: 'ctx' | 'old' | 'new'; text: string }[]; eof: boolean } | null = null;
      const pushChunk = (): void => {
        if (curChunk === null) return;
        const b = curChunk.body;
        const O: BlockLine[] = [];
        const N: BlockLine[] = [];
        for (const e of b) {
          if (e.kind === 'ctx') {
            O.push({ text: e.text, ctx: true });
            N.push({ text: e.text, ctx: true });
          } else if (e.kind === 'old') {
            O.push({ text: e.text, ctx: false });
          } else {
            N.push({ text: e.text, ctx: false });
          }
        }
        chunks.push({ anchor: curChunk.anchor, O, N, eof: curChunk.eof });
        curChunk = null;
      };
      let started = false;
      while (i < n) {
        const l = body[i]!;
        const ln = first + 1 + i + 1;
        if (secRe.test(l) || l.trim() === '*** End Patch') break;
        if (blank(l)) {
          if (curChunk !== null) curChunk.body.push({ kind: 'ctx', text: '' });
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          pushChunk();
          curChunk = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), body: [], eof: false };
          started = true;
          i++;
          continue;
        }
        if (l === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${ln}`);
          curChunk.eof = true;
          pushChunk();
          started = true;
          i++;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (curChunk === null) {
            if (started) throw new Exit2(`error: parse ${ln}`);
            curChunk = { anchor: null, body: [], eof: false };
            started = true;
          }
          if (l.startsWith(' ')) curChunk.body.push({ kind: 'ctx', text: l.slice(1) });
          else if (l.startsWith('-')) curChunk.body.push({ kind: 'old', text: l.slice(1) });
          else curChunk.body.push({ kind: 'new', text: l.slice(1) });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${ln}`);
      }
      pushChunk();
      // Blank lines at the end of a section are not part of it.
      if (chunks.length > 0) {
        const lastCh = chunks[chunks.length - 1]!;
        while (lastCh.O.length > 0 && lastCh.O[lastCh.O.length - 1]!.ctx && lastCh.O[lastCh.O.length - 1]!.text === '') {
          lastCh.O.pop();
        }
        while (lastCh.N.length > 0 && lastCh.N[lastCh.N.length - 1]!.ctx && lastCh.N[lastCh.N.length - 1]!.text === '') {
          lastCh.N.pop();
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else throw new Exit2('error: usage');
    } else pos.push(a);
  }
  if (pos.length > 1) throw new Exit2('error: usage');
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) throw new Exit2('error: no-patch');
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) throw new Exit2('error: format');
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) throw e;
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    writeSync(1, `${[...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`].join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  // Output lines in byte order of paths; a move is one R line sorting by <new>.
  const rows: { key: string; line: string }[] = [];
  const moveNew = new Set<string>();
  const moveOld = new Set<string>();
  for (const mv of tree.moves) {
    if (tree.original(mv.old) !== null && tree.get(mv.old) === null && tree.original(mv.new) === null && tree.get(mv.new) !== null) {
      rows.push({ key: mv.new, line: `R ${mv.old} -> ${mv.new}` });
      moveNew.add(mv.new);
      moveOld.add(mv.old);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (moveNew.has(p) || moveOld.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p) || '.', { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  writeSync(1, `${out.join('\n')}\n`);
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  await run().catch((e) => {
    if (e instanceof Exit2) {
      writeSync(1, `${e.line}\n`);
      process.exitCode = 2;
      return;
    }
    writeSync(1, 'error: parse 1\n');
    process.exitCode = 2;
  });
}
