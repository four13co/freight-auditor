import { PDFDocument, StandardFonts } from 'pdf-lib';

/**
 * 86e2xb911: generates a small, real, readable PDF with the given text lines
 * -- used to prove pdf-extract.ts's PDF-text-extraction step against an
 * actual PDF byte stream (not a hand-rolled fake), while keeping the fixture
 * itself readable in the repo (generated, not a checked-in opaque binary).
 */
export async function makeTextPdf(lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let y = 740;
  for (const line of lines) {
    page.drawText(line, { x: 50, y, size: 12, font });
    y -= 18;
  }
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

/** A PDF with a single blank page -- no drawn text, so extraction yields empty text. */
export async function makeBlankPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const bytes = await doc.save();
  return Buffer.from(bytes);
}
