import { describe, expect, it } from 'vitest';

import { buildQuoteAttachmentResponse, renderQuoteHtml, safeQuoteFileName } from './render';

describe('quote renderer', () => {
  it('renders generated quote HTML with tokens, BOQ blocks, manual subtotal, and GST totals', () => {
    const html = renderQuoteHtml({
      company: 'Automation Systems NG Pvt Ltd',
      preparedBy: 'Sales User (sales@automationsystems.org)',
      quote: {
        quoteNo: 'QTN-2026-0001',
        rev: 0,
        title: 'Panel quotation',
        status: 'Draft',
        subtotal: 1000,
        taxPct: 18,
        taxAmount: 180,
        total: 1180,
        currency: 'INR',
        validUntil: '2026-08-31',
        notes: 'Standard terms'
      },
      customer: {
        name: 'Alpha Panels',
        address: 'Industrial Area',
        area: 'Ludhiana'
      },
      contact: { name: 'Buyer', designation: 'GM' },
      blocks: [
        {
          title: 'Main BOQ',
          headers: ['Item', 'Qty'],
          rows: [['VFD', '2']]
        }
      ],
      generatedOn: '2026-07-29'
    });

    expect(html).toContain('Automation Systems NG Pvt Ltd');
    expect(html).toContain('QTN-2026-0001');
    expect(html).toContain('R0');
    expect(html).toContain('Alpha Panels');
    expect(html).toContain('Buyer (GM)');
    expect(html).toContain('Main BOQ');
    expect(html).toContain('<th>Item</th>');
    expect(html).toContain('<td>VFD</td>');
    expect(html).toContain('Subtotal');
    expect(html).toContain('INR 1,000.00');
    expect(html).toContain('GST @ 18%');
    expect(html).toContain('INR 180.00');
    expect(html).toContain('INR 1,180.00');
  });

  it('escapes user-provided values and creates stable filenames', () => {
    const html = renderQuoteHtml({
      company: '<Company>',
      preparedBy: 'Sales <sales@automationsystems.org>',
      quote: {
        quoteNo: 'QTN-2026-0001',
        rev: 2,
        title: '<script>alert(1)</script>',
        status: 'Sent',
        subtotal: 0,
        taxPct: 18,
        taxAmount: 0,
        total: 0,
        currency: 'INR',
        validUntil: '',
        notes: '<b>terms</b>'
      },
      customer: { name: 'Alpha / Panels', address: '', area: '' },
      contact: null,
      blocks: [{ title: '', headers: ['<Item>'], rows: [['<VFD>']] }],
      generatedOn: '2026-07-29'
    });

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;b&gt;terms&lt;/b&gt;');
    expect(safeQuoteFileName('QTN-2026-0001', 2, 'Alpha / Panels')).toBe('QTN-2026-0001-R2-Alpha Panels.html');
  });

  it('builds attachment responses with download headers', async () => {
    const response = buildQuoteAttachmentResponse({
      body: '<html><body>Quote</body></html>',
      fileName: 'QTN-2026-0001-R0-Alpha Panels.html',
      mimeType: 'text/html; charset=utf-8'
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="QTN-2026-0001-R0-Alpha Panels.html"'
    );
    expect(await response.text()).toBe('<html><body>Quote</body></html>');
  });
});
