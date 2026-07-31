import type { CrmContext } from '../auth/context';
import { normalizeEmail } from '../domain/lists';
import type { QuoteRepository, QuoteService } from '../quotes/service';
import type { DriveClient } from './client';

type DriveServiceDeps = {
  quoteService: QuoteService;
  quoteRepository: QuoteRepository;
  // A factory, not a pre-built client: Task 3's createDriveClient() validates
  // its required env vars eagerly (throws synchronously if missing). Task 5
  // constructs the DriveService once at RPC-module load time - if that
  // module held a pre-built DriveClient, importing the RPC module before
  // Drive credentials exist (e.g. before the one-time OAuth setup has run,
  // or in a test/CI environment) would throw at import time and break every
  // RPC in the file, not just the Drive one. Calling this factory lazily,
  // only inside saveQuotationToDrive, defers that failure to the moment
  // someone actually tries to save to Drive.
  getDriveClient: () => DriveClient;
  getFolderId: () => Promise<string>;
};

function toBuffer(body: BodyInit): Buffer {
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  return Buffer.from(body as ArrayBuffer);
}

function driveFileName(quoteNo: string, rev: number, customerName: string, baseFileName: string): string {
  return `${quoteNo} R${rev} - ${customerName} - ${baseFileName}`;
}

export function createDriveService(deps: DriveServiceDeps) {
  return {
    async saveQuotationToDrive(user: CrmContext, quoteNo: string, rev: number) {
      const artifact = await deps.quoteService.getDownloadArtifact(user, quoteNo, rev);
      const quote = await deps.quoteRepository.getQuote(quoteNo, rev);
      if (!quote) throw new Error(`Quotation ${quoteNo} R${rev} was not found.`);
      const customer = await deps.quoteRepository.getCustomer(quote.customerId);

      // Generated quotes already have quoteNo/rev/customerName baked into
      // artifact.fileName (via safeQuoteFileName), so wrapping it again with
      // driveFileName() would duplicate that metadata in the final name.
      // External (uploaded) quotes carry only the user's original file name,
      // with no CRM metadata, so those still need the wrapping prefix.
      const fileName =
        quote.source === 'Generated'
          ? artifact.fileName
          : driveFileName(quoteNo, rev, customer?.name ?? '', artifact.fileName);

      const folderId = await deps.getFolderId();
      const uploaded = await deps.getDriveClient().uploadFile(
        {
          fileName,
          mimeType: artifact.mimeType,
          body: toBuffer(artifact.body)
        },
        folderId
      );

      await deps.quoteRepository.updateQuote(quoteNo, rev, {
        driveFileId: uploaded.id,
        driveViewLink: uploaded.webViewLink,
        driveSavedAt: new Date().toISOString(),
        driveSavedBy: user.email,
        updatedAt: new Date().toISOString()
      });

      await deps.quoteRepository.logActivity({
        action: 'QUOTE_DRIVE_SAVE',
        entity: `${quoteNo} R${rev}`,
        customerId: quote.customerId,
        details: fileName,
        who: normalizeEmail(user.email)
      });

      return deps.quoteService.getQuotation(user, quoteNo, rev);
    }
  };
}

export type DriveService = ReturnType<typeof createDriveService>;
