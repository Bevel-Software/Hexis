import path from 'node:path';

export function assertWithinDirectory(absolutePath: string, dir: string): void {
  const resolved = path.resolve(absolutePath);
  const root = path.resolve(dir);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error('Path traversal detected');
  }
}
