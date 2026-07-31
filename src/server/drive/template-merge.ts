// Pure Docs API request builders. No network, no googleapis import - every
// function here takes plain JSON in and returns plain JSON out, so the whole
// merge pipeline is unit-testable against hand-built fixtures.

export type DocsRequest = Record<string, unknown>;
export type MergeFields = Record<string, string>;
export type BoqBlockInput = { title: string; headers: string[]; rows: string[][] };
export type TotalsInput = {
  currency: string;
  subtotal: string;
  taxPct: string;
  taxAmount: string;
  total: string;
};
export type MarkerLocation = { startIndex: number; endIndex: number };
export type DocsDocument = { body?: { content?: unknown[] } };
export type TableLocation = { startIndex: number; cellStartIndices: number[] };

export function buildMergeFieldRequests(fields: MergeFields): DocsRequest[] {
  return Object.entries(fields).map(([placeholder, value]) => ({
    replaceAllText: {
      containsText: { text: placeholder, matchCase: true },
      replaceText: value
    }
  }));
}

type ParagraphElement = { startIndex?: number; textRun?: { content?: string } };
type StructuralElement = {
  startIndex?: number;
  paragraph?: { elements?: ParagraphElement[] };
  table?: { tableRows?: Array<{ tableCells?: Array<{ content?: Array<{ startIndex?: number }> }> }> };
};

function structuralElements(doc: DocsDocument): StructuralElement[] {
  return (doc.body?.content ?? []) as StructuralElement[];
}

export function locateMarker(doc: DocsDocument, marker: string): MarkerLocation | null {
  for (const element of structuralElements(doc)) {
    for (const paragraphElement of element.paragraph?.elements ?? []) {
      const content = paragraphElement.textRun?.content;
      if (typeof content !== 'string') continue;
      const offset = content.indexOf(marker);
      if (offset < 0) continue;
      const runStart = paragraphElement.startIndex ?? 0;
      return { startIndex: runStart + offset, endIndex: runStart + offset + marker.length };
    }
  }
  return null;
}

export function buildStructureRequests(
  marker: MarkerLocation,
  blocks: BoqBlockInput[],
  totals: TotalsInput
): DocsRequest[] {
  const at = marker.startIndex;

  // The marker text is removed first so the inserts below land exactly where
  // it stood. Everything after this is emitted in REVERSE document order:
  // each insert at the same index pushes previously-inserted content further
  // down, so emitting last-first yields first-first in the final document.
  const requests: DocsRequest[] = [
    { deleteContentRange: { range: { startIndex: marker.startIndex, endIndex: marker.endIndex } } },
    { insertTable: { rows: 3, columns: 2, location: { index: at } } }
  ];

  for (const block of [...blocks].reverse()) {
    requests.push({
      insertTable: { rows: block.headers.length ? block.rows.length + 1 : 0, columns: block.headers.length, location: { index: at } }
    });
    if (block.title) {
      requests.push({ insertText: { text: `${block.title}\n`, location: { index: at } } });
    }
  }

  return requests;
}

export function collectTables(doc: DocsDocument): TableLocation[] {
  const tables: TableLocation[] = [];
  for (const element of structuralElements(doc)) {
    const rows = element.table?.tableRows;
    if (!rows) continue;
    const cellStartIndices: number[] = [];
    for (const row of rows) {
      for (const cell of row.tableCells ?? []) {
        const start = cell.content?.[0]?.startIndex;
        if (typeof start === 'number') cellStartIndices.push(start);
      }
    }
    tables.push({ startIndex: element.startIndex ?? 0, cellStartIndices });
  }
  return tables;
}

export function buildCellFillRequests(tables: TableLocation[], tableValues: string[][]): DocsRequest[] {
  const inserts: Array<{ index: number; text: string }> = [];

  tables.forEach((table, tableIndex) => {
    const values = tableValues[tableIndex];
    if (!values) return;
    table.cellStartIndices.forEach((index, cellIndex) => {
      const text = values[cellIndex];
      if (!text) return;
      inserts.push({ index, text });
    });
  });

  // Descending index order: inserting text shifts every later index, so the
  // highest index must be written first for the rest to stay valid.
  return inserts
    .sort((a, b) => b.index - a.index)
    .map(({ index, text }) => ({ insertText: { text, location: { index } } }));
}
