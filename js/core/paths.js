// js/core/paths.js — folder-path helpers shared by every namespace (pure).
// A folder path is segments joined with FOLDER_SEP ("Work / Projects").

export const FOLDER_SEP = ' / ';

export const MAX_SUBFOLDER_PARENT_DEPTH = 2;

export function splitFolderPath(path) {
  return String(path == null ? '' : path).split('/').map((part) => part.trim()).filter(Boolean);
}

export function folderParent(path) {
  const parts = splitFolderPath(path);
  if (parts.length < 2) return null;
  return parts.slice(0, -1).join(FOLDER_SEP);
}

export function folderLeaf(path) {
  const parts = splitFolderPath(path);
  return parts.length ? parts[parts.length - 1] : String(path);
}

export function folderDepth(path) {
  return Math.max(0, splitFolderPath(path).length - 1);
}

export function folderIconForDepth(depth) {
  if (depth <= 0) return 'folder-solid';
  if (depth === 1) return 'folder';
  return 'folder-deep';
}

export function isFolderOrSub(path, ancestor) {
  return path === ancestor || path.startsWith(`${ancestor}${FOLDER_SEP}`);
}

export const CONTROL_CHARS = Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)).join('');

export function cleanFolderPath(raw) {
  const parts = String(raw == null ? '' : raw)
    .replace(new RegExp('[' + CONTROL_CHARS + '<>' + '"' + ']', 'g'), '')
    .split('/')
    .map((part) => part.trim().replace(/\s+/g, ' ').slice(0, 60))
    .filter(Boolean);
  return parts.join(FOLDER_SEP).slice(0, 180);
}

export function joinLeafRename(oldPath, rawLeaf) {
  const leaf = cleanFolderPath(rawLeaf);
  if (!leaf) return '';
  const parent = folderParent(oldPath);
  return parent ? `${parent}${FOLDER_SEP}${leaf}` : leaf;
}
