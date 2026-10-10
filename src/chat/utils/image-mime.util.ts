const ALLOWED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export function isAllowedImageMime(mime: string | undefined): mime is string {
  return typeof mime === 'string' && ALLOWED_IMAGE_MIMES.has(mime);
}

export function extensionForImageMime(mime: string): string {
  return EXT_BY_MIME[mime] ?? 'bin';
}
