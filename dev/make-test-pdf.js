// Generates a simple multi-page test PDF with text and an outline, no deps.
const fs = require("fs");
const path = require("path");

const pages = 4;
const objects = [];
const addObj = (s) => objects.push(s) && objects.length;

const contentIds = [];
for (let p = 1; p <= pages; p++) {
  // Dark "code block" panel on the right half of page 1 (light text on
  // dark), to test background-aware highlighter blending.
  let text =
    p === 1
      ? "0.09 0.13 0.24 rg 320 380 240 320 re f\n" +
        "1 1 1 rg BT /F1 12 Tf 335 660 Td (white text on dark panel) Tj ET\n" +
        "0 0 0 rg\n"
      : "";
  text += `BT /F1 36 Tf 72 700 Td (Page ${p} - PDF Annotator Test) Tj ET\n`;
  for (let line = 0; line < 20; line++) {
    const y = 640 - line * 28;
    text += `BT /F1 14 Tf 72 ${y} Td (Line ${line + 1} on page ${p}. The quick brown fox jumps over the lazy dog.) Tj ET\n`;
  }
  const stream = `<< /Length ${text.length} >>\nstream\n${text}endstream`;
  contentIds.push(addObj(stream));
}

const fontId = addObj(
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
);

// ids: content objs = 1..pages, font = pages+1,
// page objs = pages+2 .. 2*pages+1, pages node = 2*pages+2, catalog = 2*pages+3,
// outline root = 2*pages+4, outline items = 2*pages+5 .. 2*pages+7,
// names dict = 2*pages+8, dests name tree = 2*pages+9.
const pageObjStart = pages + 2;
const pagesNodeId = 2 * pages + 2;
const catalogId = 2 * pages + 3;
const outlineRootId = 2 * pages + 4;
const outlineItemStart = 2 * pages + 5;
const namesId = 2 * pages + 8;
const destsTreeId = 2 * pages + 9;

const pageIds = [];
for (let p = 0; p < pages; p++) {
  addObj(
    `<< /Type /Page /Parent ${pagesNodeId} 0 R /MediaBox [0 0 612 792] ` +
      `/Contents ${contentIds[p]} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`
  );
  pageIds.push(pageObjStart + p);
}
addObj(
  `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pages} >>`
);
addObj(
  `<< /Type /Catalog /Pages ${pagesNodeId} 0 R /Outlines ${outlineRootId} 0 R ` +
    `/Names ${namesId} 0 R >>`
);
// Outline: chapter 1 (direct dest -> page 1), chapter 2 (direct -> page 2),
// chapter 3 (NAMED dest -> page 4) to exercise the string-dest path.
addObj(
  `<< /Type /Outlines /First ${outlineItemStart} 0 R /Last ${outlineItemStart + 2} 0 R /Count 3 >>`
);
addObj(
  `<< /Title (Chapter One) /Parent ${outlineRootId} 0 R /Next ${outlineItemStart + 1} 0 R ` +
    `/Dest [${pageIds[0]} 0 R /XYZ null null null] >>`
);
addObj(
  `<< /Title (Chapter Two) /Parent ${outlineRootId} 0 R /Prev ${outlineItemStart} 0 R ` +
    `/Next ${outlineItemStart + 2} 0 R /Dest [${pageIds[1]} 0 R /XYZ null null null] >>`
);
addObj(
  `<< /Title (Chapter Three Named) /Parent ${outlineRootId} 0 R /Prev ${outlineItemStart + 1} 0 R ` +
    `/Dest (chap3) >>`
);
addObj(`<< /Dests ${destsTreeId} 0 R >>`);
addObj(
  `<< /Names [(chap3) [${pageIds[3]} 0 R /XYZ null null null]] >>`
);

let out = "%PDF-1.4\n";
const offsets = [];
objects.forEach((body, i) => {
  offsets.push(out.length);
  out += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xrefPos = out.length;
out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) {
  out += `${String(off).padStart(10, "0")} 00000 n \n`;
}
out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;

fs.writeFileSync(path.join(__dirname, "test.pdf"), out, "binary");
console.log("wrote test.pdf with", pages, "pages + outline,", out.length, "bytes");
