export type RenderQuoteBlock = {
  title: string;
  headers: string[];
  rows: string[][];
};

export type RenderQuoteInput = {
  company: string;
  preparedBy: string;
  generatedOn: string;
  quote: {
    quoteNo: string;
    rev: number;
    title: string;
    status: string;
    subtotal: number | '';
    taxPct: number | '';
    taxAmount: number | '';
    total: number | '';
    currency: string;
    validUntil: string;
    notes: string;
  };
  customer: {
    name: string;
    address: string;
    area: string;
  };
  contact: {
    name: string;
    designation: string;
  } | null;
  blocks: RenderQuoteBlock[];
};

export type QuoteDownloadArtifact = {
  body: string;
  fileName: string;
  mimeType: string;
};

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMoney(value: number | ''): string {
  const amount = Number(value || 0);
  return amount.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function contactName(contact: RenderQuoteInput['contact']): string {
  if (!contact) return '-';
  return `${contact.name}${contact.designation ? ` (${contact.designation})` : ''}`;
}

function renderRows(block: RenderQuoteBlock): string {
  const header = `<tr>${block.headers.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('')}</tr>`;
  const rows = block.rows
    .map((row) => `<tr>${block.headers.map((_, index) => `<td>${escapeHtml(row[index] ?? '')}</td>`).join('')}</tr>`)
    .join('');
  return `<table>${header}${rows}</table>`;
}

export function renderQuoteHtml(input: RenderQuoteInput): string {
  const address = [input.customer.address, input.customer.area].filter((part) => part.trim()).join(', ');
  const blocks = input.blocks
    .map(
      (block) => `
        <section>
          ${block.title ? `<h2>${escapeHtml(block.title)}</h2>` : ''}
          ${renderRows(block)}
        </section>
      `
    )
    .join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(input.quote.quoteNo)} R${input.quote.rev}</title>
  <style>
    body { color: #1f2933; font: 14px/1.45 Arial, sans-serif; margin: 32px; }
    header { border-bottom: 2px solid #2f6f4e; margin-bottom: 24px; padding-bottom: 16px; }
    h1 { font-size: 24px; margin: 0 0 4px; }
    h2 { color: #2f6f4e; font-size: 15px; margin: 24px 0 8px; }
    .meta { display: grid; gap: 6px 24px; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 18px 0; }
    .label { color: #607080; font-size: 11px; letter-spacing: .02em; text-transform: uppercase; }
    table { border-collapse: collapse; margin: 8px 0 18px; width: 100%; }
    th, td { border: 1px solid #cbd5df; padding: 7px 8px; text-align: left; vertical-align: top; }
    th { background: #e7efe9; font-weight: 700; }
    .totals { margin-left: auto; max-width: 360px; }
    .totals td:first-child { font-weight: 700; width: 45%; }
    .amount { text-align: right; }
    footer { border-top: 1px solid #d9e1e8; color: #607080; margin-top: 32px; padding-top: 12px; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(input.company)}</h1>
    <div>${escapeHtml(input.quote.title)}</div>
  </header>
  <div class="meta">
    <div><div class="label">Quote No.</div><div>${escapeHtml(input.quote.quoteNo)} R${input.quote.rev}</div></div>
    <div><div class="label">Date</div><div>${escapeHtml(input.generatedOn)}</div></div>
    <div><div class="label">Customer</div><div>${escapeHtml(input.customer.name)}</div></div>
    <div><div class="label">Status</div><div>${escapeHtml(input.quote.status)}</div></div>
    <div><div class="label">Address</div><div>${escapeHtml(address || '-')}</div></div>
    <div><div class="label">Contact</div><div>${escapeHtml(contactName(input.contact))}</div></div>
    <div><div class="label">Valid Until</div><div>${escapeHtml(input.quote.validUntil || '30 days from date of offer')}</div></div>
    <div><div class="label">Prepared By</div><div>${escapeHtml(input.preparedBy)}</div></div>
  </div>
  ${blocks}
  <table class="totals">
    <tr><td>Subtotal</td><td class="amount">${escapeHtml(input.quote.currency)} ${formatMoney(input.quote.subtotal)}</td></tr>
    <tr><td>GST @ ${escapeHtml(input.quote.taxPct)}%</td><td class="amount">${escapeHtml(input.quote.currency)} ${formatMoney(input.quote.taxAmount)}</td></tr>
    <tr><td>Total</td><td class="amount">${escapeHtml(input.quote.currency)} ${formatMoney(input.quote.total)}</td></tr>
  </table>
  <footer>
    <div><strong>Notes / terms:</strong> ${escapeHtml(input.quote.notes || '-')}</div>
  </footer>
</body>
</html>`;
}

export function safeQuoteFileName(quoteNo: string, rev: number, customerName: string): string {
  const safeCustomer = customerName
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${quoteNo}-R${rev}-${safeCustomer || 'quotation'}.html`;
}

export function buildQuoteAttachmentResponse(artifact: QuoteDownloadArtifact): Response {
  const fileName = artifact.fileName.replace(/"/g, '');
  return new Response(artifact.body, {
    status: 200,
    headers: {
      'content-type': artifact.mimeType,
      'content-disposition': `attachment; filename="${fileName}"`,
      'cache-control': 'private, no-store'
    }
  });
}
