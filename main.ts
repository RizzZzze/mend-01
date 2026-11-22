// main.ts is mend, the CLI SPEC.md specifies. It does sections 1 to 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A
// patches, JSON edits and the all-or-nothing write, with move output as `R` lines. Node 22, the standard library
// alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** A file split at its own line break: its lines, the break, and whether it ends with one. */
interface FileParts {
  lines: string[];
  br: string;
  finalBr: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let finalBr = false;
  if (text.endsWith(br)) {
    lines.pop();
    finalBr = true;
  }
  return { lines, br, finalBr };
}

function joinFile(lines: string[], br: string, finalBr: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBr ? br : '');
}

const trailWS = (s: string): string => s.replace(/[ \t]+$/, '');
const bothWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** The key a line is compared by at a tier (SPEC.md section 5). */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return trailWS(line);
  return bothWS(line);
}

/** Every 0-based position where oldLines occur in lines at this tier; occurrences may overlap. */
function occurrences(lines: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  const k = oldLines.length;
  if (k === 0 || k > lines.length) return out;
  const keys = oldLines.map((l) => tierKey(l, tier));
  for (let i = 0; i + k <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < k; j += 1) {
      if (tierKey(lines[i + j]!, tier) !== keys[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which oldLines occur at least once, with its positions; null when none do. */
function findTier(lines: string[], oldLines: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, oldLines, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Tier 2 re-indentation of one new line: its leading P (from O's first line) replaced by F (from the file's first matched line). */
function reindentLine(line: string, f: string, p: string): string {
  if (!/[^ \t]/.test(line)) return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

function reindentLines(nw: string[], f: string, p: string): string[] {
  return nw.map((l) => reindentLine(l, f, p));
}

/** Replace oldLen lines at pos of before with nw, keeping before's break and final break. */
function applyReplace(before: string, pos: number, oldLen: number, nw: string[]): string {
  const parts = splitFile(before);
  const out = [...parts.lines.slice(0, pos), ...nw, ...parts.lines.slice(pos + oldLen)];
  return joinFile(out, parts.br, parts.finalBr);
}

/** One line of a unified hunk or a V4A chunk body: ' ' context, '-' old, '+' new, '\' no-newline marker. */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  raw: string;
}

/** Resolve a hunk or chunk body against the file's matched lines at pos: context lines are the file's own lines, '+' lines are re-indented at tier 2. */
function resolveBodyLines(body: BodyLine[], fileLines: string[], pos: number, tier: number, oFirst: string): string[] {
  const out: string[] = [];
  let oIdx = 0;
  const f = tier === 2 ? leadWS(fileLines[pos] ?? '') : '';
  const p = tier === 2 ? leadWS(oFirst) : '';
  for (const b of body) {
    if (b.kind === ' ') {
      out.push(fileLines[pos + oIdx]!);
      oIdx += 1;
    } else if (b.kind === '-') {
      oIdx += 1;
    } else if (b.kind === '+') {
      out.push(tier === 2 ? reindentLine(b.text, f, p) : b.text);
    }
  }
  return out;
}

/** Whether a '\' line follows the body's last context or '+' line (SPEC.md section 6, no-newline rule). */
function backslashAfterLast(body: BodyLine[]): boolean {
  let last = -1;
  body.forEach((b, idx) => {
    if (b.kind === ' ' || b.kind === '+') last = idx;
  });
  if (last < 0) return false;
  return body[last + 1]?.kind === '\\';
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
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

/** SEARCH/REPLACE blocks (SPEC.md section 7), each block one edit, applied in order. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let boundary = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= boundary; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    let end = -1;
    if (sep >= 0) {
      for (let j = sep + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (sep < 0 || end < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const parts = splitFile(before);
      const found = findTier(parts.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const nw = found.tier === 2 ? reindentLines(newLines, leadWS(parts.lines[pos]!), leadWS(oldLines[0]!)) : newLines;
      tree.now.set(p, applyReplace(before, pos, oldLines.length, nw));
    });
    prevPath = p;
    boundary = end + 1;
    i = end + 1;
  }
  return edits;
}

/** One unified diff section (SPEC.md section 6). */
interface UniSection {
  dashOld: string | null;
  dashNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  gitOld: string | null;
  gitNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Array<{ a: number; body: BodyLine[] }>;
}

/** The path named by a `--- ` or `+++ ` line: text after the four characters, up to the first tab, trimmed. */
function dashPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseUnifiedSections(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let hasHunk = false;
  let hasDashPair = false;
  const fresh = (): UniSection => ({ dashOld: null, dashNew: null, renameFrom: null, renameTo: null, gitOld: null, gitNew: null, isCreate: false, isDelete: false, hunks: [] });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      hasHunk = false;
      hasDashPair = false;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !hasHunk && !hasDashPair) {
        cur.dashOld = dashPath(line);
        cur.dashNew = dashPath(lines[i + 1]!);
        hasDashPair = true;
      } else {
        cur = fresh();
        cur.dashOld = dashPath(line);
        cur.dashNew = dashPath(lines[i + 1]!);
        sections.push(cur);
        hasHunk = false;
        hasDashPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( |$)/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const lj = lines[j]!;
        if (lj.startsWith('diff --git ')) break;
        if (lj.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (lj === '') {
          body.push({ kind: ' ', text: '', raw: lj });
          j += 1;
          continue;
        }
        if (lj[0] === ' ') {
          body.push({ kind: ' ', text: lj.slice(1), raw: lj });
          j += 1;
          continue;
        }
        if (lj[0] === '-') {
          body.push({ kind: '-', text: lj.slice(1), raw: lj });
          j += 1;
          continue;
        }
        if (lj[0] === '+') {
          body.push({ kind: '+', text: lj.slice(1), raw: lj });
          j += 1;
          continue;
        }
        if (lj[0] === '\\') {
          body.push({ kind: '\\', text: lj.slice(1), raw: lj });
          j += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
      cur.hunks.push({ a, body });
      hasHunk = true;
      i = j;
      continue;
    }
    if (cur !== null && !hasHunk) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        cur.dashNew = dashPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      else if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length);
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections;
}

/** Apply a section's hunks in order to a file's text (SPEC.md section 6). */
function applyHunks(before: string, hunks: Array<{ a: number; body: BodyLine[] }>, strict: boolean, path: string): string {
  let text = before;
  let d = 0;
  for (const h of hunks) {
    const oLines: string[] = [];
    for (const b of h.body) if (b.kind === ' ' || b.kind === '-') oLines.push(b.text);
    const parts = splitFile(text);
    if (oLines.length > 0) {
      const found = findTier(parts.lines, oLines, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.occ[0]!;
      let best = Math.abs(pos - target);
      for (const o of found.occ) {
        const dist = Math.abs(o - target);
        if (dist < best) {
          best = dist;
          pos = o;
        }
      }
      const resolved = resolveBodyLines(h.body, parts.lines, pos, found.tier, oLines[0]!);
      const runsToEnd = pos + oLines.length === parts.lines.length;
      const newFinal = runsToEnd ? !backslashAfterLast(h.body) : parts.finalBr;
      text = joinFile([...parts.lines.slice(0, pos), ...resolved, ...parts.lines.slice(pos + oLines.length)], parts.br, newFinal);
      d += resolved.length - oLines.length;
    } else {
      const ins = Math.min(Math.max(h.a + d, 0), parts.lines.length);
      const added = h.body.filter((b) => b.kind === '+').map((b) => b.text);
      const atEnd = ins === parts.lines.length;
      const newFinal = atEnd ? !backslashAfterLast(h.body) : parts.finalBr;
      text = joinFile([...parts.lines.slice(0, ins), ...added, ...parts.lines.slice(ins)], parts.br, newFinal);
      d += added.length;
    }
  }
  return text;
}

/** Unified diffs (SPEC.md section 6), each section one edit, applied in order. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnifiedSections(lines);
  return sections.map((s) => {
    const oldStr = s.dashOld ?? s.renameFrom ?? s.gitOld;
    const newStr = s.dashNew ?? s.renameTo ?? s.gitNew;
    const oldPath = oldStr === null || oldStr === '/dev/null' ? null : s.dashOld !== null ? stripAB(oldStr) : oldStr;
    const newPath = newStr === null || newStr === '/dev/null' ? null : s.dashNew !== null ? stripAB(newStr) : newStr;
    const isCreate = s.isCreate || oldPath === null;
    const isDelete = !isCreate && (s.isDelete || newPath === null);
    if (isCreate) {
      const target = newPath ?? '';
      return (tree: Tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) !== null) throw new Fail('exists', target);
        const outLines: string[] = [];
        let lastPlus: { hunk: number; idx: number } | null = null;
        s.hunks.forEach((h, hi) => {
          h.body.forEach((b, bi) => {
            if (b.kind === '+') {
              outLines.push(b.text);
              lastPlus = { hunk: hi, idx: bi };
            }
          });
        });
        let noEol = false;
        if (lastPlus !== null) {
          const body = s.hunks[lastPlus.hunk]!.body;
          noEol = body[lastPlus.idx + 1]?.kind === '\\';
        }
        tree.now.set(target, outLines.length === 0 ? '' : outLines.join('\n') + (noEol ? '' : '\n'));
      };
    }
    if (isDelete) {
      const target = oldPath ?? '';
      return (tree: Tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) === null) throw new Fail('missing', target);
        tree.now.set(target, null);
      };
    }
    if (oldPath !== newPath) {
      const oldP = oldPath ?? '';
      const newP = newPath ?? '';
      return (tree: Tree) => {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (!safe(newP)) throw new Fail('unsafe', newP);
        const before = tree.get(oldP);
        if (before === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const result = applyHunks(before, s.hunks, strict, oldP);
        tree.now.set(newP, result);
        tree.now.set(oldP, null);
        tree.moves.push([oldP, newP]);
      };
    }
    const target = oldPath ?? '';
    return (tree: Tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      const before = tree.get(target);
      if (before === null) throw new Fail('missing', target);
      tree.now.set(target, applyHunks(before, s.hunks, strict, target));
    };
  });
}

/** One V4A chunk (SPEC.md section 8). */
interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

/** One V4A section (SPEC.md section 8). */
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
  updateLine: number;
}

function isVSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

function isVBodyLine(l: string): boolean {
  return l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+';
}

/** Collect one chunk's body lines starting at j; returns the index after the chunk. */
function collectVChunkBody(lines: string[], j: number, last: number, chunk: VChunk): number {
  while (j < last && !isVSectionStart(lines[j]!)) {
    const l = lines[j]!;
    if (l.startsWith('@@')) break;
    if (l === '*** End of File') {
      chunk.eof = true;
      return j + 1;
    }
    if (l.startsWith('*** ')) break;
    if (l === '') {
      chunk.body.push({ kind: ' ', text: '', raw: l });
      j += 1;
      continue;
    }
    if (l[0] === ' ') {
      chunk.body.push({ kind: ' ', text: l.slice(1), raw: l });
      j += 1;
      continue;
    }
    if (l[0] === '-') {
      chunk.body.push({ kind: '-', text: l.slice(1), raw: l });
      j += 1;
      continue;
    }
    if (l[0] === '+') {
      chunk.body.push({ kind: '+', text: l.slice(1), raw: l });
      j += 1;
      continue;
    }
    break;
  }
  if (j >= last || isVSectionStart(lines[j]!)) {
    while (chunk.body.length > 0) {
      const b = chunk.body[chunk.body.length - 1]!;
      if (b.kind === ' ' && b.text.trim() === '') chunk.body.pop();
      else break;
    }
  }
  return j;
}

function parseV4aSections(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const raw: string[] = [];
      let j = i + 1;
      while (j < last && !isVSectionStart(lines[j]!)) {
        raw.push(lines[j]!);
        j += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const addLines: string[] = [];
      for (let k = 0; k < raw.length; k += 1) {
        const l = raw[k]!;
        if (l === '') addLines.push('');
        else if (l.startsWith('+')) addLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      sections.push({ kind: 'add', path, addLines, moveTo: null, chunks: [], updateLine: 0 });
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last && !isVSectionStart(lines[j]!)) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      sections.push({ kind: 'delete', path, addLines: [], moveTo: null, chunks: [], updateLine: 0 });
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j += 1;
      }
      const chunks: VChunk[] = [];
      let firstChunk = true;
      while (j < last && !isVSectionStart(lines[j]!)) {
        const l = lines[j]!;
        if (l.startsWith('@@')) {
          const anchorText = l.slice(2).trim();
          const chunk: VChunk = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
          j = collectVChunkBody(lines, j + 1, last, chunk);
          chunks.push(chunk);
          firstChunk = false;
          continue;
        }
        if (isVBodyLine(l)) {
          if (!firstChunk) throw new Exit2(`error: parse ${j + 1}`);
          const chunk: VChunk = { anchor: null, body: [], eof: false };
          j = collectVChunkBody(lines, j, last, chunk);
          chunks.push(chunk);
          firstChunk = false;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      sections.push({ kind: 'update', path, addLines: [], moveTo, chunks, updateLine });
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections;
}

/** First line at or after cursor equal to the anchor at the first tier where one is; -1 when none. */
function findAnchor(lines: string[], anchor: string, strict: boolean, cursor: number): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = cursor; i < lines.length; i += 1) {
      if (tierKey(lines[i]!, t) === tierKey(anchor, t)) return i;
    }
  }
  return -1;
}

/** First occurrence of oLines at or after cursor, at the first tier with one; end-of-file chunks only take one ending at the last line. */
function findChunkOccurrence(lines: string[], oLines: string[], strict: boolean, cursor: number, eof: boolean): { pos: number; tier: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, oLines, t).filter((p) => p >= cursor && (!eof || p + oLines.length === lines.length));
    if (occ.length > 0) return { pos: occ[0]!, tier: t };
  }
  return null;
}

/** Apply one V4A chunk to a file's text, returning the new text and cursor. */
function applyVChunk(text: string, chunk: VChunk, strict: boolean, path: string, cursor: number): { text: string; cursor: number } {
  const parts = splitFile(text);
  const lines = parts.lines;
  if (chunk.anchor !== null) {
    const found = findAnchor(lines, chunk.anchor, strict, cursor);
    if (found < 0) throw new Fail('no-match', path);
    cursor = found + 1;
  }
  const oLines: string[] = [];
  for (const b of chunk.body) if (b.kind === ' ' || b.kind === '-') oLines.push(b.text);
  if (oLines.length === 0) {
    const added = chunk.body.filter((b) => b.kind === '+').map((b) => b.text);
    const ins = chunk.eof ? lines.length : Math.min(cursor, lines.length);
    return { text: joinFile([...lines.slice(0, ins), ...added, ...lines.slice(ins)], parts.br, parts.finalBr), cursor: ins + added.length };
  }
  let match = findChunkOccurrence(lines, oLines, strict, cursor, chunk.eof);
  let usedBody = chunk.body;
  let usedO = oLines;
  if (match === null) {
    const filtered = chunk.body.filter((b) => !(b.kind === ' ' && b.text.trim() === ''));
    const o2: string[] = [];
    for (const b of filtered) if (b.kind === ' ' || b.kind === '-') o2.push(b.text);
    if (o2.length > 0 && o2.length < oLines.length) {
      const m2 = findChunkOccurrence(lines, o2, strict, cursor, chunk.eof);
      if (m2 !== null) {
        match = m2;
        usedBody = filtered;
        usedO = o2;
      }
    }
  }
  if (match === null) throw new Fail('no-match', path);
  const resolved = resolveBodyLines(usedBody, lines, match.pos, match.tier, usedO[0]!);
  return { text: joinFile([...lines.slice(0, match.pos), ...resolved, ...lines.slice(match.pos + usedO.length)], parts.br, parts.finalBr), cursor: match.pos + resolved.length };
}

/** V4A patches (SPEC.md section 8), each section one edit, applied in order. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseV4aSections(lines);
  return sections.map((s) => {
    if (s.kind === 'add') {
      const target = s.path;
      const addLines = s.addLines;
      return (tree: Tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) !== null) throw new Fail('exists', target);
        tree.now.set(target, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
      };
    }
    if (s.kind === 'delete') {
      const target = s.path;
      return (tree: Tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) === null) throw new Fail('missing', target);
        tree.now.set(target, null);
      };
    }
    const target = s.path;
    const moveTo = s.moveTo;
    const chunks = s.chunks;
    return (tree: Tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const before = tree.get(target);
      if (before === null) throw new Fail('missing', target);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      let text = before;
      let cursor = 0;
      for (const ch of chunks) {
        const r = applyVChunk(text, ch, strict, target, cursor);
        text = r.text;
        cursor = r.cursor;
      }
      if (moveTo !== null) {
        tree.now.set(moveTo, text);
        tree.now.set(target, null);
        tree.moves.push([target, moveTo]);
      } else {
        tree.now.set(target, text);
      }
    };
  });
}

function run(args: string[]): { code: number; out: string[] } {
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
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'v4a') edits = v4aEdits(lines, strict);
    else edits = [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
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
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const suppressed = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      suppressed.add(oldP);
      suppressed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
