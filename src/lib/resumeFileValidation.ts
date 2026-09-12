import { APP_CONSTANTS } from "@/lib/constants";
import { PDF_MAGIC, ZIP_MAGIC } from "@/lib/ai/import/extract-text";

export const RESUME_ALLOWED_MIME = new Set<string>(
  APP_CONSTANTS.RESUME_ALLOWED_MIME_TYPES,
);

// Shared by the human upload route (multipart) and the MCP save_tailored_resume
// tool (base64) so both paths enforce identical size/type/content checks.
export function validateResumeFileBytes(buf: Buffer, mimeType: string): boolean {
  if (mimeType === "application/pdf") return buf.subarray(0, 4).equals(PDF_MAGIC);
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return buf.subarray(0, 4).equals(ZIP_MAGIC);
  }
  return false;
}
