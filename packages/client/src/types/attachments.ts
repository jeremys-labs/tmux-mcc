// packages/client/src/types/attachments.ts
export interface ChatAttachment {
  type?: string;       // "image" | "file"
  mimeType: string;    // e.g. "image/png"
  fileName?: string;
  content: string;     // base64-encoded data (no data: URI prefix)
  /** object URL for preview — client-side only, not sent to server */
  previewUrl?: string;
  /** approximate byte size for limit checking */
  sizeBytes: number;
}
