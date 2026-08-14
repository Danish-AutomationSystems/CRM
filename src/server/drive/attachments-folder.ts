import { sql } from '../db/client';

const FOLDER_ID_SETTING_KEY = 'GOOGLE_DRIVE_ATTACHMENTS_FOLDER_ID';

export async function getDriveAttachmentsFolderId(): Promise<string> {
  const rows = (await sql`
    select value
    from public.settings
    where key = ${FOLDER_ID_SETTING_KEY}
    limit 1
  `) as Array<{ value: string | null }>;

  const folderId = rows[0]?.value?.trim();
  if (!folderId) {
    throw new Error('Google Drive attachments folder is not configured. Run the one-time setup first.');
  }
  return folderId;
}
