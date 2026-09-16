import { Readable } from "node:stream";

import { google } from "googleapis";

import { getServerEnv } from "@/lib/env/server";

// Step 6B.1: real (never simulated) Google Drive uploads for KYC
// evidence. There is no Drive emulator, so unlike the rest of this
// domain this module always talks to the live Google API, in every
// environment - gated entirely by whether GOOGLE_APPLICATION_CREDENTIALS
// is configured and that service account has been shared on the target
// folder (both are one-time manual setup steps, documented in
// AGENTS.md/.env.example, not something this code can do for itself).

// The shared Drive folder every Lead's own KYC subfolder is created
// inside - given directly by the business owner, not discovered.
const ROOT_FOLDER_ID = "1TbAIAc6utDjqR-lE9XcpmWWrf5NLyhvt";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export type DriveResult<T> = { ok: true; data: T } | { ok: false; message: string };

let cachedDrive: ReturnType<typeof google.drive> | null = null;

function getDrive() {
  if (cachedDrive) return cachedDrive;
  const env = getServerEnv();
  if (!env.googleApplicationCredentials) {
    throw new Error(
      "GOOGLE_APPLICATION_CREDENTIALS is not set - Drive uploads need a service-account key file path in .env.local (see .env.example).",
    );
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: env.googleApplicationCredentials,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  cachedDrive = google.drive({ version: "v3", auth });
  return cachedDrive;
}

// Drive folder names allow almost anything, but strip characters that
// would make the resulting name confusing or that Drive silently
// mangles, and bound the length so a very long display name can't
// produce an unwieldy folder name.
function sanitizeFolderNamePart(value: string): string {
  return value.replace(/[\\/:"*?<>|]/g, " ").trim().slice(0, 120);
}

export function leadDriveFolderName(platformCode: string, proposalNumber: number, displayName: string): string {
  return `${platformCode}_${proposalNumber}_${sanitizeFolderNamePart(displayName)}`;
}

function friendlyDriveError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("GOOGLE_APPLICATION_CREDENTIALS")) return message;
  if (message.includes("403") || /insufficient|forbidden/i.test(message)) {
    return "Drive denied access - confirm the target folder is shared with the service account as Editor/Content Manager, and that the Drive API is enabled for the project.";
  }
  if (message.includes("404")) {
    return "The Drive folder could not be found - it may have been moved, deleted, or was never shared with the service account.";
  }
  return `Drive request failed: ${message}`;
}

// Finds the Lead's own KYC subfolder by name under the root shared
// folder, creating it only if it doesn't already exist - looked up by
// name (not just trusted from a cached id) so a manually-deleted or
// renamed folder self-heals on the next upload instead of failing
// silently against a stale id.
export async function ensureLeadDriveFolder(name: string): Promise<DriveResult<{ folderId: string }>> {
  try {
    const drive = getDrive();
    const escaped = name.replace(/'/g, "\\'");
    const existing = await drive.files.list({
      q: `'${ROOT_FOLDER_ID}' in parents and name = '${escaped}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: "files(id, name)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "allDrives",
    });
    const found = existing.data.files?.[0]?.id;
    if (found) return { ok: true, data: { folderId: found } };

    const created = await drive.files.create({
      requestBody: { name, mimeType: FOLDER_MIME, parents: [ROOT_FOLDER_ID] },
      fields: "id",
      supportsAllDrives: true,
    });
    if (!created.data.id) return { ok: false, message: "Drive did not return a folder id." };
    return { ok: true, data: { folderId: created.data.id } };
  } catch (error) {
    return { ok: false, message: friendlyDriveError(error) };
  }
}

export async function uploadFileToDriveFolder(
  folderId: string,
  file: { buffer: Buffer; fileName: string; mimeType: string },
): Promise<DriveResult<{ fileId: string; webViewLink: string }>> {
  try {
    const drive = getDrive();
    const res = await drive.files.create({
      requestBody: { name: file.fileName, parents: [folderId] },
      media: { mimeType: file.mimeType || "application/octet-stream", body: Readable.from(file.buffer) },
      fields: "id, webViewLink",
      supportsAllDrives: true,
    });
    if (!res.data.id || !res.data.webViewLink) return { ok: false, message: "Drive did not return a file id/link." };
    return { ok: true, data: { fileId: res.data.id, webViewLink: res.data.webViewLink } };
  } catch (error) {
    return { ok: false, message: friendlyDriveError(error) };
  }
}
