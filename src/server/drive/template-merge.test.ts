import { describe, expect, it } from 'vitest';

import {
  buildCellFillRequests,
  buildMergeFieldRequests,
  buildStructureRequests,
  collectTables,
  locateMarker,
  type DocsDocument
} from './template-merge';

function docWithParagraph(text: string, startIndex = 1): DocsDocument {
  return {
    body: {
      content: [
        { startIndex: 0, endIndex: 1, sectionBreak: {} },
        {
          startIndex,
          endIndex: startIndex + text.length + 1,
          paragraph: {
            elements: [
              {
                startIndex,
                endIndex: startIndex + text.length,
                textRun: { content: text }
              }
            ]
          }
        }
      ]
    }
  };
}

describe('buildMergeFieldRequests', () => {
  it('emits one matchCase replaceAllText per field', () => {
    const requests = buildMergeFieldRequests({ '{{QUOTE_NO}}': 'QTN-2026-0001', '{{REV}}': 'R0' });

    expect(requests).toEqual([
      { replaceAllText: { containsText: { text: '{{QUOTE_NO}}', matchCase: true }, replaceText: 'QTN-2026-0001' } },
      { replaceAllText: { containsText: { text: '{{REV}}', matchCase: true }, replaceText: 'R0' } }
    ]);
  });

  it('replaces an empty value with an empty string rather than skipping the field', () => {
    expect(buildMergeFieldRequests({ '{{NOTES}}': '' })).toEqual([
      { replaceAllText: { containsText: { text: '{{NOTES}}', matchCase: true }, replaceText: '' } }
    ]);
  });
});

describe('locateMarker', () => {
  it('finds the marker range inside a text run', () => {
    const doc = docWithParagraph('{{BOQ_TABLE}}', 10);
    expect(locateMarker(doc, '{{BOQ_TABLE}}')).toEqual({ startIndex: 10, endIndex: 23 });
  });

  it('finds a marker embedded in surrounding text', () => {
    const doc = docWithParagraph('AB{{BOQ_TABLE}}', 10);
    expect(locateMarker(doc, '{{BOQ_TABLE}}')).toEqual({ startIndex: 12, endIndex: 25 });
  });

  it('returns null when the marker is absent', () => {
    expect(locateMarker(docWithParagraph('no marker here'), '{{BOQ_TABLE}}')).toBeNull();
  });
});

describe('buildStructureRequests', () => {
  const marker = { startIndex: 40, endIndex: 53 };
  const totals = { currency: 'INR', subtotal: '1,000.00', taxPct: '18', taxAmount: '180.00', total: '1,180.00' };

  it('deletes the marker first, then inserts in reverse so document order is title, table, totals', () => {
    const requests = buildStructureRequests(
      marker,
      [{ title: 'Main panel BOQ', headers: ['Item', 'Qty'], rows: [['Contactor', '4']] }],
      totals
    );

    expect(requests[0]).toEqual({ deleteContentRange: { range: { startIndex: 40, endIndex: 53 } } });
    // Reverse order: totals table, then the block's table, then the block's title.
    expect(requests[1]).toEqual({ insertTable: { rows: 3, columns: 2, location: { index: 40 } } });
    expect(requests[2]).toEqual({ insertTable: { rows: 2, columns: 2, location: { index: 40 } } });
    expect(requests[3]).toEqual({ insertText: { text: 'Main panel BOQ\n', location: { index: 40 } } });
    expect(requests).toHaveLength(4);
  });

  it('omits the title insert when a block has no title', () => {
    const requests = buildStructureRequests(marker, [{ title: '', headers: ['Item'], rows: [] }], totals);
    expect(requests.some((r) => 'insertText' in r)).toBe(false);
  });

  it('sizes each block table as headers plus rows', () => {
    const requests = buildStructureRequests(
      marker,
      [{ title: '', headers: ['A', 'B', 'C'], rows: [['1', '2', '3'], ['4', '5', '6']] }],
      totals
    );
    expect(requests).toContainEqual({ insertTable: { rows: 3, columns: 3, location: { index: 40 } } });
  });
});

describe('collectTables', () => {
  it('reads each table cell start index in row-major order', () => {
    const doc: DocsDocument = {
      body: {
        content: [
          {
            startIndex: 40,
            table: {
              tableRows: [
                { tableCells: [{ content: [{ startIndex: 43 }] }, { content: [{ startIndex: 46 }] }] },
                { tableCells: [{ content: [{ startIndex: 49 }] }, { content: [{ startIndex: 52 }] }] }
              ]
            }
          }
        ]
      }
    };

    expect(collectTables(doc)).toEqual([{ startIndex: 40, cellStartIndices: [43, 46, 49, 52] }]);
  });

  it('returns an empty list for a document with no tables', () => {
    expect(collectTables(docWithParagraph('text'))).toEqual([]);
  });
});

describe('buildCellFillRequests', () => {
  it('emits insertText in descending index order so earlier indices stay valid', () => {
    const tables = [{ startIndex: 40, cellStartIndices: [43, 46, 49, 52] }];
    const requests = buildCellFillRequests(tables, [['Item', 'Qty', 'Contactor', '4']]);

    expect(requests).toEqual([
      { insertText: { text: '4', location: { index: 52 } } },
      { insertText: { text: 'Contactor', location: { index: 49 } } },
      { insertText: { text: 'Qty', location: { index: 46 } } },
      { insertText: { text: 'Item', location: { index: 43 } } }
    ]);
  });

  it('skips empty cell values so no zero-length insert is sent', () => {
    const tables = [{ startIndex: 40, cellStartIndices: [43, 46] }];
    expect(buildCellFillRequests(tables, [['', 'Qty']])).toEqual([
      { insertText: { text: 'Qty', location: { index: 46 } } }
    ]);
  });

  it('ignores tables with no matching value list rather than throwing', () => {
    const tables = [{ startIndex: 40, cellStartIndices: [43] }, { startIndex: 60, cellStartIndices: [63] }];
    expect(buildCellFillRequests(tables, [['A']])).toEqual([{ insertText: { text: 'A', location: { index: 43 } } }]);
  });
});
