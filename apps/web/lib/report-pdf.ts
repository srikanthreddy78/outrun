import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { Report } from "@outrun/core/audit/pipeline";
import { PRODUCTS } from "@outrun/core/constants";

const WIDTH = 595.28;
const HEIGHT = 841.89;
const MARGIN = 52;
const BODY_WIDTH = WIDTH - MARGIN * 2;
const INK = rgb(0.09, 0.19, 0.15);
const MUTED = rgb(0.34, 0.43, 0.37);
const GREEN = rgb(0.08, 0.31, 0.23);

function printable(value: string, font: PDFFont): string {
  return [...value]
    .map((char) => {
      if (char === "\n" || char === "\t") return " ";
      try {
        font.encodeText(char);
        return char;
      } catch {
        return "?";
      }
    })
    .join("");
}

function wrap(value: string, font: PDFFont, size: number, width: number): string[] {
  const words = printable(value, font).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width) {
      line = next;
      continue;
    }
    if (line) {
      lines.push(line);
      line = "";
    }
    if (font.widthOfTextAtSize(word, size) <= width) {
      line = word;
      continue;
    }
    let chunk = "";
    for (const char of word) {
      if (font.widthOfTextAtSize(chunk + char, size) > width && chunk) {
        lines.push(chunk);
        chunk = "";
      }
      chunk += char;
    }
    line = chunk;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

export async function renderReportPdf(report: Report): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${report.domain} audit`);
  pdf.setAuthor("Outrun");
  pdf.setSubject("Agent readiness audit and implementation Kit");
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page: PDFPage;
  let y: number;

  const newPage = () => {
    page = pdf.addPage([WIDTH, HEIGHT]);
    page.drawRectangle({ x: 0, y: 0, width: WIDTH, height: HEIGHT, color: rgb(1, 1, 1) });
    page.drawRectangle({ x: 0, y: HEIGHT - 13, width: WIDTH, height: 13, color: GREEN });
    page.drawText("OUTRUN  /  AUDIT + KIT", { x: MARGIN, y: HEIGHT - 57, size: 9, font: bold, color: GREEN });
    y = HEIGHT - 91;
  };
  const room = (height: number) => {
    if (y - height < 70) newPage();
  };
  const line = (
    value: string,
    opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; gap?: number } = {},
  ) => {
    const size = opts.size ?? 10;
    const font = opts.bold ? bold : regular;
    const leading = size * 1.48;
    const rows = wrap(value, font, size, BODY_WIDTH);
    room(rows.length * leading + (opts.gap ?? 8));
    for (const row of rows) {
      page.drawText(row, { x: MARGIN, y, size, font, color: opts.color ?? INK });
      y -= leading;
    }
    y -= opts.gap ?? 8;
  };
  const heading = (value: string) => {
    room(45);
    y -= 9;
    line(value, { size: 15, bold: true, color: GREEN, gap: 10 });
  };

  newPage();
  line(report.domain, { size: 26, bold: true, gap: 3 });
  line(PRODUCTS[report.offer].name, { size: 12, color: MUTED, gap: 16 });
  line(
    `Delivered ${new Date(report.deliveredAt ?? Date.now()).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}`,
    { size: 9, color: MUTED, gap: 20 },
  );

  if (report.audit.summary) {
    heading("Executive summary");
    line(report.audit.summary);
  }
  heading("Findings");
  for (const [index, finding] of report.audit.findings.entries()) {
    room(75);
    line(`${index + 1}. ${finding.title}`, { size: 11, bold: true, gap: 2 });
    line(finding.detail, { gap: 3 });
    line(
      finding.evidence.checkId
        ? `Evidence: readiness check ${finding.evidence.checkId}`
        : `Evidence: ${finding.evidence.sourceUrl ?? "not supplied"}`,
      { size: 8, color: MUTED, gap: 16 },
    );
  }
  const kitIntro = "The accompanying private report page contains these downloadable assets:";
  const kitHeight =
    45 +
    wrap(kitIntro, regular, 10, BODY_WIDTH).length * 14.8 +
    7 +
    report.assets.reduce(
      (height, asset) => height + wrap(`- ${asset.name}`, regular, 9, BODY_WIDTH).length * 13.32 + 1,
      0,
    );
  if (kitHeight < HEIGHT - 160) room(kitHeight);
  heading("Implementation Kit");
  line(kitIntro, { gap: 7 });
  for (const asset of report.assets) line(`- ${asset.name}`, { size: 9, gap: 1 });
  for (const [index, current] of pdf.getPages().entries()) {
    current.drawLine({
      start: { x: MARGIN, y: 55 },
      end: { x: WIDTH - MARGIN, y: 55 },
      thickness: 0.6,
      color: rgb(0.79, 0.84, 0.8),
    });
    current.drawText(`PRIVATE REPORT  |  ${index + 1} / ${pdf.getPageCount()}`, {
      x: MARGIN,
      y: 38,
      size: 8,
      font: regular,
      color: MUTED,
    });
  }
  return pdf.save();
}
