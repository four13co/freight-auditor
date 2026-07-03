/**
 * Minimal, dependency-free X12 EDI reader (Master Spec §13).
 *
 * Delimiters are read from the ISA segment, never hard-coded:
 *   - element separator: ISA byte 4 (index 3)
 *   - segment terminator: ISA byte 106 (the char after the 16th element)
 *   - component (sub-element) separator: ISA16 (the last ISA element)
 *
 * The reader is intentionally a faithful tokenizer, not a schema validator:
 * transaction-set adapters (210/310) interpret the segment stream. It is pure —
 * no I/O, no clock — so parsing is deterministic (§5.4).
 */

export interface X12Segment {
  /** Segment id, e.g. "ISA", "B3", "L1". */
  tag: string;
  /** Elements after the tag. elements[0] is the first data element. */
  elements: string[];
}

export interface X12Delimiters {
  element: string;
  segment: string;
  component: string;
}

export interface X12Interchange {
  delimiters: X12Delimiters;
  segments: X12Segment[];
}

export class X12ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'X12ParseError';
  }
}

/**
 * Read delimiters from the fixed-width ISA envelope. ISA is the one segment with
 * a fixed layout, which is what lets us discover the terminators before we know
 * how to split the rest of the interchange.
 */
export function readIsaDelimiters(raw: string): X12Delimiters {
  const isaPos = raw.indexOf('ISA');
  if (isaPos === -1) throw new X12ParseError('no ISA segment found');
  const element = raw.charAt(isaPos + 3);
  if (!element) throw new X12ParseError('cannot read element separator from ISA');
  // ISA has 16 elements; the segment terminator is the char immediately after
  // ISA16. Walk 16 element separators from the ISA start to find it.
  let idx = isaPos;
  let seps = 0;
  while (idx < raw.length && seps < 16) {
    if (raw.charAt(idx) === element) seps += 1;
    idx += 1;
  }
  if (seps < 16) throw new X12ParseError('ISA segment is truncated (fewer than 16 elements)');
  // idx now points at the char after the 16th separator = ISA16 (component sep),
  // and the char after ISA16 is the segment terminator.
  const component = raw.charAt(idx);
  const segment = raw.charAt(idx + 1);
  if (!component || !segment) throw new X12ParseError('cannot read ISA16 / segment terminator');
  return { element, segment, component };
}

/** Parse a raw X12 string into an interchange (delimiters + segment list). */
export function parseX12(raw: string): X12Interchange {
  const delimiters = readIsaDelimiters(raw);
  const segments: X12Segment[] = [];
  for (const chunk of raw.split(delimiters.segment)) {
    const trimmed = chunk.trim();
    if (trimmed === '') continue;
    const parts = trimmed.split(delimiters.element);
    const tag = parts[0] ?? '';
    if (tag === '') continue;
    segments.push({ tag, elements: parts.slice(1) });
  }
  if (segments.length === 0) throw new X12ParseError('no segments parsed');
  return { delimiters, segments };
}

/** All segments with the given tag, in document order. */
export function segmentsByTag(interchange: X12Interchange, tag: string): X12Segment[] {
  return interchange.segments.filter((s) => s.tag === tag);
}

/** The first segment with the given tag, or undefined. */
export function firstSegment(interchange: X12Interchange, tag: string): X12Segment | undefined {
  return interchange.segments.find((s) => s.tag === tag);
}

/** 1-indexed element accessor matching X12 element numbering (el(seg, 1) = first data element). */
export function el(segment: X12Segment | undefined, n: number): string | undefined {
  if (!segment) return undefined;
  const v = segment.elements[n - 1];
  return v === '' ? undefined : v;
}
