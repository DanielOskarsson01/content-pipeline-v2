/** Sanitize a string for use as a filename. Strips unsafe chars, collapses dashes, truncates. */
export function sanitizeFilename(name: string, maxLength = 80): string {
  const clean = name
    .replace(/[/\\:*?"<>|\s]+/g, '-')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (clean.length <= maxLength) return clean || 'entity';

  // Truncated names get a hash suffix to avoid collisions
  const hash = name
    .split('')
    .reduce((acc, c) => ((acc << 5) - acc + c.charCodeAt(0)) | 0, 0)
    .toString(16)
    .replace(/^-/, '');
  return clean.slice(0, maxLength - hash.length - 1) + '-' + hash;
}
