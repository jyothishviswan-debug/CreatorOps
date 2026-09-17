import { Readable } from "node:stream";

import { google } from "googleapis";

import { getServerEnv } from "@/lib/env/server";

// Mirrors Discovery's own drive-client.ts (Step 6B.1) exactly - real
// (never simulated) Google Drive uploads for Vendor restricted-identity
// evidence. There is no Drive emulator, so this module always talks to
// the live Google API, in every environment - gated entirely by whether
// GOOGLE_APPLICATION_CREDENTIALS is configured and that service account
// has been shared on the target folder (both are one-time manual setup
// steps, not something this code can do for itself).

// The shared Drive folder every Vendor's own evidence subfolder is
// created inside - given directly by the business owner, not discovered.
const ROOT_FOLDER_ID = "1xqAZmdNqsx986E5gNVcIRT3qubjR6nq0";
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

// "V01_Vendor Name_" - a 2-digit-minimum, zero-padded sequence number
// (see types.ts's sequenceNumber field), the literal business-specified
// naming pattern, never re-derived from anything else once allocated.
export function vendorDriveFolderName(sequenceNumber: number, displayName: string): string {
  return `V${String(sequenceNumber).padStart(2, "0")}_${sanitizeFolderNamePart(displayName)}_`;
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

// Finds the Vendor's own evidence subfolder by name under the root
// shared folder, creating it only if it doesn't already exist - looked
// up by name (not just trusted from a cached id) so a manually-deleted
// or renamed folder self-heals on the next upload instead of failing
// silently against a stale id.
export async function ensureVendorDriveFolder(name: string): Promise<DriveResult<{ folderId: string }>> {
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

export async function uploadFileToVendorDriveFolder(
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
