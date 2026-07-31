import { sql } from '../db/client';

const TEMPLATES_FOLDER_SETTING_KEY = 'GOOGLE_DRIVE_TEMPLATES_FOLDER_ID';

export async function getDriveTemplatesFolderId(): Promise<string> {
  const rows = (await sql`
    select value
    from public.settings
    where key = ${TEMPLATES_FOLDER_SETTING_KEY}
    limit 1
  `) as Array<{ value: string | null }>;

  const folderId = rows[0]?.value?.trim();
  if (!folderId) {
    throw new Error('Google Drive templates folder is not configured. Run the one-time Drive setup first.');
  }
  return folderId;
}
