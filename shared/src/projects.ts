const PROJECT_FOLDER_PATTERN = /^(\d{4})(\d{2})(\d{2})-(.+)$/;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Compact local date used as a project folder prefix, e.g. "20261023". */
export function projectDateStamp(date = new Date()): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/**
 * Folder name for a newly created project. Mirrors Avalon's task folders:
 * "20261023-秋季海报". Existing folders are never renamed.
 */
export function buildProjectFolderName(title: string, date = new Date()): string {
  const name = title.trim();
  if (!name) throw new Error('项目名称不能为空');
  return `${projectDateStamp(date)}-${name}`;
}

/** Splits a dated folder name back into its title and creation date. */
export function parseProjectFolderName(folderName: string): {
  title: string;
  createdDate?: string;
} {
  const name = folderName.trim();
  const match = PROJECT_FOLDER_PATTERN.exec(name);
  if (!match) return { title: name };
  const title = match[4]!.trim();
  return {
    title: title || name,
    createdDate: `${match[1]}-${match[2]}-${match[3]}`,
  };
}

/** Title shown in the UI for a project path; strips an Avalon-style date prefix. */
export function projectDisplayTitle(folderName: string): string {
  return parseProjectFolderName(folderName).title;
}
